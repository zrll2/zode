// The pure setup helpers: step list, build progress mapping, friendly errors, kit folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupSteps, parseBuildProgress, friendlySetupError, kitDir } from '../lib/setup.mjs';

const facts = (over = {}) => ({ originalExists: false, engineExists: false, tapAlive: false, setupDone: false, ...over });
const states = (list) => list.map(s => s.state);

test('setupSteps: the first unfinished step is current, the rest todo', () => {
  const t = setupSteps(facts());
  assert.deepEqual(t.map(s => s.id), ['find', 'prepare', 'login', 'phone']);
  assert.deepEqual(states(t), ['current', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(setupSteps(facts({ originalExists: true }))), ['done', 'current', 'todo', 'todo']);
  assert.deepEqual(states(setupSteps(facts({ originalExists: true, engineExists: true }))), ['done', 'done', 'current', 'todo']);
  assert.deepEqual(states(setupSteps(facts({ originalExists: true, engineExists: true, tapAlive: true }))), ['done', 'done', 'done', 'current']);
  assert.deepEqual(states(setupSteps(facts({ originalExists: true, engineExists: true, tapAlive: true, setupDone: true }))), ['done', 'done', 'done', 'done']);
});

test('setupSteps: a connected ZCode without Done still shows the phone step', () => {
  assert.deepEqual(states(setupSteps(facts({ originalExists: true, engineExists: true, tapAlive: true, setupDone: false }))), ['done', 'done', 'done', 'current']);
});

test('setupSteps: garbage facts never throw and count as nothing done', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    assert.deepEqual(states(setupSteps(bad)), ['current', 'todo', 'todo', 'todo']);
  }
});

test('parseBuildProgress maps the four build-tap lines and nothing else', () => {
  assert.deepEqual(parseBuildProgress('Copying ZCode.app (806M) to /Applications/ZCode Engine.app ...'), { label: 'Copying ZCode (this takes a minute)', percent: 10 });
  assert.deepEqual(parseBuildProgress('Engine mode: no relay integration inside the app (the standalone Zode app runs it).'), { label: 'Setting things up', percent: 70 });
  assert.deepEqual(parseBuildProgress('Signing (ad hoc) ...'), { label: 'Almost done', percent: 85 });
  assert.deepEqual(parseBuildProgress('Built /Applications/ZCode Engine.app'), { label: 'Done', percent: 100 });
  assert.equal(parseBuildProgress('npm warn deprecated something'), null);
  assert.equal(parseBuildProgress('error: ZCode not found at /Applications/ZCode.app'), null);
  assert.equal(parseBuildProgress(''), null);
  assert.equal(parseBuildProgress(undefined), null);
});

test('friendlySetupError maps known failures to plain words', () => {
  const disk = friendlySetupError('ditto: No space left on device');
  assert.match(disk.message, /space/i);
  assert.ok(disk.hint.length > 0);

  const perm = friendlySetupError('cp: /Applications/ZCode Engine.app: Permission denied');
  assert.match(perm.message, /could not save/i);
  assert.ok(perm.hint.length > 0);

  const running = friendlySetupError('/Applications/ZCode.app is running. Quit it (Cmd+Q), then run this again.');
  assert.match(running.message, /open/i);

  const missing = friendlySetupError('ZCode not found at /Applications/ZCode.app. Install ZCode first, or set ZCODE_APP.');
  assert.match(missing.message, /find/i);
  assert.match(missing.hint, /zcode\.z\.ai/);

  const notZcode = friendlySetupError('/x does not look like ZCode (no Resources/glm/zcode.cjs).');
  assert.match(notZcode.message, /find/i);

  const unknown = friendlySetupError('kaboom at line 42');
  assert.equal(unknown.message, 'Something went wrong. Details are in ~/.zode/mac-app.log');
  assert.equal(friendlySetupError(null).message, unknown.message);
  assert.equal(friendlySetupError(undefined).message, unknown.message);
});

test('kitDir: packaged apps use Resources/engine-kit, development uses the repo', () => {
  assert.equal(kitDir({ packaged: true, resourcesPath: '/Applications/Zode.app/Contents/Resources', devRoot: '/repo' }), '/Applications/Zode.app/Contents/Resources/engine-kit');
  assert.equal(kitDir({ packaged: false, resourcesPath: '/x/Resources', devRoot: '/repo' }), '/repo');
  assert.equal(kitDir({}), '');
});
