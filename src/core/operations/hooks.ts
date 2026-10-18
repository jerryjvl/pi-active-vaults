// The package's Git hooks in a vault: the pre-push guard, and the refs hook
// that tells the daemon of ref changes. `vault init`, `vault add` and
// `vault doctor --fix` install them through this one place.
//
// Invariants: a hook of the user's own is never replaced — it is reported, and
// the package's hook is not installed beside it; a hook of the package's is
// kept current (it names paths that may have moved); a `core.hooksPath` that
// bypasses the hooks is reported, not worked around. The hooks only speed
// things up and guard against accidents (security.md): every safeguard is
// checked by the action itself.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, type PlatformKind } from '../config/index.ts';
import { configValue, gitDirectories } from '../git/index.ts';
import { MAIN_BRANCH } from '../integrity/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import type { OperationContext } from './context.ts';

export interface HookFinding {
  readonly level: 'ok' | 'warning';
  readonly message: string;
}

const PRE_PUSH_MARK = 'pi-active-vaults: pre-push guard';
const REFS_MARK = 'pi-active-vaults: refs hook';
const INSTALLED_BY = '(installed by vault init, vault add and vault doctor --fix)';

/** Refuses any push that would update `main` on a remote: changes reach main only through review. */
const PRE_PUSH_HOOK = `#!/bin/sh
# ${PRE_PUSH_MARK} ${INSTALLED_BY}
while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/heads/${MAIN_BRANCH}" ]; then
    echo "pi-active-vaults: pushing ${MAIN_BRANCH} is refused; changes reach ${MAIN_BRANCH} only through review." >&2
    exit 1
  fi
done
exit 0
`;

const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * Leaves word for the daemon that the vault's refs changed — a file named
 * after the vault in `<state>/refs` — once a ref transaction is committed, so
 * it looks at once rather than at its next minute. It reads what Git gives
 * it and never fails a transaction.
 */
function refsHook(refs: string, vault: string, os: PlatformKind): string {
  // Git for Windows runs hooks with its sh, which reads forward slashes.
  const word = `${os === 'win32' ? refs.replaceAll('\\', '/') : refs}/${vault}`;
  return `#!/bin/sh
# ${REFS_MARK} ${INSTALLED_BY}
cat >/dev/null
# true, not ":": a failed redirect of a special built-in would end the shell with a failure.
[ "$1" = committed ] && true > ${shellQuote(word)} 2>/dev/null
exit 0
`;
}

/** A package hook: installed with `install` where there is none, never in place of the user's own; what is to be said of it. */
function packageHook(hook: string, what: string, mark: string, text: string, install: boolean): HookFinding {
  const ours = existsSync(hook) && readFileSync(hook, 'utf8').includes(mark);
  if (ours) {
    if (install && readFileSync(hook, 'utf8') !== text) writeFileSync(hook, text, { mode: 0o755 });
    return { level: 'ok', message: `The ${what} is installed.` };
  }
  const name = hook.split(/[\\/]/).at(-1) ?? hook;
  if (existsSync(hook)) return { level: 'warning', message: `A ${name} hook of its own is in place at ${hook}; the package's ${what} is not installed.` };
  if (!install) return { level: 'warning', message: `The ${what} is not installed; "vault doctor --fix" installs it.` };
  writeFileSync(hook, text, { mode: 0o755 });
  return { level: 'ok', message: `The ${what} was installed.` };
}

/** The state of the vault's hooks, installing the package's where `install` says and none of the user's is in the way. */
export async function hookFindings(context: OperationContext, vault: RegisteredVault, install: boolean): Promise<HookFinding[]> {
  const { git, installation } = context;
  const findings: HookFinding[] = [];
  const hooksPath = await configValue(git, vault.path, 'core.hooksPath');
  if (hooksPath.ok && hooksPath.value !== undefined) {
    findings.push({ level: 'warning', message: `core.hooksPath (${hooksPath.value}) bypasses the package's hooks: changes are noticed up to a minute later and the pre-push guard is lost.` });
  }
  const dirs = await gitDirectories(git, vault.path);
  if (dirs.ok) {
    const hooks = join(dirs.value.common, 'hooks');
    findings.push(packageHook(join(hooks, 'pre-push'), 'pre-push guard', PRE_PUSH_MARK, PRE_PUSH_HOOK, install));
    if (install) ensurePrivateDir(installation.paths.refs);
    findings.push(packageHook(join(hooks, 'reference-transaction'), 'refs hook', REFS_MARK, refsHook(installation.paths.refs, vault.id, installation.host.os), install));
  }
  return findings;
}
