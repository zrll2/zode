// The Electron main process has no unit tests of its own; at least make sure it parses and bundles
// (a duplicated function once slipped through every other test and broke the release build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('mac/main.mjs parses', () => {
  const r = spawnSync(process.execPath, ['--check', path.join(root, 'main.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('mac/main.mjs bundles the way the release build does', async () => {
  let esbuild;
  try { esbuild = (await import('esbuild')).default ?? (await import('esbuild')); } catch { return; }   // dev dependency not installed
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'main.mjs')], bundle: true, platform: 'node', format: 'esm',
    external: ['electron', 'electron-updater', 'qrcode'], write: false, logLevel: 'silent',
  });
  assert.ok(result.outputFiles.length > 0);
});
