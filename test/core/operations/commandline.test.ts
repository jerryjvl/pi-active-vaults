// Documented behaviour: cli.md "Conventions" and api.md "Commands" — a
// command line is read into an operation's parameters from its own specs, the
// same for the `vault` CLI and Pi's `/vault` commands; each surface offers
// only its own parameters. Pi hands a command its arguments as one string, so
// quoting groups words as a shell would, without running anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignPositionals, operationNamed, parseLine, splitArguments, usage } from '../../../src/core/operations/index.ts';

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
