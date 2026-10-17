// Public surface of the result module: results and validation issues as
// values, and canonical JSON.

export { err, ok, type Err, type Ok, type Result } from './result.ts';
export { DataReader, issuePath, type Issue } from './issues.ts';
export { canonicalJson } from './canonical.ts';
