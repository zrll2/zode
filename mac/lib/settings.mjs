// Relay settings for the app, stored in ~/.zode/settings.json (mode 0600).
import fs from 'node:fs';

// voiceLanguage stays null until chosen: main.mjs picks it once from the macOS system language.
const DEFAULTS = { relayEnabled: true, addressId: null, port: 8787, launchAtLogin: false, setupDone: false, keepAwake: true, foldFinished: false, autoAllow: true, askRisky: false, notify: true, claudeCode: true, webClient: false, voiceLanguage: null, voiceModel: 'small' };

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
  if (typeof raw.autoAllow === 'boolean') s.autoAllow = raw.autoAllow;     // a missing or invalid value means on
  if (typeof raw.askRisky === 'boolean') s.askRisky = raw.askRisky;        // a missing or invalid value means off
  if (typeof raw.notify === 'boolean') s.notify = raw.notify;              // a missing or invalid value means on
  if (typeof raw.claudeCode === 'boolean') s.claudeCode = raw.claudeCode;   // a missing or invalid value means on
  if (typeof raw.webClient === 'boolean') s.webClient = raw.webClient;     // a missing or invalid value means off
  if (raw.voiceLanguage === 'en' || raw.voiceLanguage === 'zh') s.voiceLanguage = raw.voiceLanguage;
  if (raw.voiceModel === 'small') s.voiceModel = raw.voiceModel;     // 'small' is the only model today
  return s;
}

export function loadSettings(file) {
  try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return { ...DEFAULTS }; }
}

export function saveSettings(file, settings = {}) {
  const s = sanitize(settings);
  // Write beside the target and rename over it: a crash mid-save leaves the old file intact, never
  // a half-written one that load would read as defaults.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);                                     // umask may have masked the mode
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
  return s;
}

// The Permissions control's three choices, derived from the two stored booleans. Ask: the user
// answers everything; Auto: everything allowed; Careful: allowed, but the destructive ones wait.
export function presetOf({ autoAllow, askRisky } = {}) {
  if (autoAllow !== true) return 'ask';
  return askRisky === true ? 'careful' : 'auto';
}

// Set the two booleans from a preset name. An unknown name changes nothing and returns false.
export function applyPreset(settings, name) {
  if (name !== 'ask' && name !== 'auto' && name !== 'careful') return false;
  settings.autoAllow = name !== 'ask';
  settings.askRisky = name === 'careful';
  return true;
}
