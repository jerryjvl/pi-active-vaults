// Searching the index (core.md "Search", architecture.md "Degradation").
//
// A query is scoped to the vaults asked for. Keyword hits (FTS5, bm25) and
// vector hits (cosine distance to the embedded query) are fused by rank
// (reciprocal rank fusion), then reranked when a rerank model is configured
// and allowed; each returned hit is checked against its vault's accepted
// `main`. Whatever is missing — an embedding model, the policy's permission,
// the vector extension, vectors from the current model, a reachable model —
// reduces the search to keywords and is reported, never failed on.
//
// Invariants: the query's text is matched as words — it is never read as
// FTS5 syntax, so no input can change what the query means; `opt-in` subtrees
// are searched only within an explicit scope; a model receives the query and
// chunks only for vaults the policy lets it see.

import { matchesGlob } from '../conditions/index.ts';
import type { GitError } from '../git/index.ts';
import type { VaultLocation } from '../integrity/index.ts';
import { embed, rerank } from '../models/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import { embeddingText } from './chunks.ts';
import { searchModel, vectorBlob, type SearchContext } from './context.ts';
import { freshnessChecker, type Freshness } from './freshness.ts';
import { EMBEDDING_MODEL_KEY } from './schema.ts';

export interface SearchRequest {
  readonly query: string;
  readonly vaults: readonly VaultLocation[];
  /** A path glob; also admits `opt-in` subtrees it matches. */
  readonly scope?: string;
  /** Hits to return; default 10, at most 100. */
  readonly limit?: number;
}

export interface SearchHit {
  readonly vault: string;
  readonly path: string;
  readonly heading: readonly string[];
  readonly excerpt: string;
  readonly freshness: Freshness;
  readonly movedTo?: string;
}

export type SearchNote =
  | { readonly kind: 'not-indexed'; readonly vault: string }
  | { readonly kind: 'keyword-only'; readonly reason: 'no-embed-model' | 'not-allowed' | 'no-vector-extension' | 'model-changed' | 'embed-failed' }
  | { readonly kind: 'vectors-incomplete'; readonly vault: string }
  | { readonly kind: 'not-reranked'; readonly reason: 'not-allowed' | 'rerank-failed' };

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly mode: 'hybrid' | 'keyword';
  readonly reranked: boolean;
  readonly notes: readonly SearchNote[];
}

export type SearchError = { readonly reason: 'empty-query' } | GitError;

interface Candidate {
  id: number;
  vault: string;
  path: string;
  heading: string;
  header: string;
  body: string;
  blob: string;
  scope: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
/** How many of each ranking take part in fusion. */
const POOL = 100;
/** The usual reciprocal-rank-fusion constant: damps the weight of the very top ranks. */
const RRF_K = 60;
const EXCERPT_CHARS = 200;

const CANDIDATE_COLUMNS = 'c.id, c.vault, c.path, c.heading, c.header, c.body, d.blob, d.scope';
const IN_SCOPE = `c.vault IN (SELECT value FROM json_each($vaults)) AND ($scoped OR d.scope = 'default')`;

function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Each word quoted as an FTS5 string, so nothing in the query is read as syntax. */
function keywordQuery(terms: readonly string[]): string {
  return terms.map((term) => `"${term}"`).join(' OR ');
}

function excerpt(body: string, terms: readonly string[]): string {
  const lower = body.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0), Infinity);
  const start = at === Infinity ? 0 : Math.max(0, at - 60);
  const text = body.slice(start, start + EXCERPT_CHARS).trim();
  return `${start > 0 ? '…' : ''}${text}${start + EXCERPT_CHARS < body.length ? '…' : ''}`;
}

type Ranking = readonly Candidate[];

/** Reciprocal rank fusion: each ranking adds 1 / (k + rank); ties keep index order. */
function fuse(rankings: readonly Ranking[]): Candidate[] {
  const scores = new Map<number, { candidate: Candidate; score: number }>();
  for (const ranking of rankings) {
    ranking.forEach((candidate, rank) => {
      const entry = scores.get(candidate.id) ?? { candidate, score: 0 };
      entry.score += 1 / (RRF_K + rank + 1);
      scores.set(candidate.id, entry);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.candidate.id - b.candidate.id).map((e) => e.candidate);
}

type VectorOutcome = { readonly ranking: Ranking } | { readonly note: SearchNote & { kind: 'keyword-only' } };

async function vectorRanking(context: SearchContext, query: string, vaults: readonly string[], filter: Record<string, string | number>): Promise<VectorOutcome> {
  const model = searchModel(context, 'embed', vaults);
  if (!model.ok) return { note: { kind: 'keyword-only', reason: model.error.reason === 'no-default' ? 'no-embed-model' : 'not-allowed' } };
  const { index } = context;
  if (!index.vectors) return { note: { kind: 'keyword-only', reason: 'no-vector-extension' } };
  const recorded = index.get<{ value: string }>('SELECT value FROM search_meta WHERE key = ?', [EMBEDDING_MODEL_KEY])?.value;
  if (recorded !== model.value.entry.model) return { note: { kind: 'keyword-only', reason: 'model-changed' } };
  if (context.models === undefined) return { note: { kind: 'keyword-only', reason: 'no-embed-model' } };
  const embedded = await embed(context.models.client, model.value, [query]);
  if (!embedded.ok || embedded.value[0] === undefined) return { note: { kind: 'keyword-only', reason: 'embed-failed' } };
  const ranking = index.all<Candidate>(
    `SELECT ${CANDIDATE_COLUMNS} FROM search_vectors v
     JOIN search_chunks c ON c.id = v.chunk JOIN search_documents d ON d.vault = c.vault AND d.path = c.path
     WHERE ${IN_SCOPE} ORDER BY vec_distance_cosine(v.embedding, $query), c.id LIMIT $pool`,
    { ...filter, query: vectorBlob(embedded.value[0]) },
  );
  return { ranking };
}

export async function search(context: SearchContext, request: SearchRequest): Promise<Result<SearchResult, SearchError>> {
  const terms = words(request.query);
  if (terms.length === 0) return err({ reason: 'empty-query' });
  const { index } = context;
  const limit = Math.min(Math.max(1, request.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const vaultIds = request.vaults.map((v) => v.id);
  const indexedAt = new Map(index.all<{ vault: string; sha: string }>(
    'SELECT vault, sha FROM search_vaults WHERE vault IN (SELECT value FROM json_each(?))', [JSON.stringify(vaultIds)],
  ).map((row) => [row.vault, row.sha]));
  const notes: SearchNote[] = vaultIds.filter((id) => !indexedAt.has(id)).map((vault) => ({ kind: 'not-indexed', vault }));

  // With a scope, every match is fetched and the glob decides; without one, the pool is enough.
  const scoped = request.scope !== undefined;
  const filter = { vaults: JSON.stringify(vaultIds), scoped: scoped ? 1 : 0, pool: scoped ? -1 : POOL };
  const inScope = (c: Candidate): boolean => request.scope === undefined || matchesGlob(c.path, request.scope);

  const keyword = index.all<Candidate>(
    `SELECT ${CANDIDATE_COLUMNS} FROM search_fts
     JOIN search_chunks c ON c.id = search_fts.rowid JOIN search_documents d ON d.vault = c.vault AND d.path = c.path
     WHERE search_fts MATCH $match AND ${IN_SCOPE} ORDER BY bm25(search_fts), c.id LIMIT $pool`,
    { ...filter, match: keywordQuery(terms) },
  ).filter(inScope);
  const vector = await vectorRanking(context, request.query, vaultIds, filter);
  if ('note' in vector) notes.push(vector.note);
  else {
    const incomplete = index.all<{ vault: string }>(
      `SELECT DISTINCT c.vault FROM search_chunks c LEFT JOIN search_vectors v ON v.chunk = c.id
       WHERE c.vault IN (SELECT value FROM json_each(?)) AND v.chunk IS NULL ORDER BY c.vault`,
      [JSON.stringify(vaultIds)],
    );
    notes.push(...incomplete.map(({ vault }) => ({ kind: 'vectors-incomplete' as const, vault })));
  }

  let ranked = fuse('ranking' in vector ? [keyword, vector.ranking.filter(inScope)] : [keyword]);
  let reranked = false;
  const reranker = searchModel(context, 'rerank', vaultIds);
  if (!reranker.ok) {
    if (reranker.error.reason === 'not-allowed') notes.push({ kind: 'not-reranked', reason: 'not-allowed' });
  } else if (context.models !== undefined && ranked.length > 0) {
    const candidates = ranked.slice(0, Math.max(limit * 3, 30));
    const scores = await rerank(context.models.client, reranker.value, request.query, candidates.map(embeddingText));
    if (scores.ok) {
      ranked = candidates.map((candidate, i) => ({ candidate, score: scores.value[i] ?? 0, i }))
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .map((e) => e.candidate);
      reranked = true;
    } else {
      notes.push({ kind: 'not-reranked', reason: 'rerank-failed' });
    }
  }

  const check = freshnessChecker(context.git, context.state);
  const locations = new Map(request.vaults.map((v) => [v.id, v]));
  const hits: SearchHit[] = [];
  for (const candidate of ranked.slice(0, limit)) {
    const vault = locations.get(candidate.vault);
    const at = indexedAt.get(candidate.vault);
    if (vault === undefined || at === undefined) continue;
    const verdict = await check(vault, at, candidate.path, candidate.blob);
    if (!verdict.ok) return verdict;
    hits.push({
      vault: candidate.vault,
      path: candidate.path,
      heading: JSON.parse(candidate.heading) as string[],
      excerpt: excerpt(candidate.body, terms),
      ...verdict.value,
    });
  }
  return ok({ hits, mode: 'ranking' in vector ? 'hybrid' : 'keyword', reranked, notes });
}
