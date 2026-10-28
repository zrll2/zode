// updates: version parsing and comparison, the release check against scripts/update-zcode.sh --check,
// and the detached engine-rebuild script's quoting and steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareVersions, readVersion, engineRebuildScript, parseCheckOutput, checkRelease } from '../lib/updates.mjs';

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

test('engineRebuildScript: paths with a space and a single quote survive the shell', () => {
  const repo = "/Users/o'brien/My Repo/zode";
  const enginePath = "/Users/o'brien/Applications/ZCode Engine.app";
  const s = engineRebuildScript({ repo, enginePath });
  assert.ok(s.startsWith('#!/bin/bash\n'));
  assert.ok(s.includes(`REPO='/Users/o'\\''brien/My Repo/zode'`));
  assert.ok(s.includes(`ENGINE='/Users/o'\\''brien/Applications/ZCode Engine.app'`));
  execFileSync('/bin/bash', ['-n'], { input: s });                  // it is valid bash
  // Let bash evaluate the assignments: the values must come back byte for byte.
  const assigns = s.split('\n').filter(l => /^(REPO|ENGINE)=/.test(l)).join('\n');
  const out = execFileSync('/bin/bash', ['-c', `${assigns}\nprintf '%s\\n' "$REPO" "$ENGINE"`], { encoding: 'utf8' });
  assert.deepEqual(out.split('\n'), [repo, enginePath, '']);
});

test('engineRebuildScript: quits the engine, builds with ZODE_ENGINE=1, swaps only after success, reopens', () => {
  const s = engineRebuildScript({ repo: '/repo', enginePath: '/Applications/ZCode Engine.app' });
  assert.ok(s.includes(`osascript -e 'tell application id "dev.zode.engine" to quit'`));
  assert.ok(s.includes('pgrep -f "^$ENGINE/Contents/MacOS/"'));      // anchored at the line start: only the Engine's own processes
  assert.ok(s.includes('pkill -f "^$ENGINE/"'));
  assert.equal(s.includes('pgrep -f "$ENGINE'), false);              // the unanchored forms are gone
  assert.equal(s.includes('pkill -f "$ENGINE/'), false);
  assert.ok(s.includes('ZODE_ENGINE=1 ZODE_TAP_APP="$TMP/$(basename "$ENGINE")" bash "$REPO/scripts/build-tap.sh"'));
  assert.ok(s.includes('mv "$ENGINE" "$ENGINE.old"'));
  assert.ok(s.includes('mv "$TMP/$(basename "$ENGINE")" "$ENGINE"'));
  assert.ok(s.includes('rm -rf "$ENGINE.old"'));
  assert.ok(s.includes('open "$ENGINE"'));
  assert.ok(s.includes(`osascript -e 'display notification`));
  const build = 'bash "$REPO/scripts/build-tap.sh"';
  assert.ok(s.indexOf('tell application id') < s.indexOf(build));    // quit first, then build
  assert.ok(s.indexOf(build) < s.indexOf('mv "$ENGINE" "$ENGINE.old"'));    // build, then swap
  assert.ok(s.indexOf('mv "$TMP/$(basename "$ENGINE")" "$ENGINE"') < s.indexOf('open "$ENGINE"'));
  assert.equal(s.includes('kill -0 "$PID"'), false);                 // no --pid wait: Zode itself keeps running
  assert.equal(s.includes('/Applications/ZCode.app'), false);        // the original is never named, let alone touched
  assert.equal(s.includes('rm -rf "$ENGINE"\n'), false);              // the old engine goes only via the .old swap
});

const CHECK_LINE = '{"installed":"3.15.3","latest":"3.16.2","available":true,"zode":"3.15.3"}';
const CHECK_PARSED = { installed: '3.15.3', latest: '3.16.2', available: true, zode: '3.15.3' };

test('parseCheckOutput: the one JSON line the script prints', () => {
  assert.deepEqual(parseCheckOutput(CHECK_LINE), CHECK_PARSED);
  assert.deepEqual(parseCheckOutput(`\n  \t${CHECK_LINE}\n\n`), CHECK_PARSED);   // extra whitespace/newlines
  assert.deepEqual(parseCheckOutput(CHECK_LINE.replace('"available":true', '"available":false')),
    { ...CHECK_PARSED, available: false });
  // null is a valid value (the script prints null when an app is missing or has no version)
  assert.deepEqual(parseCheckOutput('{"installed":null,"latest":"3.16.2","available":false,"zode":null}'),
    { installed: null, latest: '3.16.2', available: false, zode: null });
});

test('parseCheckOutput: anything else is null, never a throw', () => {
  assert.equal(parseCheckOutput('{"installed":"1","latest":"2","available":"yes","zode":null}'), null);  // not a boolean
  assert.equal(parseCheckOutput('not json at all'), null);
  assert.equal(parseCheckOutput(''), null);
  assert.equal(parseCheckOutput('   \n'), null);
  assert.equal(parseCheckOutput('{}'), null);                         // missing fields
  assert.equal(parseCheckOutput('{"installed":"1","latest":"2","available":true}'), null);
  assert.equal(parseCheckOutput('{"installed":1,"latest":"2","available":true,"zode":null}'), null);  // wrong type
  assert.equal(parseCheckOutput('error: could not fetch the release manifest\nsecond line'), null);
  assert.equal(parseCheckOutput(`${CHECK_LINE} trailing junk`), null);
  assert.equal(parseCheckOutput(undefined), null);
  assert.equal(parseCheckOutput(null), null);
  assert.equal(parseCheckOutput(42), null);
});

test('checkRelease: runs bash on the script with --check, a 30 s timeout, and the env', async () => {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    cb(null, `${CHECK_LINE}\n`, '');
  };
  const env = { ZCODE_APP: '/Applications/ZCode.app', ZODE_APP: '/Applications/ZCode Engine.app' };
  assert.deepEqual(await checkRelease({ repo: '/repo', env, execFile }), CHECK_PARSED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/bin/bash');
  assert.deepEqual(calls[0].args, ['/repo/scripts/update-zcode.sh', '--check']);
  assert.equal(calls[0].opts.timeout, 30000);
  assert.deepEqual(calls[0].opts.env, env);
});

test('checkRelease: script failure (exit 3, no manifest) resolves null', async () => {
  const err = Object.assign(new Error('exit code 3'), { code: 3 });
  const execFile = (f, a, o, cb) => cb(err, '', 'error: could not fetch the release manifest');
  assert.equal(await checkRelease({ repo: '/repo', execFile }), null);
});

test('checkRelease: timeout or a throwing execFile resolves null', async () => {
  const killed = (f, a, o, cb) => cb(Object.assign(new Error('command timed out'), { killed: true, timedOut: true }));
  assert.equal(await checkRelease({ repo: '/repo', execFile: killed }), null);
  const throws = () => { throw new Error('spawn ENOENT'); };
  assert.equal(await checkRelease({ repo: '/repo', execFile: throws }), null);
});

test('checkRelease: malformed output resolves null', async () => {
  const execFile = (f, a, o, cb) => cb(null, 'garbage, no json', '');
  assert.equal(await checkRelease({ repo: '/repo', execFile }), null);
});

test('checkRelease: no repo resolves null without running anything', async () => {
  let called = 0;
  const execFile = () => { called += 1; };
  assert.equal(await checkRelease({ repo: null, execFile }), null);
  assert.equal(await checkRelease({ repo: '', execFile }), null);
  assert.equal(await checkRelease({}, execFile), null);
  assert.equal(called, 0);
});
