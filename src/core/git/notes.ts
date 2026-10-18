// Git notes: data attached to a commit under a notes ref, which travels with the
// repository (attestations live here). Note content is normalised by Git
// (surrounding blank lines trimmed), and a note's text is passed on standard
// input so nothing in it can be read as an option.
//
// A concurrent writer can replace the notes ref between Git's read and write,
// losing the other's note: `appendNoteLine` reads the note back and tries
// once more before saying the line is not there. For attestations a lost line
// fails closed (a missing attestation is an unmet requirement).

import { err, ok, type Result } from '../result/index.ts';
import { failure, runChecked, runGit, type Git, type GitError } from './exec.ts';
import type { Sha } from './refs.ts';
import { checkNotesRef, checkSha } from './validate.ts';
import { attributionEnv, type Attribution } from './write.ts';

/** Who the notes commit is made as, and when. */
export type NoteWriteOptions = Attribution;

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

/** A notes command that changes the ref: validated, attributed, with its text on standard input. */
async function changeNote(
  git: Git, repo: string, ref: string, object: Sha, verb: string[], options: NoteWriteOptions, content?: string,
): Promise<Result<void, GitError>> {
  const checkedRef = checkNotesRef(ref);
  if (!checkedRef.ok) return checkedRef;
  const checkedObject = checkSha(object);
  if (!checkedObject.ok) return checkedObject;
  const env = attributionEnv(options);
  if (!env.ok) return env;
  const args = notesArgs(ref, ...verb, ...(content === undefined ? [] : ['-F', '-']), object);
  const ran = await runChecked(git, args, { cwd: repo, ...(content === undefined ? {} : { input: content }), env: env.value });
  return ran.ok ? ok(undefined) : ran;
}

/** Sets the note, replacing any existing one. */
export function notesAdd(git: Git, repo: string, ref: string, object: Sha, content: string, options: NoteWriteOptions): Promise<Result<void, GitError>> {
  return changeNote(git, repo, ref, object, ['add', '-f'], options, content);
}

/** Adds to the existing note, separated by a blank line. */
export function notesAppend(git: Git, repo: string, ref: string, object: Sha, content: string, options: NoteWriteOptions): Promise<Result<void, GitError>> {
  return changeNote(git, repo, ref, object, ['append'], options, content);
}

/**
 * Appends one line to the note and reads the note back, once more if the line
 * is missing (a concurrent writer replaced the ref); false when it is still
 * missing. The line must be a single line, since notes merge line by line.
 */
export async function appendNoteLine(
  git: Git, repo: string, ref: string, object: Sha, line: string, options: NoteWriteOptions,
): Promise<Result<boolean, GitError>> {
  if (/[\r\n]/.test(line) || line.trim() === '') return err({ reason: 'invalid-argument', argument: 'note line' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const appended = await notesAppend(git, repo, ref, object, line, options);
    if (!appended.ok) return appended;
    const reread = await notesShow(git, repo, ref, object);
    if (!reread.ok) return reread;
    if ((reread.value ?? '').split('\n').includes(line)) return ok(true);
  }
  return ok(false);
}

export function notesRemove(git: Git, repo: string, ref: string, object: Sha, options: NoteWriteOptions): Promise<Result<void, GitError>> {
  return changeNote(git, repo, ref, object, ['remove', '--ignore-missing'], options);
}

/** Every object that has a note under `ref`. */
export async function notesList(git: Git, repo: string, ref: string): Promise<Result<{ object: Sha; note: Sha }[], GitError>> {
  const checkedRef = checkNotesRef(ref);
  if (!checkedRef.ok) return checkedRef;
  const ran = await runChecked(git, notesArgs(ref, 'list'), { cwd: repo });
  if (!ran.ok) return ran;
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

/**
 * Merges the notes under `other` into `ref`, concatenating each object's notes
 * from both sides line by line, sorted and without duplicates (Git's
 * `cat_sort_uniq`): nothing either side recorded is lost, whatever the order
 * in which machines wrote or met.
 */
export async function notesMergeLines(git: Git, repo: string, ref: string, other: string, options: NoteWriteOptions): Promise<Result<void, GitError>> {
  for (const name of [ref, other]) {
    const checked = checkNotesRef(name);
    if (!checked.ok) return checked;
  }
  const env = attributionEnv(options);
  if (!env.ok) return env;
  const ran = await runChecked(git, notesArgs(ref, 'merge', '--quiet', '--strategy=cat_sort_uniq', other), { cwd: repo, env: env.value });
  return ran.ok ? ok(undefined) : ran;
}
