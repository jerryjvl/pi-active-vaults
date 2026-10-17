// Git notes: data attached to a commit under a notes ref, which travels with the
// repository (attestations live here). Note content is normalised by Git
// (surrounding blank lines trimmed), and a note's text is passed on standard
// input so nothing in it can be read as an option.

import { err, ok, type Result } from '../result/index.ts';
import { failure, runForSuccess, runGit, type Git, type GitError } from './exec.ts';
import type { Sha } from './refs.ts';
import { attributionEnv, type Identity } from './write.ts';
import { checkNotesRef, checkSha } from './validate.ts';

export interface NoteWriteOptions {
  /** Who the notes commit is made as. */
  readonly identity?: Identity;
  readonly date?: Date;
}

function notesArgs(ref: string, ...rest: string[]): string[] {
  return ['notes', `--ref=${ref}`, ...rest];
}

export async function notesShow(git: Git, repo: string, ref: string, object: Sha): Promise<Result<string | undefined, GitError>> {
  const checkedRef = checkNotesRef(ref);
  if (!checkedRef.ok) return checkedRef;
  const checkedObject = checkSha(object);
  if (!checkedObject.ok) return checkedObject;
  const args = notesArgs(ref, 'show', object);
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  if (ran.value.exitCode === 0) return ok(ran.value.stdout.toString('utf8').replace(/\n$/, ''));
  return /no note found/i.test(ran.value.stderr) ? ok(undefined) : err(failure(args, ran.value));
}

async function writeNote(
  git: Git, repo: string, ref: string, object: Sha, verb: string[], content: string, options: NoteWriteOptions,
): Promise<Result<void, GitError>> {
  const checkedRef = checkNotesRef(ref);
  if (!checkedRef.ok) return checkedRef;
  const checkedObject = checkSha(object);
  if (!checkedObject.ok) return checkedObject;
  const env = attributionEnv(options);
  if (!env.ok) return env;
  const args = notesArgs(ref, ...verb, '-F', '-', object);
  const ran = await runGit(git, args, { cwd: repo, input: content, env: env.value });
  if (!ran.ok) return ran;
  return ran.value.exitCode === 0 ? ok(undefined) : err(failure(args, ran.value));
}

/** Sets the note, replacing any existing one. */
export function notesAdd(git: Git, repo: string, ref: string, object: Sha, content: string, options: NoteWriteOptions): Promise<Result<void, GitError>> {
  return writeNote(git, repo, ref, object, ['add', '-f'], content, options);
}

/** Adds to the existing note, separated by a blank line. */
export function notesAppend(git: Git, repo: string, ref: string, object: Sha, content: string, options: NoteWriteOptions): Promise<Result<void, GitError>> {
  return writeNote(git, repo, ref, object, ['append'], content, options);
}

export async function notesRemove(git: Git, repo: string, ref: string, object: Sha, options: NoteWriteOptions): Promise<Result<void, GitError>> {
  const checkedRef = checkNotesRef(ref);
  if (!checkedRef.ok) return checkedRef;
  const checkedObject = checkSha(object);
  if (!checkedObject.ok) return checkedObject;
  const env = attributionEnv(options);
  if (!env.ok) return env;
  const args = notesArgs(ref, 'remove', '--ignore-missing', object);
  const ran = await runGit(git, args, { cwd: repo, env: env.value });
  if (!ran.ok) return ran;
  return ran.value.exitCode === 0 ? ok(undefined) : err(failure(args, ran.value));
}

/** Every object that has a note under `ref`. */
export async function notesList(git: Git, repo: string, ref: string): Promise<Result<{ object: Sha; note: Sha }[], GitError>> {
  const checkedRef = checkNotesRef(ref);
  if (!checkedRef.ok) return checkedRef;
  const args = notesArgs(ref, 'list');
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  if (ran.value.exitCode !== 0) return err(failure(args, ran.value));
  return ok(
    ran.value.stdout
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [note = '', object = ''] = line.split(' ');
        return { object, note };
      }),
  );
}
