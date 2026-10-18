// `vault doctor` (cli.md, security-setup.md): checks the installation and each
// vault, and reports what is wrong — `problem` — or worth knowing —
// `warning` — with what to do. It changes nothing unless asked to fix:
// `--fix` installs the package's hooks where none is in the way and makes the
// state and config directories private to the user. A problem makes the
// command fail; warnings do not.
//
// Checks: the config file, Git, Pi, each model role's token; per vault, its
// identity, a `core.hooksPath` that bypasses the package's hooks, the
// pre-push guard, a remote on a `local` vault, locks left in main's worktree,
// forge protection in `forge` mode, hosting conflicts, search falling back to
// keywords because no policy entry names the vault, and jobs that cannot run; then sessions holding
// actors (and those whose holder cannot be told apart from a reused process),
// undelivered notifications, notify not being configured, and no daily token
// ceiling.

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listActorHolds } from '../../actors/index.ts';
import { resolveSecret, MODEL_ROLES } from '../../config/index.ts';
import { forgeAdapter, forgeProject, protectionProblems } from '../../forge/index.ts';
import {
  configValue, gitDirectories, gitVersion, listRemotes, listWorktrees, meetsMinimumGitVersion, remoteUrl, MINIMUM_GIT_VERSION,
} from '../../git/index.ts';
import { MAIN_BRANCH, type AcceptedMain } from '../../integrity/index.ts';
import { modelFor } from '../../models/index.ts';
import { undeliveredNotifications } from '../../notify/index.ts';
import { vaultJobs } from '../../queue/index.ts';
import { runProcess } from '../../process/index.ts';
import { checkRegisteredIdentity, hosting, readVaultIdentity, type RegisteredVault } from '../../registry/index.ts';
import { scriptEnvironment, type OperationContext } from '../context.ts';
import { failed, succeeded } from '../messages.ts';
import type { Operation } from '../types.ts';
import { flag, readingFrom } from './common.ts';

export interface Finding {
  readonly level: 'ok' | 'warning' | 'problem';
  readonly check: string;
  readonly vault?: string;
  readonly message: string;
}

/** The Pi version this package is built for (pi-conventions.md). */
const MINIMUM_PI: readonly [number, number] = [1, 3];
const PRE_PUSH_MARK = 'pi-active-vaults: pre-push guard';

/** Refuses any push that would update `main` on a remote: changes reach main only through review. */
const PRE_PUSH_HOOK = `#!/bin/sh
# ${PRE_PUSH_MARK} (installed by vault doctor --fix)
while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/heads/${MAIN_BRANCH}" ]; then
    echo "pi-active-vaults: pushing ${MAIN_BRANCH} is refused; changes reach ${MAIN_BRANCH} only through review." >&2
    exit 1
  fi
done
exit 0
`;

async function piVersion(context: OperationContext): Promise<Finding> {
  const ran = await runProcess({ program: { file: 'pi', args: ['--version'] }, env: scriptEnvironment(context.installation), timeoutMs: 20_000, maxStdoutBytes: 4096, maxStderrBytes: 4096 });
  if (!ran.ok) return { level: 'warning', check: 'pi', message: 'Pi was not found on PATH; vaults work from the CLI, but not in Pi sessions or headless runs.' };
  const found = /(\d+)\.(\d+)/.exec(ran.value.stdout.toString('utf8'));
  const [major, minor] = [Number(found?.[1] ?? 0), Number(found?.[2] ?? 0)];
  const recent = major > MINIMUM_PI[0] || (major === MINIMUM_PI[0] && minor >= MINIMUM_PI[1]);
  return recent
    ? { level: 'ok', check: 'pi', message: `Pi ${major}.${minor}` }
    : { level: 'problem', check: 'pi', message: `Pi ${found === null ? '(unknown version)' : `${major}.${minor}`} is older than ${MINIMUM_PI.join('.')}, which this package needs.` };
}

async function installationFindings(context: OperationContext): Promise<Finding[]> {
  const { installation } = context;
  const findings: Finding[] = [];
  findings.push(installation.configFound
    ? { level: 'ok', check: 'config', message: `${installation.paths.configFile} is valid` }
    : { level: 'warning', check: 'config', message: `There is no config file at ${installation.paths.configFile}; "vault init" or "vault add" creates it.` });
  const version = await gitVersion(context.git);
  findings.push(!version.ok ? { level: 'problem', check: 'git-version', message: 'Git could not be run.' }
    : meetsMinimumGitVersion(version.value) ? { level: 'ok', check: 'git-version', message: `Git ${version.value}` }
    : { level: 'problem', check: 'git-version', message: `Git ${version.value} is older than ${MINIMUM_GIT_VERSION.join('.')}.` });
  findings.push(await piVersion(context));
  for (const role of MODEL_ROLES) {
    const endpoint = installation.config.models[role];
    if (endpoint === undefined) continue;
    const token = await resolveSecret(endpoint.token, context.secrets);
    findings.push(token.ok
      ? { level: 'ok', check: 'models', message: `${role}: ${endpoint.model} at ${endpoint.url}; its token resolves (the endpoint is not contacted)` }
      : { level: 'problem', check: 'models', message: `${role}: the token in ${token.error.where} cannot be resolved (${token.error.reason}).` });
  }
  return findings;
}

/** A file mode check, POSIX only (Windows profile directories are the user's by their ACLs). */
function privateMode(context: OperationContext, path: string, mode: number, fix: boolean): Finding | undefined {
  if (context.installation.host.os === 'win32' || !existsSync(path)) return undefined;
  const current = statSync(path).mode & 0o777;
  if ((current & 0o077) === 0) return undefined;
  if (fix) {
    chmodSync(path, mode);
    return { level: 'ok', check: 'permissions', message: `${path} is now private to the user (was ${current.toString(8)}).` };
  }
  return { level: 'problem', check: 'permissions', message: `${path} is accessible to other users (mode ${current.toString(8)}); "vault doctor --fix" makes it private.` };
}

async function vaultFindings(context: OperationContext, vault: RegisteredVault, fix: boolean): Promise<Finding[]> {
  const { git, installation } = context;
  const at = (level: Finding['level'], check: string, message: string): Finding => ({ level, check, vault: vault.id, message });
  const accepted = readingFrom(context, vault);
  const identity = await readVaultIdentity(git, vault.path, accepted.ok ? accepted.value.sha : 'refs/heads/main');
  if (!identity.ok) return [at('problem', 'identity', `Its root contract cannot be read (${identity.error.reason}).`)];
  const findings: Finding[] = [];
  const registered = checkRegisteredIdentity(vault, identity.value);
  if (!registered.ok) findings.push(at('problem', 'identity', `It is registered as "${vault.id}" but its root contract says "${identity.value.id}".`));

  const hooksPath = await configValue(git, vault.path, 'core.hooksPath');
  if (hooksPath.ok && hooksPath.value !== undefined) {
    findings.push(at('warning', 'hooks', `core.hooksPath (${hooksPath.value}) bypasses the package's hooks: changes are noticed up to a minute later and the pre-push guard is lost.`));
  }
  const dirs = await gitDirectories(git, vault.path);
  if (dirs.ok) {
    const hook = join(dirs.value.common, 'hooks', 'pre-push');
    const ours = existsSync(hook) && readFileSync(hook, 'utf8').includes(PRE_PUSH_MARK);
    if (ours) findings.push(at('ok', 'hooks', 'The pre-push guard is installed.'));
    else if (existsSync(hook)) findings.push(at('warning', 'hooks', `A pre-push hook of its own is in place at ${hook}; the package's guard is not installed.`));
    else if (fix) {
      writeFileSync(hook, PRE_PUSH_HOOK, { mode: 0o755 });
      findings.push(at('ok', 'hooks', 'The pre-push guard was installed.'));
    } else findings.push(at('warning', 'hooks', 'The pre-push guard is not installed; "vault doctor --fix" installs it.'));
  }

  const remotes = await listRemotes(git, vault.path);
  if (identity.value.review === 'local' && remotes.ok && remotes.value.length > 0) {
    findings.push(at('warning', 'remotes', `A local vault has remotes (${remotes.value.join(', ')}): local mode is for one clone; use forge mode for a vault on several machines.`));
  }

  const worktrees = await listWorktrees(git, vault.path);
  const mainCheckout = worktrees.ok ? worktrees.value.find((w) => w.branch === MAIN_BRANCH) : undefined;
  if (mainCheckout !== undefined) {
    const own = await gitDirectories(git, mainCheckout.path);
    for (const lock of own.ok ? ['index.lock', 'HEAD.lock'] : []) {
      const path = join(own.ok ? own.value.own : '', lock);
      if (existsSync(path)) findings.push(at('problem', 'locks', `${path} is left in main's worktree; if no Git command is running there, remove it.`));
    }
  }

  if (identity.value.review === 'forge') findings.push(...await forgeFindings(context, vault, identity.value.owners));
  if (hosting(vault, identity.value, installation.config.name).conflict) {
    findings.push(at('warning', 'hosting', `host is true, but the vault's executor is ${identity.value.executor ?? ''}, so its jobs do not run here.`));
  }
  const embed = modelFor(installation.config, 'embed', [vault.id]);
  if (!embed.ok && embed.error.reason === 'not-allowed') {
    findings.push(at('warning', 'search', 'Search is keyword-only: no policy entry allows the embed role for this vault.'));
  }
  if (accepted.ok) findings.push(...(await jobFindings(context, vault, accepted.value)));
  return findings;
}

/** Each job on the accepted main that cannot run — no readable budget, no actor that may write — with why. */
async function jobFindings(context: OperationContext, vault: RegisteredVault, accepted: AcceptedMain): Promise<Finding[]> {
  const jobs = await vaultJobs(context.git, vault.path, accepted);
  if (!jobs.ok) return [{ level: 'problem', check: 'jobs', vault: vault.id, message: `Its jobs cannot be read (${jobs.error.reason}).` }];
  return jobs.value
    .filter((job) => job.issues.length > 0)
    .map((job) => ({ level: 'warning', check: 'jobs', vault: vault.id, message: `${job.path} cannot run: ${job.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}` }));
}

async function forgeFindings(context: OperationContext, vault: RegisteredVault, owners: readonly string[]): Promise<Finding[]> {
  const at = (level: Finding['level'], message: string): Finding => ({ level, check: 'forge', vault: vault.id, message });
  const remote = await remoteUrl(context.git, vault.path, 'origin');
  if (!remote.ok || remote.value === undefined) return [at('problem', 'A forge vault needs its forge as the remote "origin".')];
  const project = forgeProject(context.installation.config.forges, remote.value);
  if (!project.ok) return [at('problem', `No forge is configured for origin's host (${project.error.reason}).`)];
  const adapter = forgeAdapter(project.value.entry, project.value.project, { client: context.http, secrets: context.secrets });
  const account = await adapter.account();
  if (!account.ok) return [at('problem', `The forge cannot be asked about its settings (${account.error.reason}).`)];
  const protection = await adapter.protection(MAIN_BRANCH);
  if (!protection.ok) return [at('problem', `Main's protection cannot be read (${protection.error.reason}).`)];
  const problems = protectionProblems(protection.value, { account: account.value, owners });
  return problems.length === 0
    ? [at('ok', 'Main is protected as recommended.')]
    : problems.map((p) => at(p === 'approval-not-required' ? 'warning' : 'problem', FORGE_PROBLEMS[p]));
}

const FORGE_PROBLEMS: Readonly<Record<ReturnType<typeof protectionProblems>[number], string>> = {
  'not-protected': 'Main is not protected in the forge.',
  'direct-pushes': 'Main takes direct pushes; changes should arrive only through pull requests.',
  'force-pushes': 'Main allows force pushes.',
  deletion: 'Main can be deleted.',
  'policy-status-not-required': 'Main\'s protection does not require the vault/policy status.',
  'approval-not-required': 'No owner approval is required: vault/policy alone decides what merges.',
  'approval-unknown': 'Whether an owner\'s approval is required cannot be read (on GitLab, a tier without approval rules).',
  'executor-is-owner': 'The executor\'s forge account is an owner: it could approve its own proposals.',
};

async function machineFindings(context: OperationContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const hold of await listActorHolds(context.state, context.alive)) {
    findings.push(hold.standing === 'running'
      ? { level: 'ok', check: 'holds', vault: hold.vault, message: `${hold.actor} is held by session ${hold.holder.session} (process ${hold.holder.process.pid}) since ${hold.since}.` }
      : { level: 'warning', check: 'holds', vault: hold.vault, message: `${hold.actor} is held by session ${hold.holder.session}: process ${hold.holder.process.pid} exists, but whether it is that session cannot be told, so the hold stands. If that session has ended, ending process ${hold.holder.process.pid} releases it.` });
  }
  for (const n of undeliveredNotifications(context.state)) {
    findings.push({ level: 'warning', check: 'notify', message: `A notification to "${n.alias}" ("${n.subject}") is ${n.state === 'pending' ? `undelivered after ${n.attempts} attempt(s)${n.lastError === undefined ? '' : ` (${n.lastError})`}` : 'undeliverable: its alias is gone'}.` });
  }
  const { config } = context.installation;
  if (context.installation.notify === undefined) findings.push({ level: 'warning', check: 'notify', message: 'notify is not configured, so owners are not told of unaccepted changes.' });
  if (config.budgets.dailyTokens === undefined) findings.push({ level: 'warning', check: 'budgets', message: 'budgets.daily-tokens is not set: nothing caps the tokens all work may use in a day.' });
  findings.push({ level: 'warning', check: 'daemon', message: 'The daemon is not part of this version: timers, Git-event jobs and queued spawns do not run yet.' });
  return findings;
}

export const doctorOperation: Operation = {
  name: 'doctor',
  summary: 'Check the installation and each vault; --fix installs hooks and corrects permissions',
  vault: 'none',
  surfaces: { cli: true, command: true, mcp: false },
  params: [{ name: 'fix', kind: 'boolean', description: 'Install the package\'s hooks and make state and config private' }],
  async run(context, request) {
    const findings = await doctorFindings(context, flag(request.params, 'fix'));
    const problems = findings.some((f) => f.level === 'problem');
    return (problems ? failed : succeeded)(doctorText(findings), { findings });
  },
};

/** Every finding, installation first, then each vault, then the machine's state. */
export async function doctorFindings(context: OperationContext, fix: boolean): Promise<Finding[]> {
  const { paths } = context.installation;
  const findings = await installationFindings(context);
  for (const [path, mode] of [[dirname(paths.stateDb), 0o700], [dirname(paths.configFile), 0o700], [paths.configFile, 0o600], [paths.stateDb, 0o600]] as const) {
    const found = privateMode(context, path, mode, fix);
    if (found !== undefined) findings.push(found);
  }
  for (const vault of context.installation.vaults) findings.push(...await vaultFindings(context, vault, fix));
  findings.push(...await machineFindings(context));
  return findings;
}

export function doctorText(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.level === 'ok' ? 'ok     ' : f.level === 'warning' ? 'warning' : 'PROBLEM'} ${f.check}${f.vault === undefined ? '' : ` [${f.vault}]`}: ${f.message}`).join('\n');
}

