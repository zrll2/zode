// The Electron main process has no unit tests of its own; at least make sure it parses and bundles
// (a duplicated function once slipped through every other test and broke the release build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
    external: ['electron', 'electron-updater', 'qrcode', 'ws'], write: false, logLevel: 'silent',   // ws is inlined by build.mjs; these tests only need main.mjs's own code to bundle
  });
  assert.ok(result.outputFiles.length > 0);
});

test('mac/main.mjs approves from the listing and pushes the phone even when the panel is focused', async () => {
  // The main process has no unit tests of its own (Electron); pin the wiring of both safety fixes in
  // the same bundle the release build ships, like the parse and bundle checks above.
  let esbuild;
  try { esbuild = (await import('esbuild')).default ?? (await import('esbuild')); } catch { return; }   // dev dependency not installed
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'main.mjs')], bundle: true, platform: 'node', format: 'esm',
    external: ['electron', 'electron-updater', 'qrcode', 'ws'], write: false, logLevel: 'silent',   // ws is inlined by build.mjs; these tests only need main.mjs's own code to bundle
  });
  const js = result.outputFiles[0].text;
  assert.match(js, /const listed = findPending\(p\.requestId\)/);          // approve re-derived from the listing, not the payload
  assert.match(js, /listed\.kind !== ["']permission["']/);                 // a question or unknown request never approves
  assert.ok((js.match(/pushDevices\(note\)/g) ?? []).length >= 2);          // the toast path and the focused-panel path both push to the phones
  assert.doesNotMatch(js, /panelFocused\(\)\) \{ notifyQueue = \[\]; return; \}/);   // the old drop-everything path is gone
});

test('mac/main.mjs wires the approval audit log and the approvalLog channel', async () => {
  // Electron main has no unit tests; pin the audit wiring in the same bundle the release build ships.
  let esbuild;
  try { esbuild = (await import('esbuild')).default ?? (await import('esbuild')); } catch { return; }   // dev dependency not installed
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'main.mjs')], bundle: true, platform: 'node', format: 'esm',
    external: ['electron', 'electron-updater', 'qrcode', 'ws'], write: false, logLevel: 'silent',
  });
  const js = result.outputFiles[0].text;
  assert.match(js, /approvals\.jsonl/);                                    // the log lives in ~/.zode
  assert.match(js, /createAuditLog\(\{ file: AUDIT_FILE \}\)/);
  assert.match(js, /stt: sttAdapter, audit \}\)/);                          // the relay gets the log
  assert.match(js, /auditDecided\(request\d*\.sock, request\d*\.requestId, ["']allowed["'], ["']auto["']\)/);   // the non-relay auto-allow records too
  assert.match(js, /ipcMain\.handle\(["']zode:approvalLog["'][\s\S]{0,80}audit\.recent\(30\)/);     // the read API
});

test('mac/preload.cjs exposes approvalLog to the panel', () => {
  const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
  assert.match(preload, /approvalLog: \(\) => ipcRenderer\.invoke\(['"]zode:approvalLog['"]\)/);
});

test('mac/main.mjs takes setPreset and rejects junk; the old two-switch toggles are gone', async () => {
  let esbuild;
  try { esbuild = (await import('esbuild')).default ?? (await import('esbuild')); } catch { return; }   // dev dependency not installed
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'main.mjs')], bundle: true, platform: 'node', format: 'esm',
    external: ['electron', 'electron-updater', 'qrcode', 'ws'], write: false, logLevel: 'silent',
  });
  const js = result.outputFiles[0].text;
  assert.match(js, /name === ["']setPreset["']/);
  assert.match(js, /applyPreset\(settings, p\.value\)/);                       // junk names return false and change nothing
  assert.doesNotMatch(js, /toggleAutoAllow|toggleAskRisky/);                   // the two switches are gone, presets only
  assert.doesNotMatch(js, /p\.key === ["']autoAllow["']|p\.key === ["']askRisky["']/);
});

test('mac/main.mjs wires the question answer action end to end', () => {
  const src = fs.readFileSync(path.join(root, 'main.mjs'), 'utf8');
  assert.match(src, /name === ["']answerQuestion["']/);                       // the panel action arrives
  assert.match(src, /answerQuestion: \(requestId, sock, picks\)/);            // the action is defined
  assert.match(src, /answerResult\(questions, picks/);                        // picks are built against the pending question
  assert.match(src, /respondQuestion\(\{ sock: listed\.sock, requestId: listed\.requestId, result \}\)/);   // and sent by tap/respond
});
