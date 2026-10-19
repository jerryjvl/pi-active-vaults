// Public surface of the search module: the index of each vault's accepted
// `main`, hybrid search over it, and each hit's freshness.

export { searchSchema } from './schema.ts';
export { chunkDocument, type Chunk } from './chunks.ts';
export type { SearchContext } from './context.ts';
export { documentsWithoutVectors, updateIndex, type IndexError, type IndexReport, type IndexScope, type VectorState } from './update.ts';
export { search, type SearchError, type SearchHit, type SearchNote, type SearchRequest, type SearchResult } from './query.ts';
export { freshnessChecker, type Freshness, type FreshnessVerdict } from './freshness.ts';
