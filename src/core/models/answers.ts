// Whether a model's answer is a finished one (concepts.md "Session tree",
// daemon.md "Outcomes"): the one rule every place that takes a model's last
// answer applies — a headless run's, a fan-out item's, a gather's.
//
// Invariant: only a request that ended normally (`stop`, or `toolUse` on the
// way to a next step) is finished. One that failed, was stopped, or was cut
// off at the model's output limit is not, so its partial work is never taken
// for a result: a cut-off answer looks like any other — no error, perhaps no
// text — and only its stop reason tells them apart (2026-11-04: three voice
// items spent their turns thinking, were cut off, and counted as done).

/** Why `answer` is not a finished answer, or undefined when its request ended normally. */
export function unfinishedAnswer(answer: { readonly stopReason?: unknown; readonly errorMessage?: unknown }): string | undefined {
  const given = typeof answer.errorMessage === 'string' && answer.errorMessage !== '' ? answer.errorMessage : undefined;
  switch (answer.stopReason) {
    case 'error': return given ?? 'the model request failed';
    case 'aborted': return given ?? 'the model request was stopped';
    case 'length': return 'the model reached its output limit before it finished';
    default: return undefined;
  }
}
