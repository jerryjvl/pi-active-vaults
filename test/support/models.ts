// The models a test installation or queue is configured with: one `agent`
// model, allowed for the vault `home`, so work that is claimed can run.

import type { InstallationConfig } from '../../src/core/config/index.ts';

export const AGENT_MODEL = 'fake/agent';

export const AGENT_MODELS: Pick<InstallationConfig, 'models' | 'policy'> = {
  models: { agent: { role: 'agent', model: AGENT_MODEL } },
  policy: [{ vaults: ['home'], allowModels: ['agent'] }],
};
