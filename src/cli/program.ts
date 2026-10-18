// Where the `vault` CLI's entry point is — the source when run from source
// (tests), the compiled file when installed — for what runs it by path: the
// launcher `/vault install-cli` writes, and the daemon's service definition.

import { fileURLToPath } from 'node:url';

export const CLI_PROGRAM = fileURLToPath(new URL(`./main.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url));
