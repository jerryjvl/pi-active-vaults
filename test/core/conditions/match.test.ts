// Documented behaviour: concepts.md "applies-when" — Git and session events are
// matched against conditions; conditions never name other vaults, events from
// another vault reach a document only through a subscription, and labels match
// across vaults only where the installation declares them equivalent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchConditions,
  type Candidate,
  type ChangedDocument,
  type Condition,
  type MatchContext,
  type VaultEvent,
} from '../../../src/core/conditions/index.ts';

const spawn = (fields: Partial<Condition> & Pick<Condition, 'on'>): Condition => ({ effect: 'spawn', context: 'session-preferred', ...fields });
const inject = (fields: Partial<Condition> & Pick<Condition, 'on'>): Condition => ({ effect: 'inject', ...fields });

const NO_LINKS: MatchContext = { subscriptions: [], equivalentLabels: [] };

const merged = (vault: string, ...changes: ChangedDocument[]): VaultEvent =>
  ({ kind: 'merged', vault, commit: 'a'.repeat(40), changes });

const matched = (event: VaultEvent, candidates: Candidate[], context = NO_LINKS): string[] =>
  matchConditions(event, candidates, context).map((m) => `${m.vault}:${m.document}#${m.index}`);

test('a Git event matches when one change passes every filter of the condition', () => {
  const candidates: Candidate[] = [{
    vault: 'home',
    document: 'jobs/cars.md',
    conditions: [
      spawn({ on: 'merged', paths: ['topics/cars/**'], change: ['created', 'modified'] }),
      spawn({ on: 'merged', paths: ['topics/cars/**'], change: ['deleted'] }),
      spawn({ on: 'committed', paths: ['topics/cars/**'] }),
      spawn({ on: 'merged', labels: ['tyres'] }),
    ],
  }];
  const event = merged('home',
    { path: 'topics/cars/a.md', change: 'modified', labels: [] },
    { path: 'topics/boats/b.md', change: 'deleted', labels: ['tyres'] });
  assert.deepEqual(matched(event, candidates), ['home:jobs/cars.md#0', 'home:jobs/cars.md#3']);
});

test('a rename matches a path filter by its new or its old path', () => {
  const candidates: Candidate[] = [{ vault: 'home', document: 'j.md', conditions: [spawn({ on: 'merged', paths: ['old/**'] })] }];
  assert.deepEqual(matched(merged('home', { path: 'new/a.md', oldPath: 'old/a.md', change: 'renamed', labels: [] }), candidates), ['home:j.md#0']);
});

test('a condition without filters matches every event of its kind', () => {
  const candidates: Candidate[] = [{ vault: 'home', document: 'j.md', conditions: [spawn({ on: 'merged' })] }];
  assert.deepEqual(matched(merged('home'), candidates), ['home:j.md#0']);
});

test('events from another vault reach a document only through a subscription', () => {
  const candidates: Candidate[] = [{ vault: 'private', document: 'watch.md', conditions: [spawn({ on: 'merged' })] }];
  const event = merged('digests', { path: 'x.md', change: 'created', labels: [] });
  assert.deepEqual(matched(event, candidates), []);
  assert.deepEqual(matched(event, candidates, { subscriptions: [{ from: 'private', to: 'digests' }], equivalentLabels: [] }), [], 'direction matters');
  assert.deepEqual(matched(event, candidates, { subscriptions: [{ from: 'digests', to: 'private' }], equivalentLabels: [] }), ['private:watch.md#0']);
});

test('path filters never match another vault\'s paths, even when subscribed', () => {
  const candidates: Candidate[] = [{ vault: 'private', document: 'w.md', conditions: [spawn({ on: 'merged', paths: ['**'] })] }];
  const context: MatchContext = { subscriptions: [{ from: 'digests', to: 'private' }], equivalentLabels: [] };
  assert.deepEqual(matched(merged('digests', { path: 'x.md', change: 'created', labels: [] }), candidates, context), []);
});

test('labels match within a vault by name, across vaults only where declared equivalent', () => {
  const candidates: Candidate[] = [{ vault: 'private', document: 'w.md', conditions: [spawn({ on: 'merged', labels: ['geopolitics'] })] }];
  const subscribed = { subscriptions: [{ from: 'digests', to: 'private' }] };
  const foreign = merged('digests', { path: 'd.md', change: 'created', labels: ['geopolitics'] });
  assert.deepEqual(matched(foreign, candidates, { ...subscribed, equivalentLabels: [] }), [], 'the same word is not the same label');
  assert.deepEqual(matched(foreign, candidates, { ...subscribed, equivalentLabels: [['private:geopolitics', 'digests:geopolitics']] }), ['private:w.md#0']);
  assert.deepEqual(matched(merged('private', { path: 'p.md', change: 'created', labels: ['geopolitics'] }), candidates), ['private:w.md#0']);
});

test('session events match by tool, path and model', () => {
  const candidates: Candidate[] = [{
    vault: 'home',
    document: 'memory.md',
    conditions: [
      inject({ on: 'session.start', model: 'big-model' }),
      inject({ on: 'session.tool', tools: ['bash'] }),
      inject({ on: 'session.path', paths: ['projects/infrastructure/**'] }),
    ],
  }];
  assert.deepEqual(matched({ kind: 'session.start', model: 'big-model' }, candidates), ['home:memory.md#0']);
  assert.deepEqual(matched({ kind: 'session.start', model: 'small-model' }, candidates), []);
  assert.deepEqual(matched({ kind: 'session.tool', tool: 'bash' }, candidates), ['home:memory.md#1']);
  assert.deepEqual(matched({ kind: 'session.tool', tool: 'read' }, candidates), []);
  assert.deepEqual(matched({ kind: 'session.path', vault: 'home', path: 'projects/infrastructure/net.md' }, candidates), ['home:memory.md#2']);
  assert.deepEqual(matched({ kind: 'session.path', vault: 'other', path: 'projects/infrastructure/net.md' }, candidates), []);
});

test('external events match by name, in their own vault', () => {
  const candidates: Candidate[] = [{ vault: 'home', document: 'j.md', conditions: [spawn({ on: 'external', name: 'doorbell' })] }];
  assert.deepEqual(matched({ kind: 'external', vault: 'home', name: 'doorbell' }, candidates), ['home:j.md#0']);
  assert.deepEqual(matched({ kind: 'external', vault: 'home', name: 'phone' }, candidates), []);
});

test('matches come in a stable order: by vault, document, then condition', () => {
  const candidates: Candidate[] = [
    { vault: 'b', document: 'z.md', conditions: [spawn({ on: 'session.start' })] },
    { vault: 'a', document: 'y.md', conditions: [spawn({ on: 'session.start' }), spawn({ on: 'session.start' })] },
    { vault: 'a', document: 'x.md', conditions: [spawn({ on: 'session.start' })] },
  ];
  assert.deepEqual(matched({ kind: 'session.start' }, candidates), ['a:x.md#0', 'a:y.md#0', 'a:y.md#1', 'b:z.md#0']);
});
