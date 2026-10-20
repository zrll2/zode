// Electron runs this instead of the original main (the patched package.json points here). It
// schedules the Zode integration without delaying ZCode, then loads the original ZCode entry.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const appendLog = (msg) => {
  try {
    const f = path.join(os.homedir(), '.zode', 'zode-app.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};

// ZCode's in-app updater cannot finish in this copy: Squirrel.Mac only swaps the app when the new
// bundle's code signature matches the running one, and Zode.app is re-signed ad hoc. So it would
// download the whole update and then fail silently at install (and a successful swap would replace
// Zode.app with a plain ZCode anyway). The bundle has no off switch, but it takes its feed URL from
// ZCODE_UPDATE_FEED_URL, so point it at a local port that refuses connections: a check fails at once
// and nothing is downloaded. Update the original ZCode.app instead; the tray then offers "Rebuild
// Zode…". ZODE_KEEP_UPDATER=1 (like ZODE_OFF=1, or a feed URL of your own) leaves ZCode as it is.
function disableInAppUpdater() {
  if (process.env.ZODE_OFF === '1' || process.env.ZODE_KEEP_UPDATER === '1' || process.env.ZCODE_UPDATE_FEED_URL) return;
  process.env.ZCODE_UPDATE_FEED_URL = 'http://127.0.0.1:9/zode-updater-disabled';
  appendLog('zode: ZCode in-app updater switched off (feed set to http://127.0.0.1:9, which refuses connections): update the original ZCode.app, then "Rebuild Zode…" from the menu bar. ZODE_KEEP_UPDATER=1 keeps it on.');
}

async function main() {
  try { disableInAppUpdater(); } catch (err) { appendLog(`zode: ${err && err.stack || err}`); }
  // (1) The Zode integration: never awaited, never fatal. ZODE_OFF=1 turns it off.
  if (process.env.ZODE_OFF !== '1') {
    try {
      if (fs.existsSync(path.join(__dirname, 'zode-main.mjs'))) {
        const { startZode } = await import('./zode-main.mjs');
        startZode({ electron: require('electron'), resourcesDir: __dirname })
          .catch((err) => appendLog(`zode: ${err && err.stack || err}`));
      }
    } catch (err) { appendLog(`zode: ${err && err.stack || err}`); }
  }
  // (2) The original ZCode main. Awaiting it here keeps the original startup order; require()
  //     of boot.cjs itself returns immediately, so ZCode is not delayed.
  return import(pathToFileURL(path.join(process.resourcesPath, 'app.asar', 'out', 'main', 'index.js')).href);
}

main().catch((err) => { appendLog(`zode: ZCode failed to start: ${err && err.stack || err}`); throw err; });
