// buildMenuTemplate for every documented state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignedLabels, textWidth, buildMenuTemplate } from '../lib/menu.mjs';

const HINT = 'Not encrypted. Use Tailscale away from home.';
const ENGINE = '/Applications/ZCode Engine.app';
const calls = [];
const actions = {
  pair: () => calls.push('pair'),
  toggleRelay: () => calls.push('toggleRelay'),
  revoke: (id) => calls.push('revoke:' + id),
  selectAddress: (id) => calls.push('select:' + id),
  toggleLaunchAtLogin: () => calls.push('login'),
  toggleKeepAwake: () => calls.push('keepAwake'),
  toggleFoldFinished: () => calls.push('toggleFoldFinished'),
  refreshWork: () => calls.push('refreshWork'),
  setup: () => calls.push('setup'),
  openEngine: () => calls.push('openEngine'),
  about: () => calls.push('about'),
  quit: () => calls.push('quit'),
  updateZcode: () => calls.push('updateZcode'),
  rebuildEngine: () => calls.push('rebuildEngine'),
  installSelfUpdate: () => calls.push('installSelfUpdate'),
  checkSelfUpdate: () => calls.push('checkSelfUpdate'),
};
const addresses = [
  { id: 'tailscale', label: 'Tailscale (100.64.0.1)', ip: '100.64.0.1' },
  { id: 'lan', label: 'Wi-Fi / local network (192.168.1.5)', ip: '192.168.1.5' },
  { id: 'local', label: 'This Mac only', ip: '127.0.0.1' },
];
const state = (over = {}) => ({ running: true, error: null, phones: 0, devices: [], addresses, addressId: 'tailscale', launchAtLogin: false, tapAlive: true, keepAwake: true, engine: { path: ENGINE }, ...over });
const byLabel = (t, label) => t.find(i => i.label === label);

test('status line variants', () => {
  assert.equal(buildMenuTemplate(state({ phones: 2, devices: [{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }] }), actions)[0].label, 'Relay running · 2 phones');
  assert.equal(buildMenuTemplate(state({ phones: 1, devices: [{ id: 'a', name: 'x' }] }), actions)[0].label, 'Relay running · 1 phone');
  assert.equal(buildMenuTemplate(state(), actions)[0].label, 'Relay running · no phones paired');
  assert.equal(buildMenuTemplate(state({ running: false }), actions)[0].label, 'Relay stopped');
  assert.equal(buildMenuTemplate(state({ running: false, error: 'port 8787 is in use. Is the old Zode still running?' }), actions)[0].label,
    'Relay error: port 8787 is in use. Is the old Zode still running?');
});

test('a long error line is cut at 80 characters', () => {
  const label = buildMenuTemplate(state({ running: false, error: 'x'.repeat(200) }), actions)[0].label;
  assert.equal(label.length, 80);
  assert.ok(label.startsWith('Relay error: '));
});

// The ZCode-now block: what ZCode is doing right now, at the top of the menu. Icons arrive as opaque
// values; a finished line gets the green tick.
const icons = { green: { name: 'green' }, amber: { name: 'amber' }, red: { name: 'red' }, grey: { name: 'grey' }, tick: { name: 'tick' } };
const withWork = over => ({ icons, work: { lines: [], more: 0, ...over } });

test('work block: refresh header, one clickable lit line per session, fold switch, +N more, then the usual menu', () => {
  const t = buildMenuTemplate(state(withWork({
    lines: [
      { id: 'w1', project: 'web', status: 'Working', light: 'green', done: false },
      { id: 'w2', project: 'cli', status: 'Waiting for you', light: 'amber', done: false },
      { id: 'w3', project: 'No workspace', status: 'Failed', light: 'red', done: false },
      { id: 'w4', project: 'docs', status: '3 min ago', light: 'green', done: true },
    ],
    more: 2,
  })), actions);
  const text = i => i.label.replace(/[\u2002\u2003\u2009]+/g, ' | ');         // the status sits in its own column, after wide spaces
  assert.deepEqual(t.slice(0, 7).map(i => (i.label === undefined ? undefined : text(i))), ['ZCode right now | ↻ Refresh', 'web | Working', 'cli | Waiting for you', 'No workspace | Failed', 'docs | 3 min ago', '+2 more', 'Fold finished']);
  assert.notEqual(t[0].enabled, false);                 // the header is the refresh button
  calls.length = 0; t[0].click();
  assert.deepEqual(calls, ['refreshWork']);
  assert.equal(t[1].icon, icons.green);                 // the loaded nativeImages pass through untouched
  assert.equal(t[2].icon, icons.amber);
  assert.equal(t[3].icon, icons.red);
  assert.equal(t[4].icon, icons.tick);                  // a finished conversation gets the green tick, not a dot
  assert.equal(t[5].enabled, false);                    // the +N more stub is not clickable
  assert.equal(t[6].label, 'Fold finished');             // a finished line exists, so the fold switch is offered
  assert.equal(t[7].type, 'separator');
  assert.ok(t.slice(8).some(i => i.label === 'Relay running · no phones paired'));   // the usual menu follows
  calls.length = 0;
  t[1].click();
  assert.deepEqual(calls, ['openEngine']);              // a line opens the Engine app
});

test('work block: lines without overflow get no +N stub', () => {
  const t = buildMenuTemplate(state(withWork({ lines: [{ id: 'w1', project: 'zode', status: 'Working', light: 'green', done: false }] })), actions);
  assert.equal(t[2].type, 'separator');
  assert.equal(t.some(i => typeof i.label === 'string' && i.label.startsWith('+')), false);
});

test('work block: nothing active, nothing added — the template looks exactly as before', () => {
  const base = buildMenuTemplate(state(), actions);
  assert.equal(base.some(i => i.label === 'ZCode right now'), false);
  for (const s of [state({ work: { lines: [], more: 0 } }), state({ work: null }), state({ work: undefined }), state()]) {
    const t = buildMenuTemplate(s, actions);
    assert.equal(t.length, base.length);                              // no items added
    assert.deepEqual(t.map(i => i.label), base.map(i => i.label));    // same labels in the same order
  }
});

test('alignedLabels: statuses start in one column, wider names get less padding', () => {
  const rows = alignedLabels([{ project: 'zode', status: 'Working' }, { project: 'onetrend-trade-anyway-wt', status: '8 min ago' }, { project: 'TikTok课程培训', status: 'Just now' }]);
  assert.ok(rows[0].startsWith('zode') && rows[0].endsWith('Working'));
  const padLen = r => r.match(/[\u2002\u2003\u2009]+/)[0].length;
  assert.ok(padLen(rows[0]) > padLen(rows[1]));          // the short name is padded more than the longest one
  assert.equal(alignedLabels([]).length, 0);
  assert.ok(textWidth('TikTok课程培训') > textWidth('TikTok'));
});

test('fold finished: finished lines move into a Finished (N) submenu; unfolded shows them all', () => {
  const lines = [
    { id: 'a', project: 'web', status: 'Working', light: 'green', done: false },
    { id: 'b', project: 'docs', status: '3 min ago', light: 'green', done: true },
    { id: 'c', project: 'cli', status: '1 h ago', light: 'green', done: true },
  ];
  const open = buildMenuTemplate(state({ ...withWork({ lines }), foldFinished: false }), actions);
  assert.equal(open.some(i => i.label?.startsWith('Finished (')), false);
  assert.equal(open.find(i => i.label === 'Fold finished').checked, false);
  const folded = buildMenuTemplate(state({ ...withWork({ lines }), foldFinished: true }), actions);
  assert.equal(folded.some(i => /^docs/.test(i.label ?? '')), false);               // not inline any more
  const sub = folded.find(i => i.label === 'Finished (2)');
  assert.equal(sub.submenu.length, 2);
  assert.equal(sub.submenu[0].icon, icons.tick);
  const fold = folded.find(i => i.label === 'Fold finished');
  assert.equal(fold.checked, true);
  calls.length = 0; fold.click();
  assert.deepEqual(calls, ['toggleFoldFinished']);
});

test('alignedLabels with measured widths: every line has the same total width (right edge)', () => {
  const lines = [
    { project: 'zode', status: 'Working', px: { project: 30, status: 50 } },
    { project: 'onetrend-trade-anyway-wt', status: '8 min ago', px: { project: 150, status: 55 } },
    { project: 'bossy', status: 'Just now', px: { project: 36, status: 52 } },
  ];
  const metrics = { em: 13, en: 6.5, thin: 2.6, gap: 26 };
  const rows = alignedLabels(lines, metrics);
  const widthOf = (row, l) => {
    const pad = row.match(/[\u2002\u2003\u2009]+/)[0];
    const w = [...pad].reduce((a, c) => a + (c === '\u2003' ? 13 : c === '\u2002' ? 6.5 : 2.6), 0);
    return l.px.project + w + l.px.status;
  };
  const totals = rows.map((r, i) => widthOf(r, lines[i]));
  assert.ok(Math.max(...totals) - Math.min(...totals) <= 2.6);          // within one thin space
});

test('release update item leads the menu; the engine rebuild item is hidden because the update includes it', () => {
  const update = { available: true, originalVersion: '3.15.3', engineVersion: '3.15.2' };
  const release = { available: true, latest: '3.16.2', installed: '3.15.3' };
  const t = buildMenuTemplate(state({ update, release }), actions);
  assert.equal(t[0].label, 'ZCode 3.16.2 is available. Update ZCode…');
  assert.equal(t[1].type, 'separator');
  assert.equal(t[2].label, 'Relay running · no phones paired');          // the usual menu follows unchanged
  assert.equal(JSON.stringify(t).includes('Rebuild the engine'), false);
  calls.length = 0;
  t[0].click();
  assert.deepEqual(calls, ['updateZcode']);
});

test('release item falls back to a generic label when the version is missing', () => {
  const t = buildMenuTemplate(state({ release: { available: true, latest: null, installed: null } }), actions);
  assert.equal(t[0].label, 'A new ZCode is available. Update ZCode…');
  assert.equal(t[1].type, 'separator');
});

test('the engine rebuild item appears only when the original is newer and no release is online', () => {
  const update = { available: true, originalVersion: '3.16.2', engineVersion: '3.15.3' };
  const t = buildMenuTemplate(state({ update }), actions);
  assert.equal(t[0].label, 'ZCode 3.16.2 is installed. Rebuild the engine…');
  assert.equal(t[1].type, 'separator');
  assert.equal(t[2].label, 'Relay running · no phones paired');
  calls.length = 0;
  t[0].click();
  assert.deepEqual(calls, ['rebuildEngine']);

  for (const s of [state(), state({ update: undefined }), state({ update: { available: false, originalVersion: '3.15.3', engineVersion: '3.15.3' } })]) {
    const u = buildMenuTemplate(s, actions);
    assert.equal(u[0].label, 'Relay running · no phones paired');
    assert.equal(JSON.stringify(u).includes('Rebuild the engine'), false);
    assert.equal(u.length, t.length - 2);
  }

  const withRelease = buildMenuTemplate(state({ update, release: { available: true, latest: '3.16.2', installed: '3.15.3' } }), actions);
  assert.equal(withRelease[0].label, 'ZCode 3.16.2 is available. Update ZCode…');
  assert.equal(JSON.stringify(withRelease).includes('Rebuild the engine'), false);
});

test('the ZCode connection line follows tapAlive', () => {
  const t = buildMenuTemplate(state(), actions);
  const offset = t.findIndex(i => i.label === 'Relay running · no phones paired') + 1;
  assert.equal(t[offset].label, 'ZCode connected');
  assert.equal(t[offset].enabled, false);
  const waiting = buildMenuTemplate(state({ tapAlive: false }), actions);
  assert.equal(waiting[offset].label, 'Waiting for ZCode');
  assert.equal(buildMenuTemplate(state({ tapAlive: undefined }), actions)[offset].label, 'Waiting for ZCode');
});

test('pair item, paired phones submenu, relay checkbox', () => {
  calls.length = 0;
  const devices = [{ id: 'dev1', name: 'iphone' }, { id: 'dev2', name: 'pixel' }];
  const t = buildMenuTemplate(state({ phones: 2, devices }), actions);
  byLabel(t, 'Pair a phone…').click();
  const phones = byLabel(t, 'Paired phones');
  assert.equal(phones.enabled, true);
  assert.deepEqual(phones.submenu.map(i => i.label), ['Revoke iphone', 'Revoke pixel']);
  phones.submenu[0].click();
  assert.deepEqual(calls, ['pair', 'revoke:dev1']);
  assert.equal(byLabel(t, 'Relay on').checked, true);
  const stopped = buildMenuTemplate(state({ running: false }), actions);
  assert.equal(byLabel(stopped, 'Relay on').checked, false);
  const empty = byLabel(buildMenuTemplate(state()), 'Paired phones');
  assert.equal(empty.enabled, false);
  assert.deepEqual(empty.submenu, []);
});

test('reachable-from radios; the hint appears only for lan', () => {
  const reach = (t) => byLabel(t, 'Reachable from').submenu;
  const t = buildMenuTemplate(state({ addressId: 'tailscale' }), actions);
  assert.deepEqual(reach(t).map(i => i.label), addresses.map(a => a.label));
  assert.equal(reach(t)[0].type, 'radio');
  assert.equal(reach(t)[0].checked, true);
  reach(t)[1].click();
  assert.ok(calls.includes('select:lan'));
  assert.equal(reach(t).some(i => i.label === HINT), false);

  const lan = buildMenuTemplate(state({ addressId: 'lan' }), actions);
  assert.equal(reach(lan)[1].checked, true);
  const hint = reach(lan).find(i => i.label === HINT);
  assert.ok(hint);
  assert.equal(hint.enabled, false);
});

test('login and keep-awake checkboxes follow their settings', () => {
  const t = buildMenuTemplate(state({ launchAtLogin: true, keepAwake: false }), actions);
  const login = byLabel(t, 'Start Zode when you log in');
  assert.equal(login.type, 'checkbox');
  assert.equal(login.checked, true);
  const keep = byLabel(t, 'Keep my Mac awake while Zode is on');
  assert.equal(keep.type, 'checkbox');
  assert.equal(keep.checked, false);
  keep.click();
  assert.ok(calls.includes('keepAwake'));
});

test('the setup item is always there and reopens the wizard', () => {
  const t = buildMenuTemplate(state(), actions);
  byLabel(t, 'Set up ZCode…').click();
  assert.ok(calls.includes('setup'));
});

test('the engine item opens the Engine when found, and is a disabled notice when not', () => {
  const t = buildMenuTemplate(state(), actions);
  const open = byLabel(t, 'Open ZCode…');
  assert.equal(open.enabled, true);
  open.click();
  assert.ok(calls.includes('openEngine'));
  const labels = t.map(i => i.label);
  assert.ok(labels.indexOf('Open ZCode…') > labels.indexOf('Set up ZCode…'));
  assert.ok(labels.indexOf('About Zode') > labels.indexOf('Open ZCode…'));

  for (const s of [state({ engine: { path: null } }), state({ engine: undefined })]) {
    const missing = buildMenuTemplate(s, actions);
    const notice = byLabel(missing, 'ZCode Engine not found');
    assert.equal(notice.enabled, false);
    assert.equal(byLabel(missing, 'Open ZCode…'), undefined);
  }
});

test('self-update ready: the first item restarts into the new version', () => {
  const t = buildMenuTemplate(state({ selfUpdate: { phase: 'ready', version: '1.2.3', percent: 100 } }), actions);
  assert.equal(t[0].label, 'Restart to update Zode (1.2.3)');
  assert.equal(t[1].type, 'separator');
  assert.equal(t[2].label, 'Relay running · no phones paired');       // the usual menu follows unchanged
  calls.length = 0;
  t[0].click();
  assert.deepEqual(calls, ['installSelfUpdate']);
});

test('self-update downloading: a disabled first item with the percent', () => {
  const t = buildMenuTemplate(state({ selfUpdate: { phase: 'downloading', version: '1.2.3', percent: 37 } }), actions);
  assert.equal(t[0].label, 'Downloading the Zode update… 37%');
  assert.equal(t[0].enabled, false);
  const bare = buildMenuTemplate(state({ selfUpdate: { phase: 'downloading', percent: null } }), actions);
  assert.equal(bare[0].label, 'Downloading the Zode update…');
  assert.equal(bare[0].enabled, false);
  const idle = buildMenuTemplate(state({ selfUpdate: { phase: 'idle' } }), actions);
  assert.equal(idle[0].label, 'Relay running · no phones paired');    // nothing to show: no first item
});

test('the check item sits next to About Zode; without self-update state there is none', () => {
  const t = buildMenuTemplate(state({ selfUpdate: { phase: 'idle' } }), actions);
  const check = byLabel(t, 'Check for Zode updates…');
  assert.ok(check);
  const labels = t.map(i => i.label);
  assert.ok(labels.indexOf('Check for Zode updates…') < labels.indexOf('About Zode'));
  calls.length = 0;
  check.click();
  assert.deepEqual(calls, ['checkSelfUpdate']);
  const none = buildMenuTemplate(state(), actions);                   // no selfUpdate state: no item, no crash
  assert.equal(byLabel(none, 'Check for Zode updates…'), undefined);
});

test('about and quit; no old update/rebuild wording, no old ZCode window item', () => {
  const t = buildMenuTemplate(state(), actions);
  byLabel(t, 'About Zode').click();
  byLabel(t, 'Quit Zode').click();
  assert.ok(calls.includes('about'));
  assert.ok(calls.includes('quit'));
  assert.equal(t[t.length - 1].label, 'Quit Zode');
  const json = JSON.stringify(t);
  assert.equal(json.includes('Rebuild Zode'), false);              // the old app rebuilt itself; this one rebuilds the engine
  assert.equal(json.includes('Update ZCode and rebuild'), false);
  assert.equal(json.includes('Open ZCode window'), false);
});
