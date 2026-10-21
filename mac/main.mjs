// Zode for Mac: a standalone menu bar app that runs the phone relay in its own process. It never
// patches or boots ZCode: the Engine app exposes the agent on ~/.zcode-tap, and all this app does is
// start the relay, offer pairing and keep the tray menu going.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, Tray, Menu, BrowserWindow, ipcMain, clipboard, dialog, nativeImage, shell } from 'electron';
import QRCode from 'qrcode';
import { createRelay } from '../relay/service.mjs';
import { detectAddresses, defaultAddress } from './lib/addresses.mjs';
import { loadSettings, saveSettings } from './lib/settings.mjs';
import { buildMenuTemplate } from './lib/menu.mjs';

const HOME = os.homedir();
const SETTINGS_FILE = path.join(HOME, '.zode', 'settings.json');
const LOG_FILE = path.join(HOME, '.zode', 'mac-app.log');
const ENGINE_APP = '/Applications/ZCode Engine.app';               // built by scripts/build-tap.sh (Engine mode)
const LEGACY_APP = '/Applications/Zode.app';                       // the old patched ZCode, until the Engine is built

const appendLog = (msg) => { try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch {} };

// A rejected promise from a menu click must not vanish silently (nor take the app down).
process.on('unhandledRejection', err => appendLog(`zode: unhandled rejection: ${err?.stack || err}`));

// The Engine is whichever installed app currently exposes the agent on the tap sockets. The legacy
// copy only counts while it is not this app itself: the packaged Zode will one day live at the same
// path, with a different bundle id.
function findEngine() {
  const hasPlist = p => fs.existsSync(path.join(p, 'Contents', 'Info.plist'));
  if (hasPlist(ENGINE_APP)) return ENGINE_APP;
  let self = null;
  try { self = path.resolve(path.dirname(path.dirname(path.dirname(app.getPath('exe'))))); } catch {}
  if (hasPlist(LEGACY_APP) && self !== path.resolve(LEGACY_APP)) return LEGACY_APP;
  return null;
}

let started = false;

async function start() {
  if (started) return;
  started = true;
  const res = import.meta.dirname;                                // dist/: preload.cjs, pair/ and assets/ sit next to this bundle
  try {
    try { app.dock?.hide(); } catch (err) { appendLog(`zode: dock: ${err?.stack || err}`); }

    let settings = loadSettings(SETTINGS_FILE);
    let addresses = detectAddresses();
    let relay = null, tray = null, pairWindow = null, currentPairing = null, pairedCount = 0;
    let error = null;
    let quitting = false;
    let enginePath = null;

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
        engine: { path: enginePath },
      };
    }

    function pingPairWindow() {
      if (!pairWindow || pairWindow.isDestroyed()) return;
      pairWindow.webContents.send('zode:status', { running: !!(relay?.status().running), error, publicUrl: publicUrlFor(chosen()) });
    }

    // State changed: tell the pairing window. The tray menu itself is built when the icon is clicked (see below).
    function refresh() {
      const devices = relay ? relay.listDevices() : [];
      if (devices.length > pairedCount) currentPairing = null;      // a phone just used the shown code
      pairedCount = devices.length;
      try { pingPairWindow(); } catch (err) { appendLog(`zode: ${err?.stack || err}`); }
    }

    const actions = {
      pair: () => showPairWindow(),
      toggleRelay: async () => { settings.relayEnabled = !(relay?.status().running); save(); await applyRelay(); },
      revoke: id => { try { relay?.revokeDevice(id); } catch (err) { appendLog(`zode: revoke: ${err?.stack || err}`); } },
      selectAddress: async id => { settings.addressId = id; save(); await applyRelay(); },
      toggleLaunchAtLogin: () => { settings.launchAtLogin = !settings.launchAtLogin; save(); app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin }); refresh(); },
      openEngine: async () => {
        if (!enginePath) return;
        try {
          const openError = await shell.openPath(enginePath);       // resolves to '' or an error string
          if (openError) appendLog(`zode: open ${enginePath}: ${openError}`);
        } catch (err) { appendLog(`zode: open ${enginePath}: ${err?.stack || err}`); }
      },
      about: () => dialog.showMessageBox({
        type: 'info', title: 'Zode', message: 'Zode',
        detail: `Version ${app.getVersion()}\n\nClaude Code decides. ZCode writes. You watch from your phone.\n\nThe relay runs in this menu bar app; ZCode itself is untouched.`,
      }),
      quit: () => app.quit(),
    };

    async function pairingView() {
      const publicUrl = publicUrlFor(chosen());
      if (error || !relay?.status().running) {
        currentPairing = null;
        return { running: false, error, publicUrl, qrSvg: null, code: null, expiresAt: null, payload: null };
      }
      try {
        if (!currentPairing || currentPairing.expiresAt < Date.now()) currentPairing = relay.createPairing();
        const qrSvg = await QRCode.toString(currentPairing.payload, { type: 'svg', margin: 1 });
        return { running: true, error: null, publicUrl, qrSvg, code: currentPairing.code, expiresAt: currentPairing.expiresAt, payload: currentPairing.payload };
      } catch (err) {                                               // a failed QR never rejects out of the IPC handler
        appendLog(`zode: pairing view: ${err?.stack || err}`);
        currentPairing = null;
        return { running: false, error: err?.message ?? String(err), publicUrl, qrSvg: null, code: null, expiresAt: null, payload: null };
      }
    }

    function showPairWindow() {
      try {
        if (pairWindow && !pairWindow.isDestroyed()) { pairWindow.show(); pairWindow.focus(); pingPairWindow(); return; }
        pairWindow = new BrowserWindow({
          width: 440, height: 620, resizable: false, show: false,
          title: 'Pair a phone',
          webPreferences: { preload: path.join(res, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        pairWindow.on('close', e => { if (!quitting) { e.preventDefault(); pairWindow.hide(); } });      // the tray stays; closing just hides
        pairWindow.loadFile(path.join(res, 'pair', 'index.html'));
        pairWindow.once('ready-to-show', () => pairWindow.show());
      } catch (err) { appendLog(`zode: pair window: ${err?.stack || err}`); }
    }

    // Handlers never reject out to the renderer; failures go to the log and fall back to a safe value.
    ipcMain.handle('zode:getPairing', () => pairingView());
    ipcMain.handle('zode:newCode', () => { currentPairing = null; return pairingView(); });
    ipcMain.handle('zode:copy', (_e, text) => { try { clipboard.writeText(String(text ?? '')); return true; } catch (err) { appendLog(`zode: copy: ${err?.stack || err}`); return false; } });
    ipcMain.handle('zode:listDevices', () => { try { return relay ? relay.listDevices() : []; } catch (err) { appendLog(`zode: listDevices: ${err?.stack || err}`); return []; } });
    ipcMain.handle('zode:revoke', (_e, id) => { try { const ok = relay ? relay.revokeDevice(String(id)) : false; refresh(); return ok; } catch (err) { appendLog(`zode: revoke: ${err?.stack || err}`); return false; } });

    const icon = nativeImage.createFromPath(path.join(res, 'assets', 'trayTemplate.png'));    // the @2x variant is picked up automatically
    if (icon.isEmpty()) appendLog('zode: assets/trayTemplate.png missing from dist; no menu bar icon.');
    else {
      tray = new Tray(icon); tray.setToolTip('Zode');
      // The menu is built on click rather than set ahead of time: on macOS a preset context menu swallows
      // the click event, and the Engine may have appeared or vanished since the last click.
      const popMenu = () => {
        try {
          enginePath = findEngine();
          tray.popUpContextMenu(Menu.buildFromTemplate(buildMenuTemplate(menuState(), actions)));
        } catch (err) { appendLog(`zode: ${err?.stack || err}`); }
      };
      tray.on('click', popMenu);
      tray.on('right-click', popMenu);
    }

    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
    app.on('second-instance', () => showPairWindow());              // a second launch asks this one to show the pairing window
    app.on('before-quit', () => { quitting = true; relay?.stop().catch(() => {}); });

    await applyRelay();
  } catch (err) {
    appendLog(`zode: ${err?.stack || err}`);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();                                                       // another Zode owns the tray; it gets second-instance
} else {
  app.on('window-all-closed', () => {});                            // tray app: no windows is normal, never quit
  app.whenReady().then(() => start()).catch(err => appendLog(`zode: startup: ${err?.stack || err}`));
}
