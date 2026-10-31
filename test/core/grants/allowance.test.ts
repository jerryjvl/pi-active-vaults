// Documented behaviour: concepts.md "Web grants" — a job's `web` block lists
// the URL patterns its runs may fetch beyond the web broker's default rules.
// A part is fixed text, a listed or from-response placeholder, an open
// placeholder or a wildcard; an entry with an open part is open and reaches
// scripts only unless it says `to: all`; a host wildcard is a leading `*.`
// over a fixed domain of at least two labels and the minimum length; anything
// ambiguous is refused, and so the job does not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemEntries, parseWebBlock, selectivityIssues } from '../../../src/core/grants/index.ts';

const API = 'https://api.example.net/v3/en_AU/catalogue';

function parsed(value: unknown) {
  const result = parseWebBlock(value);
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}

function issues(value: unknown): string[] {
  const result = parseWebBlock(value);
  assert.equal(result.ok, false, 'refused');
  return result.ok ? [] : result.error.map((i) => `${i.path}: ${i.message}`);
}

test('a block of fixed, listed, from-response, open and wildcard entries is read as written, its open entries marked', () => {
  const web = parsed({
    requests: 12,
    allow: [
      { url: `${API}/entry?typeClass={tc}`, tc: ['W1', 'X2', 350] },
      { url: `${API}/entry?typeClass={tc}&vehicleId={vid}&step=MOTOR`, tc: ['W1'], vid: 'from-response' },
      { url: `${API}/models/{model}/info`, model: 'from-response' },
      { url: 'https://www.example.net/search?q={q}' },
      { url: 'https://*.example-motors.com.au/*', to: 'all' },
    ],
  });
  assert.equal(web.requests, 12);
  assert.deepEqual(web.entries.map((e) => e.open), [false, false, false, true, true]);
  assert.deepEqual(web.entries[0]?.params, { tc: ['W1', 'X2', '350'] }, 'listed values, numbers as text');
  assert.deepEqual(web.entries[1]?.params, { tc: ['W1'], vid: 'from-response' });
  assert.equal(web.entries[3]?.url, 'https://www.example.net/search?q={q}', 'carried as written');
  assert.equal(web.entries[4]?.wildcardDomain, 'example-motors.com.au');
  assert.deepEqual(itemEntries(web).map((e) => e.url), [web.entries[0]?.url, web.entries[1]?.url, web.entries[2]?.url, 'https://*.example-motors.com.au/*'],
    'items get the closed entries and open ones marked to: all; the open one without it is scripts\' only');
});

test('a block missing its parts, or with keys it does not know, is refused', () => {
  assert.deepEqual(issues({ allow: [{ url: API }] }), ['web.requests: is required']);
  assert.deepEqual(issues({ requests: 0, allow: [{ url: API }] }), ['web.requests: must be a positive whole number']);
  assert.match(issues({ requests: 3, allow: [] })[0] ?? '', /web\.allow: must list 1 to 64 entries/);
  assert.deepEqual(issues({ requests: 3, allow: [{ url: API }], also: 1 }), ['web.also: unknown key']);
  assert.deepEqual(issues({ requests: 3, allow: [{ url: `${API}/{a}`, b: ['x'] }] }), ['web.allow[0].b: is not a placeholder of the url']);
  assert.deepEqual(issues({ requests: 3, allow: [{ url: API, to: 'models' }] }), ['web.allow[0].to: must be one of all']);
  assert.match(issues({ requests: 3, allow: [{ url: `${API}/{a}`, a: [] }] })[0] ?? '', /must be "from-response" or a list/);
  assert.match(issues({ requests: 3, allow: [{ url: `${API}/{a}`, a: ['x/y'] }] })[0] ?? '', /web\.allow\[0\]\.a\[0\]: is not in the expected form/);
});

test('every ambiguous or unmatched part of a pattern is refused', () => {
  const refused = (url: string, pattern: RegExp): void => {
    const found = issues({ requests: 1, allow: [{ url }] });
    assert.ok(found.some((i) => pattern.test(i)), `${url}: ${found.join(' | ')}`);
  };
  refused('ftp://example.net/', /http or https URL pattern/);
  refused('https://example.net/a#frag', /without a fragment/);
  refused('https://user@example.net/', /user information/);
  refused('https://example.net:http/', /port that is not a number/);
  refused('https://Example.net/', /lowercase host/);
  refused('https://api.*.example.net/', /wildcard only as a leading/);
  refused('https://{host}.example.net/', /lowercase host/);
  refused('https://example.net/*/files', /a wildcard only as a trailing/);
  refused('https://example.net/a*b', /a wildcard only as a trailing/);
  refused('https://example.net/a/../b', /"\." or "\.\." path segments/);
  refused('https://example.net/*?q=1', /query after a trailing "\/\*"/);
  refused('https://example.net/a?q=1&q=2', /query key "q" twice/);
  refused('https://example.net/a?{k}=1', /fixed keys/);
  refused('https://example.net/a?q=*', /character that is not allowed in a query value/);
  refused('https://example.net/{a}/{a}', /placeholder \{a\} twice/);
});

test('a host wildcard must be selective: two labels and the minimum number of characters', () => {
  const web = parsed({
    requests: 5,
    allow: [
      { url: 'https://*.example-motors.com.au/*' }, // 20
      { url: 'https://*.example-motors.com/*' }, // 17
      { url: 'https://*.com.au/*' },
      { url: 'https://*.localhostexamplesite/*' }, // one label, however long
      { url: 'https://www.ex.com/*' }, // a named host with an open path is not a host wildcard
    ],
  });
  assert.deepEqual(selectivityIssues(web, 20).map((i) => i.path), ['web.allow[1].url', 'web.allow[2].url', 'web.allow[3].url']);
  assert.deepEqual(selectivityIssues(web, 15).map((i) => i.path), ['web.allow[2].url', 'web.allow[3].url'], 'the minimum is a setting');
  assert.match(selectivityIssues(web, 20)[0]?.message ?? '', /at least two labels and 20 characters; name the host and open the path instead/);
});
