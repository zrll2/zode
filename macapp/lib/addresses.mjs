// Which addresses a phone could reach the relay on, best first.
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
  const list = [];
  if (tailscale) list.push({ id: 'tailscale', label: `Tailscale (${tailscale})`, ip: tailscale });
  if (lanEn0 ?? lan) list.push({ id: 'lan', label: `Wi-Fi / local network (${lanEn0 ?? lan})`, ip: lanEn0 ?? lan });
  list.push({ id: 'local', label: 'This Mac only', ip: '127.0.0.1' });
  return list;
}

export function defaultAddress(list) {
  return list.find(a => a.id === 'tailscale') ?? list.find(a => a.id === 'lan') ?? list.find(a => a.id === 'local') ?? list[0];
}
