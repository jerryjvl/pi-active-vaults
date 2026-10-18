// Documented behaviour: extension.md "Spawns" and daemon.md "Claims" — an
// event that matches a job's `spawn` condition becomes a spawn request whose
// identity (document and event) is fixed before it is sent to the daemon or
// queued, so a request that reached the daemon and was also queued after a
// lost reply is still one spawn. Jobs and conditions come from the accepted
// `main`; a vault with an unaccepted change is paused, not matched
// (security.md); an event reaches its own vault and the vaults subscribed to
// it; a condition's script can only narrow a match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allot, type BudgetLimits } from '../../../src/core/budgets/index.ts';
import type { VaultEvent } from '../../../src/core/conditions/index.ts';
import { createIdSource } from '../../../src/core/ids/index.ts';
import {
  enqueueSpawn, listSpawns, matchSpawns, reachedVaults, spawnEventKey, submitSpawns,
  type QueueContext, type SpawnMatching, type SpawnSender,
} from '../../../src/core/queue/index.ts';
import type { RegisteredVault } from '../../../src/core/registry/index.ts';
import { withTestVault, type TestVault } from '../../support/vault.ts';

const LIMITS: BudgetLimits = { depthDecay: 0.5, maxDepth: 4 };

function job(on: string, extra = ''): string {
  return `---\napplies-when:\n  - { on: ${on}, effect: spawn${extra} }\nbudget: { tokens: 1000, ttl: 10m }\nactor: gardener\n---\nDo the thing.\n`;
}

function matching(v: TestVault, vaults: readonly RegisteredVault[] = [v.vault]): SpawnMatching {
  return {
    git: v.git, store: v.store, vaults,
    match: { subscriptions: [], equivalentLabels: [] },
    scripts: { env: { PATH: process.env['PATH'] ?? '' }, timeoutMs: 10_000, os: process.platform === 'win32' ? 'win32' : 'linux', sandbox: 'none', builtins: [] },
  };
}

function queueContext(v: TestVault): QueueContext {
  let n = 0;
  return { ids: createIdSource({ clock: v.clock, randomBytes: (k) => new Uint8Array(k).fill(++n % 256) }), clock: v.clock, limits: LIMITS };
}

const external: VaultEvent = { kind: 'external', vault: 'home', name: 'refresh' };

test('a matching job becomes a request with the document, condition, budget and the event under its fixed identity', withTestVault(async (v) => {
  v.repo.write('jobs/refresh.md', job('external', ', name: refresh'));
  v.repo.write('jobs/other.md', job('external', ', name: other'));
  v.repo.write('jobs/unbudgeted.md', '---\napplies-when: [{ on: external, name: refresh, effect: spawn }]\n---\n');
  v.repo.commit('jobs');
  v.accept();
  const matched = await matchSpawns(matching(v), { event: external, id: 'E1' }, [v.vault], { parent: 'PARENT' });
  assert.ok(matched.ok);
  assert.deepEqual(matched.value.requests, [{
    vault: 'home', document: 'jobs/refresh.md', condition: 0, event: { ...external, id: 'E1' }, budget: { tokens: 1000, ttlMs: 600_000 }, actor: 'gardener', parent: 'PARENT',
  }]);
  assert.deepEqual(matched.value.paused, []);
}));

test('a Git event is its own identity and carries no added ID', withTestVault(async (v) => {
  v.repo.write('jobs/watch.md', job('committed'));
  v.repo.commit('job');
  v.accept();
  const event: VaultEvent = { kind: 'committed', vault: 'home', commit: 'a'.repeat(40), changes: [] };
  const matched = await matchSpawns(matching(v), { event }, [v.vault]);
  assert.ok(matched.ok);
  assert.deepEqual(matched.value.requests.map((r) => r.event), [event]);
}));

test('jobs come from the accepted main only; a vault with an unaccepted change is paused, not matched', withTestVault(async (v) => {
  v.repo.write('jobs/refresh.md', job('external', ', name: refresh'));
  v.repo.commit('unaccepted job');
  const paused = await matchSpawns(matching(v), { event: external, id: 'E1' }, [v.vault]);
  assert.ok(paused.ok);
  assert.deepEqual(paused.value, { requests: [], dropped: [], paused: ['home'] });
}));

test('an event reaches its own vault and those subscribed to it', () => {
  const vault = (id: string): RegisteredVault => ({ id, path: `/v/${id}`, worktrees: `/w/${id}`, host: false });
  const vaults = [vault('a'), vault('b'), vault('c')];
  const subscriptions = [{ from: 'a', to: 'c' }];
  assert.deepEqual(reachedVaults(vaults, subscriptions, 'a').map((v) => v.id), ['a', 'c']);
  assert.deepEqual(reachedVaults(vaults, subscriptions, 'b').map((v) => v.id), ['b']);
  assert.deepEqual(reachedVaults(vaults, subscriptions, undefined).map((v) => v.id), ['a', 'b', 'c'], 'a session-wide event reaches every vault');
});

test('a request is queued with its identity; the same request again is the same spawn', withTestVault(async (v) => {
  v.repo.write('jobs/refresh.md', job('external', ', name: refresh'));
  v.repo.commit('job');
  v.accept();
  const matched = await matchSpawns(matching(v), { event: external, id: 'E1' }, [v.vault]);
  assert.ok(matched.ok);
  const first = await submitSpawns(v.store, queueContext(v), matched.value.requests);
  const again = await submitSpawns(v.store, queueContext(v), matched.value.requests);
  assert.equal(first[0]?.state, 'queued');
  assert.equal(again[0]?.trace, first[0]?.trace);
  assert.equal(listSpawns(v.store).length, 1);
}));

test('a request the daemon claimed and whose reply was lost is queued as the same spawn', withTestVault(async (v) => {
  v.repo.write('jobs/refresh.md', job('external', ', name: refresh'));
  v.repo.commit('job');
  v.accept();
  const matched = await matchSpawns(matching(v), { event: external, id: 'E1' }, [v.vault]);
  assert.ok(matched.ok);
  const context = queueContext(v);
  const lostReply: SpawnSender = async (request) => {
    enqueueSpawn(v.store, context, request); // the daemon claims it…
    throw new Error('connection reset'); // …and the reply never arrives
  };
  const entries = await submitSpawns(v.store, context, matched.value.requests, lostReply);
  assert.equal(entries.length, 1);
  assert.equal(listSpawns(v.store).length, 1, 'one spawn, not two');
  const accepted: SpawnSender = async (request) => enqueueSpawn(v.store, context, request).entry;
  assert.equal((await submitSpawns(v.store, context, matched.value.requests, accepted))[0]?.trace, entries[0]?.trace);
}));

test('a condition\'s script can only narrow a match; a dropped match says why', { skip: process.platform === 'win32' ? 'POSIX shell scripts' : false }, withTestVault(async (v) => {
  v.repo.write('.vault/scripts/never.sh', '#!/bin/sh\n# name: never\n# summary: Never matches\nexit 1\n');
  v.repo.write('jobs/refresh.md', job('external', ', name: refresh, script: never'));
  v.repo.commit('job');
  v.accept();
  const matched = await matchSpawns(matching(v), { event: external, id: 'E1' }, [v.vault]);
  assert.ok(matched.ok);
  assert.deepEqual(matched.value.requests, []);
  assert.deepEqual(matched.value.dropped, [{ vault: 'home', document: 'jobs/refresh.md', reason: 'exit 1' }]);
}));

test('a request runs as the job\'s actor; a job with no actor is not matched', withTestVault(async (v) => {
  v.repo.write('jobs/refresh.md', job('external', ', name: refresh'));
  v.repo.write('jobs/actorless.md', '---\napplies-when: [{ on: external, name: refresh, effect: spawn }]\nbudget: { tokens: 1000, ttl: 10m }\n---\n');
  v.repo.commit('jobs');
  v.accept();
  const matched = await matchSpawns(matching(v), { event: external, id: 'E1' }, [v.vault]);
  assert.ok(matched.ok);
  assert.deepEqual(matched.value.requests.map((r) => [r.document, r.actor]), [['jobs/refresh.md', 'gardener']]);
  const [entry] = await submitSpawns(v.store, queueContext(v), matched.value.requests);
  assert.equal(entry?.actor, 'gardener', 'the claim records whom it runs as');
}));

// concepts.md "Session tree": an event from a commit carrying a run's
// Vault-Trace continues that run's tree; commits without one start new trees;
// a merge's changes are attributed to the commits that made them, so one
// merge can continue several trees.
test('a merge\'s changes continue the trees of the runs that made them; a person\'s change starts a new one', withTestVault(async (v) => {
  v.repo.write('jobs/watch.md', job('merged'));
  v.repo.commit('job');
  v.accept();
  const run = 'R'.repeat(26);
  v.store.transaction((tx) => allot(tx, LIMITS, v.clock, { trace: run, budget: { tokens: 1000, ttlMs: 60_000 } }));
  const elsewhere = 'E'.repeat(26);
  const change = (path: string, trace?: string) => ({ path, change: 'created' as const, labels: [], commit: 'c'.repeat(40), ...(trace === undefined ? {} : { trace }) });
  const event: VaultEvent = { kind: 'merged', vault: 'home', commit: 'm'.repeat(40), changes: [change('a.md', run), change('b.md'), change('c.md', elsewhere)] };
  const matched = await matchSpawns(matching(v), { event }, [v.vault]);
  assert.ok(matched.ok);
  const requests = matched.value.requests.map((r) => ({ tree: (r.event as { tree?: string }).tree, parent: r.parent, paths: 'changes' in r.event ? r.event.changes.map((c) => c.path) : [] }));
  assert.deepEqual(requests, [
    { tree: undefined, parent: undefined, paths: ['b.md'] },
    { tree: elsewhere, parent: undefined, paths: ['c.md'] },
    { tree: run, parent: run, paths: ['a.md'] },
  ], 'one spawn per tree; a run not known here starts a new tree, still under its own identity');
  const keys = matched.value.requests.map((r) => spawnEventKey(r.event));
  assert.equal(new Set(keys).size, 3);
  assert.equal(keys[2], `merged:home:${'m'.repeat(40)}@${run}`);
}));

test('a job whose own run made the change does not fire again in that run\'s tree', withTestVault(async (v) => {
  v.repo.write('jobs/watch.md', job('merged'));
  v.repo.commit('job');
  v.accept();
  const context = queueContext(v);
  const first = enqueueSpawn(v.store, context, { vault: 'home', document: 'jobs/watch.md', event: { kind: 'manual', id: 'M' }, budget: { tokens: 100, ttlMs: 60_000 }, actor: 'gardener' }).entry;
  const event: VaultEvent = { kind: 'merged', vault: 'home', commit: 'm'.repeat(40), changes: [{ path: 'out.md', change: 'created', labels: [], commit: 'c'.repeat(40), trace: first.trace }] };
  const matched = await matchSpawns(matching(v), { event }, [v.vault]);
  assert.ok(matched.ok);
  const [again] = await submitSpawns(v.store, context, matched.value.requests);
  assert.deepEqual([again?.state, again?.reason], ['stopped', 'already-in-tree']);
}));
