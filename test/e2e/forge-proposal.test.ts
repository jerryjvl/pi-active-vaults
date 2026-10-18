// End to end (implementation plan, Stage 7): a forge-mode proposal against a
// stub forge (concepts.md "Actor" — forge mode; daemon.md "Forge sync";
// security-setup.md). A job arrives through the forge, a run triggered from
// the CLI commits on its actor branch, the daemon pushes it and opens its
// pull request with `vault/policy` pending; an owner's approval of exactly
// that commit in the forge makes it succeed; the forge merges it, the daemon
// learns of the merge by fetching, checks that the proposal's commits
// reached main, and never pushes main itself. A local bare repository stands
// behind the forge's URL, beside a stub of Gitea's API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedMain } from '../../src/core/integrity/index.ts';
import { listSpawns } from '../../src/core/queue/index.ts';
import { cliFor } from '../support/cli.ts';
import { fakePi, jobDocument, withDaemon } from '../support/daemon.ts';
import { mergeInForge, mergePullInForge, withForgeInstallation } from '../support/forge-vault.ts';
import { RUNNING } from '../support/session.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'the daemon\'s Unix domain socket in tests' : false };
const MINUTE = 60_000;
const PROTECTED = { enable_push: false, enable_force_push: false, enable_status_check: true, status_check_contexts: ['vault/policy'], required_approvals: 1 };
const MERGE_COMMITS_ONLY = { allow_merge_commits: true, allow_squash_merge: false, allow_rebase: false, allow_rebase_explicit: false };

test('a run\'s commit becomes a pull request; an owner\'s approval in the forge satisfies vault/policy; the forge\'s merge becomes the accepted main', posixOnly, withForgeInstallation(async (t, forge) => {
  const vault = cliFor(t);
  forge.stub.model.protection = PROTECTED;
  forge.stub.model.repository = MERGE_COMMITS_ONLY;
  const doctor = await vault('doctor', '--json');
  const forgeFindings = (JSON.parse(doctor.stdout) as { data: { findings: { check: string; level: string }[] } }).data.findings.filter((f) => f.check === 'forge');
  assert.deepEqual(forgeFindings.map((f) => f.level), ['ok'], 'the recommended setup');

  await withDaemon(t, fakePi(t, { 'jobs/go.md': 'commit' }), async (_daemon, minute) => {
    const withJob = mergeInForge(forge, { 'jobs/go.md': jobDocument('[{ on: external, name: go, effect: spawn }]') });
    await minute();
    assert.equal(acceptedMain(t.context.state, 'home')?.sha, withJob, 'the job arrives as the forge\'s main');

    const triggered = await vault('trigger', 'go');
    assert.equal(triggered.code, 0, triggered.stderr);
    await minute();
    const [spawn] = listSpawns(t.context.state);
    assert.ok(spawn?.commit !== undefined, JSON.stringify(spawn));
    await minute();
    const head = t.repo.git('rev-parse', 'actor/gardener');
    assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), head, 'the actor branch is pushed');
    assert.deepEqual(forge.stub.model.pulls.map((p) => [p.number, p.head, p.state]), [[1, 'actor/gardener', 'open']]);
    const policy = () => forge.stub.model.statuses.filter((s) => s.sha === head && s.context === 'vault/policy').at(-1);
    assert.equal(policy()?.state, 'pending');
    assert.match(policy()?.description ?? '', /owner/);

    forge.stub.model.reviews.push({ pull: 1, user: 'mallory', state: 'APPROVED', commit: head });
    t.clock.advance(5 * MINUTE);
    await minute();
    assert.equal(policy()?.state, 'pending', 'an approval from someone who is not an owner counts for nothing');
    forge.stub.model.reviews.push({ pull: 1, user: 'alice', state: 'APPROVED', commit: head });
    t.clock.advance(5 * MINUTE);
    await minute();
    assert.equal(policy()?.state, 'success', 'the owner approved exactly this commit');

    const merged = mergePullInForge(forge, 1, 'merge');
    await minute();
    assert.equal(acceptedMain(t.context.state, 'home')?.sha, merged);
    assert.equal(t.repo.git('rev-parse', 'main'), merged, 'main follows the forge\'s forward');
    assert.equal(forge.remote('rev-parse', 'refs/heads/main'), merged, 'and the package never pushed main');
    const status = await vault('status');
    assert.equal(status.stderr, '', 'no unaccepted change');
    assert.doesNotMatch(status.stdout, /proposal from gardener|no longer attach/, 'nothing pending; its commits reached main');
  });
}, { host: true, running: RUNNING }));
