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

async function main() {
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
