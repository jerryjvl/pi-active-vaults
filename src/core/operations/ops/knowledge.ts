// Knowledge operations: search, read, contract, reindex. Reading continues
// while `main` has an unaccepted change, from the recorded accepted `main`;
// rebuilding the index is a propagating action and is refused then.

import { acceptedContract, mainTip } from '../../integrity/index.ts';
import { readTextAt } from '../../git/index.ts';
import type { Clock } from '../../clock/index.ts';
import { search, updateIndex, type IndexProgress, type IndexReport, type SearchNote } from '../../search/index.ts';
import { fromError, invalid, succeeded } from '../messages.ts';
import type { Operation, OperationStatus } from '../types.ts';
import { integer, lineRange, readingFrom, searchContext, text, theVault } from './common.ts';

const READING = { cli: true, command: false, mcp: true } as const;

function noteText(note: SearchNote): string {
  switch (note.kind) {
    case 'not-indexed':
      return `Vault "${note.vault}" is not indexed yet; run "vault reindex ${note.vault}".`;
    case 'keyword-only':
      return `Keyword search only (${note.reason}).`;
    case 'vectors-incomplete':
      return `Vault "${note.vault}" has documents without vectors yet.`;
    case 'not-reranked':
      return `Not reranked (${note.reason}).`;
  }
}

export const searchOperation: Operation = {
  name: 'search',
  summary: 'Search the vaults for documents',
  vault: 'many',
  surfaces: { ...READING, tool: 'direct' },
  params: [
    { name: 'query', kind: 'string', required: true, positional: true, description: 'What to look for, in words' },
    { name: 'scope', kind: 'string', description: 'A path glob limiting the search; also admits opt-in subtrees it matches' },
    { name: 'limit', kind: 'integer', description: 'How many hits to return (default 10, at most 100)' },
  ],
  async run(context, request) {
    const index = context.index();
    if (!index.ok) return fromError({ reason: 'not-configured', what: 'The search index' });
    const scope = text(request.params, 'scope');
    const limit = integer(request.params, 'limit');
    const found = await search(searchContext(context, index.value), {
      query: text(request.params, 'query') ?? '',
      vaults: request.vaults,
      ...(scope === undefined ? {} : { scope }),
      ...(limit === undefined ? {} : { limit }),
    });
    if (!found.ok) return found.error.reason === 'empty-query' ? invalid('The query has no words to search for.') : fromError(found.error);
    const lines = found.value.hits.map((hit) =>
      `${hit.vault}:${hit.path}${hit.heading.length === 0 ? '' : ` — ${hit.heading.join(' › ')}`} [${hit.freshness}${hit.movedTo === undefined ? '' : ` → ${hit.movedTo}`}]\n  ${hit.excerpt}`);
    const notes = found.value.notes.map(noteText);
    return succeeded([...(lines.length === 0 ? ['No hits.'] : lines), ...notes].join('\n'), found.value);
  },
};

export const readOperation: Operation = {
  name: 'read',
  summary: 'Read a document as on the accepted main, with whether main has changed it since',
  vault: 'one',
  surfaces: { ...READING, tool: 'direct' },
  params: [
    { name: 'path', kind: 'string', required: true, positional: true, vaultPath: true, description: 'The document, as <vault-id>:<path>' },
    { name: 'range', kind: 'string', description: 'Lines to read, as start-end (1-based)' },
  ],
  async run(context, request) {
    const vault = theVault(request);
    const path = text(request.params, 'path') ?? '';
    const accepted = readingFrom(context, vault);
    if (!accepted.ok) return fromError(accepted.error);
    const content = await readTextAt(context.git, vault.path, accepted.value.sha, path);
    if (!content.ok) return fromError(content.error);
    if (content.value === undefined) return fromError({ reason: 'not-found', path: `${vault.id}:${path}` });
    const tip = await mainTip(context.git, vault.path);
    if (!tip.ok) return fromError(tip.error);
    const atTip = tip.value === null ? undefined : await readTextAt(context.git, vault.path, tip.value, path);
    if (atTip !== undefined && !atTip.ok) return fromError(atTip.error);
    // Against main itself: whether what is accepted is still what main holds.
    const freshness = atTip?.value === undefined ? 'gone' : atTip.value === content.value ? 'current' : 'changed';
    const shown = lineRange(content.value, text(request.params, 'range'));
    const note = freshness === 'current' ? '' : `\n\n[${vault.id}:${path} is ${freshness} on main since it was accepted]`;
    return succeeded(`${shown}${note}`, { vault: vault.id, path, accepted: accepted.value.sha, freshness, content: shown });
  },
};

export const contractOperation: Operation = {
  name: 'contract',
  summary: 'The effective contract for a path, with the origin of each key',
  vault: 'one',
  surfaces: { ...READING, command: true, tool: 'codemode' },
  params: [{ name: 'path', kind: 'string', required: true, positional: true, vaultPath: true, description: 'A file or directory, as <vault-id>:<path>' }],
  async run(context, request) {
    const vault = theVault(request);
    const path = text(request.params, 'path') ?? '';
    const accepted = readingFrom(context, vault);
    if (!accepted.ok) return fromError(accepted.error);
    const contract = await acceptedContract(context.reads, context.git, vault.path, accepted.value, path);
    if (!contract.ok) return fromError(contract.error);
    const { values, origins, prose } = contract.value;
    const keys = Object.keys(values).sort().map((key) => `${key}: ${JSON.stringify(values[key])}\n  from ${(origins[key] ?? []).join(', ')}`);
    const rendered = [...(keys.length === 0 ? ['No contract keys.'] : keys), ...prose.map((p) => `\n# ${p.path}\n${p.body.trim()}`)].join('\n');
    return succeeded(rendered, { vault: vault.id, path, accepted: accepted.value.sha, ...contract.value });
  },
};

function reportText(report: IndexReport): string {
  const vectors = report.vectors.state === 'complete'
    ? (report.vectors.unembedded === undefined ? 'vectors complete'
      : `vectors complete except ${report.vectors.unembedded.length} document(s) the embedding model refused even in small chunks, found by keyword only: ${report.vectors.unembedded.join(', ')}`)
    : report.vectors.state === 'none' ? `keyword only (${report.vectors.reason})`
    : `vectors failed (${report.vectors.error.reason})`;
  return `${report.vault}: indexed at ${report.sha}: ${report.added.length} added, ${report.changed.length} changed, ${report.removed.length} removed, ${report.skipped.length} skipped; ${vectors}.`;
}

/** How long an update runs before it says how far it has got, and how often after that. */
export const PROGRESS_EVERY_MS = 5_000;

export function progressText({ vault, phase, done, total }: IndexProgress): string {
  const share = total === 0 ? 100 : Math.floor((done / total) * 100);
  return `${vault}: ${phase === 'reading' ? 'reading documents' : 'embedding chunks'} ${done.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} (${share}%)`;
}

/** A listener that writes a line once an update has run a while, then every few seconds and at each phase's end. */
export function progressReporter(clock: Clock, write: (line: string) => void): (progress: IndexProgress) => void {
  const started = clock.now().getTime();
  let last = started;
  return (progress) => {
    const now = clock.now().getTime();
    const finished = progress.done === progress.total;
    if (now - started < PROGRESS_EVERY_MS || (now - last < PROGRESS_EVERY_MS && !finished)) return;
    last = now;
    write(progressText(progress));
  };
}

export const reindexOperation: Operation = {
  name: 'reindex',
  summary: 'Bring the search index up to the accepted main',
  vault: 'many',
  surfaces: { cli: true, command: false, mcp: true },
  params: [],
  async run(context, request) {
    const index = context.index();
    if (!index.ok) return fromError({ reason: 'not-configured', what: 'The search index' });
    const reports: IndexReport[] = [];
    const lines: string[] = [];
    let worst: OperationStatus = 'ok';
    for (const vault of request.vaults) {
      // Quiet for a quick update; for a long one, a line every few seconds and at each phase's end.
      const onProgress = context.progress === undefined ? undefined : progressReporter(context.clock, context.progress);
      const updated = await updateIndex(searchContext(context, index.value), vault, onProgress);
      if (updated.ok) {
        reports.push(updated.value);
        lines.push(reportText(updated.value));
      } else {
        const outcome = fromError(updated.error);
        if (worst !== 'failed') worst = outcome.status === 'ok' ? worst : outcome.status;
        lines.push(`${vault.id}: ${outcome.text}`);
      }
    }
    return { status: worst, text: lines.join('\n') || 'No vaults to index.', data: { reports } };
  },
};
