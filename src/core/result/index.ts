// Results as values. Operations that can fail for expected reasons return a
// `Result` whose error carries a `reason`; only violated invariants (programming
// errors) throw. Callers branch on `ok`, so a failure cannot be ignored by
// accident and the compiler narrows both sides.

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export const err = <E>(error: E): Err<E> => ({ ok: false, error });
