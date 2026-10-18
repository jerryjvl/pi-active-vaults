// Documented behaviour: extension.md "Write guard" — shell commands that would
// move main or push are blocked, so the guard must know a git invocation when
// it reads one; core.md — only the git module knows git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGitProgram } from '../../../src/core/git/index.ts';

test('git is recognised by name or by a path to it, on any platform', () => {
  for (const program of ['git', '/usr/bin/git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'GIT.EXE']) assert.equal(isGitProgram(program), true, program);
  for (const program of ['gitk', 'legit', 'git-lfs', '', 'echo']) assert.equal(isGitProgram(program), false, program);
});
