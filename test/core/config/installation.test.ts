// Documented behaviour: concepts.md "Installation" — the machine-local config,
// validated on load. Gates fail closed: an invalid config is an error value
// listing every problem, never a partly applied configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadInstallationConfig,
  parseInstallationConfig,
  type ConfigError,
  type InstallationConfig,
} from '../../../src/core/config/index.ts';
import { testHost } from '../../support/host.ts';

const FULL = `
installation:
  name: alice@homeserver
  person: alice
vaults:
  - id: home-knowledge
    path: ~/vaults/home-knowledge
    worktrees: ~/vaults/home-knowledge-worktrees
    host: true
  - id: private
    path: /srv/vaults/private
  - id: digests
    path: /srv/vaults/digests
models:
  embed:     { url: "https://models.example.net/v1", token: "\${EMBED_TOKEN}", model: embed-large, batch: 32, parallel: 4 }
  rerank:    { url: "https://models.example.net/v1", token: "\${RERANK_TOKEN}", model: reranker }
  judgement: { url: "https://models.example.net/v1", token: "!secret-tool lookup k judge", model: judge, parallel: 4 }
forges:
  - { host: git.example.net, type: gitea, token: "\${FORGE_TOKEN}" }
mcp: { profiles: [] }
labels:
  equivalent: [[private:geopolitics, digests:geopolitics]]
subscriptions:
  - { from: digests, to: private }
policy:
  - { vaults: [home-knowledge], allow-models: [embed, rerank, judgement] }
budgets: { daily-tokens: 2000000, cascade-pool: 300000, depth-decay: 0.25, max-depth: 3 }
taint:
  trusted-tools: [read, edit, write]
logs: { keep-days: 14 }
notify: { from: "Vault <vault@example.net>" }
templates:
  research-digests: https://git.example.net/templates/research-digests.git
`;

function parse(text: string, host = testHost()) {
  return parseInstallationConfig(text, host);
}

function valid(text: string, host = testHost()): InstallationConfig {
  const result = parse(text, host);
  if (!result.ok) assert.fail(`expected a valid config: ${JSON.stringify(result.error)}`);
  return result.value;
}

function issues(text: string): string[] {
  const result = parse(text);
  if (result.ok) assert.fail('expected the config to be rejected');
  assert.equal(result.error.reason, 'invalid');
  return (result.error as Extract<ConfigError, { reason: 'invalid' }>).issues.map((i) => `${i.path}: ${i.message}`);
}

test('the documented example loads, with kebab-case keys exposed in camelCase', () => {
  const config = valid(FULL);
  assert.equal(config.name, 'alice@homeserver');
  assert.equal(config.person, 'alice');
  assert.deepEqual(config.vaults.map((v) => [v.id, v.path, v.host]), [
    ['home-knowledge', '/home/alice/vaults/home-knowledge', true],
    ['private', '/srv/vaults/private', false],
    ['digests', '/srv/vaults/digests', false],
  ]);
  assert.equal(config.vaults[0]?.worktrees, '/home/alice/vaults/home-knowledge-worktrees');
  assert.equal(config.vaults[1]?.worktrees, undefined);
  assert.deepEqual(config.models['embed'], {
    role: 'embed',
    url: 'https://models.example.net/v1',
    token: { kind: 'env', name: 'EMBED_TOKEN', where: 'models.embed.token' },
    model: 'embed-large',
    batch: 32,
    parallel: 4,
  });
  const judgement = config.models['judgement'];
  assert.ok(judgement?.role === 'judgement');
  assert.equal(judgement.token.kind, 'command');
  assert.deepEqual(config.forges, [
    { host: 'git.example.net', type: 'gitea', token: { kind: 'env', name: 'FORGE_TOKEN', where: 'forges[0].token' }, autoMerge: true },
  ]);
  assert.deepEqual(config.labels.equivalent, [['private:geopolitics', 'digests:geopolitics']]);
  assert.deepEqual(config.subscriptions, [{ from: 'digests', to: 'private' }]);
  assert.deepEqual(config.policy, [{ vaults: ['home-knowledge'], allowModels: ['embed', 'rerank', 'judgement'] }]);
  assert.deepEqual(config.budgets, { dailyTokens: 2000000, cascadePool: 300000, depthDecay: 0.25, maxDepth: 3 });
  assert.deepEqual(config.taint, { trustedTools: ['read', 'edit', 'write'] });
  assert.deepEqual(config.logs, { keepDays: 14 });
  assert.deepEqual(config.templates, { 'research-digests': 'https://git.example.net/templates/research-digests.git' });
});

test('sections owned by later modules are passed through as plain data', () => {
  const config = valid(FULL);
  assert.deepEqual(config.mcp, { profiles: [] });
  assert.deepEqual(config.notify, { from: 'Vault <vault@example.net>' });
  assert.equal(valid('vaults: []').mcp, undefined);
});

test('an empty config is valid and applies the documented defaults', () => {
  const config = valid('');
  assert.equal(config.name, 'alice@homeserver', 'defaults to <user>@<hostname>');
  assert.equal(config.person, undefined);
  assert.deepEqual(config.vaults, []);
  assert.deepEqual(config.models, {});
  assert.deepEqual(config.budgets, { depthDecay: 0.5, maxDepth: 4 });
  assert.deepEqual(config.logs, { keepDays: 7 });
  assert.deepEqual(config.taint, { trustedTools: [] }, 'with no trusted tools every tool taints');
  assert.deepEqual(config.labels, { equivalent: [] });
});

test('model batch and parallel default to 1 and an absent role stays absent', () => {
  const config = valid(`models:\n  embed: { url: "http://127.0.0.1:4000/v1", token: "\${T}", model: m }`);
  const embed = config.models['embed'];
  assert.ok(embed?.role === 'embed');
  assert.equal(embed.batch, 1);
  assert.equal(embed.parallel, 1);
  assert.equal(config.models['rerank'], undefined);
});

test('vault paths expand ~ and must then be absolute, per platform', () => {
  const win = testHost({ os: 'win32', home: 'C:\\Users\\alice' });
  assert.equal(valid('vaults:\n  - { id: a, path: "~\\\\vaults\\\\a" }', win).vaults[0]?.path, 'C:\\Users\\alice\\vaults\\a');
  assert.equal(valid('vaults:\n  - { id: a, path: "D:\\\\vaults\\\\a" }', win).vaults[0]?.path, 'D:\\vaults\\a');
  assert.ok(issues('vaults:\n  - { id: a, path: relative/dir }')[0]?.includes('vaults[0].path'));
  assert.ok(issues('vaults:\n  - { id: a, path: /srv/a, worktrees: wt }')[0]?.includes('vaults[0].worktrees'));
});

test('invalid values are all reported together with their paths, never echoing the values', () => {
  const found = issues(`
vaults:
  - { id: "bad id", path: /a }
  - { id: ok, path: /b, host: "yes" }
  - { id: ok, path: /c }
models:
  embed: { url: "not a url", token: "sk-literal-secret-123", model: "", batch: 0 }
  mystery: { url: "https://x", token: "\${T}", model: m }
  other: { role: telepathy, model: m }
budgets: { depth-decay: 1.5, max-depth: 0 }
logs: { keep-days: 0 }
unknown-section: 1
`);
  const text = found.join('\n');
  for (const expected of [
    'vaults[0].id', 'vaults[1].host', 'vaults[2].id', 'models.embed.url', 'models.embed.token',
    'models.embed.model', 'models.embed.batch', 'models.mystery', 'models.other.role', 'budgets.depth-decay',
    'budgets.max-depth', 'logs.keep-days', 'unknown-section',
  ]) {
    assert.ok(text.includes(expected), `${expected} missing from:\n${text}`);
  }
  assert.ok(!text.includes('sk-literal-secret-123'), 'a literal secret must not be echoed');
  assert.ok(!text.includes('not a url'));
});

test('unknown keys inside known sections are rejected, so a typo cannot silently disable a feature', () => {
  assert.ok(issues('logs: { keep-day: 3 }')[0]?.includes('logs.keep-day'));
  assert.ok(issues('policy:\n  - { vaults: [], alow-models: [embed] }').some((i) => i.includes('policy[0].alow-models')));
});

test('references between sections must resolve to registered vaults and well-formed model names', () => {
  const found = issues(`
vaults:
  - { id: a, path: /a }
subscriptions:
  - { from: a, to: nowhere }
  - { from: a, to: a }
policy:
  - { vaults: [ghost], allow-models: [embed, "not a name"] }
`);
  const text = found.join('\n');
  assert.ok(text.includes('subscriptions[0].to'));
  assert.ok(text.includes('subscriptions[1]'));
  assert.ok(text.includes('policy[0].vaults[0]'));
  assert.ok(text.includes('policy[0].allow-models[1]'));
});

test('duplicate keys and malformed YAML are errors that do not repeat the file content', () => {
  const dup = parse('logs: { keep-days: 1 }\nlogs: { keep-days: 2 }\n');
  assert.equal(dup.ok, false);
  const broken = parse('models:\n  embed: { token: sk-literal-secret-123,\n');
  assert.equal(broken.ok, false);
  if (!broken.ok) {
    assert.equal(broken.error.reason, 'invalid-yaml');
    assert.ok(!JSON.stringify(broken.error).includes('sk-literal-secret-123'));
  }
});

test('a config that is not a mapping is rejected', () => {
  assert.ok(issues('- just\n- a list').length > 0);
});

test('loading a file distinguishes missing from unreadable and parses the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pav-config-'));
  try {
    const file = join(dir, 'config.yaml');
    assert.deepEqual(loadInstallationConfig(file, testHost()), { ok: false, error: { reason: 'not-found', path: file } });
    writeFileSync(file, FULL);
    const loaded = loadInstallationConfig(file, testHost());
    assert.equal(loaded.ok && loaded.value.name, 'alice@homeserver');
    const asDirectory = loadInstallationConfig(dir, testHost());
    assert.equal(asDirectory.ok === false && asDirectory.error.reason, 'unreadable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a forge may name its API base, for a forge whose API is not at the usual place', () => {
  const config = parse('forges:\n  - { host: git.lan, type: gitea, token: "${T}", api: "http://git.lan:3000/api/v1" }\n');
  assert.ok(config.ok);
  assert.deepEqual(config.value.forges, [{ host: 'git.lan', type: 'gitea', token: { kind: 'env', name: 'T', where: 'forges[0].token' }, autoMerge: true, api: 'http://git.lan:3000/api/v1' }]);
  const bad = parse('forges:\n  - { host: git.lan, type: gitea, token: "${T}", api: "ftp://git.lan" }\n');
  assert.ok(!bad.ok && bad.error.reason === 'invalid');
  assert.deepEqual(bad.error.issues, [{ path: 'forges[0].api', message: 'must be an http or https URL' }]);
});

// daemon.md "Scheduling": how long a spawn may wait in
// the queue, and how many headless sessions the daemon runs at once — the
// capacity of the model Pi runs them with.
test('the daemon section sets the queue-time limit and how many runs go at once, with defaults', () => {
  assert.deepEqual(valid('').daemon, { queueTimeMs: 24 * 60 * 60 * 1000, parallel: 1 });
  assert.deepEqual(valid('daemon: { queue-time: 90m, parallel: 3 }').daemon, { queueTimeMs: 90 * 60 * 1000, parallel: 3 });
  const found = issues('daemon: { queue-time: soon, parallel: 0, polling: 5 }').join('\n');
  for (const expected of ['daemon.queue-time', 'daemon.parallel', 'daemon.polling']) assert.ok(found.includes(expected), found);
});

// concepts.md "Models": named entries with a role; each role's default is the entry named after it.
const URL_ENTRY = 'url: "https://models.example.net/v1", token: "${T}", model: m';

test('models are named entries: the default names imply their role, other names give it', () => {
  const config = valid(`models:
  judgement: { ${URL_ENTRY} }
  classify:  { role: judgement, ${URL_ENTRY}, parallel: 4 }
  agent:     { model: homeserver/qwen3.8-27b }
  quick:     { role: agent, model: homeserver/qwen3.8-flash, parallel: 2, assume-prefix-cache: true }
  embed:     { role: embed, ${URL_ENTRY} }
`);
  assert.deepEqual(Object.keys(config.models), ['judgement', 'classify', 'agent', 'quick', 'embed']);
  assert.deepEqual(Object.values(config.models).map((m) => m.role), ['judgement', 'judgement', 'agent', 'agent', 'embed']);
  assert.deepEqual(config.models['agent'], { role: 'agent', model: 'homeserver/qwen3.8-27b', parallel: 1, assumePrefixCache: false });
  assert.deepEqual(config.models['quick'], { role: 'agent', model: 'homeserver/qwen3.8-flash', parallel: 2, assumePrefixCache: true }, 'how many fan-out items run at once on it; whether its engine caches prefixes it does not report');
  const classify = config.models['classify'];
  assert.ok(classify?.role === 'judgement');
  assert.equal(classify.parallel, 4);
  assert.deepEqual(config.models['judgement']?.role, 'judgement', 'the role is implied by the name');
});

test('a role that differs from a default name is an error; a name outside the defaults needs its role', () => {
  assert.ok(issues(`models:\n  judgement: { role: agent, model: p/m }`).some((i) => i.startsWith('models.judgement.role')));
  assert.ok(issues(`models:\n  agent: { role: embed, ${URL_ENTRY} }`).some((i) => i.startsWith('models.agent.role')));
  assert.ok(issues(`models:\n  classify: { ${URL_ENTRY} }`).some((i) => i.startsWith('models.classify.role')));
  assert.ok(issues(`models:\n  classify: { role: telepathy, ${URL_ENTRY} }`).some((i) => i.startsWith('models.classify.role')));
});

test('only judgement and agent models may have more than one entry', () => {
  assert.ok(issues(`models:\n  embed: { ${URL_ENTRY} }\n  big-embed: { role: embed, ${URL_ENTRY} }`).some((i) => i.startsWith('models.big-embed')));
  assert.ok(issues(`models:\n  rerank: { ${URL_ENTRY} }\n  second: { role: rerank, ${URL_ENTRY} }`).some((i) => i.startsWith('models.second')));
  // An embed or rerank model that is not named after its role would never be the default: that is said, not silently ignored.
  assert.ok(issues(`models:\n  mxbai: { role: embed, ${URL_ENTRY} }`).some((i) => i.startsWith('models.mxbai')));
});

test('an agent entry carries only the model, as Pi names it (provider/id), and its parallel', () => {
  assert.ok(issues('models:\n  agent: { model: p/m, parallel: 0 }').some((i) => i.startsWith('models.agent.parallel')));
  assert.ok(issues('models:\n  agent: { model: p/m, assume-prefix-cache: maybe }').some((i) => i.startsWith('models.agent.assume-prefix-cache')));
  assert.ok(issues(`models:\n  judgement: { ${URL_ENTRY}, assume-prefix-cache: true }`).some((i) => i.startsWith('models.judgement.assume-prefix-cache')), 'only agent models are Pi\'s to count');
  assert.ok(issues(`models:\n  agent: { model: p/m, url: "https://x/v1" }`).some((i) => i.startsWith('models.agent.url')));
  assert.ok(issues(`models:\n  agent: { model: p/m, token: "x" }`).some((i) => i.startsWith('models.agent.token')));
  assert.ok(issues('models:\n  agent: { model: just-an-id }').some((i) => i.startsWith('models.agent.model')), 'Pi would match a bare ID loosely');
  assert.ok(issues('models:\n  agent: { }').some((i) => i.startsWith('models.agent.model')));
  assert.ok(issues(`models:\n  judgement: { model: m }`).some((i) => i.startsWith('models.judgement.url')));
});

test('model names are well-formed, and unconfigured defaults are simply absent', () => {
  assert.ok(issues('models:\n  "bad name": { role: agent, model: p/m }').some((i) => i.includes('models.bad name') || i.startsWith('models')));
  const config = valid('models:\n  quick: { role: agent, model: p/m }');
  assert.equal(config.models['agent'], undefined, 'no default agent is configured, and that is not an error');
});

test('policy lists model names', () => {
  const config = valid('vaults:\n  - { id: a, path: /a }\npolicy:\n  - { vaults: [a], allow-models: [judgement, classify, quick] }');
  assert.deepEqual(config.policy, [{ vaults: ['a'], allowModels: ['judgement', 'classify', 'quick'] }]);
});

test('a vault may name the Git remote it is backed up to (local mode) or reviewed on (forge mode), as a remote name', () => {
  const config = valid('vaults:\n  - { id: a, path: /v/a, remote: flashstor }\n  - { id: b, path: /v/b }');
  assert.equal(config.vaults[0]?.remote, 'flashstor');
  assert.equal(config.vaults[1]?.remote, undefined, 'none: the vault stays on this machine');
  assert.ok(issues('vaults:\n  - { id: a, path: /v/a, remote: "https://example.net/a.git" }').some((i) => i.startsWith('vaults[0].remote')), 'a name, not a URL: the URL is the clone\'s');
});

test('a forge entry\'s auto-merge is on unless set to false; anything but true or false is a problem', () => {
  const off = parse('forges:\n  - { host: git.lan, type: gitea, token: "${T}", auto-merge: false }\n');
  assert.ok(off.ok);
  assert.equal(off.value.forges[0]?.autoMerge, false);
  const bad = parse('forges:\n  - { host: git.lan, type: gitea, token: "${T}", auto-merge: sometimes }\n');
  assert.ok(!bad.ok && bad.error.reason === 'invalid');
  assert.deepEqual(bad.error.issues, [{ path: 'forges[0].auto-merge', message: 'must be true or false' }]);
});
