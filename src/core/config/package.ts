// The package's own version, as its manifest says: what the extension's
// `ready` event and the daemon's `ping` report. Read from `package.json` at
// the package root, which is three levels up from this module in `src/` and
// in the built `dist/` alike.

import { readFileSync } from 'node:fs';

let version: string | undefined;

export function packageVersion(): string {
  if (version === undefined) {
    try {
      version = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    } catch {
      version = '0.0.0';
    }
  }
  return version;
}
