// A fully specified machine for config tests, so no test reads the real
// environment. Override only what a test is about.

import type { Host } from '../../src/core/config/index.ts';

export function testHost(overrides: Partial<Host> = {}): Host {
  return {
    os: 'linux',
    env: {},
    home: '/home/alice',
    user: 'alice',
    hostname: 'homeserver',
    ...overrides,
  };
}
