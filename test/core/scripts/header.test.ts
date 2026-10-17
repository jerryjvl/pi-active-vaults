// Documented behaviour: concepts.md "Script" — a script starts with a header
// comment (`#` or `//`) giving name, summary, args, output and net; `name` and
// `summary` are required, `name` is the file name without its extension, and
// `net` defaults to `yes`. A script runs with the interpreter in its `#!` line.
// A misspelt header key is an error: `nett: no` must not quietly allow network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScriptHeader } from '../../../src/core/scripts/index.ts';

const issues = (text: string, file = 'due-topics.sh'): string[] => {
  const parsed = parseScriptHeader(text, file);
  return parsed.ok ? [] : parsed.error.map((i) => `${i.path}: ${i.message}`);
};

test('the documented header parses, with its interpreter', () => {
  const text = [
    '#!/usr/bin/env python3',
    '# name: due-topics',
    '# summary: Digest topics due today, one per line',
    '# args: [--date YYYY-MM-DD]',
    '# output: lines',
    '# net: no',
    '',
    'print("hello")',
  ].join('\n');
  assert.deepEqual(parseScriptHeader(text, 'due-topics.py'), {
    ok: true,
    value: {
      name: 'due-topics',
      summary: 'Digest topics due today, one per line',
      args: '[--date YYYY-MM-DD]',
      output: 'lines',
      net: false,
      interpreter: ['/usr/bin/env', 'python3'],
    },
  });
});

test('// comments work too, net defaults to yes, and later prose is not header', () => {
  const text = '#!/usr/bin/env node\n// name: tidy\n// summary: Tidy things\n//\n// Note: free prose after a blank comment line.\nconsole.log(1);\n';
  assert.deepEqual(parseScriptHeader(text, 'tidy.js'), {
    ok: true,
    value: { name: 'tidy', summary: 'Tidy things', net: true, interpreter: ['/usr/bin/env', 'node'] },
  });
});

test('a CRLF file parses the same', () => {
  const parsed = parseScriptHeader('#!/bin/sh\r\n# name: x\r\n# summary: y\r\n# net: no\r\n', 'x.sh');
  assert.ok(parsed.ok);
  assert.deepEqual([parsed.value.interpreter, parsed.value.net], [['/bin/sh'], false]);
});

test('name and summary are required, and the name must be the file name', () => {
  assert.deepEqual(issues('#!/bin/sh\n# args: none\n'), [
    'due-topics.sh:name: is required',
    'due-topics.sh:summary: is required',
  ]);
  assert.deepEqual(issues('#!/bin/sh\n# name: other\n# summary: s\n'), ['due-topics.sh:name: must be the file name without its extension (due-topics)']);
});

test('unknown or repeated header keys and a net value other than yes or no are errors', () => {
  assert.deepEqual(issues('#!/bin/sh\n# name: due-topics\n# summary: s\n# nett: no\n# summary: again\n# net: maybe\n'), [
    'due-topics.sh:nett: unknown header key',
    'due-topics.sh:summary: is given twice',
    'due-topics.sh:net: must be one of yes, no',
  ]);
});

test('a script needs a #! line naming its interpreter', () => {
  assert.deepEqual(issues('# name: due-topics\n# summary: s\n'), ['due-topics.sh:interpreter: needs a #! line naming its interpreter']);
  assert.deepEqual(issues('#!\n# name: due-topics\n# summary: s\n'), ['due-topics.sh:interpreter: needs a #! line naming its interpreter']);
});
