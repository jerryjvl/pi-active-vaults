// Public surface of the models module: which configured model answers a
// request and may receive which vault's content, batch × parallel, and the
// role clients.

export { resolveModel, type ModelUnavailable, type PermittedModel } from './resolve.ts';
export { inBatches } from './batches.ts';
export { embed, rerank, type ModelClient, type ModelError } from './clients.ts';
export { askSystemOne, type SystemOneAnswer, type SystemOneQuestion, type SystemOneRequest, type SystemOneResult } from './systemone.ts';
