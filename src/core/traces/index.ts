// Public surface of the traces module: trace IDs, the compact record kept in
// the vault as notes on a run's commits, provenance in produced documents,
// and full logs on the machine.

export {
  checkCompactTrace,
  newTraceId,
  opaqueReference,
  parseCompactTrace,
  renderCompactTrace,
  type CompactTrace,
  type TraceSession,
  type TraceTrigger,
} from './compact.ts';
export { provenanceOf, withProvenance, type Provenance } from './provenance.ts';
export { appendFullLog, readFullLog, rotateLogs, type LogEntry, type LogError } from './logs.ts';
export { TRACES_REF, recordRun, runCommits, type RecordRunOptions, type RunCommit, type RunRecord, type RunRecordError } from './notes.ts';
