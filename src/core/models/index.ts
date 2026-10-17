// Public surface of the models module: which configured model may receive
// which vault's content, batch × parallel, and the role clients.

export { modelFor, type PermittedModel, type RoleUnavailable } from './roles.ts';
export { inBatches } from './batches.ts';
export { embed, rerank, type ModelClient, type ModelError } from './clients.ts';
