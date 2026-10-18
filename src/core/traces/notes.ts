// A run's compact records as Git notes (concepts.md "Trace"): each commit a
// run makes carries the record as of that commit — naming every document the
// run has produced so far, found from its commits since the accepted main by
// their `Vault-Trace` — as a note on `refs/notes/vault/traces`. The trailer is
// the link: a run's records are found by finding its commits. The notes
// travel and merge like attestations.
//
// Invariants: a record is checked in full before it is written and must be
// the commit's own run's; a note is read in full or reported unreadable, never
// in part. Nothing is in the tree, so a record is never a control change and
// never a commit of its own: a run that commits nothing leaves no record —
// its full log and its spawn's state say how it ended.

import { TRAILER, trailerValue } from '../actors/index.ts';
import { inPackageDirectory, isDocumentPath } from '../documents/index.ts';
import {
  appendNoteLine, changedPaths, commitsBetween, commitsWithTrailer, listFiles, notesShow,
  type Attribution, type Git, type GitError, type Sha,
} from '../git/index.ts';
import { err, ok, type Issue, type Result } from '../result/index.ts';
import { checkCompactTrace, parseCompactTrace, renderCompactTrace, type CompactTrace } from './compact.ts';

/** Where the compact records live: notes on the runs' commits. */
export const TRACES_REF = 'refs/notes/vault/traces';

/** Everything a compact record says but the documents, which come from the commits. */
export type RunRecord = Omit<CompactTrace, 'documents'>;

export type RunRecordError =
  | GitError
  | { readonly reason: 'invalid-trace'; readonly issues: readonly Issue[] }
  /** The commit is not one of the record's run's commits. */
  | { readonly reason: 'not-the-run'; readonly commit: Sha }
  | { readonly reason: 'not-recorded'; readonly subject: Sha };

export interface RecordRunOptions {
  /** The accepted main the run's commits are counted from. */
  readonly since: Sha;
  /** The run's commit just made. */
  readonly commit: Sha;
  readonly record: RunRecord;
  /** Who the notes commit is made as. */
  readonly attribution: Attribution;
}

/** The document paths the run's commits in `since..commit` touched that still exist at `commit`, sorted. */
async function producedDocuments(git: Git, repo: string, run: readonly { sha: Sha; parents: readonly Sha[] }[], commit: Sha): Promise<Result<string[], GitError>> {
  const touched = new Set<string>();
  for (const c of run) {
    const changes = await changedPaths(git, repo, c.parents[0] ?? null, c.sha);
    if (!changes.ok) return changes;
    for (const change of changes.value) touched.add(change.path);
  }
  const present = await listFiles(git, repo, commit);
  if (!present.ok) return present;
  const files = new Set(present.value);
  return ok([...touched].filter((p) => isDocumentPath(p) && !inPackageDirectory(p) && files.has(p)).sort());
}

/** Attaches the run's record as of `commit` to it; returns the record written. */
export async function recordRun(git: Git, repo: string, options: RecordRunOptions): Promise<Result<CompactTrace, RunRecordError>> {
  const { since, commit, record } = options;
  const commits = await commitsBetween(git, repo, since, commit);
  if (!commits.ok) return commits;
  const run = commits.value.filter((c) => trailerValue(c, TRAILER.trace) === record.trace);
  if (run.at(-1)?.sha !== commit) return err({ reason: 'not-the-run', commit });
  const documents = await producedDocuments(git, repo, run, commit);
  if (!documents.ok) return documents;
  const checked = checkCompactTrace({ ...record, documents: documents.value });
  if (!checked.ok) return err({ reason: 'invalid-trace', issues: checked.error });
  const appended = await appendNoteLine(git, repo, TRACES_REF, commit, renderCompactTrace(checked.value), options.attribution);
  if (!appended.ok) return appended;
  return appended.value ? ok(checked.value) : err({ reason: 'not-recorded', subject: commit });
}

/** A run's commit and the records its note holds, or the 1-based lines of the note that cannot be read. */
export type RunCommit =
  | { readonly commit: Sha; readonly records: readonly CompactTrace[] }
  | { readonly commit: Sha; readonly unreadable: readonly number[] };

/** The note's records, each of `trace`'s run; any other line makes the note unreadable. */
async function noteRecords(git: Git, repo: string, commit: Sha, trace: string): Promise<Result<RunCommit, GitError>> {
  const note = await notesShow(git, repo, TRACES_REF, commit);
  if (!note.ok) return note;
  const records: CompactTrace[] = [];
  const unreadable: number[] = [];
  (note.value ?? '').split('\n').filter((line) => line.trim() !== '').forEach((line, i) => {
    const parsed = parseCompactTrace(line);
    if (parsed.ok && parsed.value.trace === trace) records.push(parsed.value);
    else unreadable.push(i + 1);
  });
  return ok(unreadable.length > 0 ? { commit, unreadable } : { commit, records });
}

/** The commits of `trace`'s run reachable from `revisions`, newest first, with their records. */
export async function runCommits(git: Git, repo: string, revisions: readonly string[], trace: string): Promise<Result<RunCommit[], GitError>> {
  const commits = await commitsWithTrailer(git, repo, revisions, TRAILER.trace, trace);
  if (!commits.ok) return commits;
  const found: RunCommit[] = [];
  for (const commit of commits.value) {
    const read = await noteRecords(git, repo, commit.sha, trace);
    if (!read.ok) return read;
    found.push(read.value);
  }
  return ok(found);
}
