// What the extension holds while a Pi session runs: the operation context, the
// vault session, the catalog fixed at its start, and what is waiting to be
// added to the model's context. Made at `session_start`, released at
// `session_shutdown` (pi-conventions.md "Extension lifecycle"); between
// sessions there is nothing.

import type { OperationContext } from '../core/operations/index.ts';
import type { VaultSession } from '../core/sessions/index.ts';

export interface Live {
  readonly context: OperationContext;
  readonly session: VaultSession;
  /** Where the session started. */
  readonly cwd: string;
  /** The vault catalog for the system prompt: fixed for the session (principle 16). */
  readonly catalog: string;
  /** What the model is told with its next request: start notices, a run's brief, `session.start` documents. */
  readonly pending: string[];
  /** What is appended to a call's result: the context its paths brought in, and what it spawned. */
  readonly forResult: Map<string, string[]>;
  /** Event bus subscriptions to drop at shutdown. */
  readonly subscriptions: (() => void)[];
}

/** The live session, or why there is none. */
export interface Holder {
  live?: Live | undefined;
  problem?: string | undefined;
}

/** The live session, or a problem to report as a tool or command result. */
export function liveOr(holder: Holder): { live: Live } | { problem: string } {
  return holder.live !== undefined ? { live: holder.live } : { problem: holder.problem ?? 'The vault extension has not started for this session.' };
}
