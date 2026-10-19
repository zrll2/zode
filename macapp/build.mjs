// Bundle the Zode integration into dist/ (installed into Zode.app/Contents/Resources/zode).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'main.mjs')],                     // pulls in relay/service.mjs, qrcode and ws
  outfile: path.join(dist, 'zode-main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` },
});

const copyAll = (from, to) => {
  if (!fs.existsSync(from)) return;                               // assets/ appears when the tray icons are added
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
};
copyAll(path.join(root, 'pair'), path.join(dist, 'pair'));
copyAll(path.join(root, 'assets'), dist);                         // trayTemplate.png + trayTemplate@2x.png
fs.copyFileSync(path.join(root, 'preload.cjs'), path.join(dist, 'preload.cjs'));
fs.copyFileSync(path.join(root, 'boot.cjs'), path.join(dist, 'boot.cjs'));
console.log(`built ${dist}`);
