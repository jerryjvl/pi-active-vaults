// Public surface of the sessions module: what a Pi session — interactive or
// a headless run — is to the vaults: its actor, hold, trace and budget; the
// write guard; taint; context injection; session events and the spawns they
// request; per-turn budget records; and the vault catalog for its prompt.
// The extension adapts these to Pi's events; nothing here knows Pi.

export { parseRunContext, renderRunContext, type RunContext } from './run.ts';
export { callerOf, closeSession, holdActor, holdRefusalText, openSession, type SessionRefusal, type SessionStart, type VaultSession } from './session.ts';
export { guardToolCall, type GuardedCall, type GuardVerdict } from './guard.ts';
export { taints, type TaintedCall } from './taint.ts';
export { injectionsFor, renderInjections, type Injection, type SessionEvent } from './injection.ts';
export { sessionEvent, type SessionEventOutcome } from './events.ts';
export { recordTurn, type TurnRecord, type TurnStop } from './turns.ts';
export { catalogText } from './catalog.ts';
