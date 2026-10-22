// Relay settings for the app, stored in ~/.zode/settings.json (mode 0600).
import fs from 'node:fs';

const DEFAULTS = { relayEnabled: true, addressId: null, port: 8787, launchAtLogin: false, setupDone: false, keepAwake: true, foldFinished: false };

function sanitize(raw) {
  const s = { ...DEFAULTS };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return s;
  if (typeof raw.relayEnabled === 'boolean') s.relayEnabled = raw.relayEnabled;
  if (typeof raw.addressId === 'string' || raw.addressId === null) s.addressId = raw.addressId;
  if (Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535) s.port = raw.port;
  if (typeof raw.launchAtLogin === 'boolean') s.launchAtLogin = raw.launchAtLogin;
  if (typeof raw.setupDone === 'boolean') s.setupDone = raw.setupDone;
  if (typeof raw.keepAwake === 'boolean') s.keepAwake = raw.keepAwake;
  if (typeof raw.foldFinished === 'boolean') s.foldFinished = raw.foldFinished;
  return s;
}

export function loadSettings(file) {
  try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return { ...DEFAULTS }; }
}

export function saveSettings(file, settings = {}) {
  const s = sanitize(settings);
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);                                      // umask may have masked the mode
  return s;
}
