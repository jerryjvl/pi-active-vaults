// Public surface of the process module: starting a process, and telling
// whether a recorded process still runs.

export { ownProcessGroup, runProcess, type ProcessError, type ProcessOutcome, type ProcessRequest, type Program } from './run.ts';
export { processStartTime, systemProcessProbe, type ProcessLiveness, type ProcessProbe, type ProcessStartError } from './identity.ts';
