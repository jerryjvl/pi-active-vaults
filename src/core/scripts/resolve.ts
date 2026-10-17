// Resolving scripts and checks by name (concepts.md "Script").
//
// Vault scripts are the files directly in `.vault/scripts/` (checks: in
// `.vault/checks/`) of the accepted `main` — resolution takes an
// `AcceptedMain`, so no branch, working tree or unaccepted commit can supply a
// script. Files in subdirectories and hidden files are support files. A
// script's version is its blob SHA, which is what a check's attestation names.
//
// Built-ins ship with the package and are passed in (the operations layer
// assembles them); they are named `builtin:<name>`. A vault script named like a
// built-in is an error rather than an override, and so is anything that would
// make a name mean more than one thing or run something other than a file the
// owner accepted: two files of one name, a symbolic link, an invalid header.

import { PACKAGE_DIRECTORY } from '../documents/index.ts';
import { TREE_MODES, listTree, readTextAt, type Git, type GitError, type Sha, type TreeEntry } from '../git/index.ts';
import type { AcceptedMain } from '../integrity/index.ts';
import { err, ok, type Issue, type Result } from '../result/index.ts';
import { parseScriptHeader, scriptNameOf, type ScriptHeader } from './header.ts';

export type ScriptKind = 'script' | 'check';

export const SCRIPT_DIRECTORIES: Readonly<Record<ScriptKind, string>> = {
  script: `${PACKAGE_DIRECTORY}/scripts`,
  check: `${PACKAGE_DIRECTORY}/checks`,
};

export const BUILTIN_PREFIX = 'builtin:';

export interface ScriptOutput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A script shipped with the package, run in-process. */
export interface BuiltinScript {
  readonly name: string;
  readonly header: Omit<ScriptHeader, 'name' | 'interpreter'>;
  run(
    args: readonly string[],
    context: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly input?: string },
  ): Promise<ScriptOutput>;
}

export interface VaultScript {
  readonly kind: ScriptKind;
  readonly name: string;
  /** Its path in the vault. */
  readonly path: string;
  /** Its blob SHA on the accepted main. */
  readonly version: Sha;
  readonly header: ScriptHeader;
}

export interface InvalidScript {
  readonly kind: ScriptKind;
  readonly name: string;
  readonly issues: readonly Issue[];
}

export type ResolvedScript =
  | { readonly source: 'builtin'; readonly name: string; readonly builtin: BuiltinScript }
  | ({ readonly source: 'vault' } & VaultScript);

export type ScriptError =
  | GitError
  | { readonly reason: 'no-such-script'; readonly name: string }
  | { readonly reason: 'invalid-script'; readonly name: string; readonly issues: readonly Issue[] }
  | { readonly reason: 'shadows-builtin'; readonly name: string }
  | { readonly reason: 'ambiguous-script'; readonly name: string; readonly paths: readonly string[] };

export interface ResolveOptions {
  readonly kind: ScriptKind;
  readonly builtins: readonly BuiltinScript[];
}

/** The top-level, non-hidden files of the kind's directory, grouped by script name, names sorted. */
async function candidates(git: Git, repo: string, accepted: AcceptedMain, kind: ScriptKind): Promise<Result<Map<string, TreeEntry[]>, GitError>> {
  const directory = SCRIPT_DIRECTORIES[kind];
  const entries = await listTree(git, repo, accepted.sha, directory);
  if (!entries.ok) return entries;
  const byName = new Map<string, TreeEntry[]>();
  for (const entry of entries.value) {
    const file = entry.path.slice(directory.length + 1);
    if (file.includes('/') || file.startsWith('.')) continue;
    const name = scriptNameOf(file);
    byName.set(name, [...(byName.get(name) ?? []), entry]);
  }
  return ok(new Map([...byName].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** One name's files, judged: a usable script, or why not. */
async function classify(
  git: Git, repo: string, accepted: AcceptedMain, name: string, files: readonly TreeEntry[], options: ResolveOptions,
): Promise<Result<VaultScript, ScriptError>> {
  const [entry, ...others] = files;
  if (entry === undefined) return err({ reason: 'no-such-script', name });
  if (options.kind === 'script' && options.builtins.some((b) => b.name === name)) return err({ reason: 'shadows-builtin', name });
  if (others.length > 0) return err({ reason: 'ambiguous-script', name, paths: files.map((f) => f.path) });
  if (entry.mode === TREE_MODES.symlink) {
    return err({ reason: 'invalid-script', name, issues: [{ path: entry.path, message: 'is a symbolic link, not a script' }] });
  }
  const text = await readTextAt(git, repo, accepted.sha, entry.path);
  if (!text.ok) return text;
  const header = parseScriptHeader(text.value ?? '', entry.path);
  if (!header.ok) return err({ reason: 'invalid-script', name, issues: header.error });
  return ok({ kind: options.kind, name, path: entry.path, version: entry.sha, header: header.value });
}

/** Why files present in the directory do not make a usable script. */
type ScriptProblem = Extract<ScriptError, { reason: 'invalid-script' | 'shadows-builtin' | 'ambiguous-script' }>;

function isProblem(error: ScriptError): error is ScriptProblem {
  return error.reason === 'invalid-script' || error.reason === 'shadows-builtin' || error.reason === 'ambiguous-script';
}

function problemIssues(problem: ScriptProblem): readonly Issue[] {
  switch (problem.reason) {
    case 'invalid-script':
      return problem.issues;
    case 'shadows-builtin':
      return [{ path: problem.name, message: `shadows the built-in ${BUILTIN_PREFIX}${problem.name}` }];
    case 'ambiguous-script':
      return [{ path: problem.name, message: `is defined by more than one file: ${problem.paths.join(', ')}` }];
  }
}

/** Every script (or check) on the accepted main, and every file that is not a usable one. */
export async function listScripts(
  git: Git, repo: string, accepted: AcceptedMain, options: ResolveOptions,
): Promise<Result<{ scripts: VaultScript[]; invalid: InvalidScript[] }, GitError>> {
  const byName = await candidates(git, repo, accepted, options.kind);
  if (!byName.ok) return byName;
  const scripts: VaultScript[] = [];
  const invalid: InvalidScript[] = [];
  for (const [name, files] of byName.value) {
    const classified = await classify(git, repo, accepted, name, files, options);
    if (classified.ok) scripts.push(classified.value);
    else if (isProblem(classified.error)) invalid.push({ kind: options.kind, name, issues: problemIssues(classified.error) });
    else return err(classified.error as GitError); // a file listed a moment ago could not be read
  }
  return ok({ scripts, invalid });
}

/** The script (or check) `name` refers to: a built-in, or a file on the accepted main. */
export async function resolveScript(
  git: Git, repo: string, accepted: AcceptedMain, name: string, options: ResolveOptions,
): Promise<Result<ResolvedScript, ScriptError>> {
  if (name.startsWith(BUILTIN_PREFIX)) {
    const builtin = options.kind === 'script' ? options.builtins.find((b) => `${BUILTIN_PREFIX}${b.name}` === name) : undefined;
    return builtin === undefined ? err({ reason: 'no-such-script', name }) : ok({ source: 'builtin', name, builtin });
  }
  const byName = await candidates(git, repo, accepted, options.kind);
  if (!byName.ok) return byName;
  const classified = await classify(git, repo, accepted, name, byName.value.get(name) ?? [], options);
  return classified.ok ? ok({ source: 'vault', ...classified.value }) : classified;
}
