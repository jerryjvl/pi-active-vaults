// Public surface of the operations layer: what every surface is generated
// from. So far, the assembly of the local stores from each module's schema;
// the catalogue of operations and permission sets arrive in Stage 4.

export { INDEX_MODULES, STATE_MODULES, openIndexStore, openStateStore } from './stores.ts';
