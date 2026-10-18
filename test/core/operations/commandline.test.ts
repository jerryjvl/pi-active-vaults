// Documented behaviour: cli.md "Conventions" and api.md "Commands" — a
// command line is read into an operation's parameters from its own specs, the
// same for the `vault` CLI and Pi's `/vault` commands; each surface offers
// only its own parameters. Pi hands a command its arguments as one string, so
// quoting groups words as a shell would, without running anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignPositionals, commandRequest, describeCommandLineError, operationNamed, parseLine, splitArguments, usage } from '../../../src/core/operations/index.ts';
import type { RegisteredVault } from '../../../src/core/registry/index.ts';

const op = (name: string) => {
  const found = operationNamed(name);
  if (found === undefined) throw new Error(name);
  return found;
};

test('arguments are split on spaces, with quotes grouping words and backslashes escaping; nothing is expanded', () => {
  assert.deepEqual(splitArguments('  review   gardener '), ['review', 'gardener']);
  assert.deepEqual(splitArguments(`trace "a b" 'c "d"' e\\ f`), ['trace', 'a b', 'c "d"', 'e f']);
  assert.deepEqual(splitArguments('run $HOME/x `id` *.md'), ['run', '$HOME/x', '`id`', '*.md']);
  assert.deepEqual(splitArguments('""'), ['']);
  assert.deepEqual(splitArguments(''), []);
});

test('an unterminated quote takes the rest of the line', () => {
  assert.deepEqual(splitArguments('accept "half open'), ['accept', 'half open']);
});

test('a command line fills the parameters its surface offers, and only those', () => {
  const accept = op('accept');
  const line = parseLine(accept, ['--adopt', 'abc', '--yes'], 'command');
  assert.deepEqual(line.params, { adopt: 'abc', yes: true });
  assert.deepEqual(line.problems, []);
  const commit = op('commit');
  assert.deepEqual(parseLine(commit, ['-m', 'x', '--actor', 'gardener'], 'cli').params, { message: 'x', actor: 'gardener' });
  assert.match(parseLine(commit, ['--actor', 'gardener'], 'tool').problems.join(), /--actor is not an option/);
});

test('positionals fill positional parameters in order; the rest is returned', () => {
  const params: Record<string, unknown> = {};
  assert.deepEqual(assignPositionals(op('review'), params, ['gardener', 'extra'], 'command'), ['extra']);
  assert.deepEqual(params, { actor: 'gardener' });
});

test('usage names the command as its surface types it', () => {
  assert.match(usage(op('review'), 'cli'), /^vault review \[vault\] <actor>\n/);
  assert.match(usage(op('review'), 'command'), /^\/vault review \[vault\] <actor>\n/);
});

const vault = (id: string): RegisteredVault => ({ id, path: `/v/${id}`, worktrees: `/w/${id}`, host: false });
const installation = { vaults: [vault('home'), vault('work')] };

test('a command line becomes a request: a first argument naming a vault is the vault, when what remains still fills the command', () => {
  const review = op('review');
  const named = commandRequest(installation, review, 'command', parseLine(review, ['work', 'gardener'], 'command'));
  assert.deepEqual(named.ok && [named.value.vaults.map((v) => v.id), named.value.params], [['work'], { actor: 'gardener' }]);
  const here = commandRequest(installation, review, 'command', parseLine(review, ['work'], 'command'), { vault: vault('home'), path: '' });
  assert.deepEqual(here.ok && [here.value.vaults.map((v) => v.id), here.value.params], [['home'], { actor: 'work' }], 'an actor that happens to share a vault\'s name');
  const read = op('read');
  const pathed = commandRequest(installation, read, 'cli', parseLine(read, ['work:a.md'], 'cli'));
  assert.deepEqual(pathed.ok && [pathed.value.vaults.map((v) => v.id), pathed.value.params], [['work'], { path: 'a.md' }]);
});

test('a command line that does not fit says why, as its surface names the command', () => {
  const review = op('review');
  const extra = commandRequest(installation, review, 'cli', parseLine(review, ['home', 'gardener', 'more'], 'cli'));
  assert.ok(!extra.ok);
  assert.match(describeCommandLineError(extra.error, review, 'cli'), /^Too many arguments: more/);
  const which = commandRequest(installation, review, 'command', parseLine(review, ['gardener'], 'command'));
  assert.ok(!which.ok);
  assert.match(describeCommandLineError(which.error, review, 'command'), /Which vault\? Name it \(\/vault review <vault> …/);
  const unknown = commandRequest(installation, review, 'cli', parseLine(review, ['--vault', 'nowhere', 'gardener'], 'cli'));
  assert.ok(!unknown.ok);
  assert.equal(describeCommandLineError(unknown.error, review, 'cli'), '"nowhere" is not a registered vault.');
});
