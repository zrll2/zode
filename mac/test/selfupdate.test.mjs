// createSelfUpdater against a fake updater: the phase machine, the config, the schedules, and the
// one-restart-per-ready-version rule. The fake is an EventEmitter with settable fields, the same
// surface the real electron-updater autoUpdater has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSelfUpdater, shortError } from '../lib/selfupdate.mjs';

function fakeUpdater(check = async () => ({})) {
  const u = new EventEmitter();
  u.autoDownload = null;
  u.autoInstallOnAppQuit = null;
  u.allowPrerelease = null;
  u.logger = null;
  u.checkForUpdates = check;
  let installs = 0;
  u.quitAndInstall = () => { installs += 1; };
  u.installs = () => installs;
  return u;
}

const fakeTimers = () => {
  const timers = [];
  const make = kind => (fn, ms) => { const t = { kind, fn, ms, unref() {} }; timers.push(t); return t; };
  return { timers, setTimeout: make('timeout'), setInterval: make('interval') };
};

test('start configures the updater and schedules the 60 s first check and the 6 h interval', async () => {
  let checks = 0;
  const u = fakeUpdater(async () => { checks += 1; u.emit('update-not-available'); return {}; });
  const timers = fakeTimers();
  const s = createSelfUpdater({ updater: u, isPackaged: true, timers });
  s.start();
  s.start();                                                          // idempotent: no second pair of timers
  assert.equal(u.autoDownload, true);
  assert.equal(u.autoInstallOnAppQuit, true);
  assert.equal(u.allowPrerelease, false);
  assert.equal(typeof u.logger.info, 'function');
  assert.equal(timers.timers.length, 2);
  assert.deepEqual(timers.timers.map(t => t.ms), [60_000, 6 * 60 * 60 * 1000]);
  await timers.timers[0].fn();
  await timers.timers[1].fn();
  assert.equal(checks, 2);
});

test('phases: checking, available becomes downloading, progress, downloaded becomes ready', async () => {
  const u = fakeUpdater(async () => {
    u.emit('checking-for-update');
    u.emit('update-available', { version: '1.2.3' });
    u.emit('download-progress', { percent: 42.6 });
    return {};
  });
  const s = createSelfUpdater({ updater: u, isPackaged: true });
  const r = await s.checkNow();
  assert.equal(s.getState().phase, 'downloading');
  assert.equal(s.getState().version, '1.2.3');
  assert.equal(s.getState().percent, 43);
  assert.deepEqual(r, { status: 'downloading', version: '1.2.3' });
  u.emit('update-downloaded', { version: '1.2.3' });
  assert.equal(s.getState().phase, 'ready');
  assert.equal(s.getState().percent, 100);
});

test('not available returns to idle; a check that finds it already downloaded reports ready', async () => {
  const u = fakeUpdater(async () => { u.emit('checking-for-update'); u.emit('update-not-available'); return {}; });
  const s = createSelfUpdater({ updater: u, isPackaged: true });
  assert.deepEqual(await s.checkNow(), { status: 'up-to-date' });
  assert.equal(s.getState().phase, 'idle');

  const u2 = fakeUpdater(async () => { u2.emit('update-downloaded', { version: '2.0.0' }); return {}; });
  const s2 = createSelfUpdater({ updater: u2, isPackaged: true });
  assert.deepEqual(await s2.checkNow(), { status: 'ready', version: '2.0.0' });
});

test('error sets a plain message and the next check retries', async () => {
  const u = fakeUpdater(async () => { throw new Error('HttpError: 404 Not Found'); });
  const s = createSelfUpdater({ updater: u, isPackaged: true });
  const r1 = await s.checkNow();
  assert.equal(r1.status, 'error');
  assert.match(r1.error, /No update information/);
  assert.equal(s.getState().phase, 'error');
  u.checkForUpdates = async () => { u.emit('update-not-available'); return {}; };
  const r2 = await s.checkNow();
  assert.equal(r2.status, 'up-to-date');
  assert.equal(s.getState().phase, 'idle');
});

test('not packaged: nothing happens and the phase stays idle', async () => {
  const u = fakeUpdater();
  const timers = fakeTimers();
  const s = createSelfUpdater({ updater: u, isPackaged: false, timers });
  s.start();
  assert.equal(timers.timers.length, 0);                              // no checks scheduled
  assert.equal(u.autoDownload, null);                                 // no config touched
  assert.deepEqual(await s.checkNow(), { status: 'disabled' });
  assert.equal(s.getState().phase, 'idle');
});

test('concurrent checks collapse into one', async () => {
  let calls = 0;
  const u = fakeUpdater(async () => {
    calls += 1;
    await new Promise(r => setTimeout(r, 5));
    u.emit('update-not-available');
    return {};
  });
  const s = createSelfUpdater({ updater: u, isPackaged: true });
  const [a, b] = await Promise.all([s.checkNow(), s.checkNow()]);
  assert.equal(calls, 1);
  assert.equal(b, a);                                                 // the very same promise and result
  assert.equal(a.status, 'up-to-date');
});

test('a ready state is kept: a scheduled check does not take the restart item away', async () => {
  let checks = 0;
  const u = fakeUpdater(async () => { checks += 1; u.emit('update-not-available'); return {}; });
  const s = createSelfUpdater({ updater: u, isPackaged: true });
  u.emit('update-downloaded', { version: '3.0.0' });
  const r = await s.checkNow();
  assert.deepEqual(r, { status: 'ready', version: '3.0.0' });
  assert.equal(checks, 0);                                            // no new check ran, ready stays ready
});

test('install calls quitAndInstall only when an update is ready', () => {
  const u = fakeUpdater();
  const s = createSelfUpdater({ updater: u, isPackaged: true });
  s.install();
  assert.equal(u.installs(), 0);
  u.emit('update-downloaded', { version: '3.0.0' });
  s.install();
  assert.equal(u.installs(), 1);
});

test('the ready callback fires once per version', () => {
  const seen = [];
  const u = fakeUpdater();
  const s = createSelfUpdater({ updater: u, isPackaged: true, onReady: v => seen.push(v) });
  u.emit('update-downloaded', { version: '4.0.0' });
  u.emit('update-downloaded', { version: '4.0.0' });
  u.emit('update-downloaded', { version: '4.1.0' });
  assert.deepEqual(seen, ['4.0.0', '4.1.0']);
});

test('shortError maps failures to plain sentences', () => {
  assert.match(shortError('ENOTFOUND api.github.com'), /reach the update server/);
  assert.match(shortError('HttpError: 404 Not Found'), /No update information/);
  assert.match(shortError('signature verification failed'), /safety check/);
  assert.match(shortError('weird crash'), /Something went wrong/);
  assert.match(shortError(undefined), /Something went wrong/);
});
