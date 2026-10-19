#!/usr/bin/env node
// Scan a folder for personal data and files that must not be published.  node scripts/scan-secrets.mjs [dir]
// Extra patterns (names, project names, emails) go in a local, uncommitted file: ~/.zode-scan-denylist (one regex per line)
// or the file named by ZODE_SCAN_DENY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const SKIP_DIR = new Set(['.git', 'node_modules', '.expo', 'dist', 'build']);
const MAX_BYTES = 5 * 1024 * 1024;

const generic = [
  ['home path', /\/(Users|home)\/(?!demo\b|me\b|you\b|user\b|example\b|runner\b)[A-Za-z0-9._-]+\//g],
  ['email', /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|example\.(com|org)|anthropic\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['api key', /\b(sk|pk)-[A-Za-z0-9_-]{20,}\b/g],
  ['aws key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./g],
  ['secret assignment', /\b(api[_-]?key|secret|token|password)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_-]{16,}["']/gi],
  ['real session id', /\bsess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/g],
  ['private ip', /\b(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)\b/g],
];
const deny = [];
for (const f of [process.env.ZODE_SCAN_DENY, path.join(os.homedir(), '.zode-scan-denylist')].filter(Boolean)) {
  try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l.trim() && !l.startsWith('#')) deny.push(['denylist', new RegExp(l.trim(), 'gi')]); } catch {}
}
const badName = /(^|\/)(zcode(\.real)?\.cjs|.*\.asar|.*\.events\.jsonl|\.zcode-session-.*|credentials\.json|\.env(\..*)?)$/;

let findings = 0, files = 0;
function report(file, line, kind, text) { findings++; console.log(`${path.relative(root, file)}:${line}  [${kind}]  ${text.slice(0, 100)}`); }
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.isFile()) continue;
    files++;
    const rel = path.relative(root, p);
    const size = fs.statSync(p).size;
    if (badName.test(rel)) report(p, 0, 'forbidden file', rel);
    if (size > MAX_BYTES) report(p, 0, 'file over 5 MB', `${(size / 1048576).toFixed(1)} MB`);
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|lockb?)$/i.test(p) || path.basename(p) === 'package-lock.json' || size > MAX_BYTES) continue;
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    text.split('\n').forEach((line, i) => {
      for (const [kind, re] of [...generic, ...deny]) { re.lastIndex = 0; const m = re.exec(line); if (m) report(p, i + 1, kind, m[0]); }
    });
  }
}
walk(root);
console.log(`\nScanned ${files} files in ${root}.`);
console.log(findings ? `${findings} finding(s). Fix them before you publish.` : 'No findings.');
if (!deny.length) console.log('Note: no personal denylist loaded (~/.zode-scan-denylist). Add your name, email and project names there.');
process.exit(findings ? 1 : 0);
