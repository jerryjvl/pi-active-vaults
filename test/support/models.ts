// The models a test installation or queue is configured with: one `agent`
// model, allowed for the vault `home`, so work that is claimed can run.

import type { InstallationConfig } from '../../src/core/config/index.ts';

/** The model Pi's faux provider (test/support/pi.ts) runs on, so extension tests and the daemon's fake Pi agree on it. */
export const AGENT_MODEL = 'faux/faux-1';

export const AGENT_MODELS: Pick<InstallationConfig, 'models' | 'policy'> = {
  models: { agent: { role: 'agent', model: AGENT_MODEL } },
  policy: [{ vaults: ['home'], allowModels: ['agent'] }],
};
