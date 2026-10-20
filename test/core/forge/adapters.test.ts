// Documented behaviour: core.md `forge` — one adapter interface over Gitea,
// GitHub and GitLab: the executor's account, opening or updating a pull
// request, publishing commit statuses, reading owners' approvals of an exact
// commit, reading the pull requests merged most recently, and reading branch protection and the repository's merge methods
// (security-setup.md: squash and rebase merges must be disabled). Each forge's own API shapes and
// token header; requests never follow redirects and errors never carry the
// token. Local stub servers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ForgeEntry, ForgeType } from '../../../src/core/config/index.ts';
import { UNPROTECTED, forgeAdapter, forgeProject, protectionProblems, type ForgeAdapter } from '../../../src/core/forge/index.ts';
import { FORGE_TOKEN, startForgeStub, type ForgeModel, type ForgeStub } from '../../support/forge-stub.ts';
import { startStubServer } from '../../support/stub-server.ts';

const TYPES: readonly ForgeType[] = ['gitea', 'github', 'gitlab'];
const SHA_1 = '1'.repeat(40);
const SHA_2 = '2'.repeat(40);

const entry = (type: ForgeType, api: string): ForgeEntry => ({ host: 'git.example.net', type, token: { kind: 'env', name: 'FORGE_TOKEN', where: 'forges[0].token' }, api, autoMerge: true });
const deps = { client: { fetch, timeoutMs: 5000 }, secrets: { env: { FORGE_TOKEN }, runCommand: async () => assert.fail('no command') } };

async function withForge(type: ForgeType, run: (adapter: ForgeAdapter, stub: ForgeStub) => Promise<void>, model: Partial<ForgeModel> = {}): Promise<void> {
  const stub = await startForgeStub(type, () => SHA_2, model);
  try {
    await run(forgeAdapter(entry(type, stub.api), 'home/vault', deps), stub);
  } finally {
    await stub.server.close();
  }
}

for (const type of TYPES) {
  test(`${type}: the executor's account is read with the forge's own token header`, () => withForge(type, async (adapter) => {
    assert.deepEqual(await adapter.account(), { ok: true, value: 'vault-bot' });
  }));

  test(`${type}: a pull request for an actor branch is found, opened, and updated`, () => withForge(type, async (adapter, stub) => {
    assert.deepEqual(await adapter.findPullRequest('actor/gardener', 'main'), { ok: true, value: undefined });
    const opened = await adapter.openPullRequest({ head: 'actor/gardener', base: 'main', title: 'Proposal from gardener', body: 'Two commits.' });
    assert.ok(opened.ok, JSON.stringify(opened));
    assert.deepEqual({ ...opened.value, url: '' }, { number: 1, url: '', head: 'actor/gardener', headSha: SHA_2, state: 'open' });
    const found = await adapter.findPullRequest('actor/gardener', 'main');
    assert.equal(found.ok && found.value?.number, 1);
    assert.equal((await adapter.findPullRequest('actor/librarian', 'main')).ok, true);
    assert.ok((await adapter.updatePullRequest(1, { title: 'Proposal from gardener (3 commits)', body: 'Three.' })).ok);
    assert.deepEqual([stub.model.pulls[0]?.title, stub.model.pulls[0]?.body], ['Proposal from gardener (3 commits)', 'Three.']);
  }));

  test(`${type}: commit statuses are published, each state in the forge's own words, descriptions kept short`, () => withForge(type, async (adapter, stub) => {
    assert.ok((await adapter.setStatus(SHA_1, { context: 'vault/policy', state: 'failure', description: 'x'.repeat(300) })).ok);
    assert.ok((await adapter.setStatus(SHA_1, { context: 'vault/check/links', state: 'success', description: 'pass' })).ok);
    const [policy, check] = stub.model.statuses;
    assert.deepEqual([policy?.context, policy?.state, policy?.description.length], ['vault/policy', type === 'gitlab' ? 'failed' : 'failure', 140]);
    assert.deepEqual([check?.sha, check?.state], [SHA_1, 'success']);
  }));

  test(`${type}: the pull requests merged most recently into a branch are read newest first, each with the head it was merged at`, () => withForge(type, async (adapter) => {
    const merged = await adapter.mergedPullRequests('main');
    assert.ok(merged.ok, JSON.stringify(merged));
    assert.deepEqual(merged.value.map((p) => [p.number, p.head, p.headSha, p.state]), [
      [5, 'actor/gardener', SHA_2, 'merged'],
      [1, 'actor/gardener', SHA_1, 'merged'],
    ], 'not open, not closed unmerged, not into another branch');
  }, { pulls: [
    { number: 1, head: 'actor/gardener', base: 'main', title: '', body: '', state: 'merged', sha: SHA_1 },
    { number: 2, head: 'actor/librarian', base: 'main', title: '', body: '', state: 'open' },
    { number: 3, head: 'actor/librarian', base: 'main', title: '', body: '', state: 'closed' },
    { number: 4, head: 'actor/librarian', base: 'other', title: '', body: '', state: 'merged', sha: SHA_1 },
    { number: 5, head: 'actor/gardener', base: 'main', title: '', body: '', state: 'merged', sha: SHA_2 },
  ] }));

  test(`${type}: a missing branch protection is reported as unprotected`, () => withForge(type, async (adapter) => {
    const read = await adapter.protection('main');
    assert.ok(read.ok);
    assert.equal(read.value.protected, false);
  }));
}

const reviews: ForgeModel['reviews'] = [
  { pull: 1, user: 'alice', state: 'APPROVED', commit: SHA_1 },
  { pull: 1, user: 'bob', state: 'APPROVED', commit: SHA_1 },
  { pull: 1, user: 'bob', state: 'CHANGES_REQUESTED', commit: SHA_2 },
  { pull: 1, user: 'carol', state: 'APPROVED', commit: SHA_2 },
  { pull: 1, user: 'carol', state: 'COMMENTED', commit: SHA_2 },
  { pull: 1, user: 'dave', state: 'DISMISSED', commit: SHA_2 },
];
const pull = { number: 1, head: 'actor/gardener', base: 'main', title: 't', body: 'b', state: 'open' as const };

for (const type of ['gitea', 'github'] as const) {
  test(`${type}: approvals are each user's standing approval, with the exact commit approved`, () => withForge(type, async (adapter) => {
    const approvals = await adapter.approvals({ number: 1, url: '', head: 'actor/gardener', headSha: SHA_2, state: 'open' });
    assert.deepEqual(approvals, { ok: true, value: [{ user: 'alice', commit: SHA_1 }, { user: 'carol', commit: SHA_2 }] });
  }, { pulls: [{ ...pull }], reviews }));
}

test('github: reviews are read across every page; a review by a deleted account counts for nothing', () => withForge('github', async (adapter, stub) => {
  const approvals = await adapter.approvals({ number: 1, url: '', head: 'actor/gardener', headSha: SHA_2, state: 'open' });
  assert.deepEqual(approvals, { ok: true, value: [{ user: 'alice', commit: SHA_2 }] });
  const pages = stub.server.requests.filter((r) => r.url.includes('/reviews')).map((r) => new URL(r.url, 'http://stub').searchParams.get('page'));
  assert.deepEqual(pages, ['1', '2']);
}, { pulls: [{ ...pull }], reviews: [
  ...Array.from({ length: 120 }, (_, i) => ({ pull: 1, user: `commenter-${i}`, state: 'COMMENTED', commit: SHA_1 } as const)),
  { pull: 1, user: 'alice', state: 'APPROVED', commit: SHA_2 },
  { pull: 1, user: null, state: 'APPROVED', commit: SHA_2 },
] }));

test('gitlab: approvals count for the head commit only where approvals are reset on push; otherwise their commit is unknown', async () => {
  const pr = { number: 1, url: '', head: 'actor/gardener', headSha: SHA_2, state: 'open' as const };
  await withForge('gitlab', async (adapter) => {
    assert.deepEqual(await adapter.approvals(pr), { ok: true, value: [{ user: 'alice', commit: SHA_2 }, { user: 'carol', commit: SHA_2 }] });
  }, { pulls: [{ ...pull }], reviews, gitlab: { resetApprovalsOnPush: true, pipelinesMustSucceed: true } });
  for (const resetApprovalsOnPush of [false, undefined]) {
    await withForge('gitlab', async (adapter) => {
      assert.deepEqual(await adapter.approvals(pr), { ok: true, value: [{ user: 'alice' }, { user: 'carol' }] });
    }, { pulls: [{ ...pull }], reviews, gitlab: { ...(resetApprovalsOnPush === undefined ? {} : { resetApprovalsOnPush }), pipelinesMustSucceed: true } });
  }
});

test('branch protection is read in each forge\'s terms', async () => {
  await withForge('gitea', async (adapter) => {
    assert.deepEqual(await adapter.protection('main'), { ok: true, value: {
      protected: true, directPushes: false, forcePushes: false, deletion: false, requiresPolicyStatus: true, requiredApprovals: 1,
    } });
  }, { protection: { enable_push: false, enable_force_push: false, enable_status_check: true, status_check_contexts: ['vault/policy'], required_approvals: 1 } });
  await withForge('github', async (adapter) => {
    assert.deepEqual(await adapter.protection('main'), { ok: true, value: {
      protected: true, directPushes: false, forcePushes: true, deletion: false, requiresPolicyStatus: false, requiredApprovals: 2,
    } });
  }, { protection: {
    required_status_checks: { contexts: ['ci'], checks: [{ context: 'ci' }] },
    required_pull_request_reviews: { required_approving_review_count: 2 },
    allow_force_pushes: { enabled: true }, allow_deletions: { enabled: false },
  } });
  await withForge('github', async (adapter) => {
    assert.deepEqual(await adapter.protection('main'), { ok: true, value: {
      protected: true, directPushes: false, forcePushes: false, deletion: false, requiresPolicyStatus: true, requiredApprovals: 1,
    } }, 'a main protected by a ruleset alone is protected');
  }, { rules: [
    { type: 'deletion', ruleset_source_type: 'Repository', ruleset_source: 'home/vault', ruleset_id: 7 },
    { type: 'non_fast_forward', ruleset_source_type: 'Repository', ruleset_source: 'home/vault', ruleset_id: 7 },
    { type: 'pull_request', ruleset_id: 7, parameters: {
      required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_code_owner_review: false,
      require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ['merge'],
    } },
    { type: 'required_status_checks', ruleset_source_type: 'Organization', ruleset_source: 'home', ruleset_id: 9, parameters: {
      required_status_checks: [{ context: 'vault/policy' }], strict_required_status_checks_policy: false,
    } },
    { type: 'commit_message_pattern', ruleset_id: 9, parameters: { operator: 'starts_with', pattern: 'x' } },
  ] });
  await withForge('github', async (adapter) => {
    assert.deepEqual(await adapter.protection('main'), { ok: true, value: {
      protected: true, directPushes: false, forcePushes: false, deletion: true, requiresPolicyStatus: false, requiredApprovals: 2,
    } }, 'branch protection and rulesets together: each restriction from either, the most approvals of both');
  }, {
    protection: { required_pull_request_reviews: { required_approving_review_count: 2 }, allow_force_pushes: { enabled: true }, allow_deletions: { enabled: true } },
    rules: [{ type: 'non_fast_forward', ruleset_id: 3 }, { type: 'pull_request', ruleset_id: 3, parameters: { required_approving_review_count: 1 } }],
  });
  await withForge('github', async (adapter) => {
    assert.equal((await adapter.protection('main')).ok, false, 'a rule not in GitHub\'s shape is an error, not a guess');
  }, { rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 'one' } }] });
  await withForge('gitlab', async (adapter) => {
    assert.deepEqual(await adapter.protection('main'), { ok: true, value: {
      protected: true, directPushes: true, forcePushes: false, deletion: false, requiresPolicyStatus: true, requiredApprovals: 'unknown',
    } });
  }, { protection: { push_access_levels: [{ access_level: 40 }], allow_force_push: false }, gitlab: { pipelinesMustSucceed: true } });
});

test('the merge methods that replace a proposal\'s commits are read in each forge\'s terms, and unknown where the forge does not say', async () => {
  const unknown = { squash: 'unknown', rebase: 'unknown' };
  const cases: [ForgeType, Record<string, unknown>, object][] = [
    ['gitea', {}, unknown],
    ['gitea', { allow_squash_merge: false, allow_rebase: false, allow_rebase_explicit: false }, { squash: false, rebase: false }],
    ['gitea', { allow_squash_merge: true, allow_rebase: false, allow_rebase_explicit: true }, { squash: true, rebase: true }],
    ['gitea', { allow_squash_merge: false, allow_rebase: true }, { squash: false, rebase: true }],
    ['gitea', { allow_squash_merge: false, allow_rebase: false }, { squash: false, rebase: 'unknown' }],
    ['github', {}, unknown],
    ['github', { allow_squash_merge: false, allow_rebase_merge: false }, { squash: false, rebase: false }],
    ['github', { allow_squash_merge: true, allow_rebase_merge: true }, { squash: true, rebase: true }],
    ['gitlab', {}, unknown],
    ['gitlab', { squash_option: 'never', merge_method: 'merge' }, { squash: false, rebase: false }],
    ['gitlab', { squash_option: 'default_off', merge_method: 'merge', automatic_rebase_enabled: true }, { squash: true, rebase: false }],
    ['gitlab', { squash_option: 'never', merge_method: 'ff', automatic_rebase_enabled: true }, { squash: false, rebase: true }],
    ['gitlab', { squash_option: 'never', merge_method: 'rebase_merge', automatic_rebase_enabled: false }, { squash: false, rebase: false }],
    ['gitlab', { squash_option: 'never', merge_method: 'ff' }, { squash: false, rebase: 'unknown' }],
  ];
  for (const [type, repository, expected] of cases) {
    await withForge(type, async (adapter) => {
      assert.deepEqual(await adapter.mergeMethods(), { ok: true, value: expected }, `${type}: ${JSON.stringify(repository)}`);
    }, { repository });
  }
  await withForge('github', async (adapter) => {
    assert.equal((await adapter.mergeMethods()).ok, false, 'a refusal is an error, for doctor to report as cannot verify');
  }, { repository: 'forbidden' });
});

test('a forge is found by the host of the vault\'s remote, and the project by its path', () => {
  const forges = [entry('gitea', 'http://127.0.0.1:1/api/v1'), { ...entry('github', ''), host: 'github.com' }];
  for (const url of ['https://git.example.net/home/vault.git', 'ssh://git@git.example.net:2222/home/vault.git', 'git@git.example.net:home/vault.git', 'https://git.example.net/home/vault']) {
    const found = forgeProject(forges, url);
    assert.ok(found.ok, url);
    assert.deepEqual([found.value.entry.type, found.value.project], ['gitea', 'home/vault'], url);
  }
  const nested = forgeProject([{ ...entry('gitlab', ''), host: 'gitlab.example.net' }], 'https://gitlab.example.net/group/sub/vault.git');
  assert.ok(nested.ok && nested.value.project === 'group/sub/vault');
  assert.deepEqual(forgeProject(forges, 'https://elsewhere.example.net/home/vault.git'), { ok: false, error: { reason: 'no-forge', host: 'elsewhere.example.net' } });
  assert.deepEqual(forgeProject(forges, '/srv/git/vault.git'), { ok: false, error: { reason: 'no-forge', host: '' } });
});

test('a failing, redirecting or unauthorised forge is an error naming the forge, never the token', async () => {
  for (const status of [500, 307]) {
    const failing = await startStubServer(() => ({ status, headers: { location: 'http://127.0.0.1:1/' }, body: FORGE_TOKEN }));
    try {
      const adapter = forgeAdapter(entry('gitea', `${failing.url}/api/v1`), 'home/vault', deps);
      const account = await adapter.account();
      assert.deepEqual(account, { ok: false, error: { reason: status === 307 ? 'redirected' : 'http-error', status, forge: 'git.example.net' } });
      assert.ok(!JSON.stringify(account).includes(FORGE_TOKEN));
    } finally {
      await failing.close();
    }
  }
  await withForge('gitea', async (_adapter, stub) => {
    const noToken = forgeAdapter(entry('gitea', stub.api), 'home/vault', { ...deps, secrets: { env: {}, runCommand: deps.secrets.runCommand } });
    assert.deepEqual(await noToken.account(), { ok: false, error: { reason: 'token', forge: 'git.example.net', where: 'forges[0].token' } });
  });
});

test('the recommended setup is checked: protected main, pull requests only, vault/policy required, owner approval, no squash or rebase merges, an executor that is not an owner', () => {
  const recommended = { protected: true, directPushes: false, forcePushes: false, deletion: false, requiresPolicyStatus: true, requiredApprovals: 1 } as const;
  const bot = { account: 'vault-bot', owners: ['alice'], merges: { squash: false, rebase: false } } as const;
  assert.deepEqual(protectionProblems(recommended, bot), []);
  assert.deepEqual(protectionProblems(UNPROTECTED, bot), ['not-protected']);
  assert.deepEqual(protectionProblems({ ...recommended, directPushes: true, forcePushes: true, deletion: true }, bot),
    ['direct-pushes', 'force-pushes', 'deletion']);
  assert.deepEqual(protectionProblems({ ...recommended, requiresPolicyStatus: false, requiredApprovals: 0 }, { ...bot, account: 'alice' }),
    ['policy-status-not-required', 'approval-not-required', 'executor-is-owner']);
  assert.deepEqual(protectionProblems({ ...recommended, requiredApprovals: 'unknown' }, bot), ['approval-unknown']);
  assert.deepEqual(protectionProblems(recommended, { ...bot, merges: { squash: true, rebase: false } }), ['squash-merges'], 'they discard the commits trailers, attestations and traces are on');
  assert.deepEqual(protectionProblems(recommended, { ...bot, merges: { squash: false, rebase: true } }), ['rebase-merges'], 'a rebase replaces them with new commits');
  assert.deepEqual(protectionProblems(recommended, { ...bot, merges: { squash: true, rebase: true } }), ['squash-merges', 'rebase-merges']);
  assert.deepEqual(protectionProblems(UNPROTECTED, { ...bot, merges: { squash: 'unknown', rebase: false } }), ['not-protected', 'merges-unknown']);
  assert.deepEqual(protectionProblems(recommended, { ...bot, merges: { squash: false, rebase: 'unknown' } }), ['merges-unknown']);
});
