// Where the manual for the commands lives, for the help that names it (cli.md
// "What this document is"): both `vault --help` and `/vault help` end with it,
// and so does a command's own help, because help text is what a person or a
// session reads first and, on its own, implies that a command's one-line summary
// is all there is to know about it.
//
// It is written as a place a reader can go to. Where this package's `docs/` is
// beside its `dist/` — a checkout, or an install that packed both (`docs` is in
// `files` for that reason) — that is a full path, readable from wherever the
// help was printed; where it is not, only the document's name and its package
// are given, which is still something to search for. Nothing is fetched: this
// names a place and checks that it exists, and does nothing else.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANUAL = 'docs/components/cli.md';

/** The manual's place, seen from this module: a path on this machine, or its name and where that name comes from. */
function place(): string {
  const here = fileURLToPath(new URL(`../../${MANUAL}`, import.meta.url));
  return existsSync(here) ? here : `${MANUAL}, in the pi-active-vaults package`;
}

/** The line that names it, for the end of a help text. */
export const MANUAL_HINT = `What each command does, who may run it, and what its output means: ${place()}`;
