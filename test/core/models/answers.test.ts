// Documented behaviour: concepts.md "Session tree" (an item that fails) and
// daemon.md "Outcomes" (`error`) — a model's answer is finished only when its
// request ended normally: one that ended in an error, was stopped, or was cut
// off at the model's output limit is not, and says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unfinishedAnswer } from '../../../src/core/models/index.ts';

test('an answer that ended normally, or to call a tool, is finished', () => {
  assert.equal(unfinishedAnswer({ stopReason: 'stop' }), undefined);
  assert.equal(unfinishedAnswer({ stopReason: 'toolUse' }), undefined);
});

test('an answer that ended in an error or was stopped is unfinished, with the provider\'s reason when it gave one', () => {
  assert.equal(unfinishedAnswer({ stopReason: 'error', errorMessage: 'Connection error.' }), 'Connection error.');
  assert.equal(unfinishedAnswer({ stopReason: 'error' }), 'the model request failed');
  assert.equal(unfinishedAnswer({ stopReason: 'error', errorMessage: '' }), 'the model request failed');
  assert.equal(unfinishedAnswer({ stopReason: 'aborted' }), 'the model request was stopped');
});

test('an answer cut off at the model\'s output limit is unfinished, though nothing went wrong', () => {
  assert.equal(unfinishedAnswer({ stopReason: 'length' }), 'the model reached its output limit before it finished');
});
