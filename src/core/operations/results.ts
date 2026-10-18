// What a model gets back from an operation (api.md "Tool contract"), the same
// for Pi tools and MCP tools: the text, then the notices of any vault it acted
// on with an unaccepted change; the outcome as data for programs; and whether
// it is an error the model should act on.
//
// Invariants: a long text is cut with a note saying how much is left and how
// to ask for less, but programs get the whole of it; a confirmation is the
// person's to give, so it is never part of a model's result.

import type { OperationOutcome } from './types.ts';

/** The outcome as data, as programs get it — a tool's structured content, the CLI's `--json`. */
export interface OutcomeData {
  readonly status: OperationOutcome['status'];
  readonly data: unknown;
  readonly text: string;
  readonly notices: readonly string[];
}

export interface ModelResult {
  readonly text: string;
  readonly structured: OutcomeData;
  readonly isError: boolean;
}

export function outcomeData(outcome: OperationOutcome, notices: readonly string[]): OutcomeData {
  return { status: outcome.status, data: outcome.data ?? null, text: outcome.text, notices };
}

/** About 12k tokens: enough for a document or a page of hits, small enough to leave room for work. */
export const MODEL_TEXT_LIMIT = 50_000;

export function modelResult(outcome: OperationOutcome, notices: readonly string[], limit = MODEL_TEXT_LIMIT): ModelResult {
  const cut = outcome.text.length > limit
    ? `${outcome.text.slice(0, limit)}\n[${outcome.text.length - limit} more characters not shown: ask for less — a line range with vault_read, a narrower query or scope.]`
    : outcome.text;
  return {
    text: [cut, ...notices].filter((t) => t !== '').join('\n\n'),
    structured: outcomeData(outcome, notices),
    isError: outcome.status !== 'ok',
  };
}
