// Public surface of the sessions module: what a Pi session — interactive or
// a headless run — is to the vaults: its actor, holds, trace and budget, and
// the person changing its actor; the write guard; taint; context injection;
// session events and the spawns they request; per-turn budget records; the
// vault catalog for its prompt; and the tool a prefixed tool call means. The extension adapts these to Pi's
// events; nothing here knows Pi.

export { parseRunContext, renderRunContext, type RunContext } from './run.ts';
export { callerOf, closeSession, openSession, type SessionRefusal, type SessionStart, type VaultSession } from './session.ts';
export { describeWriting, holdForOperation, holdIn, switchActor, switchRefusalText, type SwitchRefusal } from './actor.ts';
export { guardToolCall, type GuardedCall, type GuardVerdict } from './guard.ts';
export { taints, type TaintedCall } from './taint.ts';
export { injectionsFor, renderInjections, type Injection, type SessionEvent } from './injection.ts';
export { sessionEvent, type SessionEventOutcome } from './events.ts';
export { recordTurn, workLeft, type TurnRecord, type TurnStop } from './turns.ts';
export { catalogText } from './catalog.ts';
export { intendedToolName, withIntendedToolNames } from './toolnames.ts';
export { logItemOutcome, logSession, logToolResult, traceRecord, type ToolResult } from './trace.ts';
