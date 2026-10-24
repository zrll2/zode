// Settings: defaults on missing/broken input, validation, 0600 mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSettings, saveSettings } from '../lib/settings.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zode-settings-'));
const DEFAULTS = { relayEnabled: true, addressId: null, port: 8787, launchAtLogin: false, setupDone: false, keepAwake: true, foldFinished: false, voiceLanguage: null, voiceModel: 'small' };

test('missing or broken file falls back to defaults', () => {
  const dir = tmp();
  assert.deepEqual(loadSettings(path.join(dir, 'nope.json')), DEFAULTS);
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, '{not json');
  assert.deepEqual(loadSettings(f), DEFAULTS);
  fs.writeFileSync(f, '["an array"]');
  assert.deepEqual(loadSettings(f), DEFAULTS);
});

test('unknown keys and invalid values fall back to defaults', () => {
  const dir = tmp();
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ relayEnabled: 'yes', addressId: 42, port: '8787', launchAtLogin: 1, setupDone: 'done', keepAwake: 'yes', foldFinished: 'no', voiceLanguage: 'fr', voiceModel: 'large', bogus: true }));
  assert.deepEqual(loadSettings(f), DEFAULTS);
});

test('save then load round-trips, and the file is mode 0600', () => {
  const dir = tmp();
  const f = path.join(dir, 'settings.json');
  const saved = saveSettings(f, { relayEnabled: false, addressId: 'tailscale', port: 9000, launchAtLogin: true, setupDone: true, keepAwake: false, foldFinished: true, voiceLanguage: 'zh', voiceModel: 'small' });
  assert.deepEqual(saved, { relayEnabled: false, addressId: 'tailscale', port: 9000, launchAtLogin: true, setupDone: true, keepAwake: false, foldFinished: true, voiceLanguage: 'zh', voiceModel: 'small' });
  assert.deepEqual(loadSettings(f), saved);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('saveSettings drops unknown keys and out-of-range ports', () => {
  const dir = tmp();
  const f = path.join(dir, 'settings.json');
  const saved = saveSettings(f, { port: 70000, evil: 'x', addressId: 'lan' });
  assert.deepEqual(saved, { relayEnabled: true, addressId: 'lan', port: 8787, launchAtLogin: false, setupDone: false, keepAwake: true, foldFinished: false, voiceLanguage: null, voiceModel: 'small' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), saved);
});

test('setupDone, keepAwake and foldFinished survive a round-trip and default correctly', () => {
  const dir = tmp();
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ setupDone: true, keepAwake: false, foldFinished: true }));
  assert.deepEqual(loadSettings(f), { ...DEFAULTS, setupDone: true, keepAwake: false, foldFinished: true });
  fs.writeFileSync(f, JSON.stringify({ keepAwake: 'yes', foldFinished: 1 }));
  const loaded = loadSettings(f);
  assert.equal(loaded.keepAwake, true);                            // not a boolean: default
  assert.equal(loaded.foldFinished, false);
  assert.equal(loaded.setupDone, false);
});

test('voice settings: language is en or zh (null until chosen), model is small', () => {
  const dir = tmp();
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ voiceLanguage: 'zh' }));
  assert.deepEqual(loadSettings(f), { ...DEFAULTS, voiceLanguage: 'zh' });
  fs.writeFileSync(f, JSON.stringify({ voiceLanguage: 'FR', voiceModel: 'large' }));
  assert.deepEqual(loadSettings(f), DEFAULTS);
});
