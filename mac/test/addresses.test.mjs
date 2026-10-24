// detectAddresses against mocked interface tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAddresses, defaultAddress, autoAddresses } from '../lib/addresses.mjs';

const ip = (address) => ({ address, family: 'IPv4', internal: false });

test('tailscale only: Automatic first, then tailscale, then this Mac', () => {
  const list = detectAddresses({ utun5: [ip('100.101.2.3')] });
  assert.deepEqual(list.map(a => a.id), ['auto', 'tailscale', 'local']);
  assert.deepEqual(list[0], { id: 'auto', label: 'Automatic: Wi-Fi and Tailscale' });
  assert.deepEqual(list[1], { id: 'tailscale', label: 'Tailscale (100.101.2.3)', ip: '100.101.2.3' });
});

test('lan only', () => {
  const list = detectAddresses({ en0: [ip('192.168.1.5')] });
  assert.deepEqual(list.map(a => a.id), ['auto', 'lan', 'local']);
  assert.deepEqual(list[1], { id: 'lan', label: 'Wi-Fi / local network (192.168.1.5)', ip: '192.168.1.5' });
});

test('both: tailscale first; en0 wins for the lan entry; non-IPv4 ignored', () => {
  const list = detectAddresses({
    en1: [ip('10.0.0.7')],
    utun3: [ip('100.64.0.9')],
    en0: [ip('192.168.0.20'), { address: 'fe80::1', family: 'IPv6', internal: false }],
  });
  assert.deepEqual(list.map(a => a.id), ['auto', 'tailscale', 'lan', 'local']);
  assert.equal(list[1].ip, '100.64.0.9');
  assert.equal(list[2].ip, '192.168.0.20');                         // en0, not the 10.x on en1
});

test('none: Automatic and this Mac', () => {
  assert.deepEqual(detectAddresses({}), [
    { id: 'auto', label: 'Automatic: Wi-Fi and Tailscale' },
    { id: 'local', label: 'This Mac only', ip: '127.0.0.1' },
  ]);
});

test('internal and non-private IPv4 are ignored; 172.16-31 is private', () => {
  const list = detectAddresses({
    en0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, ip('8.8.8.8'), ip('172.20.3.4')],
  });
  assert.deepEqual(list.map(a => a.id), ['auto', 'lan', 'local']);
  assert.equal(list[1].ip, '172.20.3.4');
});

test('autoAddresses: the Tailscale and LAN entries that exist, never loopback, junk tolerated', () => {
  assert.deepEqual(autoAddresses(detectAddresses({ en0: [ip('192.168.1.5')], utun3: [ip('100.64.0.9')] })).map(a => a.id), ['tailscale', 'lan']);
  assert.deepEqual(autoAddresses(detectAddresses({ en0: [ip('192.168.1.5')] })).map(a => a.id), ['lan']);
  assert.deepEqual(autoAddresses(detectAddresses({ utun5: [ip('100.101.2.3')] })).map(a => a.id), ['tailscale']);
  assert.deepEqual(autoAddresses(detectAddresses({})), []);          // nothing real: not even loopback
  assert.deepEqual(autoAddresses([]), []);
  assert.deepEqual(autoAddresses(undefined), []);
});

test('defaultAddress: automatic when it is on the list, otherwise tailscale, lan, local', () => {
  assert.equal(defaultAddress(detectAddresses({ en0: [ip('192.168.1.5')], utun3: [ip('100.64.0.9')] })).id, 'auto');
  assert.equal(defaultAddress(detectAddresses({})).id, 'auto');
  const legacy = [                                                   // lists without the automatic entry (filtered callers)
    { id: 'tailscale', label: 'Tailscale (100.64.0.9)', ip: '100.64.0.9' },
    { id: 'lan', label: 'Wi-Fi / local network (192.168.1.5)', ip: '192.168.1.5' },
    { id: 'local', label: 'This Mac only', ip: '127.0.0.1' },
  ];
  assert.equal(defaultAddress(legacy).id, 'tailscale');
  assert.equal(defaultAddress(legacy.slice(1)).id, 'lan');
  assert.equal(defaultAddress(legacy.slice(2)).id, 'local');
  assert.equal(defaultAddress([]), undefined);
  assert.equal(defaultAddress(undefined), undefined);
});
