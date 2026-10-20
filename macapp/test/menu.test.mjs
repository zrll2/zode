// buildMenuTemplate for every documented state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuTemplate } from '../lib/menu.mjs';

const HINT = 'Not encrypted. Use Tailscale away from home.';
const calls = [];
const actions = {
  pair: () => calls.push('pair'),
  toggleRelay: () => calls.push('toggleRelay'),
  revoke: (id) => calls.push('revoke:' + id),
  selectAddress: (id) => calls.push('select:' + id),
  toggleLaunchAtLogin: () => calls.push('login'),
  showZCode: () => calls.push('showZCode'),
  about: () => calls.push('about'),
  rebuild: () => calls.push('rebuild'),
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
