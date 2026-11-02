import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checks, summarize, fetchWithRetry } from '../scripts/verify-release.mjs';

const VERSION = '1.5.7';
const REPO = 'zrll2/zode';

const release = (overrides = {}) => ({
  draft: false,
  assets: [
    { name: `Zode-${VERSION}-arm64.dmg`, size: 1000 },
    { name: `Zode-${VERSION}-arm64-mac.zip`, size: 900 },
    { name: 'latest-mac.yml', size: 300 },
    { name: `Zode-${VERSION}-arm64.dmg.blockmap`, size: 10 },
    ...overrides.assets ?? [],
  ],
  ...overrides,
});

const feed = (version = VERSION) =>
  `version: ${version}\nfiles:\n  - url: Zode-${VERSION}-arm64-mac.zip\n    sha512: abc\n    size: 900\n  - url: Zode-${VERSION}-arm64.dmg.blockmap\n    sha512: def\n    size: 10\npath: Zode-${VERSION}-arm64-mac.zip\n`;

// Fake fetch routing on URL shape; handlers may override per test.
function fakeFetch({ release: rel = release(), feedText = feed(), status = 200, body = '', headers = {}, throws = 0 } = {}) {
  let thrown = 0;
  return async (url, opts = {}) => {
    if (thrown < throws) { thrown++; throw new Error('boom'); }
    if (url.startsWith('https://api.github.com/')) {
      if (rel === null) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => rel };
    }
    if (url.endsWith('latest-mac.yml')) return { ok: true, status, text: async () => feedText, headers: new Map(Object.entries(headers)), body: null };
    if (url.endsWith('.dmg')) return { ok: true, status, headers: new Map(Object.entries(headers)), body: asyncIterable(body) };
    // privacy pages: echo the path in the body
    return { ok: true, status, text: async () => (status === 200 ? 'Our Privacy Policy' : 'nope'), headers: new Map(Object.entries(headers)) };
  };
}

function asyncIterable(s) {
  return { [Symbol.asyncIterator]() { let done = false; return { next: async () => (done ? { done: true } : ((done = true), { value: Buffer.from(s), done: false })) }; } };
}

const ctx = (extra = {}) => ({ version: VERSION, repo: REPO, fetchImpl: fakeFetch(), retryDelayMs: 0, ...extra });

test('releasePublished passes on a published release', async () => {
  const r = await checks.releasePublished(ctx());
  assert.equal(r.ok, true);
});

test('releasePublished fails on a draft', async () => {
  const r = await checks.releasePublished(ctx({ fetchImpl: fakeFetch({ release: release({ draft: true }) }) }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /draft/);
});

test('releasePublished fails when an asset is missing', async () => {
  const rel = release();
  rel.assets = rel.assets.filter((a) => !a.name.endsWith('.zip'));
  const r = await checks.releasePublished(ctx({ fetchImpl: fakeFetch({ release: rel }) }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /missing assets/);
});

test('releasePublished fails when the tag does not exist', async () => {
  const r = await checks.releasePublished(ctx({ fetchImpl: fakeFetch({ release: null }) }));
  assert.equal(r.ok, false);
});

test('updateFeed passes on a good feed', async () => {
  const r = await checks.updateFeed(ctx());
  assert.equal(r.ok, true);
});

test('updateFeed fails on a wrong feed version', async () => {
  const r = await checks.updateFeed(ctx({ fetchImpl: fakeFetch({ feedText: feed('1.5.6') }) }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /1\.5\.6/);
});

test('updateFeed fails when a feed file is not a release asset', async () => {
  const r = await checks.updateFeed(ctx({ fetchImpl: fakeFetch({ feedText: feed() + '  - url: ghost.dmg\n' }) }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /ghost\.dmg/);
});

test('dmgReachable passes with matching content-length', async () => {
  const r = await checks.dmgReachable(ctx({ fetchImpl: fakeFetch({ headers: { 'content-length': '1000' } }) }));
  assert.equal(r.ok, true);
});

test('dmgReachable fails on a wrong content-length', async () => {
  const r = await checks.dmgReachable(ctx({ fetchImpl: fakeFetch({ headers: { 'content-length': '42' } }) }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /content-length/);
});

test('homebrewMatches passes when version and sha256 match', async () => {
  const sha = createHash('sha256').update('fake dmg bytes').digest('hex');
  const dir = await mkdtemp(path.join(tmpdir(), 'cask-'));
  const cask = path.join(dir, 'zode.rb');
  await writeFile(cask, `cask "zode" do\n  version "${VERSION}"\n  sha256 "${sha}"\nend\n`);
  const r = await checks.homebrewMatches(ctx({ caskPath: cask, fetchImpl: fakeFetch({ body: 'fake dmg bytes' }) }));
  await rm(dir, { recursive: true, force: true });
  assert.equal(r.ok, true);
});

test('homebrewMatches fails on a wrong sha256', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cask-'));
  const cask = path.join(dir, 'zode.rb');
  await writeFile(cask, `cask "zode" do\n  version "${VERSION}"\n  sha256 "${'a'.repeat(64)}"\nend\n`);
  const r = await checks.homebrewMatches(ctx({ caskPath: cask, fetchImpl: fakeFetch({ body: 'fake dmg bytes' }) }));
  await rm(dir, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match(r.detail, /sha256/);
});

test('homebrewMatches skips with --no-hash', async () => {
  const r = await checks.homebrewMatches(ctx({ noHash: true }));
  assert.equal(r.ok, true);
  assert.equal(r.detail, 'skipped (--no-hash)');
});

test('privacyUrls passes on the real config URLs', async () => {
  const r = await checks.privacyUrls(ctx());
  assert.equal(r.ok, true);
});

test('privacyUrls fails on a 404', async () => {
  const r = await checks.privacyUrls(ctx({ fetchImpl: fakeFetch({ status: 404 }) }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /404/);
});

test('privacyUrls fails when the body has no word privacy', async () => {
  const r = await checks.privacyUrls(ctx({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'nothing here', headers: new Map() }) }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /"privacy"/);
});

test('notesMention passes for 1.5.7 and fails for an unmentioned version', async () => {
  assert.equal((await checks.notesMention(ctx())).ok, true);
  const r = await checks.notesMention(ctx({ version: '9.9.9' }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /9\.9\.9/);
});

test('a check that throws returns ok: false, not an exception', async () => {
  const r = await checks.privacyUrls(ctx({ fetchImpl: async () => { throw new Error('down'); } }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /down/);
});

test('fetchWithRetry retries thrown fetches and succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; if (calls < 3) throw new Error('flaky'); return 'ok'; };
  assert.equal(await fetchWithRetry({ fetchImpl, retryDelayMs: 0 }, 'https://x'), 'ok');
  assert.equal(calls, 3);
});

test('fetchWithRetry gives up after 3 attempts', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('always'); };
  await assert.rejects(() => fetchWithRetry({ fetchImpl, retryDelayMs: 0 }, 'https://x'), /always/);
  assert.equal(calls, 3);
});

test('summarize: ok when all checks pass, not ok otherwise', () => {
  const good = { name: 'a', ok: true, detail: 'ok' };
  const bad = { name: 'b', ok: false, detail: 'boom' };
  assert.deepEqual(summarize([good], VERSION), { ok: true, text: 'ok a\nrelease v1.5.7 verified' });
  assert.deepEqual(summarize([good, bad], VERSION), { ok: false, text: 'ok a\nFAIL b: boom\nrelease v1.5.7 NOT verified' });
});
