// The app updating itself from GitHub Releases via electron-updater (packaged builds only; a
// development run skips everything). All electron-updater specifics are injected (an
// EventEmitter-shaped `updater`), so the state machine is testable without Electron. Nothing here
// throws; a failed check just retries on the next tick.

const START_DELAY_MS = 60 * 1000;                     // after launch; startup never waits on the network
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// One short plain sentence per known failure; electron-updater's own messages are long and technical.
export function shortError(text) {
  const t = String(text ?? '');
  if (/network|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch/i.test(t)) return 'Could not reach the update server. Try again later.';
  if (/404|not found|ENOENT|no latest/i.test(t)) return 'No update information was found for this release.';
  if (/signature|verify|checksum/i.test(t)) return 'The downloaded update failed its safety check.';
  return 'Something went wrong while looking for updates.';
}

export function createSelfUpdater({ updater, isPackaged = false, log = {}, now = Date.now, timers = {}, onReady } = {}) {
  const setTimeoutFn = timers.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const setIntervalFn = timers.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const state = { phase: 'idle', version: null, percent: null, checkedAt: null, error: null };
  let wired = false, started = false, notified = null, checkInFlight = null;

  // electron-updater calls logger.info/warn/error/debug; whatever the app passed in is optional.
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(k => [k, (...a) => { try { log[k]?.(...a); } catch { /* never */ } }]));

  const set = patch => { try { Object.assign(state, patch); } catch { /* never */ } };

  function wire() {
    if (wired) return;
    wired = true;
    try {
      updater.on('checking-for-update', () => set({ phase: 'checking' }));
      // autoDownload is on: an available update starts downloading at once.
      updater.on('update-available', info => set({ phase: 'downloading', version: (info && info.version) || null, percent: 0, error: null }));
      updater.on('update-not-available', () => set({ phase: 'idle', version: null, percent: null, error: null, checkedAt: now() }));
      updater.on('download-progress', p => set({ phase: 'downloading', percent: Math.max(0, Math.min(100, Math.round(Number(p && p.percent) || 0))) }));
      updater.on('update-downloaded', info => {
        const v = (info && info.version) || state.version;
        set({ phase: 'ready', version: v, percent: 100, error: null, checkedAt: now() });
        if (v && v !== notified) {                      // one notification per version, never twice
          notified = v;
          try { onReady?.(v); } catch { /* the app logs its own failures */ }
        }
      });
      updater.on('error', err => set({ phase: 'error', error: shortError(err?.message ?? err) }));
    } catch { /* a broken updater stays idle */ }
  }

  async function checkNow() {
    if (!isPackaged) return { status: 'disabled' };
    wire();                                           // events first, so a manual check works before start() too
    if (state.phase === 'ready') return { status: 'ready', version: state.version };   // already downloaded: keep the menu stable, restart any time
    if (checkInFlight) return checkInFlight;          // never concurrent
    checkInFlight = (async () => {
      try {
        set({ phase: 'checking', error: null });
        await updater.checkForUpdates();              // the events above drive the state from here
        if (state.phase === 'ready') return { status: 'ready', version: state.version };
        if (state.phase === 'downloading') return { status: 'downloading', version: state.version };
        if (state.phase === 'error') return { status: 'error', error: state.error };
        return { status: 'up-to-date' };              // idle after update-not-available
      } catch (err) {
        set({ phase: 'error', error: shortError(err?.message ?? err) });
        try { log.error?.(`selfupdate: check failed: ${err?.message ?? err}`); } catch { /* never */ }
        return { status: 'error', error: state.error };
      } finally {
        set({ checkedAt: now() });
        checkInFlight = null;                         // the next check retries, also after an error
      }
    })();
    return checkInFlight;
  }

  function install() {
    if (state.phase !== 'ready') return;
    try { updater.quitAndInstall(); } catch (err) { try { log.error?.(`selfupdate: install: ${err?.message ?? err}`); } catch { /* never */ } }
  }

  function start() {
    if (!isPackaged || started) return;
    started = true;
    try {
      updater.autoDownload = true;                    // download in the background, offer the restart
      updater.autoInstallOnAppQuit = true;            // if the user never clicks, install on the next quit
      updater.allowPrerelease = false;
      updater.logger = logger;
      wire();
      const once = setTimeoutFn(() => { checkNow().catch(() => {}); }, START_DELAY_MS);
      once?.unref?.();
      const every = setIntervalFn(() => { checkNow().catch(() => {}); }, CHECK_INTERVAL_MS);
      every?.unref?.();
    } catch (err) {
      try { log.error?.(`selfupdate: start: ${err?.stack || err}`); } catch { /* never */ }
    }
  }

  if (isPackaged) wire();                             // listen from the start: an update can finish at any moment

  return { start, checkNow, install, getState: () => ({ ...state }) };
}
