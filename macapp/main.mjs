// Zode integration for the ZCode Electron app: the phone relay runs inside the app, with a menu bar
// icon for state and pairing and a small window that shows the QR code. boot.cjs loads this bundle
// next to itself; `electron` is passed in so the bundle never imports it statically.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import QRCode from 'qrcode';
import { createRelay } from '../relay/service.mjs';
import { detectAddresses, defaultAddress } from './lib/addresses.mjs';
import { loadSettings, saveSettings } from './lib/settings.mjs';
import { buildMenuTemplate } from './lib/menu.mjs';

const HOME = os.homedir();
const SETTINGS_FILE = path.join(HOME, '.zode', 'settings.json');
const LOG_FILE = path.join(HOME, '.zode', 'zode-app.log');

const appendLog = (msg) => { try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch {} };

let started = false;

// Everything runs after app.whenReady(); any failure is logged and never stops ZCode itself.
export async function startZode({ electron, resourcesDir } = {}) {
  if (started) return;
  started = true;
  const res = resourcesDir || import.meta.dirname;                 // Contents/Resources/zode after install
  try {
    const { app, Tray, Menu, BrowserWindow, ipcMain, clipboard, dialog, nativeImage } = electron;
    await app.whenReady();

    let settings = loadSettings(SETTINGS_FILE);
    let addresses = detectAddresses();
    let relay = null, tray = null, pairWindow = null, currentPairing = null, pairedCount = 0;
    let error = null;
    let quitting = false;

    const chosen = () => addresses.find(a => a.id === settings.addressId) ?? defaultAddress(addresses);
    const publicUrlFor = a => `ws://${a.ip}:${settings.port}`;
    const save = () => { settings = saveSettings(SETTINGS_FILE, settings); };
    const relayLog = {
      log: (...a) => appendLog('relay: ' + a.join(' ')),
      warn: (...a) => appendLog('relay warn: ' + a.join(' ')),
      error: (...a) => appendLog('relay error: ' + a.join(' ')),
    };
    const startError = err => err?.code === 'EADDRINUSE'
      ? `port ${settings.port} is in use. Is \`./zode relay\` still running?`
      : (err?.message ?? String(err));

    // (Re)create the relay from the current settings. A failed start keeps the app alive and shows in the menu.
    async function applyRelay() {
      error = null;
      if (relay) { await relay.stop().catch(() => {}); relay = null; }
      currentPairing = null;
      if (settings.relayEnabled) {
        const a = chosen();                                       // never 0.0.0.0: one concrete address
        relay = createRelay({ host: a.ip, port: settings.port, publicUrl: publicUrlFor(a), log: relayLog });
        relay.on('status', refresh);
        try { await relay.start(); } catch (err) { error = startError(err); }
      }
      refresh();
    }

    function menuState() {
      const devices = relay ? relay.listDevices() : [];
      return {
        running: !!(relay?.status().running),
        error,
        phones: devices.length,
        devices,
        addresses,
        addressId: chosen().id,
        launchAtLogin: settings.launchAtLogin,
      };
    }

    function pingPairWindow() {
      if (!pairWindow || pairWindow.isDestroyed()) return;
      pairWindow.webContents.send('zode:status', { running: !!(relay?.status().running), error, publicUrl: publicUrlFor(chosen()) });
    }

    function refresh() {
      const devices = relay ? relay.listDevices() : [];
      if (devices.length > pairedCount) currentPairing = null;      // a phone just used the shown code
      pairedCount = devices.length;
      try {
        if (tray) tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate(menuState(), actions)));
        pingPairWindow();
      } catch (err) { appendLog(`zode: ${err?.stack || err}`); }
    }

    const actions = {
      pair: () => showPairWindow(),
      toggleRelay: async () => { settings.relayEnabled = !(relay?.status().running); save(); await applyRelay(); },
      revoke: id => { relay?.revokeDevice(id); },
      selectAddress: async id => { settings.addressId = id; save(); await applyRelay(); },
      toggleLaunchAtLogin: () => { settings.launchAtLogin = !settings.launchAtLogin; save(); app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin }); refresh(); },
      showZCode: () => {
        const win = BrowserWindow.getAllWindows().find(w => w !== pairWindow);
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show(); win.focus();
      },
      about: () => dialog.showMessageBox({ type: 'info', title: 'Zode', message: 'Zode', detail: 'Claude Code decides. ZCode writes. You watch from your phone.\n\nThe phone relay runs inside this app.' }),
    };

    async function pairingView() {
      const publicUrl = publicUrlFor(chosen());
      if (error || !relay?.status().running) {
        currentPairing = null;
        return { running: false, error, publicUrl, qrSvg: null, code: null, expiresAt: null, payload: null };
      }
      if (!currentPairing || currentPairing.expiresAt < Date.now()) currentPairing = relay.createPairing();
      const qrSvg = await QRCode.toString(currentPairing.payload, { type: 'svg', margin: 1 });
      return { running: true, error: null, publicUrl, qrSvg, code: currentPairing.code, expiresAt: currentPairing.expiresAt, payload: currentPairing.payload };
    }

    function showPairWindow() {
      if (pairWindow && !pairWindow.isDestroyed()) { pairWindow.show(); pairWindow.focus(); pingPairWindow(); return; }
      pairWindow = new BrowserWindow({
        width: 440, height: 620, resizable: false, show: false,
        title: 'Pair a phone',
        webPreferences: { preload: path.join(res, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      pairWindow.on('close', e => { if (!quitting) { e.preventDefault(); pairWindow.hide(); } });      // the tray stays; closing just hides
      pairWindow.loadFile(path.join(res, 'pair', 'index.html'));
      pairWindow.once('ready-to-show', () => pairWindow.show());
    }

    ipcMain.handle('zode:getPairing', () => pairingView());
    ipcMain.handle('zode:newCode', () => { currentPairing = null; return pairingView(); });
    ipcMain.handle('zode:copy', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });
    ipcMain.handle('zode:listDevices', () => (relay ? relay.listDevices() : []));
    ipcMain.handle('zode:revoke', (_e, id) => { const ok = relay ? relay.revokeDevice(String(id)) : false; refresh(); return ok; });

    const icon = nativeImage.createFromPath(path.join(res, 'trayTemplate.png'));    // the @2x variant is picked up automatically
    if (icon.isEmpty()) appendLog('zode: trayTemplate.png missing next to the bundle; no menu bar icon (use `./zode pair`).');
    else { tray = new Tray(icon); tray.setToolTip('Zode'); }

    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
    app.on('before-quit', () => { quitting = true; relay?.stop().catch(() => {}); });

    await applyRelay();
  } catch (err) {
    appendLog(`zode: ${err?.stack || err}`);
  }
}
