// Batch × parallel (concepts.md "Installation"): work is split into batches of
// the role's `batch` inputs and sent up to `parallel` at a time, so endpoints
// that batch well and endpoints that take one input per request both get full
// throughput. Results keep the input order. The first failure fails the whole
// call and no further batch is started; a partial result is never returned.

import { err, ok, type Result } from '../result/index.ts';

export async function inBatches<I, O, E>(
  inputs: readonly I[],
  shape: { readonly batch: number; readonly parallel: number },
  send: (batch: readonly I[]) => Promise<Result<readonly O[], E>>,
): Promise<Result<O[], E>> {
  const batches: (readonly I[])[] = [];
  for (let i = 0; i < inputs.length; i += shape.batch) batches.push(inputs.slice(i, i + shape.batch));
  const results: (readonly O[])[] = new Array(batches.length);
  let next = 0;
  let failure: { error: E } | undefined;

  const worker = async (): Promise<void> => {
    while (failure === undefined && next < batches.length) {
      const index = next++;
      const sent = await send(batches[index] as readonly I[]);
      if (sent.ok) results[index] = sent.value;
      else failure ??= { error: sent.error };
    }
  };
  await Promise.all(Array.from({ length: Math.min(shape.parallel, batches.length) }, worker));
  return failure === undefined ? ok(results.flat() as O[]) : err(failure.error);
}
