import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findEngine, migrateEngine, enginePathFor, appProcessPattern, isRunning } from '../lib/system.mjs';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zode-eng-'));
const apps = h => path.join(h, 'SysApplications');     // a stand-in for /Applications: a test never touches the real one
const never = (_c, _a, o, cb) => (typeof o === 'function' ? o : cb)(new Error('not running'), '');   // pgrep finds nothing
const fake = (_cmd, _args, o, cb) => (typeof o === 'function' ? o : cb)(null, '');                  // PlistBuddy / codesign succeed

test('findEngine: the private folder wins over the old places', async () => {
  const h = home();
  fs.mkdirSync(path.join(h, 'Applications', 'ZCode Engine.app'), { recursive: true });
  assert.equal(await findEngine({ home: h, apps: apps(h) }), path.join(h, 'Applications', 'ZCode Engine.app'));
  fs.mkdirSync(enginePathFor(h), { recursive: true });
  assert.equal(await findEngine({ home: h, apps: apps(h) }), enginePathFor(h));
});

test('migrateEngine: an old engine moves into the private folder and is re-signed', async () => {
  const h = home();
  const old = path.join(h, 'Applications', 'ZCode Engine.app');
  fs.mkdirSync(path.join(old, 'Contents'), { recursive: true });
  const calls = [];
  const run = (cmd, args, o, cb) => { calls.push(path.basename(cmd)); return (cmd === 'pgrep' ? never : fake)(cmd, args, o, cb); };
  const moved = await migrateEngine({ home: h, apps: apps(h), run });
  assert.equal(moved, enginePathFor(h));
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(path.join(enginePathFor(h), 'Contents')), true);
  assert.deepEqual(calls.filter(c => c !== 'pgrep'), ['PlistBuddy', 'codesign']);
});

test('migrateEngine: nothing to move, already moved, or running means null and no change', async () => {
  const h = home();
  assert.equal(await migrateEngine({ home: h, apps: apps(h), run: never }), null);
  const old = path.join(h, 'Applications', 'ZCode Engine.app');
  fs.mkdirSync(old, { recursive: true });
  const running = (_c, _a, o, cb) => (typeof o === 'function' ? o : cb)(null, '123\n');
  assert.equal(await migrateEngine({ home: h, apps: apps(h), run: running }), null);
  assert.equal(fs.existsSync(old), true);
  fs.mkdirSync(enginePathFor(h), { recursive: true });
  assert.equal(await migrateEngine({ home: h, apps: apps(h), run: never }), null);
});

test('appProcessPattern anchors at the start of the command line', () => {
  assert.equal(appProcessPattern('/Applications/ZCode.app'), '^/Applications/ZCode.app/Contents/MacOS/');
  assert.equal(appProcessPattern('/Users/x/Library/Application Support/Zode/engine.noindex/ZCode.app'),
    '^/Users/x/Library/Application Support/Zode/engine.noindex/ZCode.app/Contents/MacOS/');
});

test('isRunning asks pgrep for the anchored pattern and reads its stdout', async () => {
  const calls = [];
  const found = (cmd, args, o, cb) => { calls.push([cmd, args]); (typeof o === 'function' ? o : cb)(null, '123\n'); };
  assert.equal(await isRunning('/Applications/ZCode.app', found), true);
  assert.deepEqual(calls, [['pgrep', ['-f', '^/Applications/ZCode.app/Contents/MacOS/']]]);
  assert.equal(await isRunning('/Applications/ZCode.app', never), false);
  assert.equal(await isRunning('', never), false);
});
