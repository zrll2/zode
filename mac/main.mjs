// Zode for Mac: a standalone menu bar app that runs the phone relay in its own process. It never
// patches or boots ZCode: the Engine app exposes the agent on ~/.zcode-tap, and this app starts the
// relay, offers pairing, keeps the tray menu going and walks through first-run setup.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { app, Tray, Menu, BrowserWindow, ipcMain, clipboard, dialog, nativeImage, nativeTheme, screen, shell, powerSaveBlocker, Notification } from 'electron';
import updaterPkg from 'electron-updater';
const { autoUpdater } = updaterPkg;
import QRCode from 'qrcode';
import { createRelay } from '../relay/service.mjs';
import { detectAddresses, defaultAddress } from './lib/addresses.mjs';
import { loadSettings, saveSettings } from './lib/settings.mjs';
import { buildMenuTemplate } from './lib/menu.mjs';
import { buildPanelModel } from './lib/panel.mjs';
import { panelBounds, trayImageName, isTemplate } from './lib/panelWindow.mjs';
import { setupSteps, parseBuildProgress, friendlySetupError, kitDir } from './lib/setup.mjs';
import { isRunning, quitApp, tapAlive, findOriginal, findEngine, findOldIntegrated, runBuild } from './lib/system.mjs';
import { readVersion, compareVersions, checkRelease, engineRebuildScript } from './lib/updates.mjs';
import { listSessions, listPending, readTapServers, summarize, respondPermission, stopSession, sendToSession, nudgeSession, RETRY_MESSAGE } from './lib/sessions.mjs';
import { createSelfUpdater } from './lib/selfupdate.mjs';

const HOME = os.homedir();
const SETTINGS_FILE = path.join(HOME, '.zode', 'settings.json');
const LOG_FILE = path.join(HOME, '.zode', 'mac-app.log');
const DOWNLOAD_URL = 'https://zcode.z.ai';
const UPDATE_LOG = path.join(HOME, '.zode', 'update.log');
const REBUILD_LOG = path.join(HOME, '.zode', 'rebuild.log');
const UPDATE_CHECK_MS = 30 * 60 * 1000;
const RELEASE_CHECK_DELAY_MS = 30 * 1000;             // after start; startup never waits on the network
const RELEASE_CHECK_MS = 6 * 60 * 60 * 1000;
const WORK_TIMEOUT_MS = 1500;                         // per tap socket, and the cap on the tray-click wait
const WORK_POLL_MS = 30 * 1000;                       // background refresh while a ZCode server is live
const WORK_SETTLE_MS = 1000;                          // after a menu action, before the refresh + reopen
const PANEL_WIDTH = 340;                              // the panel that opens under the menu bar icon
const PANEL_REOPEN_MS = 250;                          // a tray click this soon after a blur-hide is the click that closed it

const appendLog = (msg) => { try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch {} };

// The last non-empty line of a log file ('' when unreadable): what failed, in the script's own words.
const lastLogLine = (file) => {
  try {
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    return (lines[lines.length - 1] ?? '').trim();
  } catch { return ''; }
};

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

    // Status lights for the ZCode-now lines at the top of the menu (plain PNGs, so they keep their color).
    const dotIcons = {
      green: nativeImage.createFromPath(path.join(res, 'assets', 'dotGreen.png')),
      amber: nativeImage.createFromPath(path.join(res, 'assets', 'dotAmber.png')),
      red: nativeImage.createFromPath(path.join(res, 'assets', 'dotRed.png')),
      grey: nativeImage.createFromPath(path.join(res, 'assets', 'dotGrey.png')),
      tick: nativeImage.createFromPath(path.join(res, 'assets', 'tickGreen.png')),         // a finished conversation
    };

    let settings = loadSettings(SETTINGS_FILE);
    let addresses = detectAddresses();
    let relay = null, tray = null, pairWindow = null, currentPairing = null, pairedCount = 0;
    let error = null;
    let quitting = false;
    let enginePath = null;
    let tapUp = false;
    const kit = kitDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, devRoot: devRoot() });
    // When the original ZCode is newer than the Engine copy (update), or a newer release is online
    // (release), the menu offers to rebuild the Engine, or to update ZCode.
    let originalPath = null;
    let update = { available: false, originalVersion: null, engineVersion: null };
    let updateCheck = null;
    let release = { available: false, latest: null, installed: null };
    let releaseCheck = null;
    let updating = false;                              // one engine job (update or rebuild) at a time
    // What ZCode is doing right now, read from the tap sockets; the menu only ever sees the cached value.
    let work = { lines: [], more: 0, counts: { working: 0, waiting: 0, failed: 0 }, pending: {} };
    let workActive = 0;                                // the active count last logged, so a change logs once
    let workRefresh = null;
    let workPoll = null;
    let panelWindow = null;                            // the popover under the tray icon; created lazily, kept
    let panelHeight = 300;                             // the last height the renderer asked for
    let panelHidingAt = 0;                             // when the panel last hid on blur, to skip the closing click
    let panelHoldBlur = false;                         // a dialog is anchored to the panel: keep it up

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
    const say = opts => { try { dialog.showMessageBox(opts).catch(() => {}); } catch { /* never */ } };

    // Zode updating itself from GitHub Releases: packaged builds only, a development run skips it.
    const selfUpdater = createSelfUpdater({
      updater: autoUpdater,
      isPackaged: app.isPackaged === true,
      log: {
        info: m => appendLog(`selfupdate: ${m}`),
        warn: m => appendLog(`selfupdate warn: ${m}`),
        error: m => appendLog(`selfupdate error: ${m}`),
        debug: m => appendLog(`selfupdate debug: ${m}`),
      },
      onReady: version => {
        try { new Notification({ title: 'Zode', body: `Zode ${version} is ready. Restart from the menu bar.` }).show(); }
        catch (err) { appendLog(`zode: update notification: ${err?.stack || err}`); }
      },
    });

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

    // Is the original ZCode newer than the Engine copy? Two Info.plist reads, cheap enough to run on
    // every tray click too. Shared while in flight.
    function checkUpdate() {
      if (updateCheck) return updateCheck;
      updateCheck = (async () => {
        try {
          const [origV, engineV] = await Promise.all([
            readVersion(originalPath),
            enginePath ? readVersion(enginePath) : Promise.resolve(null),
          ]);
          const next = { available: !!(origV && engineV && compareVersions(origV, engineV) > 0), originalVersion: origV, engineVersion: engineV };
          const changed = ['available', 'originalVersion', 'engineVersion'].some(k => next[k] !== update[k]);
          update = next;
          if (changed) {
            appendLog(`zode: original ZCode is ${next.originalVersion ?? 'missing'}, the engine is ${next.engineVersion ?? 'missing'}${next.available ? '; offering a rebuild' : ''}`);
            refresh();
          }
        } catch (err) { appendLog(`zode: update check: ${err?.stack || err}`); }
      })().finally(() => { updateCheck = null; });
      return updateCheck;
    }

    // Is a newer ZCode release online than the installed original? scripts/update-zcode.sh --check
    // answers in one JSON line (up to ~15 s of network). Run 30 s after start and then every 6
    // hours, never twice at once; the tray click only ever reads the cached value.
    function checkReleaseOnce() {
      if (releaseCheck) return releaseCheck;
      releaseCheck = checkRelease({ repo: kit, env: { ...process.env, ZCODE_APP: originalPath, ZODE_APP: enginePath } })
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

    // Measure text in the real UI font (a hidden page with a canvas), so the menu can pad each line until the
    // status text ends at one right edge. Any failure returns null and the menu falls back to an estimate.
    let measureWin = null;
    async function measureTexts(strings) {
      try {
        if (!measureWin || measureWin.isDestroyed()) {
          measureWin = new BrowserWindow({ show: false, width: 120, height: 60, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
          await measureWin.loadURL('data:text/html;charset=utf-8,<canvas id="c"></canvas>');
        }
        const widths = await measureWin.webContents.executeJavaScript(
          `(() => { const x = document.getElementById('c').getContext('2d'); x.font = '13px -apple-system, system-ui'; return ${JSON.stringify(strings)}.map(t => x.measureText(t).width); })()`);
        return Array.isArray(widths) && widths.every(Number.isFinite) ? widths : null;
      } catch { return null; }
    }
    async function withMeasures(summary) {
      const lines = summary.lines;
      if (!lines.length) return summary;
      const spaces = ['\u00a0'];
      const w = await measureTexts([...spaces, ...lines.map(l => l.project), ...lines.map(l => l.status), 'ZCode right now', 'Refresh']);
      const SPACES = spaces.length;
      if (!w) return summary;
      const [space] = w;
      const n = lines.length;
      return {
        ...summary,
        metrics: { space, gap: space * 4 },
        headerPx: { project: w[SPACES + 2 * n], status: w[SPACES + 2 * n + 1] },
        lines: lines.map((l, i) => ({ ...l, px: { project: w[SPACES + i], status: w[SPACES + n + i] } })),
      };
    }

    // One shared listing across every live ZCode server (1.5 s per socket, never twice at once). The
    // menu and the tooltip read only the cached `work`, so a slow refresh keeps the previous lines.
    function refreshSessions() {
      if (workRefresh) return workRefresh;
      workRefresh = (async () => {
        try {
          const listed = await listSessions({ timeoutMs: WORK_TIMEOUT_MS });
          const summary = summarize(listed, Date.now());
          // The panel shows ages since the last activity; summarize drops the timestamps, so keep them.
          const at = new Map(listed.map(s => [s?.sessionId, Number(s?.updatedAt) || 0]));
          summary.lines = summary.lines.map(l => (at.has(l.id) ? { ...l, at: at.get(l.id) } : l));
          const pending = {};
          if (summary.counts.waiting > 0) {            // only waiting conversations can have something pending
            for (const request of await listPending({ timeoutMs: WORK_TIMEOUT_MS })) {
              if (request.sessionId == null) continue;
              (pending[request.sessionId] ??= []).push(request);
            }
          }
          work = await withMeasures({ ...summary, pending });
          const active = work.counts.working + work.counts.waiting + work.counts.failed;
          if (active !== workActive) {
            workActive = active;
            appendLog(`zode: ${active} active ZCode ${active === 1 ? 'conversation' : 'conversations'}`);
          }
          try { tray?.setToolTip(workTooltip(work.counts)); } catch { /* no tray yet */ }
          applyTrayImage();                              // the icon dot follows the glyph, also on the 30 s poll
          pushPanel();                                   // an open panel re-renders from the fresh state
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
        keepAwake: settings.keepAwake,
        setupDone: settings.setupDone,
        foldFinished: settings.foldFinished === true,
        tapAlive: tapUp,
        engine: { path: enginePath },
        update,
        release,
        work,
        icons: dotIcons,
        selfUpdate: selfUpdater.getState(),
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
      pushPanel();                                       // a setting or the relay changed: the panel follows
    }

    // One click for the whole update: the detached scripts/update-zcode.sh updates the original ZCode,
    // rebuilds the Engine from it and reopens the Engine. Zode itself is NOT quit and NOT restarted —
    // its relay lives here now, not in the app being replaced — so there is no --pid and no quit.
    async function updateZcode() {
      try {
        if (updating) return;
        const latest = release.latest ?? 'a new version';
        const { response } = await dialog.showMessageBox({
          type: 'warning', buttons: ['Update', 'Cancel'], defaultId: 0, cancelId: 1,
          message: `Update ZCode to ${latest}?`,
          detail: 'Zode downloads the same release ZCode would, updates ZCode and rebuilds the Engine. This takes a few minutes, and any running ZCode tasks will stop. Zode itself stays running. Continue?',
        });
        if (response !== 0) return;
        const engineTarget = enginePath || await findEngine().catch(() => null);
        const script = path.join(kit, 'scripts', 'update-zcode.sh');
        if (!fs.existsSync(script)) {
          say({ type: 'error', message: 'Zode cannot find its updater.', detail: `Expected it at ${script}. Reinstall Zode, or run ./zode install in the Zode repo.` });
          return;
        }
        updating = true;
        fs.mkdirSync(path.dirname(UPDATE_LOG), { recursive: true });
        const logFd = fs.openSync(UPDATE_LOG, 'a');
        const child = spawn('/bin/bash', [script, '--yes'], { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, ZCODE_APP: originalPath, ZODE_APP: engineTarget, ZODE_ENGINE: '1' } });
        child.on('error', err => appendLog(`zode: update: ${err?.stack || err}`));
        child.unref();
        fs.closeSync(logFd);
        say({ type: 'info', message: 'Updating ZCode…', detail: 'This takes a few minutes. Zode stays running.' });
        appendLog(`zode: updating ZCode to ${latest} with ${script} (log: ${UPDATE_LOG})`);
        child.on('close', async code => {
          updating = false;
          try {
            if (code === 0) {
              enginePath = await findEngine().catch(() => null);
              const newVersion = await readVersion(originalPath);
              say({ type: 'info', message: `ZCode is now ${newVersion || release.latest || 'up to date'}`, detail: 'The Engine was rebuilt from it and reopened.' });
              appendLog(`zode: update finished; ZCode is now ${newVersion ?? 'unknown'}`);
              checkUpdate();
              checkReleaseOnce();
            } else {
              const last = lastLogLine(UPDATE_LOG);
              say({ type: 'error', message: 'Updating ZCode failed.', detail: `${last || 'No details were logged.'}\n\nFull log: ${UPDATE_LOG}` });
              appendLog(`zode: update failed (exit ${code}); last log line: ${last}`);
            }
          } catch (err) { appendLog(`zode: update result: ${err?.stack || err}`); }
        });
      } catch (err) { appendLog(`zode: update: ${err?.stack || err}`); updating = false; }
    }

    // Rebuild the Engine from the newer original ZCode. The work happens in a detached shell
    // (engineRebuildScript) so a slow build never blocks the app; whether a ZCode turn is in
    // progress is not visible from here, so the dialog warns about it instead of refusing.
    async function rebuildEngine() {
      try {
        if (updating) return;
        const version = update.originalVersion ?? 'the installed version';
        const { response } = await dialog.showMessageBox({
          type: 'warning', buttons: ['Rebuild', 'Cancel'], defaultId: 0, cancelId: 1,
          message: `Rebuild the Engine from ZCode ${version}?`,
          detail: 'The Engine quits, is rebuilt from your original ZCode and reopens. This takes about a minute, and running ZCode tasks will stop. Zode itself stays running. Continue?',
        });
        if (response !== 0) return;
        const engineTarget = enginePath || await findEngine().catch(() => null);
        if (!engineTarget) { say({ type: 'error', message: 'There is no Engine to rebuild.', detail: 'Run “Set up ZCode…” first.' }); return; }
        const buildScript = path.join(kit, 'scripts', 'build-tap.sh');
        if (!fs.existsSync(buildScript)) {
          say({ type: 'error', message: 'Zode cannot find its builder.', detail: `Expected it at ${buildScript}. Reinstall Zode, or run ./zode install in the Zode repo.` });
          return;
        }
        updating = true;
        fs.mkdirSync(path.dirname(REBUILD_LOG), { recursive: true });
        const logFd = fs.openSync(REBUILD_LOG, 'a');
        const child = spawn('/bin/bash', ['-c', engineRebuildScript({ repo: kit, enginePath: engineTarget })], { detached: true, stdio: ['ignore', logFd, logFd] });
        child.on('error', err => appendLog(`zode: rebuild: ${err?.stack || err}`));
        child.unref();
        fs.closeSync(logFd);
        say({ type: 'info', message: 'Rebuilding the Engine…', detail: 'This takes about a minute. Zode stays running.' });
        appendLog(`zode: rebuilding the engine from ZCode ${version} (log: ${REBUILD_LOG})`);
        child.on('close', async code => {
          updating = false;
          try {
            if (code === 0) {
              enginePath = await findEngine().catch(() => null);
              say({ type: 'info', message: 'The Engine is rebuilt.', detail: `It is now based on ZCode ${version} and has been reopened.` });
              appendLog(`zode: engine rebuild finished`);
              checkUpdate();
            } else {
              const last = lastLogLine(REBUILD_LOG);
              say({ type: 'error', message: 'Rebuilding the Engine failed.', detail: `${last || 'No details were logged.'}\n\nFull log: ${REBUILD_LOG}` });
              appendLog(`zode: engine rebuild failed (exit ${code}); last log line: ${last}`);
            }
          } catch (err) { appendLog(`zode: rebuild result: ${err?.stack || err}`); }
        });
      } catch (err) { appendLog(`zode: rebuild: ${err?.stack || err}`); updating = false; }
    }

    // Which project a session belongs to, for the action log line.
    function projectOf(sessionId) {
      return work.lines.find(l => l.id === sessionId)?.project ?? 'ZCode';
    }

    // One menu action on a conversation: confirm (risky approvals), run it, give ZCode a moment to
    // settle, then refresh and reopen the menu. Exactly one log line per action; a real refusal gets
    // one plain dialog. Cancelled confirmations do nothing at all.
    async function runWorkAction({ what, project, confirm, run }) {
      try {
        if (confirm && !(await confirm())) return;
        const failure = await run();
        appendLog(`zode: ${what} (${project})${failure ? `; did not work: ${failure}` : ''}`);
        if (failure) await dialog.showMessageBox({ type: 'warning', message: 'That did not work', detail: String(failure) });
      } catch (err) {
        appendLog(`zode: ${what} (${project}); did not work: ${err?.message ?? err}`);
        try { await dialog.showMessageBox({ type: 'warning', message: 'That did not work', detail: String(err?.message ?? err) }); } catch { /* never */ }
      }
      await new Promise(resolve => { const t = setTimeout(resolve, WORK_SETTLE_MS); t.unref?.(); });
      refreshSessions().finally(() => { if (!panelVisible()) reopenMenu?.(); });   // an open panel refreshes in place
    }

    // The pending request a menu item belonged to, for the log line and the risky-command dialog.
    const findPending = requestId => Object.values(work.pending ?? {}).flat().find(r => r.requestId === requestId) ?? null;

    let reopenMenu = null;                              // set once the tray exists: pops the menu up again
    const actions = {
      pair: () => showPairWindow(),
      toggleRelay: async () => { settings.relayEnabled = !(relay?.status().running); save(); await applyRelay(); },
      revoke: id => { try { relay?.revokeDevice(id); } catch (err) { appendLog(`zode: revoke: ${err?.stack || err}`); } },
      selectAddress: async id => { settings.addressId = id; save(); await applyRelay(); },
      refreshWork: () => { refreshSessions().finally(() => { if (!panelVisible()) reopenMenu?.(); }); },   // fresh data, then the menu or the panel
      // Unblock a conversation from the menu bar. A permission answer is fire-and-forget (the desktop
      // window may have answered first; any outcome is fine), stop/send surface a real refusal.
      approve: (requestId, sock, risky, text) => {
        const p = findPending(requestId);
        runWorkAction({
          what: 'approved', project: p ? projectOf(p.sessionId) : 'ZCode',
          confirm: risky ? () => dialog.showMessageBox({
            type: 'warning', buttons: ['Allow', 'Cancel'], defaultId: 0, cancelId: 1,
            message: 'Allow this command?', detail: String(p?.detail || text || ''),
          }).then(({ response }) => response === 0) : null,
          run: async () => { await respondPermission({ sock, requestId, decision: 'allow', reason: 'Approved from the menu bar' }); return null; },
        });
      },
      deny: (requestId, sock) => {
        const p = findPending(requestId);
        runWorkAction({
          what: 'denied', project: p ? projectOf(p.sessionId) : 'ZCode',
          run: async () => { await respondPermission({ sock, requestId, decision: 'deny', reason: 'Denied from the menu bar' }); return null; },
        });
      },
      nudge: (sessionId, sock) => runWorkAction({ what: 'nudged', project: projectOf(sessionId), run: () => nudgeSession({ sock, sessionId }) }),
      stop: (sessionId, sock) => runWorkAction({ what: 'stopped', project: projectOf(sessionId), run: () => stopSession({ sock, sessionId }) }),
      retry: (sessionId, sock) => runWorkAction({ what: 'asked to try again', project: projectOf(sessionId), run: () => sendToSession({ sock, sessionId, content: RETRY_MESSAGE }) }),
      toggleFoldFinished: () => { settings.foldFinished = !settings.foldFinished; save(); pushPanel(); },
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
      updateZcode: () => updateZcode(),
      rebuildEngine: () => rebuildEngine(),
      installSelfUpdate: () => selfUpdater.install(),
      checkSelfUpdate: async () => {
        try {
          const cap = new Promise(resolve => { const t = setTimeout(() => resolve({ status: 'error', error: 'The check took too long. Try again later.' }), 20_000); t.unref?.(); });
          const r = await Promise.race([selfUpdater.checkNow(), cap]);
          if (!r || r.status === 'disabled') return;
          if (r.status === 'up-to-date') say({ type: 'info', message: 'Zode is up to date', detail: `Version ${app.getVersion()} is the latest release.` });
          else if (r.status === 'downloading') say({ type: 'info', message: 'Update found, downloading…', detail: r.version ? `Zode ${r.version} is downloading in the background. Zode will let you know when it is ready.` : 'The new version is downloading in the background.' });
          else if (r.status === 'ready') say({ type: 'info', message: r.version ? `Zode ${r.version} is ready` : 'A Zode update is ready', detail: 'Choose “Restart to update Zode” from the menu bar to install it.' });
          else say({ type: 'error', message: 'Checking for updates failed.', detail: `${r.error ?? 'Something went wrong.'}\n\nDetails are in ~/.zode/mac-app.log` });
        } catch (err) { appendLog(`zode: self check: ${err?.stack || err}`); }
      },
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

    // ---- the menu bar panel --------------------------------------------------------------------
    // A small popover under the tray icon; the native menu stays as the right-click fallback. The
    // renderer only draws: one model in (zode:panelState, pushed again on zode:panelPush), actions
    // out (zode:panelAction). Everything the renderer sends is validated here, and nothing here
    // throws: failures go to the log and, where the user acted, to a plain dialog.

    function panelVisible() {
      try { return !!(panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()); } catch { return false; }
    }

    // The same state the native menu reads, shaped for buildPanelModel; work.lines carry `at`
    // (refreshSessions keeps them) so the panel can show ages.
    function panelModel() {
      try {
        const devices = relay ? relay.listDevices() : [];
        return buildPanelModel({
          running: !!(relay?.status().running),
          phones: devices.length,
          addresses,
          addressId: chosen().id,
          launchAtLogin: settings.launchAtLogin,
          keepAwake: settings.keepAwake,
          setupDone: settings.setupDone,
          foldFinished: settings.foldFinished === true,
          tapAlive: tapUp === true,
          engine: { path: enginePath },
          update,
          release,
          work,
          selfUpdate: selfUpdater.getState(),
          version: app.getVersion(),
        });
      } catch (err) {
        appendLog(`zode: panel model: ${err?.stack || err}`);
        return buildPanelModel(null);
      }
    }

    function pushPanel() {
      try {
        if (panelVisible()) panelWindow.webContents.send('zode:panelPush', panelModel());
      } catch (err) { appendLog(`zode: panel push: ${err?.stack || err}`); }
    }

    // The tray icon mirrors the panel's headline state: amber while something needs you, green while
    // work runs, the quiet template image otherwise. Only the template is tinted by macOS.
    function applyTrayImage() {
      if (!tray) return;
      try {
        const glyph = panelModel().glyph;
        const name = trayImageName({ glyph, dark: nativeTheme.shouldUseDarkColors === true });
        const image = nativeImage.createFromPath(path.join(res, 'assets', name));
        if (image.isEmpty()) { appendLog(`zode: assets/${name} is missing; keeping the tray icon.`); return; }
        if (!isTemplate(glyph)) image.setTemplateImage(false);
        tray.setImage(image);
      } catch (err) { appendLog(`zode: tray image: ${err?.stack || err}`); }
    }

    function hidePanel() {
      try {
        if (panelHoldBlur) return;                     // a dialog is anchored to the panel: keep it up
        if (panelVisible()) { panelHidingAt = Date.now(); panelWindow.hide(); }
      } catch (err) { appendLog(`zode: panel hide: ${err?.stack || err}`); }
    }

    function showPanel() {
      try {
        if (!panelWindow || panelWindow.isDestroyed()) {
          panelWindow = new BrowserWindow({
            width: PANEL_WIDTH, height: 300, show: false, frame: false, transparent: true, resizable: false,
            movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
            hasShadow: true, vibrancy: 'popover', visualEffectState: 'active', alwaysOnTop: true,
            webPreferences: { preload: path.join(res, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
          });
          panelWindow.setAlwaysOnTop(true, 'pop-up-menu');
          panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
          panelWindow.on('blur', hidePanel);
          panelWindow.on('closed', () => { panelWindow = null; });
          panelWindow.loadFile(path.join(res, 'panel', 'index.html'));
        }
        const trayBounds = tray ? tray.getBounds() : null;
        const display = screen.getDisplayMatching(trayBounds ?? { x: 0, y: 0, width: 0, height: 0 });
        panelWindow.setBounds(panelBounds({ trayBounds, workArea: display.workArea, width: PANEL_WIDTH, height: panelHeight }));
        panelWindow.show();
        panelWindow.focus();
        pushPanel();                                   // the open-time refresh pushes again once it lands
      } catch (err) { appendLog(`zode: panel show: ${err?.stack || err}`); }
    }

    // Left click on the icon: hide an open panel, or refresh (the ~1.5 s capped wait, together with
    // the version check) and open under the icon. The click that closed it on blur arrives here too.
    function togglePanel() {
      if (panelVisible()) { hidePanel(); return; }
      if (Date.now() - panelHidingAt < PANEL_REOPEN_MS) return;
      (async () => {
        try {
          try { tapUp = await tapAlive(); } catch { /* keep the cached value */ }
          const cap = new Promise(resolve => { const t = setTimeout(resolve, WORK_TIMEOUT_MS); t.unref?.(); });
          await Promise.race([Promise.allSettled([checkUpdate(), refreshSessions()]), cap]);
          showPanel();
        } catch (err) { appendLog(`zode: panel open: ${err?.stack || err}`); }
      })();
    }

    // The risky-approval dialog anchors to the panel, which stays up while it shows.
    async function confirmOverPanel({ message, detail }) {
      let win = null;
      try {
        if (panelWindow && !panelWindow.isDestroyed()) { win = panelWindow; panelHoldBlur = true; win.setAlwaysOnTop(false); }
      } catch { win = null; }
      const opts = { type: 'warning', buttons: ['Allow', 'Cancel'], defaultId: 0, cancelId: 1, message, detail };
      try {
        const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
        return response === 0;
      } catch { return false; }
      finally {
        panelHoldBlur = false;
        try { if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'pop-up-menu'); } catch { /* gone */ }
      }
    }

    // The work actions, as the native menu runs them, with the risky confirm anchored to the panel.
    function panelApprove({ requestId, sock, risky, summary }) {
      const p = findPending(requestId);
      runWorkAction({
        what: 'approved', project: p ? projectOf(p.sessionId) : 'ZCode',
        confirm: risky ? () => confirmOverPanel({ message: 'Allow this command?', detail: String(p?.detail || summary || '') }) : null,
        run: async () => { await respondPermission({ sock, requestId, decision: 'allow', reason: 'Approved from the menu bar' }); return null; },
      });
    }

    // Every payload is checked against the last listing before it reaches an action; anything unknown
    // or stale is ignored.
    const liveSocks = () => new Set((Array.isArray(work?.lines) ? work.lines : []).map(l => l?.sock).filter(s => typeof s === 'string' && s.length > 0));
    const idOk = v => (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v));

    function handlePanelAction(name, payload) {
      const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      if (name === 'approve') {
        if (!idOk(p.requestId) || !liveSocks().has(p.sock)) return;
        panelApprove({ requestId: p.requestId, sock: p.sock, risky: p.risky === true, summary: typeof p.summary === 'string' ? p.summary : '' });
      } else if (name === 'deny') {
        if (!idOk(p.requestId) || !liveSocks().has(p.sock)) return;
        actions.deny(p.requestId, p.sock);
      } else if (name === 'nudge' || name === 'stop' || name === 'retry') {
        if (!idOk(p.sessionId) || !liveSocks().has(p.sock)) return;
        actions[name](p.sessionId, p.sock);
      } else if (name === 'show' || name === 'openZcode') {
        actions.openEngine();
      } else if (name === 'refresh') {
        actions.refreshWork();
      } else if (name === 'toggle') {
        if (p.key === 'keepAwake') actions.toggleKeepAwake();
        else if (p.key === 'relayEnabled') actions.toggleRelay();
        else if (p.key === 'launchAtLogin') actions.toggleLaunchAtLogin();
      } else if (name === 'foldFinished') {
        actions.toggleFoldFinished();
      } else if (name === 'setAddress') {
        if (typeof p.id !== 'string' || !addresses.some(a => a && a.id === p.id)) return;
        actions.selectAddress(p.id);
      } else if (name === 'pair' || name === 'phones') {
        hidePanel();
        actions.pair();
      } else if (name === 'setup') {
        showSetupWindow();
      } else if (name === 'checkUpdates') {
        actions.checkSelfUpdate();
      } else if (name === 'banner') {
        if (p.kind === 'setup') showSetupWindow();
        else if (p.kind === 'update') actions.installSelfUpdate();
        else if (p.kind === 'engine') actions.rebuildEngine();
        else if (p.kind === 'zcode') {                 // which zcode banner is showing decides the action
          if (release?.available === true) actions.updateZcode();
          else if (update?.available === true) actions.rebuildEngine();
        }
      } else if (name === 'quit') {
        app.quit();
      } else if (name === 'close') {
        hidePanel();
      }
    }

    ipcMain.handle('zode:panelState', () => panelModel());
    ipcMain.handle('zode:panelAction', (_e, name, payload) => {
      try {
        handlePanelAction(name, payload);
        return true;
      } catch (err) { appendLog(`zode: panel action: ${err?.stack || err}`); return false; }
    });
    ipcMain.on('zode:panelResize', (_e, h) => {
      try {
        if (!Number.isFinite(h)) return;
        panelHeight = h;                               // remembered for the next open
        if (!panelVisible()) return;
        const trayBounds = tray ? tray.getBounds() : null;
        const display = screen.getDisplayMatching(trayBounds ?? { x: 0, y: 0, width: 0, height: 0 });
        panelWindow.setBounds(panelBounds({ trayBounds, workArea: display.workArea, width: PANEL_WIDTH, height: h }));   // the top edge stays under the icon
      } catch (err) { appendLog(`zode: panel resize: ${err?.stack || err}`); }
    });
    try { nativeTheme.on('updated', () => applyTrayImage()); } catch (err) { appendLog(`zode: nativeTheme: ${err?.stack || err}`); }

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
        const [foundOriginal, engineP, oldPath, tap] = await Promise.all([findOriginal(), findEngine(), findOldIntegrated(), tapAlive()]);
        const [originalRunning, oldRunning] = await Promise.all([
          foundOriginal ? isRunning(foundOriginal) : Promise.resolve(false),
          oldPath ? isRunning(oldPath) : Promise.resolve(false),
        ]);
        return {
          steps: setupSteps({ originalExists: !!foundOriginal, engineExists: !!engineP, tapAlive: tap, setupDone: settings.setupDone === true }),
          original: { exists: !!foundOriginal, path: foundOriginal, running: originalRunning },
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
        const [foundOriginal, oldPath] = await Promise.all([findOriginal(), findOldIntegrated()]);
        if (foundOriginal && await isRunning(foundOriginal)) {
          build.running = false;
          return { started: false, blocked: 'zcode' };
        }
        if (oldPath && await isRunning(oldPath)) {
          build.running = false;
          return { started: false, blocked: 'old' };
        }
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
        const [foundOriginal, oldPath] = await Promise.all([findOriginal(), findOldIntegrated()]);
        if (foundOriginal && await isRunning(foundOriginal)) return { ok: await quitApp('dev.zcode.app', foundOriginal) };
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
      // The native menu is the right-click fallback now; a left click opens the panel (togglePanel).
      // The menu is built on click, after a version check and a session refresh, rather than set ahead
      // of time: on macOS a preset context menu swallows the click event, so there would be no moment
      // to re-check before it opens. The checks together are capped at ~1.5 s; whatever has not landed
      // by then is simply not in this menu yet and shows up on the next click. The release check (up
      // to 15 s of network) only ever runs on its schedule; the click reads the cached value.
      const popMenu = () => { try { tray.popUpContextMenu(Menu.buildFromTemplate(buildMenuTemplate(menuState(), actions))); } catch (err) { appendLog(`zode: ${err?.stack || err}`); } };
      reopenMenu = popMenu;
      const popMenuWhenReady = () => {
        (async () => {
          try {
            originalPath = await findOriginal();
            enginePath = await findEngine();
            tapUp = await tapAlive();
          } catch { /* keep the cached values */ }
          const cap = new Promise(resolve => { const t = setTimeout(resolve, WORK_TIMEOUT_MS); t.unref?.(); });
          await Promise.race([Promise.allSettled([checkUpdate(), refreshSessions()]), cap]);
          popMenu();
        })();
      };
      tray.on('click', togglePanel);                    // the panel; the native menu stays on right-click
      tray.on('right-click', popMenuWhenReady);
    }

    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
    app.on('second-instance', () => showPairWindow());              // a second launch asks this one to show the pairing window
    app.on('before-quit', () => { quitting = true; relay?.stop().catch(() => {}); });

    // The old integrated copy holds the phone connection for itself (same settings, same paired
    // phones, same port). Ask before the relay starts, so the user never sees a port error first.
    enginePath = await findEngine();
    originalPath = await findOriginal();
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

    checkUpdate();
    setInterval(checkUpdate, UPDATE_CHECK_MS);
    setTimeout(checkReleaseOnce, RELEASE_CHECK_DELAY_MS);
    setInterval(checkReleaseOnce, RELEASE_CHECK_MS);
    refreshSessions();
    pollSessions();
    selfUpdater.start();

    // First run, or the Engine is gone: walk through setup.
    // Someone who already uses Zode (engine built, ZCode connected, a phone paired, e.g. coming from the old app)
    // has nothing to set up: do not greet them with the wizard.
    if (!settings.setupDone && enginePath && (relay?.listDevices().length ?? 0) > 0 && await tapAlive().catch(() => false)) { settings.setupDone = true; save(); }
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
