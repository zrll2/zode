// buildMenuTemplate for every documented state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignedLabels, textWidth, buildMenuTemplate } from '../lib/menu.mjs';

const HINT = 'Not encrypted. Use Tailscale away from home.';
const calls = [];
const actions = {
  pair: () => calls.push('pair'),
  toggleRelay: () => calls.push('toggleRelay'),
  revoke: (id) => calls.push('revoke:' + id),
  selectAddress: (id) => calls.push('select:' + id),
  toggleLaunchAtLogin: () => calls.push('login'),
  toggleFoldFinished: () => calls.push('toggleFoldFinished'),
  refreshWork: () => calls.push('refreshWork'),
  showZCode: () => calls.push('showZCode'),
  about: () => calls.push('about'),
  rebuild: () => calls.push('rebuild'),
  updateZcode: () => calls.push('updateZcode'),
};
const addresses = [
  { id: 'tailscale', label: 'Tailscale (100.64.0.1)', ip: '100.64.0.1' },
  { id: 'lan', label: 'Wi-Fi / local network (192.168.1.5)', ip: '192.168.1.5' },
  { id: 'local', label: 'This Mac only', ip: '127.0.0.1' },
];
const state = (over = {}) => ({ running: true, error: null, phones: 0, devices: [], addresses, addressId: 'tailscale', launchAtLogin: false, ...over });
const byLabel = (t, label) => t.find(i => i.label === label);

test('status line variants', () => {
  assert.equal(buildMenuTemplate(state({ phones: 2, devices: [{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }] }), actions)[0].label, 'Relay running · 2 phones');
  assert.equal(buildMenuTemplate(state({ phones: 1, devices: [{ id: 'a', name: 'x' }] }), actions)[0].label, 'Relay running · 1 phone');
  assert.equal(buildMenuTemplate(state(), actions)[0].label, 'Relay running · no phones paired');
  assert.equal(buildMenuTemplate(state({ running: false }), actions)[0].label, 'Relay stopped');
  assert.equal(buildMenuTemplate(state({ running: false, error: 'port 8787 is in use. Is `./zode relay` still running?' }), actions)[0].label,
    'Relay error: port 8787 is in use. Is `./zode relay` still running?');
});

test('a long error line is cut at 80 characters', () => {
  const label = buildMenuTemplate(state({ running: false, error: 'x'.repeat(200) }), actions)[0].label;
  assert.equal(label.length, 80);
  assert.ok(label.startsWith('Relay error: '));
});

test('pair item, paired phones submenu, relay checkbox', () => {
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

test('login checkbox, ZCode window, about, and no quit item', () => {
  const t = buildMenuTemplate(state({ launchAtLogin: true }), actions);
  assert.equal(byLabel(t, 'Start Zode when you log in').checked, true);
  assert.equal(byLabel(t, 'Start Zode when you log in').type, 'checkbox');
  byLabel(t, 'Open ZCode window').click();
  byLabel(t, 'About Zode').click();
  assert.ok(calls.includes('showZCode'));
  assert.ok(calls.includes('about'));
  assert.equal(JSON.stringify(t).includes('Quit'), false);          // the app has its own Quit
});

test('rebuild item leads the menu only when an update is available', () => {
  const update = { available: true, originalVersion: '3.16.2', runningVersion: '3.15.3' };
  const t = buildMenuTemplate(state({ update }), actions);
  assert.equal(t[0].label, 'ZCode 3.16.2 is installed. Rebuild Zode…');
  assert.equal(t[1].type, 'separator');
  assert.equal(t[2].label, 'Relay running · no phones paired');          // the usual menu follows unchanged
  calls.length = 0;
  t[0].click();
  assert.deepEqual(calls, ['rebuild']);

  for (const s of [state(), state({ update: undefined }), state({ update: { available: false, originalVersion: '3.15.3', runningVersion: '3.15.3' } })]) {
    const u = buildMenuTemplate(s, actions);
    assert.equal(u[0].label, 'Relay running · no phones paired');
    assert.equal(JSON.stringify(u).includes('Rebuild Zode'), false);
    assert.equal(u.length, t.length - 2);
  }
});

test('release update item leads the menu; the rebuild item is hidden because the update includes it', () => {
  const update = { available: true, originalVersion: '3.15.3', runningVersion: '3.15.2' };
  const release = { available: true, latest: '3.16.2', installed: '3.15.3' };
  const t = buildMenuTemplate(state({ update, release }), actions);
  assert.equal(t[0].label, 'ZCode 3.16.2 is available. Update ZCode and rebuild Zode…');
  assert.equal(t[1].type, 'separator');
  assert.equal(t[2].label, 'Relay running · no phones paired');          // the usual menu follows unchanged
  assert.equal(JSON.stringify(t).includes('Rebuild Zode'), false);
  calls.length = 0;
  t[0].click();
  assert.deepEqual(calls, ['updateZcode']);
});

test('release item falls back to a generic label when the version is missing', () => {
  const t = buildMenuTemplate(state({ release: { available: true, latest: null, installed: null } }), actions);
  assert.equal(t[0].label, 'A new ZCode is available. Update ZCode and rebuild Zode…');
  assert.equal(t[1].type, 'separator');
});

test('without an available release the menu is unchanged, and the rebuild item still appears', () => {
  for (const s of [state(), state({ release: undefined }), state({ release: { available: false, latest: '3.16.2', installed: '3.15.3' } })]) {
    const u = buildMenuTemplate(s, actions);
    assert.equal(u[0].label, 'Relay running · no phones paired');
    assert.equal(JSON.stringify(u).includes('Update ZCode and rebuild'), false);
  }
  const t = buildMenuTemplate(state({ update: { available: true, originalVersion: '3.16.2', runningVersion: '3.15.3' } }), actions);
  assert.equal(t[0].label, 'ZCode 3.16.2 is installed. Rebuild Zode…');
  calls.length = 0;
  t[0].click();
  assert.deepEqual(calls, ['rebuild']);
});

// The ZCode-now block: what ZCode is doing right now, at the top of the menu.
const icons = { green: { name: 'green' }, amber: { name: 'amber' }, red: { name: 'red' }, grey: { name: 'grey' }, tick: { name: 'tick' } };
const withWork = over => ({ icons, work: { lines: [], more: 0, ...over } });

test('work block: header, one clickable lit line per session, +N more, then the usual menu', () => {
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
  assert.deepEqual(t.slice(0, 7).map(i => (i.label === undefined ? undefined : text(i))), ['ZCode right now | Refresh', 'web | Working', 'cli | Waiting for you', 'No workspace | Failed', 'docs | 3 min ago', '+2 more', 'Fold finished']);
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
  assert.deepEqual(calls, ['showZCode']);               // a line focuses the ZCode window
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

test('finished over an hour ago folds into its own submenu by default; recent finished stay inline', () => {
  const lines = [
    { id: 'a', project: 'web', status: 'Working', light: 'green', done: false, older: false },
    { id: 'b', project: 'docs', status: '3 min ago', light: 'green', done: true, older: false },
    { id: 'c', project: 'cli', status: '2 h ago', light: 'green', done: true, older: true },
    { id: 'd', project: 'api', status: '1 h ago', light: 'green', done: true, older: true },
  ];
  const t = buildMenuTemplate(state(withWork({ lines })), actions);
  assert.ok(t.some(i => /^docs/.test(i.label ?? '')));                                 // the 3 min old one stays inline
  assert.equal(t.some(i => /^cli/.test(i.label ?? '')), false);                        // the 2 h old one does not
  const sub = t.find(i => i.label === 'Finished over an hour ago (2)');
  assert.equal(sub.submenu.length, 2);
  assert.equal(sub.submenu[0].icon, icons.tick);
});
