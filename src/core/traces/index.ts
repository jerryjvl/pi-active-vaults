// Public surface of the traces module: trace IDs, the compact record kept in
// the vault, provenance in produced documents, and full logs on the machine.

export {
  TRACES_DIRECTORY,
  compactTracePath,
  newTraceId,
  opaqueReference,
  parseCompactTrace,
  renderCompactTrace,
  writeCompactTrace,
  type CompactTrace,
  type TraceSession,
  type TraceTrigger,
} from './compact.ts';
export { PROVENANCE_KEY, provenanceOf, withProvenance, type Provenance } from './provenance.ts';
export { appendFullLog, readFullLog, rotateLogs, type LogEntry, type LogError } from './logs.ts';
