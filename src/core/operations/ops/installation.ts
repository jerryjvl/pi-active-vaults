// Installation operations: the vaults on this machine and its name — list,
// add, init, whoami, template show. They change the installation config only
// by registering a vault (`registerVault`), which also creates the config
// file on a machine that has none, with the installation's person (`--person`,
// by default the OS user). A vault registered with `add` is not accepted by
// that, so it shows an unaccepted change until an owner adopts its `main`.
// Both install the vault's hooks (`hooks.ts`), except where the user's own are
// in the way. `init` also makes the person's worktree, so there is somewhere
// to edit at once.

import { writeFileSync } from 'node:fs';
import { isAbsolute, basename, dirname, resolve } from 'node:path';
import { ensureActorWorktree, syncActorBranch, type ActorCommitContext } from '../../actors/index.ts';
import { checkPerson, ensurePrivateDir, registerVault } from '../../config/index.ts';
import { runProcess } from '../../process/index.ts';
import type { AcceptedMain } from '../../integrity/index.ts';
import { readVaultIdentity, registeredVaults, type RegisteredVault } from '../../registry/index.ts';
import { err, ok, type Result } from '../../result/index.ts';
import { createEmptyVault, createFromTemplate, inspectTemplate, resolveTemplateSpec } from '../../templates/index.ts';
import { packageIdentity, type OperationContext } from '../context.ts';
import { hookFindings } from '../hooks.ts';
import { fromError, succeeded } from '../messages.ts';
import type { Caller, Operation } from '../types.ts';
import { newTraceId } from '../../traces/index.ts';
import { commitContext, identityOf, ownWorktree, personOf, readingFrom, text } from './common.ts';

const CLI_ONLY = { cli: true, command: false, mcp: false } as const;

/** A path given on the command line, made absolute from where the caller is. */
function absolute(path: string, caller: Caller): string {
  return isAbsolute(path) ? path : resolve(caller.cwd ?? process.cwd(), path);
}

export const listOperation: Operation = {
  name: 'list',
  summary: 'The registered vaults and their catalog entries',
  vault: 'none',
  surfaces: CLI_ONLY,
  params: [],
  async run(context) {
    const listed = [];
    const lines: string[] = [];
    for (const vault of context.installation.vaults) {
      const accepted = readingFrom(context, vault);
      const identity = await identityOf(context, vault);
      const entry = identity.ok ? { summary: identity.value.purpose.summary, audience: identity.value.audience, review: identity.value.review, owners: identity.value.owners } : undefined;
      const worktree = ownWorktree(context, vault);
      listed.push({ id: vault.id, path: vault.path, worktrees: vault.worktrees, ...(worktree === undefined ? {} : { worktree }), host: vault.host, accepted: accepted.ok ? accepted.value.sha : null, ...entry });
      lines.push(`${vault.id}  ${vault.path}${entry === undefined ? '  (its root contract cannot be read)' : `\n  ${entry.summary} — for ${entry.audience}; ${entry.review} review; owners ${entry.owners.join(', ')}`}${worktree === undefined ? '' : `\n  your worktree: ${worktree}`}`);
    }
    return succeeded(lines.join('\n') || 'No vaults are registered. Create one with "vault init <path>" or register one with "vault add <path>".', { vaults: listed });
  },
};

/**
 * The person for a config this command is about to create: `--person`, else
 * the OS user. Undefined when the config exists, which `--person` then does
 * not apply to — refused rather than ignored.
 */
function newConfigPerson(context: OperationContext, request: { readonly params: Record<string, unknown> }): Result<string | undefined, { readonly reason: string; readonly [detail: string]: unknown }> {
  const given = text(request.params, 'person');
  if (context.installation.configFound) {
    return given === undefined ? ok(undefined) : err({ reason: 'person-given', file: context.installation.paths.configFile });
  }
  return checkPerson(given ?? context.installation.host.user, context.installation.host);
}

const PERSON_PARAM = { name: 'person', kind: 'string', description: 'The installation\'s person, when the config file is created (default: the OS user)' } as const;

/** The vault as registered just now, with its default locations. */
function justRegistered(context: OperationContext, id: string, path: string): RegisteredVault | undefined {
  return registeredVaults({ vaults: [{ id, path, host: false }] }, context.installation.paths, context.installation.host.os)[0];
}

/** Installs the vault's hooks where none of the user's are in the way; what happened, one line each. */
async function installHooks(context: OperationContext, id: string, path: string): Promise<string[]> {
  const vault = justRegistered(context, id, path);
  return vault === undefined ? [] : (await hookFindings(context, vault, true)).map((f) => f.message);
}

/** Makes the person's worktree in a vault just created, so there is somewhere to edit; what happened, one line. */
async function makeOwnWorktree(context: OperationContext, id: string, path: string, accepted: AcceptedMain, person: string): Promise<string> {
  const vault = justRegistered(context, id, path);
  if (vault === undefined) return '';
  const made = await ensureActorWorktree(context.git, vault, accepted, person, context.reads);
  return made.ok
    ? `Your worktree, where you edit and commit: ${made.value.path}`
    : `No worktree was made for "${person}": ${made.error.reason === 'unknown-actor' ? 'not one of the vault\'s owners or actors' : made.error.reason}.`;
}

export const addOperation: Operation = {
  name: 'add',
  summary: 'Register an existing vault in the installation',
  vault: 'none',
  surfaces: CLI_ONLY,
  params: [{ name: 'path', kind: 'string', required: true, positional: true, description: 'The vault repository' }, PERSON_PARAM],
  async run(context, request) {
    const person = newConfigPerson(context, request);
    if (!person.ok) return fromError(person.error);
    const path = absolute(text(request.params, 'path') ?? '', request.caller);
    const identity = await readVaultIdentity(context.git, path, 'refs/heads/main');
    if (!identity.ok) return fromError(identity.error);
    const registered = registerVault(context.installation.paths.configFile, context.installation.host, { id: identity.value.id, path }, person.value);
    if (!registered.ok) return fromError(registered.error);
    const hooks = await installHooks(context, identity.value.id, path);
    return succeeded([
      `Registered vault "${identity.value.id}" at ${path}${person.value === undefined ? '' : `, creating ${context.installation.paths.configFile} for person "${person.value}"`}. Nothing in it is accepted on this machine yet: an owner can look at main and adopt it with "vault accept ${identity.value.id} --adopt <sha>".`,
      ...hooks.map((h) => `Hooks: ${h}`),
    ].join('\n'), { id: identity.value.id, path, hooks });
  },
};

/** Fails when the id or path is already registered, before anything is created. */
function alreadyRegistered(context: OperationContext, id: string, path: string) {
  const byId = context.installation.vaults.find((v) => v.id === id);
  if (byId !== undefined) return { reason: 'already-registered', id } as const;
  const byPath = context.installation.vaults.find((v) => v.path === path);
  return byPath === undefined ? undefined : ({ reason: 'path-registered', id: byPath.id } as const);
}

export const initOperation: Operation = {
  name: 'init',
  summary: 'Create a vault — empty, or from a template with fresh history — and register it',
  vault: 'none',
  surfaces: CLI_ONLY,
  params: [
    { name: 'path', kind: 'string', required: true, positional: true, description: 'Where to create it: a new or empty directory' },
    { name: 'template', kind: 'string', description: 'A template URL or short name, optionally @ref' },
    { name: 'id', kind: 'string', description: 'The vault\'s id (default: the directory\'s name)' },
    PERSON_PARAM,
  ],
  async run(context, request) {
    const created = newConfigPerson(context, request);
    if (!created.ok) return fromError(created.error);
    const person = created.value === undefined ? personOf(request.caller) : ok(created.value);
    if (!person.ok) return fromError(person.error);
    const path = absolute(text(request.params, 'path') ?? '', request.caller);
    const id = text(request.params, 'id') ?? basename(path);
    const registered = alreadyRegistered(context, id, path);
    if (registered !== undefined) return fromError(registered);
    const deps = { git: context.git, store: context.state, clock: context.clock, attribution: { identity: packageIdentity(context.installation, person.value) } };
    const spec = text(request.params, 'template');
    let made;
    if (spec === undefined) {
      made = await createEmptyVault(deps, { path, id, by: person.value });
    } else {
      const source = resolveTemplateSpec(spec, context.installation.config.templates);
      if (!source.ok) return fromError(source.error);
      made = await createFromTemplate(deps, { source: source.value, path, id, by: person.value });
    }
    if (!made.ok) return fromError(made.error);
    const added = registerVault(context.installation.paths.configFile, context.installation.host, { id, path }, created.value);
    if (!added.ok) return fromError(added.error, { created: made.value });
    const hooks = await installHooks(context, id, path);
    const worktree = await makeOwnWorktree(context, id, path, made.value.accepted, person.value);
    return succeeded([
      `Created vault "${id}" at ${path}, accepted at ${made.value.accepted.sha}, and registered it${created.value === undefined ? '' : `, creating ${context.installation.paths.configFile} for person "${created.value}"`}.`,
      ...hooks.map((h) => `Hooks: ${h}`),
      ...(worktree === '' ? [] : [worktree]),
    ].join('\n'), { ...made.value, hooks });
  },
};

export const workspaceOperation: Operation = {
  name: 'workspace',
  summary: 'Write an editor workspace with your worktree in every vault you own or write as; --open brings them up to date and opens it',
  vault: 'none',
  surfaces: CLI_ONLY,
  params: [{ name: 'open', kind: 'boolean', description: 'Bring your worktrees up to date with the accepted main, then open the workspace with `code`' }],
  async run(context, request) {
    const person = personOf(request.caller);
    if (!person.ok) return fromError(person.error);
    const folders: { name: string; path: string }[] = [];
    const lines: string[] = [];
    const open = request.params['open'] === true;
    const committing = open ? await commitContext(context, request.caller) : undefined;
    for (const vault of context.installation.vaults) {
      const accepted = readingFrom(context, vault);
      if (!accepted.ok) {
        lines.push(`${vault.id}: left out (nothing accepted yet)`);
        continue;
      }
      const worktree = await ensureActorWorktree(context.git, vault, accepted.value, person.value, context.reads);
      if (!worktree.ok) {
        lines.push(`${vault.id}: left out (${worktree.error.reason === 'unknown-actor' ? `${person.value} is not one of its owners or actors` : worktree.error.reason})`);
        continue;
      }
      folders.push({ name: vault.id, path: worktree.value.path });
      // Opening is when you read them: each starts from the accepted main, unless you have work in progress.
      if (committing !== undefined) lines.push(...(await syncLine(context, committing, vault, accepted.value, person.value)));
    }
    const file = context.installation.paths.workspace;
    ensurePrivateDir(dirname(file));
    // Regenerated every time, so a new vault appears without editing the file by hand.
    writeFileSync(file, `${JSON.stringify({ folders }, null, 2)}\n`, { mode: 0o600 });
    lines.unshift(`Wrote ${file} with ${folders.length} worktree(s): ${folders.map((f) => f.name).join(', ') || 'none'}.`);
    if (open) {
      // The person's own editor, started for them: it gets their whole environment
      // (on WSL, `code` needs its variables to reach VS Code on Windows), unlike
      // scripts, which run with only the variables they need.
      const opened = await runProcess({ program: { file: 'code', args: [file] }, env: { ...context.installation.host.env }, timeoutMs: 60_000, maxStdoutBytes: 65_536, maxStderrBytes: 65_536 });
      lines.push(opened.ok && opened.value.exitCode === 0 ? 'Opened it with code.' : 'It could not be opened with code; open the file in your editor.');
    }
    return succeeded(lines.join('\n'), { file, folders });
  },
};

/** Your branch in a vault brought up to date for opening; a line when anything happened, or why it could not. */
async function syncLine(context: OperationContext, committing: ActorCommitContext, vault: RegisteredVault, accepted: AcceptedMain, person: string): Promise<string[]> {
  const synced = await syncActorBranch(committing, vault, accepted, person, {
    origin: { trace: newTraceId(context.ids), actor: person }, date: context.clock.now(), identity: packageIdentity(context.installation, person),
  });
  if (!synced.ok) return [`${vault.id}: not brought up to date (${synced.error.reason})`];
  switch (synced.value.outcome) {
    case 'fast-forwarded': case 'merged': return [`${vault.id}: brought up to date with the accepted main (${synced.value.outcome})`];
    case 'uncommitted-changes': return [`${vault.id}: left as it is (uncommitted changes)`];
    default: return [];
  }
}

export const whoamiOperation: Operation = {
  name: 'whoami',
  summary: 'This installation\'s name, for a vault\'s executor',
  vault: 'none',
  surfaces: CLI_ONLY,
  params: [],
  async run(context) {
    const { name, person } = context.installation.config;
    return succeeded(name, { name, ...(person === undefined ? {} : { person }) });
  },
};

export const templateShowOperation: Operation = {
  name: 'template-show',
  command: 'template show',
  summary: 'Check that a repository is a compatible template and summarise it',
  vault: 'none',
  surfaces: CLI_ONLY,
  params: [{ name: 'template', kind: 'string', required: true, positional: true, description: 'A template URL or short name, optionally @ref' }],
  async run(context, request) {
    const source = resolveTemplateSpec(text(request.params, 'template') ?? '', context.installation.config.templates);
    if (!source.ok) return fromError(source.error);
    const summary = await inspectTemplate(context.git, source.value);
    if (!summary.ok) return fromError(summary.error);
    const { template, vault, commit, files } = summary.value;
    return succeeded([
      `${template.name} version ${template.version}: ${template.summary}`,
      `  at ${commit}; ${files} files`,
      `  purpose: ${vault.purpose}`,
      `  owners: ${vault.owners.join(', ')}; actors: ${vault.actors.join(', ') || 'none'}`,
    ].join('\n'), summary.value);
  },
};
