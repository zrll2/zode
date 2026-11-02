#!/usr/bin/env node
// Verify a published Mac release is live and correct. Run after publish.sh --publish:
//   node scripts/verify-release.mjs [--version X.Y.Z] [--repo owner/name] [--no-hash]
// Checks are pure and exported for tests; pass { fetchImpl } to avoid the network.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(MAC_DIR, '..');
const ASSETS = (v) => [`Zode-${v}-arm64.dmg`, `Zode-${v}-arm64-mac.zip`, 'latest-mac.yml'];
const assetUrl = (repo, v, name) => `https://github.com/${repo}/releases/download/v${v}/${name}`;
const okr = (name, detail = 'ok') => ({ name, ok: true, detail });
const fail = (name, detail) => ({ name, ok: false, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const authHeaders = () => {
  const h = { 'User-Agent': 'zode-release-verify', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
};
// Network errors are retried twice (3 attempts total); a check never throws, it returns { ok: false }.
export async function fetchWithRetry(ctx, url, opts = {}, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await ctx.fetchImpl(url, opts); }
    catch (e) { lastErr = e; if (i < attempts - 1) await sleep(ctx.retryDelayMs ?? 2000); }
  }
  throw lastErr;
}
// Returns { release } or { fail } with the failure already attributed to `name`.
async function getReleaseOr(ctx, name) {
  try {
    const res = await fetchWithRetry(ctx, `https://api.github.com/repos/${ctx.repo}/releases/tags/v${ctx.version}`, { headers: authHeaders() });
    if (res.status === 404) return { fail: fail(name, `no release for tag v${ctx.version}`) };
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return { release: await res.json() };
  } catch (e) {
    return { fail: fail(name, `GitHub API unreachable: ${e.message}`) };
  }
}
const assetNames = (release) => new Set((release.assets ?? []).map((a) => a.name));
// Reads a workspace file, returning { text } or { fail } attributed to `name`; `override` (tests) wins over `rel`.
async function readLocal(ctx, rel, name, override) {
  try {
    return { text: await readFile(override ?? path.join(ROOT, rel), 'utf8') };
  } catch (e) {
    return { fail: fail(name, `cannot read ${rel}: ${e.message}`) };
  }
}
async function downloadSha256(ctx, url) {
  const res = await fetchWithRetry(ctx, url);
  if (!res.ok || !res.body) throw new Error(`download returned ${res.status}`);
  const hash = createHash('sha256');
  for await (const chunk of res.body) hash.update(chunk);
  return hash.digest('hex');
}
const parseFeed = (t) => ({ version: /^version:\s*(\S+)/m.exec(t)?.[1] ?? null,
  files: [...t.matchAll(/^\s*-\s*url:\s*(\S+)/gm)].map((m) => m[1]) });
export async function releasePublished(ctx) {
  const r = await getReleaseOr(ctx, 'releasePublished');
  if (r.fail) return r.fail;
  if (r.release.draft) return fail('releasePublished', 'release is still a draft');
  const missing = ASSETS(ctx.version).filter((n) => !assetNames(r.release).has(n));
  if (missing.length) return fail('releasePublished', `missing assets: ${missing.join(', ')}`);
  return okr('releasePublished');
}
export async function updateFeed(ctx) {
  const name = 'updateFeed';
  let feed;
  try {
    const res = await fetchWithRetry(ctx, assetUrl(ctx.repo, ctx.version, 'latest-mac.yml'), { headers: authHeaders() });
    if (!res.ok) return fail(name, `latest-mac.yml fetch returned ${res.status}`);
    feed = parseFeed(await res.text());
  } catch (e) {
    return fail(name, `latest-mac.yml unreachable: ${e.message}`);
  }
  if (feed.version !== ctx.version) return fail(name, `feed version ${feed.version} != ${ctx.version}`);
  const r = await getReleaseOr(ctx, name);
  if (r.fail) return r.fail;
  const names = assetNames(r.release);
  const missing = feed.files.filter((f) => !names.has(f));
  if (missing.length) return fail(name, `feed lists files absent from the release: ${missing.join(', ')}`);
  return okr(name);
}
export async function dmgReachable(ctx) {
  const name = 'dmgReachable';
  const dmg = `Zode-${ctx.version}-arm64.dmg`;
  const r = await getReleaseOr(ctx, name);
  if (r.fail) return r.fail;
  const asset = (r.release.assets ?? []).find((a) => a.name === dmg);
  if (!asset) return fail(name, `${dmg} is not a release asset`);
  let res;
  try {
    res = await fetchWithRetry(ctx, assetUrl(ctx.repo, ctx.version, dmg), { method: 'HEAD', redirect: 'follow' });
  } catch (e) {
    return fail(name, `HEAD failed: ${e.message}`);
  }
  if (res.status !== 200) return fail(name, `HEAD returned ${res.status}`);
  const len = res.headers.get('content-length');
  if (Number(len) !== asset.size) return fail(name, `content-length ${len} != asset size ${asset.size}`);
  return okr(name, `${asset.size} bytes`);
}
export async function homebrewMatches(ctx) {
  const name = 'homebrewMatches';
  const c = await readLocal(ctx, 'packaging/homebrew/zode.rb', name, ctx.caskPath);
  if (!c.text) return okr(name, 'skipped (no cask file)');
  const cask = c.text;
  const caskVersion = /^  version\s+"([^"]+)"/m.exec(cask)?.[1];
  if (caskVersion !== ctx.version) return fail(name, `cask version ${caskVersion} != ${ctx.version}`);
  if (ctx.noHash) return okr(name, 'skipped (--no-hash)');
  const caskSha = /^  sha256\s+"([0-9a-f]{64})"/m.exec(cask)?.[1];
  if (!caskSha) return fail(name, 'cask has no sha256');
  let actual;
  try {
    actual = await downloadSha256(ctx, assetUrl(ctx.repo, ctx.version, `Zode-${ctx.version}-arm64.dmg`));
  } catch (e) {
    return fail(name, `DMG download failed: ${e.message}`);
  }
  if (actual !== caskSha) return fail(name, `sha256 ${actual} != cask ${caskSha}`);
  return okr(name, actual);
}
export async function privacyUrls(ctx) {
  const name = 'privacyUrls';
  const c = await readLocal(ctx, 'app/store.config.json', name);
  if (c.fail) return c.fail;
  let config;
  try {
    config = JSON.parse(c.text);
  } catch (e) {
    return fail(name, `store.config.json is not valid JSON: ${e.message}`);
  }
  const urls = [...new Set(Object.values(config.apple?.info ?? {}).map((l) => l.privacyPolicyUrl).filter(Boolean))];
  if (!urls.length) return fail(name, 'no privacyPolicyUrl configured');
  for (const url of urls) {
    let res;
    try {
      res = await fetchWithRetry(ctx, url);
    } catch (e) {
      return fail(name, `${url} unreachable: ${e.message}`);
    }
    if (res.status !== 200) return fail(name, `${url} returned ${res.status}`);
    if (!/privacy/i.test(await res.text().catch(() => ''))) return fail(name, `${url} body has no word "privacy"`);
  }
  return okr(name, urls.join(', '));
}
export async function notesMention(ctx) {
  const name = 'notesMention';
  const c = await readLocal(ctx, 'docs/RELEASE_NOTES.md', name);
  if (c.fail) return c.fail;
  const esc = ctx.version.replace(/\./g, '\\.');
  if (!new RegExp(`(^|\\W)v?${esc}(\\W|$)`).test(c.text)) return fail(name, `no line mentions ${ctx.version}`);
  return okr(name);
}

export const checks = { releasePublished, updateFeed, dmgReachable, homebrewMatches, privacyUrls, notesMention };

export function summarize(results, version) {
  const ok = results.every((r) => r.ok);
  const lines = results.map((r) => (r.ok ? `ok ${r.name}` : `FAIL ${r.name}: ${r.detail}`));
  lines.push(`release v${version} ${ok ? 'verified' : 'NOT verified'}`);
  return { ok, text: lines.join('\n') };
}

export async function runChecks(ctx) {
  const results = [];
  for (const [name, fn] of Object.entries(checks)) {
    try { results.push(await fn(ctx)); }
    catch (e) { results.push(fail(name, e.message)); }
  }
  return results;
}

export function parseArgs(argv, { version, repo }) {
  const out = { version, repo, noHash: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--version') out.version = argv[++i];
    else if (argv[i] === '--repo') out.repo = argv[++i];
    else if (argv[i] === '--no-hash') out.noHash = true;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let version = 'unknown';
  let repo = 'zrll2/zode';
  try {
    const pkg = JSON.parse(await readFile(path.join(MAC_DIR, 'package.json'), 'utf8'));
    version = pkg.version;
    const url = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
    repo = (pkg.homepage ?? '').match(/github\.com\/([^/]+\/[^/#?]+)/)?.[1] || url.replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '') || repo;
  } catch {}
  const ctx = parseArgs(process.argv, { version, repo });
  ctx.fetchImpl = fetch;
  ctx.retryDelayMs = 2000;
  const { ok, text } = summarize(await runChecks(ctx), ctx.version);
  console.log(text);
  process.exit(ok ? 0 : 1);
}
