// Install (or remove) the Zode integration in a copy of ZCode.app:
//   node macapp/install.mjs [path to Zode.app] [--uninstall]
// Patches the asar's package.json main to ../zode/boot.cjs and copies dist/ into Contents/Resources/zode.
// It never signs; the caller re-signs afterwards (scripts/apply-app.sh does).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchMain, restoreMain } from './lib/asarpatch.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const NEW_MAIN = '../zode/boot.cjs';
const arg = process.argv.slice(2).find(a => !a.startsWith('--'));
const uninstall = process.argv.includes('--uninstall');
const appPath = path.resolve(arg || '/Applications/Zode.app');
const resources = path.join(appPath, 'Contents', 'Resources');
const asar = path.join(resources, 'app.asar');
const zodeDir = path.join(resources, 'zode');
const stamp = path.join(zodeDir, 'original-main.txt');

if (!fs.existsSync(asar)) { console.error(`No app.asar at ${asar} — is ${appPath} a ZCode copy?`); process.exit(1); }

if (uninstall) {
  let original = null;
  try { original = fs.readFileSync(stamp, 'utf8').trim(); } catch {}
  if (!original) { console.error(`Nothing to restore: ${stamp} is missing (not installed, or installed before this file existed).`); process.exit(1); }
  restoreMain(asar, original);
  for (const f of fs.readdirSync(zodeDir)) fs.rmSync(path.join(zodeDir, f), { recursive: true, force: true });
  console.log(`Restored app.asar main to "${original}" and cleared ${zodeDir}.`);
  console.log(`Re-sign the app: codesign --force --deep -s - "${appPath}"`);
  process.exit(0);
}

if (!fs.existsSync(path.join(root, 'dist', 'zode-main.mjs'))) {
  try { await import('./build.mjs'); }
  catch (err) { console.error(`Build failed: ${err.message}. Run \`npm install --prefix ${root}\` first.`); process.exit(1); }
}

fs.mkdirSync(zodeDir, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'dist'))) {
  fs.cpSync(path.join(root, 'dist', f), path.join(zodeDir, f), { recursive: true });
}

const { original, patched } = patchMain(asar, NEW_MAIN);
if (patched) fs.writeFileSync(stamp, original + '\n', { mode: 0o600 });
console.log(patched
  ? `Patched app.asar: main "${original}" -> "${NEW_MAIN}" (original kept in original-main.txt).`
  : `app.asar was already patched (main = "${NEW_MAIN}"); original-main.txt left as is.`);
console.log(`Installed the integration into ${zodeDir}.`);
console.log(`Re-sign the app: codesign --force --deep -s - "${appPath}"`);
