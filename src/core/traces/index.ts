// Public surface of the traces module: trace IDs, the compact record kept in
// the vault (and as a run's commits carry it), provenance in produced
// documents, and full logs on the machine.

export {
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
export { provenanceOf, withProvenance, type Provenance } from './provenance.ts';
export { appendFullLog, readFullLog, rotateLogs, type LogEntry, type LogError } from './logs.ts';
export { writeRunRecord, type RunRecord, type RunRecordError } from './run.ts';
