// Documented behaviour: what the package enforces is read from commits
// (security.md); a document in a revision is missing, unreadable or read, and
// the three are never confused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDocumentAt } from '../../../src/core/documents/index.ts';
import { gitFor, withTempRepo } from '../../support/git-repo.ts';

test('a document in a revision is read, unreadable, or missing — never from the working tree', withTempRepo(async (repo) => {
  repo.write('good.md', '---\nlabels: [a]\n---\nBody\n');
  repo.write('bad.md', '---\nlabels: [unclosed\n---\n');
  const sha = repo.commit('documents');
  repo.write('good.md', '---\nlabels: [changed]\n---\n');
  const git = gitFor(repo);
  assert.deepEqual(await readDocumentAt(git, repo.path, sha, 'good.md'), {
    ok: true,
    value: { state: 'read', document: { frontmatter: { labels: ['a'] }, body: 'Body\n', hasFrontmatter: true } },
  });
  const bad = await readDocumentAt(git, repo.path, sha, 'bad.md');
  assert.equal(bad.ok && bad.value.state, 'unreadable');
  assert.deepEqual(await readDocumentAt(git, repo.path, sha, 'none.md'), { ok: true, value: { state: 'missing' } });
}));
