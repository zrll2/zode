// Zode integration for the ZCode Electron app: the phone relay runs inside the app, with a menu bar
// icon for state and pairing and a small window that shows the QR code. boot.cjs loads this bundle
// next to itself; `electron` is passed in so the bundle never imports it statically.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { createRelay } from '../relay/service.mjs';
import { detectAddresses, defaultAddress } from './lib/addresses.mjs';
import { loadSettings, saveSettings } from './lib/settings.mjs';
import { buildMenuTemplate } from './lib/menu.mjs';
import { updateState, rebuildScript, checkRelease } from './lib/updates.mjs';
import { listSessions, readTapServers, summarize } from './lib/sessions.mjs';

const HOME = os.homedir();
const SETTINGS_FILE = path.join(HOME, '.zode', 'settings.json');
const LOG_FILE = path.join(HOME, '.zode', 'zode-app.log');
const HOME_FILE = path.join(HOME, '.zode', 'home');                 // the Zode repo path, written by the installer
const REBUILD_LOG = path.join(HOME, '.zode', 'rebuild.log');
const UPDATE_LOG = path.join(HOME, '.zode', 'update.log');
const UPDATE_CHECK_MS = 30 * 60 * 1000;
const RELEASE_CHECK_DELAY_MS = 30 * 1000;             // after start; startup never waits on the network
const RELEASE_CHECK_MS = 6 * 60 * 60 * 1000;
const WORK_TIMEOUT_MS = 1500;                         // per tap socket, and the cap on the tray-click wait
const WORK_POLL_MS = 30 * 1000;                       // background refresh while a ZCode server is live

const appendLog = (msg) => { try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch {} };
const readRepoHome = () => { try { return fs.readFileSync(HOME_FILE, 'utf8').trim() || null; } catch { return null; } };

let started = false;

// Everything runs after app.whenReady(); any failure is logged and never stops ZCode itself.
export async function startZode({ electron, resourcesDir } = {}) {
  if (started) return;
  started = true;
  const res = resourcesDir || import.meta.dirname;                 // Contents/Resources/zode after install
  try {
    const { app, Tray, Menu, BrowserWindow, ipcMain, clipboard, dialog, nativeImage } = electron;
    await app.whenReady();

    // Status lights for the ZCode-now lines at the top of the menu (plain PNGs, so they keep their color).
    const dotIcons = {
      green: nativeImage.createFromPath(path.join(res, 'dotGreen.png')),
      amber: nativeImage.createFromPath(path.join(res, 'dotAmber.png')),
      red: nativeImage.createFromPath(path.join(res, 'dotRed.png')),
      grey: nativeImage.createFromPath(path.join(res, 'dotGrey.png')),
      tick: nativeImage.createFromPath(path.join(res, 'tickGreen.png')),         // a finished conversation
    };

    let settings = loadSettings(SETTINGS_FILE);
    let addresses = detectAddresses();
    let relay = null, tray = null, pairWindow = null, currentPairing = null, pairedCount = 0;
    let error = null;
    let quitting = false;
    // ZCode's own updater is off in this copy (boot.cjs); when a newer release is online (release)
    // or the original ZCode is newer (update), the menu offers to update, or to rebuild.
    const appPath = path.resolve(process.resourcesPath || path.join(res, '..'), '..', '..');   // this Zode.app bundle
    const originalApp = process.env.ZCODE_APP || '/Applications/ZCode.app';   // same default as scripts/build-tap.sh
    let update = { available: false, originalVersion: null, runningVersion: null };
    let updateCheck = null;
    // A newer ZCode release online than the installed original, from scripts/update-zcode.sh --check.
    let release = { available: false, latest: null, installed: null };
    let releaseCheck = null;
    // What ZCode is doing right now, read from the tap sockets; the menu only ever sees the cached value.
    let work = { lines: [], more: 0, counts: { working: 0, waiting: 0, failed: 0 } };
    let workActive = 0;                                // the active count last logged, so a change logs once
    let workRefresh = null;
    let workPoll = null;

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

    // Two Info.plist reads, so it is cheap enough to run on every tray click too. Shared while in flight.
    function checkUpdate() {
      if (updateCheck) return updateCheck;
      updateCheck = updateState({ original: originalApp, running: appPath })
        .then(next => {
          const changed = ['available', 'originalVersion', 'runningVersion'].some(k => next[k] !== update[k]);
          update = next;
          if (changed) {
            appendLog(`zode: original ZCode is ${next.originalVersion ?? 'missing'}, this copy is ${next.runningVersion ?? 'unknown'}${next.available ? '; offering a rebuild' : ''}`);
            refresh();
          }
        })
        .catch(err => appendLog(`zode: update check: ${err?.stack || err}`))
        .finally(() => { updateCheck = null; });
      return updateCheck;
    }

    // Is a newer ZCode release online than the installed original? scripts/update-zcode.sh --check
    // answers in one JSON line (up to ~15 s of network). Run 30 s after start and then every 6
    // hours, never twice at once; the tray click only ever reads the cached value.
    function checkReleaseOnce() {
      if (releaseCheck) return releaseCheck;
      releaseCheck = checkRelease({ repo: readRepoHome(), env: { ...process.env, ZCODE_APP: originalApp, ZODE_APP: appPath } })
        .then(next => {
          if (next) {
            const changed = ['available', 'latest', 'installed'].some(k => next[k] !== release[k]);
            release = { available: next.available === true, latest: next.latest, installed: next.installed };
            if (changed) {
              appendLog(`zode: release check: latest ZCode release is ${release.latest ?? 'unknown'}${release.available ? `; installed original is ${release.installed ?? 'unknown'}; offering the update` : ''}`);
              refresh();
            }
          }
        })
        .catch(err => appendLog(`zode: release check: ${err?.stack || err}`))
        .finally(() => { releaseCheck = null; });
      return releaseCheck;
    }

    // "Zode: 2 working, 1 waiting" — the nonzero parts only, or plain "Zode" when nothing is active.
    function workTooltip(counts) {
      const parts = [];
      if (counts.failed) parts.push(`${counts.failed} failed`);
      if (counts.working) parts.push(`${counts.working} working`);
      if (counts.waiting) parts.push(`${counts.waiting} waiting`);
      return parts.length ? `Zode: ${parts.join(', ')}` : 'Zode';
    }

    // One shared listing across every live ZCode server (1.5 s per socket, never twice at once). The
    // menu and the tooltip read only the cached `work`, so a slow refresh keeps the previous lines.
    function refreshSessions() {
      if (workRefresh) return workRefresh;
      workRefresh = (async () => {
        try {
          work = summarize(await listSessions({ timeoutMs: WORK_TIMEOUT_MS }), Date.now());
          const active = work.counts.working + work.counts.waiting + work.counts.failed;
          if (active !== workActive) {
            workActive = active;
            appendLog(`zode: ${active} active ZCode ${active === 1 ? 'conversation' : 'conversations'}`);
          }
          try { tray?.setToolTip(workTooltip(work.counts)); } catch {}
        } catch (err) { appendLog(`zode: sessions: ${err?.stack || err}`); }
      })().finally(() => { workRefresh = null; });
      return workRefresh;
    }

    // Fresh lines every 30 s while a ZCode server is live. A tick with none is one local readdir that
    // touches no sockets, so nothing runs (and no server is asked) while ZCode is closed.
    function pollSessions() {
      if (workPoll) return;
      workPoll = setInterval(() => { if (readTapServers().length > 0) refreshSessions(); }, WORK_POLL_MS);
      workPoll.unref?.();
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
        update,
        release,
        work,
        icons: dotIcons,
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

    // Both update paths need the Zode repo. Returns the repo path, or null after the shared error dialog.
    async function requireRepo(purpose) {
      const repo = readRepoHome();
      if (repo && fs.existsSync(path.join(repo, 'scripts', 'build-tap.sh'))) return repo;
      appendLog(`zode: ${purpose}: no usable repo path in ${HOME_FILE} (${repo ?? 'missing'})`);
      await dialog.showMessageBox({
        type: 'error', message: 'Zode cannot find its own repo.',
        detail: `~/.zode/home should contain the path of the Zode repo${repo ? ` (it says ${repo}, which has no scripts/build-tap.sh)` : ''}. Run ./zode install in the Zode repo; that rebuilds the app as well.`,
      });
      return null;
    }

    // Quit, rebuild Zode.app from the newer original ZCode, reopen. The work happens in a detached shell
    // (rebuildScript) because this process must be gone before the bundle can be replaced. Whether a ZCode
    // turn is in progress is not visible from here, so the dialog warns about it instead of refusing.
    async function rebuild() {
      try {
        const version = update.originalVersion ?? 'the installed version';
        const { response } = await dialog.showMessageBox({
          type: 'warning', buttons: ['Rebuild', 'Cancel'], defaultId: 0, cancelId: 1,
          message: `Zode will quit, rebuild itself from ZCode ${version} and reopen.`,
          detail: 'This takes about a minute. Unsaved work in ZCode sessions that are running will not continue. Continue?',
        });
        if (response !== 0) return;
        const repo = await requireRepo('rebuild');
        if (!repo) return;
        fs.mkdirSync(path.dirname(REBUILD_LOG), { recursive: true });
        const logFd = fs.openSync(REBUILD_LOG, 'a');
        const child = spawn('/bin/bash', ['-c', rebuildScript({ pid: process.pid, repo, appPath })], { detached: true, stdio: ['ignore', logFd, logFd] });
        child.on('error', err => appendLog(`zode: rebuild: ${err?.stack || err}`));
        child.unref();
        fs.closeSync(logFd);
        appendLog(`zode: rebuilding from ZCode ${version} with ${repo}/scripts/build-tap.sh (log: ${REBUILD_LOG}); quitting`);
        app.quit();
      } catch (err) { appendLog(`zode: rebuild: ${err?.stack || err}`); }
    }

    // One click for the whole update: the detached scripts/update-zcode.sh quits both apps, swaps in
    // the new original ZCode, rebuilds this copy from it and reopens Zode. --pid makes it wait for
    // this process to be gone before touching anything.
    async function updateZcode() {
      try {
        const latest = release.latest ?? 'a new version';
        const { response } = await dialog.showMessageBox({
          type: 'warning', buttons: ['Update', 'Cancel'], defaultId: 0, cancelId: 1,
          message: `Update ZCode to ${latest}?`,
          detail: 'Zode will quit, update the original ZCode (the same release ZCode would download), rebuild itself and reopen. This takes a few minutes. ZCode and any running ZCode tasks will stop. Continue?',
        });
        if (response !== 0) return;
        const repo = await requireRepo('update');
        if (!repo) return;
        const script = path.join(repo, 'scripts', 'update-zcode.sh');
        fs.mkdirSync(path.dirname(UPDATE_LOG), { recursive: true });
        const logFd = fs.openSync(UPDATE_LOG, 'a');
        const child = spawn('/bin/bash', [script, '--yes', '--pid', String(process.pid)], { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, ZCODE_APP: originalApp, ZODE_APP: appPath } });
        child.on('error', err => appendLog(`zode: update: ${err?.stack || err}`));
        child.unref();
        fs.closeSync(logFd);
        appendLog(`zode: updating ZCode to ${latest} with ${script} (log: ${UPDATE_LOG}); quitting`);
        app.quit();
      } catch (err) { appendLog(`zode: update: ${err?.stack || err}`); }
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
      rebuild: () => rebuild(),
      updateZcode: () => updateZcode(),
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
    else {
      tray = new Tray(icon); tray.setToolTip('Zode');
      // The menu is built on click, after a version check and a session refresh, rather than set ahead
      // of time: on macOS a preset context menu swallows the click event, so there would be no moment
      // to re-check before it opens. Both checks together are capped at ~1.5 s; whatever has not landed
      // by then is simply not in this menu yet and shows up on the next click.
      const popMenu = () => { try { tray.popUpContextMenu(Menu.buildFromTemplate(buildMenuTemplate(menuState(), actions))); } catch (err) { appendLog(`zode: ${err?.stack || err}`); } };
      const popMenuWhenReady = () => {
        const cap = new Promise(resolve => { const t = setTimeout(resolve, WORK_TIMEOUT_MS); t.unref?.(); });
        Promise.race([Promise.allSettled([checkUpdate(), refreshSessions()]), cap]).then(popMenu, popMenu);
      };
      tray.on('click', popMenuWhenReady);
      tray.on('right-click', popMenuWhenReady);
    }

    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
    app.on('before-quit', () => { quitting = true; relay?.stop().catch(() => {}); });

    checkUpdate();
    setInterval(checkUpdate, UPDATE_CHECK_MS);
    setTimeout(checkReleaseOnce, RELEASE_CHECK_DELAY_MS);
    setInterval(checkReleaseOnce, RELEASE_CHECK_MS);
    refreshSessions();
    pollSessions();
    await applyRelay();
  } catch (err) {
    appendLog(`zode: ${err?.stack || err}`);
  }
}
