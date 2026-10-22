// Zode for Mac: a standalone menu bar app that runs the phone relay in its own process. It never
// patches or boots ZCode: the Engine app exposes the agent on ~/.zcode-tap, and this app starts the
// relay, offers pairing, keeps the tray menu going and walks through first-run setup.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, Tray, Menu, BrowserWindow, ipcMain, clipboard, dialog, nativeImage, shell, powerSaveBlocker } from 'electron';
import QRCode from 'qrcode';
import { createRelay } from '../relay/service.mjs';
import { detectAddresses, defaultAddress } from './lib/addresses.mjs';
import { loadSettings, saveSettings } from './lib/settings.mjs';
import { buildMenuTemplate } from './lib/menu.mjs';
import { setupSteps, parseBuildProgress, friendlySetupError, kitDir } from './lib/setup.mjs';
import { isRunning, quitApp, tapAlive, findOriginal, findEngine, findOldIntegrated, runBuild } from './lib/system.mjs';

const HOME = os.homedir();
const SETTINGS_FILE = path.join(HOME, '.zode', 'settings.json');
const LOG_FILE = path.join(HOME, '.zode', 'mac-app.log');
const DOWNLOAD_URL = 'https://zcode.z.ai';

const appendLog = (msg) => { try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch {} };

// A rejected promise from a menu click must not vanish silently (nor take the app down).
process.on('unhandledRejection', err => appendLog(`zode: unhandled rejection: ${err?.stack || err}`));

// The kit (scripts/, bridge/) lives in the repo while in development; a later order packages it into
// Resources/engine-kit. Walk up from dist/ until a folder that owns the builder shows up.
function devRoot() {
  let dir = import.meta.dirname;
  for (let i = 0; i < 6 && dir && dir !== path.dirname(dir); i++) {
    if (fs.existsSync(path.join(dir, 'scripts', 'build-tap.sh'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

let started = false;
let setupWindow = null;
let powerBlockerId = null;
let build = { running: false, label: null, percent: 0, lines: [], error: null };

async function start() {
  if (started) return;
  started = true;
  const res = import.meta.dirname;                                // dist/: preload.cjs, pair/, setup/ and assets/ sit next to this bundle
  try {
    try { app.dock?.hide(); } catch (err) { appendLog(`zode: dock: ${err?.stack || err}`); }

    let settings = loadSettings(SETTINGS_FILE);
    let addresses = detectAddresses();
    let relay = null, tray = null, pairWindow = null, currentPairing = null, pairedCount = 0;
    let error = null;
    let quitting = false;
    let enginePath = null;
    let tapUp = false;

    const chosen = () => addresses.find(a => a.id === settings.addressId) ?? defaultAddress(addresses);
    const publicUrlFor = a => `ws://${a.ip}:${settings.port}`;
    const save = () => { settings = saveSettings(SETTINGS_FILE, settings); };
    const relayLog = {
      log: (...a) => appendLog('relay: ' + a.join(' ')),
      warn: (...a) => appendLog('relay warn: ' + a.join(' ')),
      error: (...a) => appendLog('relay error: ' + a.join(' ')),
    };
    const startError = err => err?.code === 'EADDRINUSE'
      ? `port ${settings.port} is in use. Is the old Zode still running?`
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
      updatePowerBlocker();
    }

    // A Mac that sleeps drops the phone: hold an anti-suspension blocker while the relay runs and
    // the setting allows it.
    function updatePowerBlocker() {
      try {
        const want = settings.keepAwake === true && !!(relay && relay.status().running);
        if (want && powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        else if (!want && powerBlockerId !== null) {
          if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
          powerBlockerId = null;
        }
      } catch (err) { appendLog(`zode: keep awake: ${err?.stack || err}`); }
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
        keepAwake: settings.keepAwake,
        setupDone: settings.setupDone,
        tapAlive: tapUp,
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
      toggleKeepAwake: () => { settings.keepAwake = !(settings.keepAwake === true); save(); updatePowerBlocker(); refresh(); },
      setup: () => showSetupWindow(),
      openEngine: async () => {
        const p = enginePath || await findEngine().catch(() => null);
        if (!p) return;
        try {
          const openError = await shell.openPath(p);                // resolves to '' or an error string
          if (openError) appendLog(`zode: open ${p}: ${openError}`);
        } catch (err) { appendLog(`zode: open ${p}: ${err?.stack || err}`); }
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

    // ---- first-run setup wizard ---------------------------------------------------------------
    function sendSetupEvent(data) {
      try { if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send('zode:setupEvent', data); } catch { /* window gone */ }
    }

    // Same placement rule as build-tap.sh: /Applications when writable, the home folder otherwise.
    function engineDest() {
      try {
        fs.accessSync('/Applications', fs.constants.W_OK);
        return '/Applications/ZCode Engine.app';
      } catch { return path.join(HOME, 'Applications', 'ZCode Engine.app'); }
    }

    async function setupSnapshot() {
      try {
        const [originalPath, engineP, oldPath, tap] = await Promise.all([findOriginal(), findEngine(), findOldIntegrated(), tapAlive()]);
        const [originalRunning, oldRunning] = await Promise.all([
          originalPath ? isRunning(originalPath) : Promise.resolve(false),
          oldPath ? isRunning(oldPath) : Promise.resolve(false),
        ]);
        return {
          steps: setupSteps({ originalExists: !!originalPath, engineExists: !!engineP, tapAlive: tap, setupDone: settings.setupDone === true }),
          original: { exists: !!originalPath, path: originalPath, running: originalRunning },
          engine: { exists: !!engineP, path: engineP },
          oldApp: { exists: !!oldPath, path: oldPath, running: oldRunning },
          tapAlive: tap,
          setupDone: settings.setupDone === true,
          build: { running: build.running, label: build.label, percent: build.percent, lines: build.lines.slice(-200), error: build.error },
        };
      } catch (err) {
        appendLog(`zode: setup state: ${err?.stack || err}`);
        return {
          steps: setupSteps({}),
          original: { exists: false, path: null, running: false },
          engine: { exists: false, path: null },
          oldApp: { exists: false, path: null, running: false },
          tapAlive: false,
          setupDone: false,
          build: { running: build.running, label: build.label, percent: build.percent, lines: [], error: build.error },
        };
      }
    }

    async function startBuild() {
      if (build.running) return { started: true };
      build = { running: true, label: 'Starting…', percent: 0, lines: [], error: null };   // set before any await: the wizard sees it at once
      sendSetupEvent({ type: 'build', label: build.label, percent: 0, line: null });
      try {
        // Only one ZCode copy may run at a time; an open original or old copy blocks the build.
        const [originalPath, oldPath] = await Promise.all([findOriginal(), findOldIntegrated()]);
        if (originalPath && await isRunning(originalPath)) {
          build.running = false;
          return { started: false, blocked: 'zcode' };
        }
        if (oldPath && await isRunning(oldPath)) {
          build.running = false;
          return { started: false, blocked: 'old' };
        }
        const kit = kitDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, devRoot: devRoot() });
        if (!kit || !fs.existsSync(path.join(kit, 'scripts', 'build-tap.sh'))) {
          build.running = false;
          build.error = friendlySetupError('');
          appendLog('zode: setup: no engine kit with scripts/build-tap.sh was found');
          sendSetupEvent({ type: 'buildDone', ok: false, error: build.error });
          return { started: false, error: build.error };
        }
        const result = await runBuild({
          kit,
          dest: engineDest(),
          onLine: line => {
            build.lines.push(line);
            if (build.lines.length > 500) build.lines.splice(0, build.lines.length - 500);
            const p = parseBuildProgress(line);
            if (p) { build.label = p.label; build.percent = p.percent; }
            sendSetupEvent({ type: 'build', label: build.label, percent: build.percent, line });
          },
        });
        build.running = false;
        if (result.ok) {
          build.label = 'Done';
          build.percent = 100;
          enginePath = await findEngine();
          appendLog(`zode: the engine is built${enginePath ? ` at ${enginePath}` : ''}`);
        } else {
          build.error = friendlySetupError(result.error ?? '');
          appendLog(`zode: engine build failed: ${result.error ?? 'unknown'}`);
        }
        sendSetupEvent({ type: 'buildDone', ok: !!result.ok, error: build.error });
        return { started: true, ok: !!result.ok, error: build.error };
      } catch (err) {
        build.running = false;
        build.error = friendlySetupError(err?.message ?? String(err));
        appendLog(`zode: setup build: ${err?.stack || err}`);
        sendSetupEvent({ type: 'buildDone', ok: false, error: build.error });
        return { started: false, error: build.error };
      }
    }

    ipcMain.handle('zode:setupState', () => setupSnapshot());
    ipcMain.handle('zode:setupStartBuild', () => startBuild());
    ipcMain.handle('zode:setupQuitBlocking', async () => {
      try {
        const [originalPath, oldPath] = await Promise.all([findOriginal(), findOldIntegrated()]);
        if (originalPath && await isRunning(originalPath)) return { ok: await quitApp('dev.zcode.app', originalPath) };
        if (oldPath && await isRunning(oldPath)) return { ok: await quitApp('dev.zode.app', oldPath) };
        return { ok: true };
      } catch (err) { appendLog(`zode: quit blocking app: ${err?.stack || err}`); return { ok: false }; }
    });
    ipcMain.handle('zode:setupOpenEngine', async () => {
      try {
        const p = enginePath || await findEngine();
        if (!p) return { ok: false, error: 'ZCode Engine not found. Run setup again.' };
        const openError = await shell.openPath(p);
        if (openError) { appendLog(`zode: open ${p}: ${openError}`); return { ok: false, error: openError }; }
        return { ok: true };
      } catch (err) { appendLog(`zode: open engine: ${err?.stack || err}`); return { ok: false, error: 'Something went wrong.' }; }
    });
    ipcMain.handle('zode:setupOpenDownload', async () => {
      try { await shell.openExternal(DOWNLOAD_URL); return { ok: true }; }
      catch (err) { appendLog(`zode: open download page: ${err?.stack || err}`); return { ok: false, error: 'Could not open the browser.' }; }
    });
    ipcMain.handle('zode:setupDone', () => {
      try {
        settings.setupDone = true;
        save();
        if (setupWindow && !setupWindow.isDestroyed()) setupWindow.hide();
        return true;
      } catch (err) { appendLog(`zode: setup done: ${err?.stack || err}`); return false; }
    });
    ipcMain.handle('zode:setupTrashOldApp', async () => {
      try {
        const oldPath = await findOldIntegrated();
        if (!oldPath) return { ok: false, error: 'The old Zode.app is already gone.' };
        if (await isRunning(oldPath)) return { ok: false, error: 'Quit the old Zode first, then try again.' };
        if (!(await tapAlive())) return { ok: false, error: 'Finish setting up ZCode first.' };
        await shell.trashItem(oldPath);
        appendLog(`zode: moved the old copy to the Trash (${oldPath})`);
        return { ok: true };
      } catch (err) {
        appendLog(`zode: trash old copy: ${err?.stack || err}`);
        return { ok: false, error: 'Something went wrong. Details are in ~/.zode/mac-app.log' };
      }
    });

    function showSetupWindow() {
      try {
        if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
        setupWindow = new BrowserWindow({
          width: 520, height: 560, resizable: false, show: false,
          title: 'Set up Zode',
          webPreferences: { preload: path.join(res, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        setupWindow.on('close', e => { if (!quitting) { e.preventDefault(); setupWindow.hide(); } });
        setupWindow.loadFile(path.join(res, 'setup', 'index.html'));
        setupWindow.once('ready-to-show', () => setupWindow.show());
      } catch (err) { appendLog(`zode: setup window: ${err?.stack || err}`); }
    }

    const icon = nativeImage.createFromPath(path.join(res, 'assets', 'trayTemplate.png'));    // the @2x variant is picked up automatically
    if (icon.isEmpty()) appendLog('zode: assets/trayTemplate.png missing from dist; no menu bar icon.');
    else {
      tray = new Tray(icon); tray.setToolTip('Zode');
      // The menu is built on click rather than set ahead of time: on macOS a preset context menu swallows
      // the click event, and the connection state is only worth looking up right then.
      const popMenu = async () => {
        try {
          enginePath = await findEngine();
          tapUp = await tapAlive();
          tray.popUpContextMenu(Menu.buildFromTemplate(buildMenuTemplate(menuState(), actions)));
        } catch (err) { appendLog(`zode: ${err?.stack || err}`); }
      };
      tray.on('click', () => { popMenu(); });
      tray.on('right-click', () => { popMenu(); });
    }

    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
    app.on('second-instance', () => showPairWindow());              // a second launch asks this one to show the pairing window
    app.on('before-quit', () => { quitting = true; relay?.stop().catch(() => {}); });

    // The old integrated copy holds the phone connection for itself (same settings, same paired
    // phones, same port). Ask before the relay starts, so the user never sees a port error first.
    enginePath = await findEngine();
    try {
      const oldPath = await findOldIntegrated();
      if (oldPath && await isRunning(oldPath)) {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          buttons: ['Quit the old Zode', 'Not now'], defaultId: 0, cancelId: 1,
          message: 'An older Zode app is still running.',
          detail: 'The old Zode.app and this app talk to your phone over the same connection. Quit the old one so your phone reaches this app instead.',
        });
        if (response === 0) {
          const gone = await quitApp('dev.zode.app', oldPath);
          if (!gone) appendLog(`zode: the old copy did not quit (${oldPath})`);
        }
      }
    } catch (err) { appendLog(`zode: old copy check: ${err?.stack || err}`); }

    await applyRelay();

    // First run, or the Engine is gone: walk through setup.
    if (!settings.setupDone || !enginePath) showSetupWindow();
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
