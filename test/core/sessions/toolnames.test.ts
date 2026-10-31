// Documented behaviour: extension.md "Tool names" — a tool call under a
// prefix a model puts before a tool's name (`tools.`, `functions.`) is renamed
// to the tool it means, but only when its own name is no tool's and the rest
// is one; the rest of the message is kept as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intendedToolName, withIntendedToolNames } from '../../../src/core/sessions/index.ts';

const tools = new Set(['vault_script', 'read', 'tools.real']);
const isTool = (name: string): boolean => tools.has(name);

test('a prefixed name means the tool behind the prefix, only when that is a tool and the name itself is not', () => {
  assert.equal(intendedToolName('tools.vault_script', isTool), 'vault_script');
  assert.equal(intendedToolName('functions.read', isTool), 'read');
  assert.equal(intendedToolName('vault_script', isTool), undefined, 'already a tool');
  assert.equal(intendedToolName('tools.real', isTool), undefined, 'a tool really named so is never shadowed');
  assert.equal(intendedToolName('tools.bash', isTool), undefined, 'no such tool behind the prefix');
  assert.equal(intendedToolName('tools.', isTool), undefined);
  assert.equal(intendedToolName('other.read', isTool), undefined, 'only the known prefixes');
});

test('a message keeps everything but the names it renames, and says which', () => {
  const message = {
    role: 'assistant', stopReason: 'toolUse',
    content: [
      { type: 'text', text: 'Planning.' },
      { type: 'toolCall', id: 'c1', name: 'tools.vault_script', arguments: { name: 'digest-plan' } },
      { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'a.md' } },
    ],
  };
  const corrected = withIntendedToolNames(message, isTool);
  assert.deepEqual(corrected?.renamed, [{ from: 'tools.vault_script', to: 'vault_script' }]);
  assert.deepEqual(corrected?.message, { ...message, content: [message.content[0], { ...message.content[1], name: 'vault_script' }, message.content[2]] });
  assert.equal(withIntendedToolNames({ ...message, content: [message.content[2]] }, isTool), undefined, 'nothing to rename');
  assert.equal(withIntendedToolNames({ role: 'user', content: [message.content[1]] }, isTool), undefined, 'only the model\'s own messages');
});
