// Templates (concepts.md "Templates"): a vault repository whose root contract
// carries a `template` marker — the sign that it is meant, and compatible, as
// a starting point.
//
// Invariants:
//  - a template is read from one commit, fetched without history into a
//    private scratch repository that is always removed, over a transport
//    with integrity (see `git/remote.ts`): what is fetched becomes the new
//    vault's scripts and contracts, accepted from its first commit;
//  - the marker and the template's vault identity are checked before anything
//    is created; a template holding a symbolic link is refused, since a link
//    could point anywhere on the machine;
//  - creating writes only into a new or empty directory, gives the vault
//    fresh history — one commit, so nothing of the template's history comes
//    along — sets its id, and replaces the marker with `vault.from-template`
//    (source URL and commit); the rest of every file is as the template wrote
//    it. That commit is recorded as the accepted main (`how: init`). If any
//    step fails, a directory it made is removed again.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Clock } from '../clock/index.ts';
import { VAULT_ID } from '../config/index.ts';
import { ROOT_CONTRACT } from '../contracts/index.ts';
import { describeDocumentError, readDocumentAt, updateFrontmatter, type FrontmatterValue } from '../documents/index.ts';
import {
  TREE_MODES, checkRemote, createCommit, fetchCommit, initRepository, listTree, readFileAt, stageExecutable,
  type Attribution, type Git, type GitError, type Sha, type TreeEntry,
} from '../git/index.ts';
import { recordAccepted, type AcceptedMain } from '../integrity/index.ts';
import { parseVaultIdentity, type VaultIdentity } from '../registry/index.ts';
import { DataReader, err, ok, type Issue, type Result } from '../result/index.ts';
import type { Store } from '../store/index.ts';

export interface TemplateSource {
  /** A URL, or the URL a short name stands for. */
  readonly url: string;
  /** A branch, tag or commit; the remote's HEAD when absent. */
  readonly ref?: string;
}

export interface TemplateMarker {
  readonly name: string;
  readonly version: number;
  readonly summary: string;
}

export interface TemplateSummary extends TemplateSource {
  readonly commit: Sha;
  readonly template: TemplateMarker;
  readonly vault: { readonly purpose: string; readonly owners: readonly string[]; readonly actors: readonly string[] };
  /** How many files a vault made from it starts with. */
  readonly files: number;
}

export type TemplateError =
  | GitError
  | { readonly reason: 'unknown-template'; readonly name: string }
  | { readonly reason: 'not-a-template' }
  | { readonly reason: 'invalid-template'; readonly issues: readonly Issue[] }
  | { readonly reason: 'unsupported-entry'; readonly path: string }
  | { readonly reason: 'not-empty'; readonly path: string }
  | { readonly reason: 'accepted-moved'; readonly current: Sha | null };

const TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/**
 * `<name|url>[@ref]`: a short name from the installation's `templates`, or a
 * URL. The ref is what follows the last `@` after the URL's last `/` or `:`,
 * so `git@host:path` keeps its user.
 */
export function resolveTemplateSpec(spec: string, named: Readonly<Record<string, string>>): Result<TemplateSource, TemplateError> {
  const at = spec.lastIndexOf('@');
  const hasRef = at > Math.max(spec.lastIndexOf('/'), spec.lastIndexOf(':'));
  const base = hasRef ? spec.slice(0, at) : spec;
  const ref = hasRef ? spec.slice(at + 1) : undefined;
  if (ref !== undefined && !REF.test(ref)) return err({ reason: 'invalid-argument', argument: 'ref' });
  const url = Object.hasOwn(named, base) ? named[base] : undefined;
  if (url === undefined && TEMPLATE_NAME.test(base)) return err({ reason: 'unknown-template', name: base });
  const checked = checkRemote(url ?? base);
  if (!checked.ok) return checked;
  return ok({ url: checked.value, ...(ref === undefined ? {} : { ref }) });
}

interface FetchedTemplate {
  readonly commit: Sha;
  readonly marker: TemplateMarker;
  readonly identity: VaultIdentity;
  /** The root contract's `vault` value as written, to carry over. */
  readonly vault: Readonly<Record<string, unknown>>;
  readonly contract: string;
  readonly entries: readonly TreeEntry[];
}

function readMarker(value: unknown): Result<TemplateMarker, Issue[]> {
  const r = new DataReader();
  const t = r.record(value, 'template', ['name', 'version', 'summary']);
  const marker = { name: r.string(t['name'], 'template.name', TEMPLATE_NAME), version: r.integer(t, 'version', 'template') ?? 0, summary: '' };
  if (t['version'] === undefined) r.add('template.version', 'must be a positive whole number');
  return r.result({ ...marker, summary: r.string(t['summary'], 'template.summary') });
}

/** Fetches the template's commit into `scratch` and reads its marker, identity and files. */
async function fetchTemplate(git: Git, scratch: string, source: TemplateSource): Promise<Result<FetchedTemplate, TemplateError>> {
  const created = await initRepository(git, scratch, {});
  if (!created.ok) return created;
  const commit = await fetchCommit(git, scratch, source.url, source.ref);
  if (!commit.ok) return commit;
  const root = await readDocumentAt(git, scratch, commit.value, ROOT_CONTRACT);
  if (!root.ok) return root;
  if (root.value.state === 'missing') return err({ reason: 'not-a-template' });
  if (root.value.state === 'unreadable') return err({ reason: 'invalid-template', issues: [{ path: ROOT_CONTRACT, message: describeDocumentError(root.value.error) }] });
  const { frontmatter } = root.value.document;
  if (frontmatter['template'] === undefined) return err({ reason: 'not-a-template' });
  const marker = readMarker(frontmatter['template']);
  const identity = parseVaultIdentity(frontmatter['vault']);
  const issues = [...(marker.ok ? [] : marker.error), ...(identity.ok ? [] : identity.error)];
  if (!marker.ok || !identity.ok) return err({ reason: 'invalid-template', issues });
  const entries = await listTree(git, scratch, commit.value);
  if (!entries.ok) return entries;
  const contract = await readFileAt(git, scratch, commit.value, ROOT_CONTRACT);
  if (!contract.ok) return contract;
  return ok({
    commit: commit.value, marker: marker.value, identity: identity.value,
    vault: frontmatter['vault'] as Record<string, unknown>, contract: contract.value.toString('utf8'), entries: entries.value,
  });
}

/** Runs `use` with a private scratch repository, removed afterwards whatever happens. */
async function withScratch<T>(use: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), 'pav-template-'));
  try {
    return await use(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function summaryOf(source: TemplateSource, fetched: FetchedTemplate): TemplateSummary {
  return {
    ...source,
    commit: fetched.commit,
    template: fetched.marker,
    vault: { purpose: fetched.identity.purpose.summary, owners: fetched.identity.owners, actors: fetched.identity.actors },
    files: fetched.entries.length,
  };
}

/** Whether `source` is a compatible template, and what it holds (`vault template show`). */
export function inspectTemplate(git: Git, source: TemplateSource): Promise<Result<TemplateSummary, TemplateError>> {
  return withScratch(async (scratch) => {
    const fetched = await fetchTemplate(git, scratch, source);
    return fetched.ok ? ok(summaryOf(source, fetched.value)) : fetched;
  });
}

export interface CreateFromTemplate {
  readonly source: TemplateSource;
  /** A new or empty directory. */
  readonly path: string;
  readonly id: string;
  /** The person creating it: who the accepted main is recorded as accepted by. */
  readonly by: string;
}

export interface CreatedVault {
  readonly vault: { readonly id: string; readonly path: string };
  readonly accepted: AcceptedMain;
  readonly template: TemplateSummary;
}

/** Creates a vault from a template: its content, fresh history, its own id, the recorded origin, accepted. */
export async function createFromTemplate(
  deps: { readonly git: Git; readonly store: Store; readonly clock: Clock; readonly attribution: Attribution },
  request: CreateFromTemplate,
): Promise<Result<CreatedVault, TemplateError>> {
  const { git } = deps;
  const { path, id, source } = request;
  if (!VAULT_ID.test(id)) return err({ reason: 'invalid-argument', argument: 'id' });
  const remote = checkRemote(source.url);
  if (!remote.ok) return remote;
  const existed = existsSync(path);
  if (existed && readdirSync(path).length > 0) return err({ reason: 'not-empty', path });

  return withScratch(async (scratch) => {
    const fetched = await fetchTemplate(git, scratch, source);
    if (!fetched.ok) return fetched;
    const link = fetched.value.entries.find((entry) => entry.mode === TREE_MODES.symlink);
    if (link !== undefined) return err({ reason: 'unsupported-entry', path: link.path });

    const made = await populate(deps, scratch, fetched.value, request);
    if (!made.ok && !existed) rmSync(path, { recursive: true, force: true });
    return made.ok ? ok({ vault: { id, path }, accepted: made.value, template: summaryOf(source, fetched.value) }) : made;
  });
}

/** Writes the template's files into the new repository, with the root contract made the new vault's, and commits and accepts them. */
async function populate(
  deps: { readonly git: Git; readonly store: Store; readonly clock: Clock; readonly attribution: Attribution },
  scratch: string, fetched: FetchedTemplate, request: CreateFromTemplate,
): Promise<Result<AcceptedMain, TemplateError>> {
  const { git } = deps;
  mkdirSync(request.path, { recursive: true });
  const initialised = await initRepository(git, request.path, { initialBranch: 'main' });
  if (!initialised.ok) return initialised;

  for (const entry of fetched.entries) {
    const bytes = await readFileAt(git, scratch, fetched.commit, entry.path);
    if (!bytes.ok) return bytes;
    const target = join(request.path, ...entry.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes.value, { mode: entry.mode === TREE_MODES.executable ? 0o755 : 0o644 });
  }
  const vault = { ...fetched.vault, id: request.id, 'from-template': { url: request.source.url, commit: fetched.commit } } as FrontmatterValue;
  const contract = updateFrontmatter(fetched.contract, { template: undefined, vault });
  if (!contract.ok) return err({ reason: 'invalid-template', issues: [{ path: ROOT_CONTRACT, message: describeDocumentError(contract.error) }] });
  writeFileSync(join(request.path, ROOT_CONTRACT), contract.value);
  const executable = await stageExecutable(git, request.path, fetched.entries.filter((e) => e.mode === TREE_MODES.executable).map((e) => e.path));
  if (!executable.ok) return executable;

  const sha = await createCommit(git, request.path, {
    message: `Create vault ${request.id} from template ${fetched.marker.name} ${fetched.marker.version}`,
    ...deps.attribution,
    date: deps.clock.now(),
  });
  if (!sha.ok) return sha;
  return recordAccepted(deps.store, request.id, { sha: sha.value, how: 'init', by: request.by, at: deps.clock.now() }, null);
}
