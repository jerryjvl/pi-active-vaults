// Public surface of the result module: results and validation issues as
// values, canonical JSON, and JSON-lines framing.

export { err, ok, type Err, type Ok, type Result } from './result.ts';
export { DataReader, isRecord, issuePath, type Issue } from './issues.ts';
export { canonicalJson } from './canonical.ts';
export { lineSplitter, type LineSplitter } from './lines.ts';
