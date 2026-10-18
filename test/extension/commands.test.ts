// Documented behaviour: api.md "Commands" — `/vault <command>` offers the
// catalogue's Pi commands, typed by the person, so they may act as an owner:
// status, review, accept (and adopt, confirmed first), contract, jobs, run,
// trace, doctor, and `install-cli` to put the launcher on PATH. Arguments are
// read like the CLI's. Tested through Pi 1.3.0's SDK.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptedMain } from '../../src/core/integrity/index.ts';
import { listSpawns } from '../../src/core/queue/index.ts';
import { withInstallation } from '../support/installation.ts';
import { withPi } from '../support/pi.ts';
import { RUNNING } from '../support/session.ts';

const OUTPUT = 'pav:vault';

// A `vault` of someone else's, early on PATH.
const SHADOW = mkdtempSync(join(tmpdir(), 'pav-shadow-'));
writeFileSync(join(SHADOW, 'vault'), '#!/bin/sh\n');
chmodSync(join(SHADOW, 'vault'), 0o755);
after(() => rmSync(SHADOW, { recursive: true, force: true }));

test('/vault alone lists the commands; an unknown one says so', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    await pi.prompt('/vault');
    const [list] = pi.customMessages(OUTPUT);
    for (const command of ['status', 'review', 'accept', 'contract', 'jobs', 'run', 'trace', 'doctor', 'install-cli']) assert.match(list ?? '', new RegExp(`/vault ${command}`));
    await pi.prompt('/vault frobnicate');
    assert.match(pi.customMessages(OUTPUT).at(-1) ?? '', /"frobnicate" is not a \/vault command/);
    assert.equal(pi.requests.length, 0, 'commands are not sent to the model');
  });
}, { running: RUNNING }));

test('commands act as the installation\'s person: review then accept a proposal', withInstallation(async (t) => {
  assert.equal((await t.run('write', { path: 'notes/a.md', content: 'A', actor: 'gardener' }, { surface: 'mcp' })).status, 'ok');
  assert.equal((await t.run('commit', { message: 'A note', actor: 'gardener' })).status, 'ok');
  await withPi(t, {}, async (pi) => {
    await pi.prompt('/vault review gardener');
    assert.match(pi.customMessages(OUTPUT).at(-1) ?? '', /Proposal from gardener: 1 commit\(s\)/);
    await pi.prompt('/vault accept gardener');
    assert.match(pi.customMessages(OUTPUT).at(-1) ?? '', /Accepted gardener's proposal/);
  });
}, { running: RUNNING }));

test('adopting asks the person first; nothing is recorded unless they confirm', withInstallation(async (t) => {
  t.repo.write('news.md', 'news');
  const tip = t.repo.commit('news on main');
  const before = acceptedMain(t.context.state, 'home')?.sha;
  await withPi(t, { confirm: false }, async (pi) => {
    await pi.prompt(`/vault accept --adopt ${tip}`);
    assert.match(pi.customMessages(OUTPUT).at(-1) ?? '', /Not confirmed; nothing was done\./);
  });
  assert.equal(acceptedMain(t.context.state, 'home')?.sha, before);
  await withPi(t, { confirm: true }, async (pi) => {
    await pi.prompt(`/vault accept --adopt ${tip}`);
    assert.match(pi.customMessages(OUTPUT).at(-1) ?? '', new RegExp(`Adopted ${tip}`));
  });
  assert.equal(acceptedMain(t.context.state, 'home')?.sha, tip);
}, { running: RUNNING }));

test('a command\'s arguments are read like the CLI\'s, quotes included', withInstallation(async (t) => {
  t.repo.write('jobs/daily.md', '---\napplies-when: [{ on: external, name: daily, effect: spawn }]\nbudget: { tokens: 1000, ttl: 10m }\nactor: gardener\n---\nRun.\n');
  t.repo.commit('job');
  t.accept();
  await withPi(t, {}, async (pi) => {
    await pi.prompt('/vault run "home:jobs/daily.md"');
    assert.deepEqual(listSpawns(t.context.state).map((s) => s.document), ['jobs/daily.md']);
    await pi.prompt('/vault run --nonsense');
    assert.match(pi.customMessages(OUTPUT).at(-1) ?? '', /--nonsense is not an option of "run"[^]*\/vault run/);
  });
}, { running: RUNNING }));

test('/vault install-cli writes the launcher where the person\'s PATH can find it', { skip: process.platform === 'win32' ? 'POSIX launcher' : false }, withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    await pi.prompt('/vault install-cli');
    const launcher = join(t.host.home, '.local', 'bin', 'vault');
    assert.ok(existsSync(launcher));
    assert.match(pi.customMessages(OUTPUT).at(-1) ?? '', new RegExp(`Wrote ${launcher.replace(/[\\/.]/g, '.')}`));
  });
}, { running: RUNNING }));

test('/vault install-cli says when another vault is on PATH and which one runs (here, the launcher\'s directory is not on PATH)', { skip: process.platform === 'win32' ? 'POSIX launcher' : false }, withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    await pi.prompt('/vault install-cli');
    const message = pi.customMessages(OUTPUT).at(-1) ?? '';
    assert.ok(message.includes(`${join(SHADOW, 'vault')} is the vault that runs`), message);
    assert.ok(message.includes('not on PATH'), message);
  });
}, { running: RUNNING, env: { PATH: `${SHADOW}:${process.env['PATH'] ?? ''}` } }));
