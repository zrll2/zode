// Which addresses a phone could reach the relay on, best first. `auto` is a mode, not an address:
// it means "bind every real way in at once" (see autoAddresses below).
import os from 'node:os';

const parseIPv4 = (ip) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
};
const isTailscale = ([a, b]) => a === 100 && b >= 64 && b <= 127;   // 100.64.0.0/10
const isPrivate = ([a, b]) => a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);

export function detectAddresses(interfaces = os.networkInterfaces()) {
  let tailscale = null, lan = null, lanEn0 = null;
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = parseIPv4(a.address); if (!ip) continue;
      if (!tailscale && isTailscale(ip)) tailscale = a.address;
      if (isPrivate(ip)) { if (name === 'en0') lanEn0 ??= a.address; lan ??= a.address; }
    }
  }
  const list = [{ id: 'auto', label: 'Automatic: Wi-Fi and Tailscale' }];
  if (tailscale) list.push({ id: 'tailscale', label: `Tailscale (${tailscale})`, ip: tailscale });
  if (lanEn0 ?? lan) list.push({ id: 'lan', label: `Wi-Fi / local network (${lanEn0 ?? lan})`, ip: lanEn0 ?? lan });
  list.push({ id: 'local', label: 'This Mac only', ip: '127.0.0.1' });
  return list;
}

// Automatic mode: the Tailscale and LAN entries that exist, never loopback — a phone can never reach
// 127.0.0.1, and loopback stays for "This Mac only".
export function autoAddresses(list) {
  const l = Array.isArray(list) ? list : [];
  return ['tailscale', 'lan']
    .map(id => l.find(a => a && a.id === id && typeof a.ip === 'string' && a.ip))
    .filter(Boolean);
}

// Automatic is the default whenever the list carries it; otherwise the best single address.
export function defaultAddress(list) {
  const l = Array.isArray(list) ? list : [];
  return l.find(a => a?.id === 'auto') ?? l.find(a => a.id === 'tailscale') ?? l.find(a => a.id === 'lan') ?? l.find(a => a.id === 'local') ?? l[0];
}
