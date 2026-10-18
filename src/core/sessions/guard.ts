// The write guard (extension.md "Write guard"): blocks file writes outside the
// session's actor worktree, and shell commands that would move `main` or
// push, with an explanation the model can act on.
//
// It is a safety net for an agent's mistakes, not a security boundary
// (security.md): it sees the calls of Pi's file and shell tools, judges a
// write by where it really lands (through links on the way), and reads shell
// commands as words — it follows `cd` and `git -C`, and looks inside `$(…)`
// and backquotes, but runs nothing and cannot know what a script it starts
// will do. What it misses, the accepted `main` and merge policy still catch.
//
// Invariants:
//  - in a vault, a session writes only in its own actor's worktree, never in
//    the worktree's Git internals, and only while it holds that actor;
//  - outside the vaults, an interactive session writes as Pi normally would,
//    but a headless run writes only in its worktree;
//  - control changes (contracts, `.vault/`, conditions, budgets) are allowed in
//    the worktree: an owner sees them at merge;
//  - pushing is always blocked — the package pushes proposals (`vault
//    propose`) — and so is anything that would move `main`.

import { isAbsolute, join, resolve } from 'node:path';
import { isGitProgram } from '../git/index.ts';
import { MAIN_BRANCH } from '../integrity/index.ts';
import { locate, type OperationContext } from '../operations/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import { holdActor, holdRefusalText, type VaultSession } from './session.ts';

/** A tool call as the guard sees it: a file it writes (absolute), or a shell command and where it runs. */
export type GuardedCall =
  | { readonly kind: 'write'; readonly path: string }
  | { readonly kind: 'shell'; readonly command: string; readonly cwd: string };

export type GuardVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

const ALLOWED: GuardVerdict = { allowed: true };
const blocked = (reason: string): GuardVerdict => ({ allowed: false, reason });

type Place =
  | { readonly kind: 'worktree'; readonly vault: RegisteredVault; readonly actor: string; readonly rest: string }
  | { readonly kind: 'checkout'; readonly vault: RegisteredVault; readonly rest: string }
  | { readonly kind: 'outside' };

/** Which vault directory a path really lands in: an actor's worktree, a checkout, or neither. */
function placeOf(vaults: readonly RegisteredVault[], path: string): Place {
  const here = locate(vaults, path);
  if (here === undefined) return { kind: 'outside' };
  return here.actor === undefined ? { kind: 'checkout', vault: here.vault, rest: here.path } : { kind: 'worktree', vault: here.vault, actor: here.actor, rest: here.path };
}

const isGitInternal = (rest: string): boolean => rest.split('/')[0]?.toLowerCase() === '.git';

async function guardWrite(context: OperationContext, session: VaultSession, path: string): Promise<GuardVerdict> {
  const place = placeOf(context.installation.vaults, path);
  const own = session.vault !== undefined && session.worktree !== undefined && place.kind !== 'outside'
    && place.vault.id === session.vault.id && place.kind === 'worktree' && place.actor === session.actor;
  if (own) {
    if (isGitInternal(place.rest)) return blocked(`${path} is in the worktree's Git internals; write documents, and commit with vault_commit.`);
    const held = await holdActor(context, session);
    return held.ok ? ALLOWED : blocked(holdRefusalText(session, held.error));
  }
  switch (place.kind) {
    case 'outside':
      return session.mode === 'interactive' ? ALLOWED
        : blocked(`A job writes only in its worktree (${session.worktree ?? 'none'}); ${path} is outside it.`);
    case 'checkout': {
      const instead = session.vault?.id === place.vault.id && session.worktree !== undefined && !isGitInternal(place.rest)
        ? ` Write to ${join(session.worktree, ...place.rest.split('/'))} instead, and commit with vault_commit.` : '';
      return blocked(`${path} is in vault "${place.vault.id}"'s checkout, which holds main; changes reach main only through review.${instead}${noActorIn(session, place.vault)}`);
    }
    case 'worktree':
      return blocked(`${path} is in ${place.actor}'s worktree of vault "${place.vault.id}"; this session writes ${session.worktree === undefined ? 'in no worktree' : `only in ${session.worktree}`}.${noActorIn(session, place.vault)}`);
  }
}

function noActorIn(session: VaultSession, vault: RegisteredVault): string {
  return session.vault?.id === vault.id && session.worktree !== undefined ? '' : ` This session has no actor in vault "${vault.id}".`;
}

// ---- Shell commands ----

interface Segment {
  readonly words: readonly string[];
}

/**
 * The simple commands of a command line, as words: quotes group and are
 * removed, a backslash escapes, and `;`, `&`, `|` and newlines separate
 * commands. The text of `$(…)` and backquotes is read as command lines too.
 */
function segments(line: string): Segment[] {
  const found: Segment[] = [];
  let words: string[] = [];
  let word: string | undefined;
  let quote: '"' | "'" | undefined;
  const endWord = (): void => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) found.push({ words });
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
      continue;
    }
    if ((c === '$' && line[i + 1] === '(') || c === '`') {
      // A command substitution runs a command line of its own.
      const close = c === '`' ? line.indexOf('`', i + 1) : matchingParen(line, i + 1);
      const end = close === -1 ? line.length : close;
      found.push(...segments(line.slice(i + (c === '`' ? 1 : 2), end)));
      word = (word ?? '') + line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === '\\' && i + 1 < line.length) word += line[++i] as string;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (c === '\\' && i + 1 < line.length) {
      word = (word ?? '') + (line[++i] as string);
    } else if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') {
      endSegment();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word ?? '') + c;
    }
  }
  endSegment();
  return found;
}

function matchingParen(line: string, open: number): number {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Git's options that come before the subcommand and take a value as the next word. */
const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix'];
/** Subcommands that move the checked-out branch — `main`, in a vault's checkout. */
const MOVES_CHECKED_OUT = ['commit', 'merge', 'reset', 'rebase', 'cherry-pick', 'revert', 'pull', 'am', 'checkout', 'switch'];
const MAIN_NAMES = [MAIN_BRANCH, `refs/heads/${MAIN_BRANCH}`];

const names = (word: string, wanted: readonly string[]): boolean => wanted.includes(word);
/** A refspec whose destination is main (`x:main`, `+x:refs/heads/main`). */
const intoMain = (word: string): boolean => word.includes(':') && names(word.slice(word.lastIndexOf(':') + 1), MAIN_NAMES);

/** Why a Git command would push or move main, or undefined. */
function gitMovesMain(args: readonly string[], cwd: string, vaults: readonly RegisteredVault[]): string | undefined {
  let dir = cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith('-')) break;
    if (arg === '-C') dir = resolve(dir, args[++i] ?? '');
    else if (GIT_VALUE_OPTIONS.includes(arg)) i++;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return undefined;
  if (sub === 'push') return 'Pushing is not for sessions: the package pushes proposals (vault propose), and never main.';
  if (sub === 'update-ref' && rest.some((w) => names(w, MAIN_NAMES))) return 'That would move main directly.';
  if (sub === 'branch' && rest.some((w) => names(w, MAIN_NAMES)) && rest.some((w) => /^-([fmMdDcC]|-force|-move|-delete|-copy)/.test(w))) return 'That would move, rename or delete main.';
  if ((sub === 'checkout' || sub === 'switch') && rest.some((w) => /^-[BC]$|^--force-create$/.test(w)) && rest.some((w) => names(w, MAIN_NAMES))) return 'That would reset main.';
  if ((sub === 'fetch' || sub === 'pull') && rest.some(intoMain)) return 'That would update main from elsewhere.';
  if (MOVES_CHECKED_OUT.includes(sub)) {
    const place = placeOf(vaults, dir);
    if (place.kind === 'checkout') return `In vault "${place.vault.id}"'s checkout, git ${sub} would move main; work in your worktree and commit with vault_commit.`;
  }
  return undefined;
}

const CHANGES_DIRECTORY = ['cd', 'pushd', 'set-location', 'sl', 'chdir'];

function guardShell(context: OperationContext, command: string, cwd: string): GuardVerdict {
  let dir = cwd;
  for (const { words } of segments(command)) {
    const [program = '', ...args] = words;
    if (CHANGES_DIRECTORY.includes(program.toLowerCase())) {
      const target = args.find((a) => !a.startsWith('-'));
      if (target !== undefined) dir = isAbsolute(target) ? target : resolve(dir, target);
      continue;
    }
    if (!isGitProgram(program)) continue;
    const why = gitMovesMain(args, dir, context.installation.vaults);
    if (why !== undefined) return blocked(`Blocked: ${words.join(' ')} — ${why}`);
  }
  return ALLOWED;
}

/** Whether the session may make this call. */
export async function guardToolCall(context: OperationContext, session: VaultSession, call: GuardedCall): Promise<GuardVerdict> {
  return call.kind === 'write' ? guardWrite(context, session, call.path) : guardShell(context, call.command, call.cwd);
}
