// Reading history, diffs and file content at a given revision. Nothing here
// looks at the working tree: content that instructs or executes is read from a
// commit (the accepted `main`), so uncommitted or unaccepted edits cannot
// influence it.

import { err, ok, type Result } from '../result/index.ts';
import { failure, runForText, runGit, type Git, type GitError } from './exec.ts';
import { resolveRevision, type Sha } from './refs.ts';
import { checkTreePath } from './validate.ts';

export interface Trailer {
  readonly key: string;
  readonly value: string;
}

export interface CommitInfo {
  readonly sha: Sha;
  readonly parents: readonly Sha[];
  readonly author: { readonly name: string; readonly email: string };
  readonly date: Date;
  readonly subject: string;
  readonly message: string;
  readonly trailers: readonly Trailer[];
}

export interface FileChange {
  readonly change: 'created' | 'modified' | 'deleted' | 'renamed';
  readonly path: string;
  readonly oldPath?: string;
}

const FIELD_COUNT = 7;
// Fields are NUL-separated: a commit message can contain any text but never NUL.
const COMMIT_FORMAT = '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B%x00%(trailers:only,unfold)';

function parseTrailers(text: string): Trailer[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const colon = line.indexOf(':');
      return { key: line.slice(0, colon), value: line.slice(colon + 1).trim() };
    });
}

function parseCommits(output: string): CommitInfo[] {
  const fields = output.split('\0');
  const commits: CommitInfo[] = [];
  for (let i = 0; i + FIELD_COUNT <= fields.length; i += FIELD_COUNT) {
    const [sha = '', parents = '', name = '', email = '', date = '', body = '', trailers = ''] = fields.slice(i, i + FIELD_COUNT);
    const message = body.trimEnd();
    commits.push({
      sha,
      parents: parents === '' ? [] : parents.split(' '),
      author: { name, email },
      date: new Date(date),
      subject: message.split('\n', 1)[0] ?? '',
      message,
      trailers: parseTrailers(trailers),
    });
  }
  return commits;
}

/** Commits reachable from `to` but not from `from` (or all of `to`'s history when `from` is null), oldest first. */
export async function commitsBetween(git: Git, repo: string, from: string | null, to: string): Promise<Result<CommitInfo[], GitError>> {
  const range = await rangeEnds(git, repo, from, to);
  if (!range.ok) return range;
  const spec = range.value.from === null ? range.value.to : `${range.value.from}..${range.value.to}`;
  const args = ['log', '--reverse', '--topo-order', '-z', '--no-show-signature', '--encoding=UTF-8', COMMIT_FORMAT, spec, '--'];
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  return ran.value.exitCode === 0 ? ok(parseCommits(ran.value.stdout.toString('utf8'))) : err(failure(args, ran.value));
}

async function rangeEnds(git: Git, repo: string, from: string | null, to: string): Promise<Result<{ from: Sha | null; to: Sha }, GitError>> {
  const toSha = await resolveRevision(git, repo, to);
  if (!toSha.ok) return toSha;
  if (from === null) return ok({ from: null, to: toSha.value });
  const fromSha = await resolveRevision(git, repo, from);
  return fromSha.ok ? ok({ from: fromSha.value, to: toSha.value }) : fromSha;
}

/** The empty tree of this repository's hash algorithm — the "before" of a first commit. */
async function emptyTree(git: Git, repo: string): Promise<Result<string, GitError>> {
  return runForText(git, ['hash-object', '-t', 'tree', '--stdin'], { cwd: repo, input: '' });
}

async function diffEnds(git: Git, repo: string, from: string | null, to: string): Promise<Result<{ from: string; to: Sha }, GitError>> {
  const toSha = await resolveRevision(git, repo, to);
  if (!toSha.ok) return toSha;
  const fromRef = from === null ? await emptyTree(git, repo) : await resolveRevision(git, repo, from);
  return fromRef.ok ? ok({ from: fromRef.value, to: toSha.value }) : fromRef;
}

const STATUS: Readonly<Record<string, FileChange['change']>> = { A: 'created', M: 'modified', T: 'modified', D: 'deleted' };

/** Files that differ between two revisions, with renames detected. `from` null means "from nothing". */
export async function changedPaths(git: Git, repo: string, from: string | null, to: string): Promise<Result<FileChange[], GitError>> {
  const ends = await diffEnds(git, repo, from, to);
  if (!ends.ok) return ends;
  const args = ['diff-tree', '-r', '-z', '--name-status', '-M', '--no-commit-id', ends.value.from, ends.value.to];
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  if (ran.value.exitCode !== 0) return err(failure(args, ran.value));
  const tokens = ran.value.stdout.toString('utf8').split('\0');
  const changes: FileChange[] = [];
  for (let i = 0; i < tokens.length - 1; ) {
    const status = tokens[i++] ?? '';
    if (status.startsWith('R')) {
      const oldPath = tokens[i++] ?? '';
      changes.push({ change: 'renamed', path: tokens[i++] ?? '', oldPath });
    } else {
      changes.push({ change: STATUS[status[0] ?? ''] ?? 'modified', path: tokens[i++] ?? '' });
    }
  }
  return ok(changes);
}

/**
 * The patch between two revisions, for people to review. External diff
 * programs and text conversion filters from configuration or attributes are
 * switched off: reviewing a change must not run anything.
 */
export async function diffText(git: Git, repo: string, from: string | null, to: string): Promise<Result<string, GitError>> {
  const ends = await diffEnds(git, repo, from, to);
  if (!ends.ok) return ends;
  const args = [
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--src-prefix=a/', '--dst-prefix=b/',
    ends.value.from, ends.value.to, '--',
  ];
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  return ran.value.exitCode === 0 ? ok(ran.value.stdout.toString('utf8')) : err(failure(args, ran.value));
}

/** Every file in the revision's tree, as slash-separated paths. */
export async function listFiles(git: Git, repo: string, revision: string): Promise<Result<string[], GitError>> {
  const sha = await resolveRevision(git, repo, revision);
  if (!sha.ok) return sha;
  const args = ['ls-tree', '-r', '-z', '--name-only', sha.value];
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  if (ran.value.exitCode !== 0) return err(failure(args, ran.value));
  return ok(ran.value.stdout.toString('utf8').split('\0').filter((p) => p !== ''));
}

/** A file's bytes as committed in `revision`. */
export async function readFileAt(git: Git, repo: string, revision: string, path: string): Promise<Result<Buffer, GitError>> {
  const checked = checkTreePath(path);
  if (!checked.ok) return checked;
  const sha = await resolveRevision(git, repo, revision);
  if (!sha.ok) return sha;
  const args = ['cat-file', 'blob', `${sha.value}:${path}`];
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  if (ran.value.exitCode === 0) return ok(ran.value.stdout);
  return err(/Not a valid object name|bad file|does not exist in/i.test(ran.value.stderr) ? { reason: 'not-found', path } : failure(args, ran.value));
}
