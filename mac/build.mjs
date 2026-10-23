// Build the Zode app into dist/: one bundled main (relay, qrcode and ws inlined), the pairing
// window, the setup wizard, the menu bar panel, the preload bridge and the tray icons, plus a
// minimal package.json so `electron dist` runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'main.mjs')],                     // pulls in ../relay/service.mjs, qrcode and ws
  outfile: path.join(dist, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` },
});

const copyAll = (from, to) => {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
};
copyAll(path.join(root, 'pair'), path.join(dist, 'pair'));
copyAll(path.join(root, 'setup'), path.join(dist, 'setup'));
copyAll(path.join(root, 'panel'), path.join(dist, 'panel'));
// The tray icons are binary PNGs kept in assets/; until mac/assets exists, borrow macapp's copies.
copyAll(fs.existsSync(path.join(root, 'assets')) ? path.join(root, 'assets') : path.join(root, '..', 'macapp', 'assets'), path.join(dist, 'assets'));
fs.copyFileSync(path.join(root, 'preload.cjs'), path.join(dist, 'preload.cjs'));
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ name: 'zode-mac', version: '0.1.0', type: 'module', main: 'main.mjs' }, null, 2) + '\n');
console.log(`built ${dist}`);
