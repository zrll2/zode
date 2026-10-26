// buildPanelModel for every documented state, plus the panel's pure display helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelModel, orderTitle } from '../lib/panel.mjs';
import { runFor, finishedDefaultOpen, addressSegOptions } from '../panel/helpers.mjs';

const NOW = 1_800_000_000_000;
const min = 60 * 1000;

const line = over => ({ id: over?.id ?? 's1', sessionId: over?.id ?? 's1', sock: '/sock', project: 'web', status: 'Working', done: false, older: false, light: 'green', at: NOW - 3 * min, liveSince: 0, title: '', ...over });   // like real lines: id is the session id
const perm = over => ({ requestId: 'r1', kind: 'permission', toolName: 'Bash', summary: 'Run: npm test', detail: 'Run: npm test', risky: false, sock: '/sock', ...over });
const input = over => ({
  running: true, phones: 2,
  addresses: [{ id: 'lan', label: 'Wi-Fi / local network (192.168.1.5)', ip: '192.168.1.5' }, { id: 'local', label: 'This Mac only', ip: '127.0.0.1' }],
  addressId: 'lan', launchAtLogin: false, keepAwake: true, autoAllow: true, askRisky: false, notify: true, claudeCode: true, setupDone: true, foldFinished: false,
  tapAlive: true, engine: { path: '/Applications/ZCode Engine.app' },
  update: { available: false, originalVersion: null, engineVersion: null },
  release: { available: false, latest: null, installed: null },
  version: '1.0.1',
  work: { lines: [], more: 0, pending: {} },
  selfUpdate: { phase: 'idle', version: null, percent: null },
  ...over,
});

test('quiet: idle glyph, no banner, empty lists, settings pass through, no headline', () => {
  const m = buildPanelModel(input(), NOW);
  assert.equal(m.glyph, 'idle');
  assert.equal(m.banner, null);
  assert.deepEqual(m.needs, []);
  assert.deepEqual(m.working, []);
  assert.deepEqual(m.done, []);
  assert.deepEqual(m.earlier, []);
  assert.equal(m.phones, 2);
  assert.equal(m.connected, true);
  assert.equal('summary' in m, false);                                // the headline is gone from the model
  assert.equal(m.usageLabel, null);                                   // usage unknown: hidden
  assert.deepEqual(m.settings, {
    keepAwake: true, autoAllow: true, askRisky: false, notify: true, claudeCode: true, relayEnabled: true, launchAtLogin: false, foldFinished: false,
    addressId: 'lan',
    addresses: [{ id: 'lan', label: 'Wi-Fi / local network (192.168.1.5)' }, { id: 'local', label: 'This Mac only' }],
    version: '1.0.1', selfUpdate: 'idle',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);                 // JSON-safe: no undefined, no functions
});

test('the automatic address choice is a mode without an ip and passes through first', () => {
  const m = buildPanelModel(input({
    addresses: [
      { id: 'auto', label: 'Automatic: Wi-Fi and Tailscale' },
      { id: 'tailscale', label: 'Tailscale (100.64.0.9)', ip: '100.64.0.9' },
      { id: 'lan', label: 'Wi-Fi / local network (192.168.1.5)', ip: '192.168.1.5' },
      { id: 'local', label: 'This Mac only', ip: '127.0.0.1' },
    ],
    addressId: 'auto',
  }), NOW);
  assert.equal(m.settings.addressId, 'auto');
  assert.deepEqual(m.settings.addresses[0], { id: 'auto', label: 'Automatic: Wi-Fi and Tailscale' });
  assert.deepEqual(m.settings.addresses.slice(1).map(a => a.id), ['tailscale', 'lan', 'local']);
});

test('busy: every need kind, red before amber, working rows with run start, finished split by age', () => {
  const m = buildPanelModel(input({
    work: {
      lines: [
        line({ id: 'w1', status: 'Working', at: NOW - 3 * min, liveSince: NOW - 12 * 60_000, title: 'Rewrite the pagination' }),
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
  assert.equal(m.needs[0].waiting, 'Failed');                          // no sentence: the right-hand value says it
  assert.equal('ask' in m.needs[0], false);
  const ask = m.needs[1];
  assert.equal(ask.id, 'a1');
  assert.equal(ask.requestId, 'r-oldest');            // the oldest permission request, not the newer one
  assert.equal(ask.ask, 'Run: sudo rm -rf /tmp/x');
  assert.equal(ask.risky, true);
  assert.equal(ask.waiting, '5 min');
  assert.equal(ask.sessionId, 'a1');
  assert.equal(ask.sock, '/sock');
  assert.deepEqual([ask.more, ask.same], [1, 0]);     // one other permission, none with the same command (the question does not count)
  assert.equal(m.needs[2].kind, 'question');          // the question behind the permissions wins nothing
  assert.equal(m.needs[2].waiting, '1 min');
  assert.equal('requestId' in m.needs[2], false);
  assert.equal('more' in m.needs[2], false);
  assert.equal(m.needs[3].kind, 'stalled');
  assert.equal(m.needs[3].waiting, 'Quiet 12m');      // the right-hand value, no sentence
  assert.equal('ask' in m.needs[3], false);
  assert.deepEqual(m.working, [{ id: 'w1', project: 'web', doing: 'Rewrite the pagination', since: NOW - 12 * 60_000, at: NOW - 3 * min }]);
  assert.deepEqual(m.done, [
    { id: 'd1', project: 'web', doing: '', t: '3 min ago', took: '' },
    { id: 'd2', project: 'web', doing: '', t: '48 min ago', took: '' },
  ]);
  assert.deepEqual(m.earlier, [{ id: 'e1', project: 'web', doing: '', t: '2 h ago', took: '' }]);
  assert.equal(m.glyph, 'needs');
});

test('a waiting session with only a question — or nothing pending — still asks to be answered in ZCode', () => {
  const withQuestion = buildPanelModel(input({
    work: { lines: [line({ id: 'a', light: 'amber', status: 'Waiting for you', at: NOW - min })], pending: { a: [perm({ kind: 'question', summary: '' })] } },
  }), NOW);
  assert.equal(withQuestion.needs[0].kind, 'question');
  assert.equal(withQuestion.needs[0].waiting, '1 min');
  const withNothing = buildPanelModel(input({
    work: { lines: [line({ id: 'b', light: 'amber', status: 'Waiting for you', at: NOW - min })] },
  }), NOW);
  assert.equal(withNothing.needs[0].kind, 'question');
  assert.equal(withNothing.needs[0].waiting, '1 min');
});

test('repeated requests: more counts the others, same counts identical commands, none with a single request', () => {
  const perms = (summary, requestId) => perm({ requestId, summary });
  const loop = buildPanelModel(input({
    work: { lines: [line({ id: 'a', light: 'amber', status: 'Waiting for you' })],
      pending: { a: [perms('Run: npm test', '1'), perms('Run: npm test', '2'), perms('Run: npm test', '3'), perms('Run: npm install', '4')] } },
  }), NOW);
  assert.equal(loop.needs.length, 1);
  assert.equal(loop.needs[0].kind, 'ask');
  assert.deepEqual([loop.needs[0].more, loop.needs[0].same], [3, 2]);   // three others, two of them the same command
  const solo = buildPanelModel(input({
    work: { lines: [line({ id: 'a', light: 'amber', status: 'Waiting for you' })], pending: { a: [perms('Run: npm test', '1')] } },
  }), NOW);
  assert.deepEqual([solo.needs[0].more, solo.needs[0].same], [0, 0]);   // one request: nothing to group
  const identified = buildPanelModel(input({                            // no summary: the tool name is the display text
    work: { lines: [line({ id: 'a', light: 'amber', status: 'Waiting for you' })],
      pending: { a: [perm({ requestId: '1', toolName: 'Bash' }), perm({ requestId: '2', toolName: 'Bash' })] } },
  }), NOW);
  assert.deepEqual([identified.needs[0].more, identified.needs[0].same], [1, 1]);
});

test('piled-up requests: pile, sameCount and canAlways ride on the ask need', () => {
  const opts = [
    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once', response: { decision: 'allow' } },
    { optionId: 'allow_project', kind: 'allow_always', name: 'Always allow in this project', response: { decision: 'allow' } },
  ];
  const m = buildPanelModel(input({
    work: { lines: [line({ id: 'a', light: 'amber', status: 'Waiting for you' })], pending: { a: [
      perm({ requestId: 'r1', summary: 'Run: npm test', options: opts }),
      perm({ requestId: 'r2', summary: 'Run: npm test' }),
      perm({ requestId: 'r3', summary: 'Run: npm test', risky: true }),
      perm({ requestId: 'r4', summary: 'Run: other' }),
      perm({ requestId: 'q', kind: 'question', summary: '' }),               // questions are not part of the pile
    ] } },
  }), NOW);
  const ask = m.needs[0];
  assert.equal(ask.kind, 'ask');
  assert.equal(ask.pile.length, 4);                                          // the shown one included, the question not
  assert.deepEqual(ask.pile[0], { requestId: 'r1', sock: '/sock', risky: false });
  assert.deepEqual(ask.pile[2], { requestId: 'r3', sock: '/sock', risky: true });
  assert.equal(ask.sameCount, 3);                                            // the shown one plus its two identical twins
  assert.equal(ask.canAlways, true);
  assert.deepEqual([ask.more, ask.same], [3, 2]);                            // the counts behind the +N more line

  // a single request: the pile is just itself, nothing to group, nothing to always-allow
  const solo = buildPanelModel(input({
    work: { lines: [line({ id: 'b', light: 'amber', status: 'Waiting for you' })], pending: { b: [perm({ requestId: 'r9', summary: 'Run: solo' })] } },
  }), NOW);
  assert.deepEqual(solo.needs[0].pile, [{ requestId: 'r9', sock: '/sock', risky: false }]);
  assert.equal(solo.needs[0].sameCount, 1);
  assert.equal(solo.needs[0].canAlways, false);

  // hundreds of repeats: the pile caps at 500
  const many = buildPanelModel(input({
    work: { lines: [line({ id: 'h', light: 'amber', status: 'Waiting for you' })], pending: { h: Array.from({ length: 600 }, (_, i) => perm({ requestId: 'm' + i, summary: 'Run: loop' })) } },
  }), NOW);
  assert.equal(many.needs[0].pile.length, 500);
  assert.equal(many.needs[0].sameCount, 500);
  assert.equal(many.needs[0].more, 599);
});

test('phoneList: sanitised, newest activity first, capped at 12, junk ignored, a label for every state', () => {
  const filler = Array.from({ length: 9 }, (_, i) => ({ id: 'p' + i, name: 'p' + i, connected: false, lastSeen: NOW - (i + 5) * min }));
  const m = buildPanelModel(input({
    phones: 3,
    phoneList: [
      { id: 'a', name: 'iphone', connected: true, lastSeen: NOW - min },
      { id: 'b', name: 'ipad', connected: false, lastSeen: NOW - 90 * 1000 },
      { id: 'c', name: 'watch', connected: false },                     // never seen anything: sorts last
      null, 7, 'x', { nope: 1 }, { id: '', name: 'x' },
      ...filler,
    ],
  }), NOW);
  assert.equal(m.phoneList.length, 12);
  assert.deepEqual(m.phoneList[0], { id: 'a', name: 'iphone', connected: true, lastSeen: NOW - min, when: 'Connected' });
  assert.deepEqual(m.phoneList[1], { id: 'b', name: 'ipad', connected: false, lastSeen: NOW - 90 * 1000, when: 'Last seen 1 min' });
  assert.equal(m.phoneList[2].id, 'p0');
  assert.equal(m.phoneList[10].id, 'p8');
  assert.deepEqual(m.phoneList[11], { id: 'c', name: 'watch', connected: false, lastSeen: null, when: 'Never connected' });
  // more than a dozen known phones: exactly the newest twelve stay
  const many = buildPanelModel(input({ phoneList: Array.from({ length: 15 }, (_, i) => ({ id: 'd' + i, name: 'd' + i, connected: false, lastSeen: NOW - i * min })) }), NOW);
  assert.equal(many.phoneList.length, 12);
  assert.deepEqual(many.phoneList.map(p => p.id), Array.from({ length: 12 }, (_, i) => 'd' + i));
  assert.deepEqual(buildPanelModel(input({ phoneList: 'nope' }), NOW).phoneList, []);
  assert.deepEqual(buildPanelModel(input({}), NOW).phoneList, []);
});

test('usage: sanitised into {today, week} with a today-only label, or null when missing or junk', () => {
  const ok = buildPanelModel(input({ usage: { today: 172000000, week: 5810000000 } }), NOW);
  assert.deepEqual(ok.usage, { today: 172000000, week: 5810000000 });
  assert.equal(ok.usageLabel, '172M today');                             // the 7-day part is gone
  const small = buildPanelModel(input({ usage: { today: 1500, week: 999 } }), NOW);
  assert.equal(small.usageLabel, '1.5K today');
  const round = buildPanelModel(input({ usage: { today: 1234.6, week: 2000000 } }), NOW);
  assert.deepEqual(round.usage, { today: 1235, week: 2000000 });
  assert.equal(round.usageLabel, '1.2K today');
  assert.equal(buildPanelModel(input({ usage: null }), NOW).usage, null);
  assert.equal(buildPanelModel(input({ usage: null }), NOW).usageLabel, null);
  assert.equal(buildPanelModel(input({ usage: { today: 'x', week: -5 } }), NOW).usage, null);
  assert.equal(buildPanelModel(input({ usage: { today: 10 } }), NOW).usageLabel, null);   // week missing: no line at all
  assert.equal(buildPanelModel(input({}), NOW).usageLabel, null);
});

test('banner: none when everything is fine', () => {
  assert.equal(buildPanelModel(input(), NOW).banner, null);
});

test('banner: the engine rebuild, when the original ZCode is newer on disk', () => {
  const m = buildPanelModel(input({ update: { available: true, originalVersion: '3.16.2', engineVersion: '3.15.3' } }), NOW);
  assert.equal(m.banner.kind, 'zcode');
  assert.equal(m.banner.title, 'ZCode 3.16.2 is installed');
  assert.equal(m.banner.button, 'Rebuild the engine');
  assert.equal(m.banner.dot, 'amber');
  assert.equal('detail' in m.banner, false);                        // titles and buttons carry it; no descriptions
});

test('banner: a release online beats the plain rebuild', () => {
  const m = buildPanelModel(input({
    update: { available: true, originalVersion: '3.15.3', engineVersion: '3.15.2' },
    release: { available: true, latest: '3.16.3', installed: '3.15.3' },
  }), NOW);
  assert.equal(m.banner.kind, 'zcode');
  assert.equal(m.banner.title, 'ZCode 3.16.3 is available');
  assert.equal(m.banner.button, 'Update ZCode');
  assert.equal('detail' in m.banner, false);
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
  // connected but never set up: no setup banner (ZCode itself is fine)
  assert.equal(buildPanelModel(input({ setupDone: false }), NOW).banner, null);
});

test('banner: ZCode not running shows the down row once setup is out of the way', () => {
  const m = buildPanelModel(input({ tapAlive: false }), NOW);
  assert.deepEqual(m.banner, { kind: 'down', title: 'ZCode is not running', button: 'Open ZCode', dot: 'red' });
  assert.equal(buildPanelModel(input({ tapAlive: true }), NOW).banner, null);
});

test('runFor: seconds, minutes, hours and a blank when the start is unknown', () => {
  assert.equal(runFor(NOW - 45_000, NOW), '45s');
  assert.equal(runFor(NOW - 60_000, NOW), '1m');
  assert.equal(runFor(NOW - 12 * 60_000, NOW), '12m');
  assert.equal(runFor(NOW - 65 * 60_000, NOW), '1h 5m');
  assert.equal(runFor(0, NOW), '');
  assert.equal(runFor(undefined, NOW), '');
  assert.equal(runFor(NOW + 5000, NOW), '0s');                        // a future start never goes negative
});

test('finishedDefaultOpen: expanded when it is the whole show, collapsed beside other work or on fold', () => {
  const done = [{ id: 'd1' }];
  assert.equal(finishedDefaultOpen({ done }), true);
  assert.equal(finishedDefaultOpen({ done, working: [{ id: 'w' }] }), false);
  assert.equal(finishedDefaultOpen({ done, needs: [{ id: 'n' }] }), false);
  assert.equal(finishedDefaultOpen({ done, foldFinished: true }), false);
  assert.equal(finishedDefaultOpen({}), false);                        // nothing finished: nothing to open
});

test('addressSegOptions: Automatic always; Wi-Fi and Tailscale only when the address exists', () => {
  assert.deepEqual(addressSegOptions([
    { id: 'auto', label: 'Automatic' },
    { id: 'tailscale', label: 'Tailscale (100.64.0.9)' },
    { id: 'lan', label: 'Wi-Fi / local network (192.168.1.5)' },
    { id: 'local', label: 'This Mac only' },
  ]), [
    { id: 'auto', label: 'Automatic' },
    { id: 'lan', label: 'Wi-Fi' },
    { id: 'tailscale', label: 'Tailscale' },
  ]);
  assert.deepEqual(addressSegOptions([{ id: 'auto', label: 'Automatic' }, { id: 'local', label: 'This Mac only' }]),
    [{ id: 'auto', label: 'Automatic' }]);
  assert.deepEqual(addressSegOptions(undefined), [{ id: 'auto', label: 'Automatic' }]);
  assert.deepEqual(addressSegOptions('junk'), [{ id: 'auto', label: 'Automatic' }]);
});

test('settings switches: the auto-allow default is on, the risky gate and notify ride along', () => {
  assert.equal(buildPanelModel(input({ autoAllow: true }), NOW).settings.autoAllow, true);
  assert.equal(buildPanelModel(input({ autoAllow: false }), NOW).settings.autoAllow, false);
  assert.equal(buildPanelModel(input({}), NOW).settings.autoAllow, true);         // the default is on: junk never flips it
  assert.equal(buildPanelModel(input({ autoAllow: 'yes' }), NOW).settings.autoAllow, true);
  assert.equal(buildPanelModel(input({ askRisky: true }), NOW).settings.askRisky, true);
  assert.equal(buildPanelModel(input({}), NOW).settings.askRisky, false);         // missing or invalid means off
  assert.equal(buildPanelModel(input({ notify: false }), NOW).settings.notify, false);
  assert.equal(buildPanelModel(input({ notify: 'yes' }), NOW).settings.notify, true);
  assert.equal(buildPanelModel(input({ claudeCode: true }), NOW).settings.claudeCode, true);
  assert.equal(buildPanelModel(input({ claudeCode: false }), NOW).settings.claudeCode, false);
  assert.equal(buildPanelModel(input({}), NOW).settings.claudeCode, true);           // the default is on: junk never flips it
  assert.equal(buildPanelModel(input({ claudeCode: 'yes' }), NOW).settings.claudeCode, true);
});

test('ages without a usable clock stay empty instead of throwing', () => {
  const m = buildPanelModel(input({
    work: { lines: [line({ at: 'not a number' }), line({ at: Number.MAX_SAFE_INTEGER })] },
  }), NOW);
  assert.deepEqual(m.working.map(x => x.at), [0, Number.MAX_SAFE_INTEGER]);   // a future stamp counts as now
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

test('voice: quiet defaults on no or junk input; real values pass through', () => {
  const quiet = { language: 'en', engine: false, model: { id: 'small', state: 'missing', bytes: 0 }, download: { state: 'idle', received: 0, total: 0, error: '' } };
  assert.deepEqual(buildPanelModel(input(), NOW).voice, quiet);
  assert.deepEqual(buildPanelModel(null, NOW).voice, quiet);
  assert.deepEqual(buildPanelModel(input({ voice: { language: 'fr', engine: 'yes', model: { state: 'weird', bytes: -5, id: 9 }, download: { state: 'nope', received: 'x', total: NaN, error: 7 } } }), NOW).voice,
    { language: 'en', engine: false, model: { id: 'small', state: 'missing', bytes: 0 }, download: { state: 'idle', received: 0, total: 0, error: '' } });
  assert.deepEqual(buildPanelModel(input({
    voice: { language: 'zh', engine: true, model: { id: 'small', state: 'ready', bytes: 487601967 }, download: { state: 'downloading', received: 122, total: 488, error: '' } },
  }), NOW).voice,
  { language: 'zh', engine: true, model: { id: 'small', state: 'ready', bytes: 487601967 }, download: { state: 'downloading', received: 122, total: 488, error: '' } });
});

test('agoFor and clockFor: the right-hand time of a running row', async () => {
  const { agoFor, clockFor } = await import('../panel/helpers.mjs');
  assert.equal(agoFor(NOW - 3_000, NOW), 'now');
  assert.equal(agoFor(NOW - 42_000, NOW), '42s ago');
  assert.equal(agoFor(NOW - 5 * min, NOW), '5m ago');
  assert.equal(agoFor(NOW - 130 * min, NOW), '2h ago');
  assert.equal(agoFor(0, NOW), '');
  assert.equal(clockFor(NOW - 247_000, NOW), '4:07');
  assert.equal(clockFor(NOW - (3600 + 5 * 60 + 9) * 1000, NOW), '1:05:09');
  assert.equal(clockFor(NOW - 9_000, NOW), '0:09');
  assert.equal(clockFor(undefined, NOW), '');
  assert.equal(clockFor(-5, NOW), '');
});

test('orderTitle: every work order reads "Work order NN: ..."', () => {
  const t = (title, project = 'x-wt') => orderTitle({ title, project });
  assert.equal(t('# Work order 01: READ-ONLY audit'), 'Work order 01: READ-ONLY audit');
  assert.equal(t('**Work order S1 — thing'), 'Work order S1: thing');
  assert.equal(t('Bug register review'), 'Work order: Bug register review');
  assert.equal(t('Bug register review', 'zode'), 'Bug register review');
  assert.equal(t(''), '');
});

test('finished rows: "N min ago" and how long the conversation took', () => {
  const m = buildPanelModel(input({ work: { lines: [
    line({ id: 'd', done: true, status: 'Done', at: NOW - min, startedAt: NOW - 15 * min }),
    line({ id: 'x', done: true, status: 'Done', at: NOW - 2 * min, startedAt: NOW - 90 * 1000 }),
  ], more: 0, pending: {} } }), NOW);
  const r = Object.fromEntries(m.done.map(d => [d.id, d]));
  assert.deepEqual([r.d.t, r.d.took], ['1 min ago', '14 min']);
  assert.equal(r.x.took, '');
});
