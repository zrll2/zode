// buildMenuTemplate for every documented state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuTemplate } from '../lib/menu.mjs';

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
  setup: () => calls.push('setup'),
  openEngine: () => calls.push('openEngine'),
  about: () => calls.push('about'),
  quit: () => calls.push('quit'),
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

test('the ZCode connection line follows tapAlive', () => {
  const t = buildMenuTemplate(state(), actions);
  assert.equal(t[1].label, 'ZCode connected');
  assert.equal(t[1].enabled, false);
  const waiting = buildMenuTemplate(state({ tapAlive: false }), actions);
  assert.equal(waiting[1].label, 'Waiting for ZCode');
  assert.equal(buildMenuTemplate(state({ tapAlive: undefined }), actions)[1].label, 'Waiting for ZCode');
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

test('about and quit; no update items and no old ZCode window item', () => {
  const t = buildMenuTemplate(state(), actions);
  byLabel(t, 'About Zode').click();
  byLabel(t, 'Quit Zode').click();
  assert.ok(calls.includes('about'));
  assert.ok(calls.includes('quit'));
  assert.equal(t[t.length - 1].label, 'Quit Zode');
  const json = JSON.stringify(t);
  assert.equal(json.includes('Rebuild'), false);
  assert.equal(json.includes('Update'), false);
  assert.equal(json.includes('Open ZCode window'), false);
});
