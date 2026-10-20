// updates: version parsing and comparison, the update decision, and the rebuild script's quoting and steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareVersions, readVersion, updateState, rebuildScript } from '../lib/updates.mjs';

const tmp = () => fs.mkdtempSync(path.join('/tmp', 'zode-updates-'));
const plist = v => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Zode</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${v}</string>
\t<key>CFBundleVersion</key>
\t<string>${v}.100</string>
</dict>
</plist>
`;
const fakeApp = (dir, name, v) => {
  const app = path.join(dir, name);
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist(v));
  return app;
};

test('compareVersions: numeric per part, tolerant of junk and missing input', () => {
  assert.ok(compareVersions('3.15.3', '3.16.2') < 0);
  assert.ok(compareVersions('3.16.2', '3.15.3') > 0);
  assert.ok(compareVersions('3.9.0', '3.10.0') < 0);                // not a string compare
  assert.equal(compareVersions('3.15.3', '3.15.3'), 0);
  assert.equal(compareVersions('3.15', '3.15.0'), 0);
  assert.ok(compareVersions('3.15.3', '3.15') > 0);
  assert.ok(compareVersions('v3.16.2-beta', '3.16.1') > 0);
  assert.equal(compareVersions('junk', '3.15.3'), 0);
  assert.equal(compareVersions('3.15.3', ''), 0);
  assert.equal(compareVersions(undefined, '3.15.3'), 0);
  assert.equal(compareVersions(null, undefined), 0);
  assert.equal(compareVersions(42, {}), 0);
});

test('readVersion: XML Info.plist, missing or odd input, binary plist via plutil', async () => {
  const dir = tmp();
  assert.equal(await readVersion(fakeApp(dir, 'ZCode.app', '3.16.2')), '3.16.2');
  assert.equal(await readVersion(path.join(dir, 'Nope.app')), null);
  assert.equal(await readVersion(undefined), null);
  assert.equal(await readVersion(''), null);
  const noKey = path.join(dir, 'NoKey.app');
  fs.mkdirSync(path.join(noKey, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(noKey, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleName</key><string>x</string></dict></plist>');
  assert.equal(await readVersion(noKey), null);
  fs.writeFileSync(path.join(noKey, 'Contents', 'Info.plist'), 'not a plist at all');
  assert.equal(await readVersion(noKey), null);
  if (process.platform === 'darwin') {                              // Electron ships XML, but binary must work too
    const bin = fakeApp(dir, 'Bin.app', '3.17.0');
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', path.join(bin, 'Contents', 'Info.plist')]);
    assert.ok(fs.readFileSync(path.join(bin, 'Contents', 'Info.plist')).subarray(0, 6).toString() === 'bplist');
    assert.equal(await readVersion(bin), '3.17.0');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('updateState: available only when the original exists and is newer', async () => {
  const dir = tmp();
  const running = fakeApp(dir, 'Zode.app', '3.15.3');
  assert.deepEqual(await updateState({ original: fakeApp(dir, 'New.app', '3.16.2'), running }),
    { available: true, originalVersion: '3.16.2', runningVersion: '3.15.3' });
  assert.deepEqual(await updateState({ original: fakeApp(dir, 'Same.app', '3.15.3'), running }),
    { available: false, originalVersion: '3.15.3', runningVersion: '3.15.3' });
  assert.deepEqual(await updateState({ original: fakeApp(dir, 'Old.app', '3.14.0'), running }),
    { available: false, originalVersion: '3.14.0', runningVersion: '3.15.3' });
  assert.deepEqual(await updateState({ original: path.join(dir, 'Missing.app'), running }),
    { available: false, originalVersion: null, runningVersion: '3.15.3' });
  assert.deepEqual(await updateState({ original: fakeApp(dir, 'New2.app', '3.16.2'), running: path.join(dir, 'Gone.app') }),
    { available: false, originalVersion: '3.16.2', runningVersion: null });
  assert.deepEqual(await updateState({}), { available: false, originalVersion: null, runningVersion: null });
  assert.deepEqual(await updateState(), { available: false, originalVersion: null, runningVersion: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rebuildScript: paths with a space and a single quote survive the shell', () => {
  const repo = "/Users/o'brien/My Repo/zode";
  const appPath = "/Users/o'brien/Applications/Zode Dev.app";
  const s = rebuildScript({ pid: 4242, repo, appPath });
  assert.ok(s.startsWith('#!/bin/bash\n'));
  assert.ok(s.includes(`PID='4242'`));
  assert.ok(s.includes(`REPO='/Users/o'\\''brien/My Repo/zode'`));
  assert.ok(s.includes(`APP='/Users/o'\\''brien/Applications/Zode Dev.app'`));
  execFileSync('/bin/bash', ['-n'], { input: s });                  // it is valid bash
  // Let bash evaluate the assignments: the values must come back byte for byte.
  const assigns = s.split('\n').filter(l => /^(PID|REPO|APP)=/.test(l)).join('\n');
  const out = execFileSync('/bin/bash', ['-c', `${assigns}\nprintf '%s\\n' "$PID" "$REPO" "$APP"`], { encoding: 'utf8' });
  assert.deepEqual(out.split('\n'), ['4242', repo, appPath, '']);
});

test('rebuildScript: waits for the pid, builds into a temp app, swaps only after success, reports failure', () => {
  const s = rebuildScript({ pid: 7, repo: '/repo', appPath: '/Applications/Zode.app' });
  assert.ok(s.includes('kill -0 "$PID"'));
  assert.ok(s.includes('-ge 60'));
  assert.ok(s.includes('ZODE_TAP_APP="$TMP/Zode.app" bash "$REPO/scripts/build-tap.sh"'));
  assert.ok(s.includes('mv "$APP" "$APP.old"'));
  assert.ok(s.includes('mv "$TMP/Zode.app" "$APP"'));
  assert.ok(s.includes('rm -rf "$APP.old"'));
  assert.ok(s.includes('open "$APP"'));
  assert.ok(s.includes('osascript -e \'display notification'));
  const build = 'bash "$REPO/scripts/build-tap.sh"';
  assert.ok(s.indexOf('kill -0') < s.indexOf(build));                 // wait, then build
  assert.ok(s.indexOf(build) < s.indexOf('mv "$APP" "$APP.old"'));    // build, then swap
  assert.ok(s.indexOf('mv "$TMP/Zode.app" "$APP"') < s.indexOf('open "$APP"'));
  assert.equal(s.includes('/Applications/ZCode.app'), false);        // the original is never named, let alone touched
  assert.equal(s.includes('rm -rf "$APP"\n'), false);                 // the old app goes only via the .old swap
});
