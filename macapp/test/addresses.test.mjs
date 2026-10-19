// detectAddresses against mocked interface tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAddresses, defaultAddress } from '../lib/addresses.mjs';

const ip = (address) => ({ address, family: 'IPv4', internal: false });

test('tailscale only: tailscale first, then this Mac', () => {
  const list = detectAddresses({ utun5: [ip('100.101.2.3')] });
  assert.deepEqual(list.map(a => a.id), ['tailscale', 'local']);
  assert.deepEqual(list[0], { id: 'tailscale', label: 'Tailscale (100.101.2.3)', ip: '100.101.2.3' });
});

test('lan only', () => {
  const list = detectAddresses({ en0: [ip('192.168.1.5')] });
  assert.deepEqual(list.map(a => a.id), ['lan', 'local']);
  assert.deepEqual(list[0], { id: 'lan', label: 'Wi-Fi / local network (192.168.1.5)', ip: '192.168.1.5' });
});

test('both: tailscale first; en0 wins for the lan entry; non-IPv4 ignored', () => {
  const list = detectAddresses({
    en1: [ip('10.0.0.7')],
    utun3: [ip('100.64.0.9')],
    en0: [ip('192.168.0.20'), { address: 'fe80::1', family: 'IPv6', internal: false }],
  });
  assert.deepEqual(list.map(a => a.id), ['tailscale', 'lan', 'local']);
  assert.equal(list[0].ip, '100.64.0.9');
  assert.equal(list[1].ip, '192.168.0.20');                         // en0, not the 10.x on en1
});

test('none: only this Mac', () => {
  assert.deepEqual(detectAddresses({}), [{ id: 'local', label: 'This Mac only', ip: '127.0.0.1' }]);
});

test('internal and non-private IPv4 are ignored; 172.16-31 is private', () => {
  const list = detectAddresses({
    en0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, ip('8.8.8.8'), ip('172.20.3.4')],
  });
  assert.deepEqual(list.map(a => a.id), ['lan', 'local']);
  assert.equal(list[0].ip, '172.20.3.4');
});

test('defaultAddress prefers tailscale, then lan, then local', () => {
  assert.equal(defaultAddress(detectAddresses({ en0: [ip('192.168.1.5')], utun3: [ip('100.64.0.9')] })).id, 'tailscale');
  assert.equal(defaultAddress(detectAddresses({ en0: [ip('192.168.1.5')] })).id, 'lan');
  assert.equal(defaultAddress(detectAddresses({})).id, 'local');
});
