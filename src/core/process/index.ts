// Public surface of the process module: starting a process — to completion,
// or long-lived and line by line — telling whether a recorded process still
// runs, and ending one by its exact identity.

export { ownProcessGroup, runProcess, type ProcessError, type ProcessOutcome, type ProcessRequest, type Program } from './run.ts';
export { endProcess, startChild, type Child, type ChildRequest, type EndOutcome } from './child.ts';
export { processStartTime, systemProcessProbe, type ProcessLiveness, type ProcessProbe, type ProcessStartError } from './identity.ts';
