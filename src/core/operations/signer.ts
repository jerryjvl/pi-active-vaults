// The kinds of statement the signer makes (components/signer.md): the one
// place that lists them, as stores.ts lists the modules each store holds. A
// new pair of processes that must trust each other without sharing a key adds
// its kind here — with a statement type of its own, and what it states derived
// from the signer's own sources — and its schema to `SIGNER_MODULES` if it
// keeps records.

import type { SignerConfig } from '../config/index.ts';
import { webGrantKind } from '../grants/index.ts';
import type { SignerDeps, StatementKind } from '../signing/index.ts';

export function signerKinds(deps: SignerDeps, config: SignerConfig): StatementKind[] {
  return [webGrantKind(deps, config)];
}
