// buildPanelModel for every documented state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelModel } from '../lib/panel.mjs';

const NOW = 1_800_000_000_000;
const min = 60 * 1000;

const line = over => ({ id: over?.id ?? 's1', sessionId: over?.id ?? 's1', sock: '/sock', project: 'web', status: 'Working', done: false, older: false, light: 'green', at: NOW - 3 * min, ...over });   // like real lines: id is the session id
const perm = over => ({ requestId: 'r1', kind: 'permission', toolName: 'Bash', summary: 'Run: npm test', detail: 'Run: npm test', risky: false, sock: '/sock', ...over });
const input = over => ({
  running: true, phones: 2,
  addresses: [{ id: 'lan', label: 'Wi-Fi / local network (192.168.1.5)', ip: '192.168.1.5' }, { id: 'local', label: 'This Mac only', ip: '127.0.0.1' }],
  addressId: 'lan', launchAtLogin: false, keepAwake: true, setupDone: true, foldFinished: false,
  tapAlive: true, engine: { path: '/Applications/ZCode Engine.app' },
  update: { available: false, originalVersion: null, engineVersion: null },
  release: { available: false, latest: null, installed: null },
  version: '1.0.1',
  work: { lines: [], more: 0, pending: {} },
  selfUpdate: { phase: 'idle', version: null, percent: null },
  ...over,
});

test('quiet: idle glyph, All quiet, no banner, empty lists, settings pass through', () => {
  const m = buildPanelModel(input(), NOW);
  assert.equal(m.glyph, 'idle');
  assert.deepEqual(m.summary, { title: 'All quiet', tone: 'plain', sub: 'Mac awake · ZCode connected' });
  assert.equal(m.banner, null);
  assert.deepEqual(m.needs, []);
  assert.deepEqual(m.working, []);
  assert.deepEqual(m.done, []);
  assert.deepEqual(m.earlier, []);
  assert.equal(m.phones, 2);
  assert.equal(m.connected, true);
  assert.deepEqual(m.settings, {
    keepAwake: true, relayEnabled: true, launchAtLogin: false, foldFinished: false,
    addressId: 'lan',
    addresses: [{ id: 'lan', label: 'Wi-Fi / local network (192.168.1.5)' }, { id: 'local', label: 'This Mac only' }],
    version: '1.0.1', selfUpdate: 'idle',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);                 // JSON-safe: no undefined, no functions
});

test('the summary sub follows the ZCode connection and the keep-awake setting', () => {
  assert.equal(buildPanelModel(input({ tapAlive: false }), NOW).summary.sub, 'ZCode is not connected yet');
  assert.equal(buildPanelModel(input({ keepAwake: false }), NOW).summary.sub, 'ZCode connected');
  assert.equal(buildPanelModel(input({ tapAlive: false, keepAwake: false }), NOW).summary.sub, 'ZCode is not connected yet');
});

test('busy: every need kind, red before amber, working rows, finished split by age', () => {
  const m = buildPanelModel(input({
    work: {
      lines: [
        line({ id: 'w1', status: 'Working', at: NOW - 3 * min }),
        line({ id: 'a1', light: 'amber', status: 'Waiting for you', at: NOW - 5 * min }),
        line({ id: 'f1', light: 'red', status: 'Failed', at: NOW - 2 * min }),
        line({ id: 'q1', light: 'amber', status: 'Waiting for you', at: NOW - 1 * min }),
        line({ id: 'st', light: 'amber', status: 'Quiet for 12 min', at: NOW - 12 * min }),
        line({ id: 'd1', status: '3 min ago', done: true, older: false, at: NOW - 3 * min }),
        line({ id: 'd2', status: '48 min ago', done: true, older: false, at: NOW - 48 * min }),
        line({ id: 'e1', status: '2 h ago', done: true, older: true, at: NOW - 120 * min }),
      ],
      pending: {
        // oldest first, as listPending hands them over; a question sits behind two permissions
        a1: [
          perm({ requestId: 'r-oldest', summary: 'Run: sudo rm -rf /tmp/x', risky: true }),
          perm({ requestId: 'r-newer', summary: 'Run: npm install' }),
          perm({ requestId: 'r-q', kind: 'question', summary: '' }),
        ],
        q1: [perm({ requestId: 'r7', kind: 'question', summary: '' })],
      },
    },
  }), NOW);
  assert.deepEqual(m.needs.map(x => x.kind), ['failed', 'ask', 'question', 'stalled']);
  assert.equal(m.needs[0].id, 'f1');
  assert.equal(m.needs[0].ask, 'The last attempt failed.');
  assert.equal(m.needs[0].waiting, '2 min');
  const ask = m.needs[1];
  assert.equal(ask.id, 'a1');
  assert.equal(ask.requestId, 'r-oldest');            // the oldest permission request, not the newer one
  assert.equal(ask.ask, 'Run: sudo rm -rf /tmp/x');
  assert.equal(ask.ask !== 'Run: npm install', true);
  assert.equal(ask.risky, true);
  assert.equal(ask.waiting, '5 min');
  assert.equal(ask.sessionId, 'a1');
  assert.equal(ask.sock, '/sock');
  assert.equal(m.needs[2].kind, 'question');          // the question behind the permissions wins nothing
  assert.equal(m.needs[2].ask, 'Needs an answer in ZCode');
  assert.equal('requestId' in m.needs[2], false);
  assert.equal(m.needs[3].ask, 'No activity for 12 min. It may be stuck.');
  assert.equal(m.needs[3].waiting, '12 min');
  assert.deepEqual(m.working, [{ id: 'w1', project: 'web', doing: 'Working', t: '3 min' }]);
  assert.deepEqual(m.done, [
    { id: 'd1', project: 'web', t: '3 min ago' },
    { id: 'd2', project: 'web', t: '48 min ago' },
  ]);
  assert.deepEqual(m.earlier, [{ id: 'e1', project: 'web', t: '2 h ago' }]);
  assert.equal(m.summary.title, '4 need you · 1 working');
  assert.equal(m.summary.tone, 'warn');
  assert.equal(m.glyph, 'needs');
});

test('a waiting session with only a question — or nothing pending — still asks to be answered in ZCode', () => {
  const withQuestion = buildPanelModel(input({
    work: { lines: [line({ id: 'a', light: 'amber', status: 'Waiting for you', at: NOW - min })], pending: { a: [perm({ kind: 'question', summary: '' })] } },
  }), NOW);
  assert.equal(withQuestion.needs[0].kind, 'question');
  assert.equal(withQuestion.needs[0].ask, 'Needs an answer in ZCode');
  const withNothing = buildPanelModel(input({
    work: { lines: [line({ id: 'b', light: 'amber', status: 'Waiting for you', at: NOW - min })] },
  }), NOW);
  assert.equal(withNothing.needs[0].kind, 'question');
  assert.equal(withNothing.needs[0].waiting, '1 min');
});

test('summary titles for every combination, plural and singular', () => {
  const one = buildPanelModel(input({ work: { lines: [line({ id: 'a', light: 'amber', status: 'Waiting for you' })] } }), NOW);
  assert.equal(one.summary.title, '1 needs you');
  const two = buildPanelModel(input({
    work: { lines: [line({ id: 'a', light: 'amber', status: 'Waiting for you' }), line({ id: 'b', light: 'amber', status: 'Waiting for you' })] },
  }), NOW);
  assert.equal(two.summary.title, '2 need you');
  const mixed = buildPanelModel(input({
    work: { lines: [line({ id: 'a', light: 'amber', status: 'Waiting for you' }), line({ id: 'w1' }), line({ id: 'w2', at: NOW - 11 * min })] },
  }), NOW);
  assert.equal(mixed.summary.title, '1 needs you · 2 working');
  assert.equal(buildPanelModel(input(), NOW).summary.title, 'All quiet');
});

test('glyph: needs, then working, then idle', () => {
  assert.equal(buildPanelModel(input({
    work: { lines: [line({ id: 'a', light: 'amber', status: 'Waiting for you' }), line({ id: 'w' })] },
  }), NOW).glyph, 'needs');
  assert.equal(buildPanelModel(input({ work: { lines: [line({ id: 'w' })] } }), NOW).glyph, 'working');
  assert.equal(buildPanelModel(input({ work: { lines: [line({ id: 'd', status: '3 min ago', done: true })] } }), NOW).glyph, 'idle');
  assert.equal(buildPanelModel(input(), NOW).glyph, 'idle');
});

test('banner: none when there is nothing to say', () => {
  assert.equal(buildPanelModel(input(), NOW).banner, null);
});

test('banner: the engine rebuild, when the original ZCode is newer on disk', () => {
  const m = buildPanelModel(input({ update: { available: true, originalVersion: '3.16.2', engineVersion: '3.15.3' } }), NOW);
  assert.equal(m.banner.kind, 'zcode');
  assert.equal(m.banner.title, 'ZCode 3.16.2 is installed');
  assert.equal(m.banner.button, 'Rebuild the engine');
});

test('banner: a release online beats the plain rebuild', () => {
  const m = buildPanelModel(input({
    update: { available: true, originalVersion: '3.15.3', engineVersion: '3.15.2' },
    release: { available: true, latest: '3.16.3', installed: '3.15.3' },
  }), NOW);
  assert.equal(m.banner.kind, 'zcode');
  assert.equal(m.banner.title, 'ZCode 3.16.3 is available');
  assert.equal(m.banner.button, 'Update ZCode');
});

test('banner: a release with no version falls back to a generic title', () => {
  const m = buildPanelModel(input({ release: { available: true, latest: null, installed: null } }), NOW);
  assert.equal(m.banner.title, 'A new ZCode is available');
  assert.equal(m.banner.button, 'Update ZCode');
});

test('banner: the Zode self-update ready beats a ZCode release', () => {
  const m = buildPanelModel(input({
    selfUpdate: { phase: 'ready', version: '1.0.2', percent: 100 },
    release: { available: true, latest: '3.16.3', installed: '3.15.3' },
  }), NOW);
  assert.equal(m.banner.kind, 'update');
  assert.equal(m.banner.title, 'Zode 1.0.2 is ready');
  assert.equal(m.banner.button, 'Restart');
});

test('banner: setup beats everything — a missing engine, or ZCode not connected and not set up', () => {
  const noEngine = buildPanelModel(input({
    engine: { path: null },
    selfUpdate: { phase: 'ready', version: '1.0.2' },
    release: { available: true, latest: '3.16.3' },
  }), NOW);
  assert.equal(noEngine.banner.kind, 'setup');
  assert.equal(noEngine.banner.button, 'Set up');
  const fresh = buildPanelModel(input({ tapAlive: false, setupDone: false, selfUpdate: { phase: 'ready', version: '1.0.2' } }), NOW);
  assert.equal(fresh.banner.kind, 'setup');
  // connected but never set up, or set up but the engine is gone: only the real gap shows the banner
  assert.equal(buildPanelModel(input({ setupDone: false }), NOW).banner, null);
  assert.equal(buildPanelModel(input({ tapAlive: false }), NOW).banner, null);
});

test('settings.selfUpdate normalizes the updater phase', () => {
  assert.equal(buildPanelModel(input({ selfUpdate: { phase: 'downloading', percent: 40 } }), NOW).settings.selfUpdate, 'downloading');
  for (const phase of ['idle', 'checking', 'error']) {
    assert.equal(buildPanelModel(input({ selfUpdate: { phase } }), NOW).settings.selfUpdate, 'idle');
  }
});

test('ages without a usable clock stay empty instead of throwing', () => {
  const m = buildPanelModel(input({
    work: { lines: [line({ at: 'not a number' }), line({ at: Number.MAX_SAFE_INTEGER })] },
  }), NOW);
  assert.deepEqual(m.working.map(x => x.t), ['', 'now']);   // a future stamp (clock skew) counts as now
  assert.deepEqual(m.needs, []);
  const junkNow = buildPanelModel(input({ work: { lines: [line()] } }), 'not a time');
  assert.equal(junkNow.glyph, 'working');
});

test('junk or missing input never throws and yields the quiet model', () => {
  for (const junk of [
    null, undefined, 42, 'x', [], () => {},
    {}, { work: null }, { work: { lines: 'nope' } },
    { work: { lines: [null, 7, 'x', {}, { id: 'z' }] }, pending: { z: 'nope' } },
    { work: { lines: [line({ light: 'weird' })] } },
    { phones: NaN }, { addresses: 'nope', selfUpdate: 'nope', engine: 5 },
  ]) {
    const m = buildPanelModel(junk, NOW);
    assert.equal(m.glyph, 'idle');
    assert.deepEqual(m.needs, []);
    assert.deepEqual(m.working, []);
    assert.deepEqual(m.done, []);
    assert.deepEqual(m.earlier, []);
    assert.equal(m.banner, null);
    assert.deepEqual(m.settings.addresses, []);
    assert.equal(m.settings.selfUpdate, 'idle');
  }
});

test('junk pending entries on a real waiting line still produce one fallback ask card', () => {
  const m = buildPanelModel(input({
    work: { lines: [line({ id: 'a', light: 'amber', status: 'Waiting for you' })], pending: { a: [null, 3, 'x', { kind: 'permission' }] } },
  }), NOW);
  assert.equal(m.needs.length, 1);
  assert.equal(m.needs[0].kind, 'ask');
  assert.equal(m.needs[0].ask, 'Permission request');
  assert.equal(m.needs[0].risky, false);
  assert.equal(m.banner, null);
});
