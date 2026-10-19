// Sits between ZCode desktop and the real `zcode.cjs app-server --stdio`.
// Desktop keeps working through stdio. Supervisors connect to a unix socket and
//   - receive a copy of every server line,
//   - send requests; their ids are rewritten to "tap:<client>:<id>" so they never clash with desktop ids,
//   - receive only the responses to their own requests.
// Server->client requests (permission, user input) are tracked as pending. The FIRST answer wins: desktop (stdin) or a supervisor
// (`tap/respond`). Later answers are dropped, and every tap is told with a `tap/resolved` notification.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.ZCODE_TAP_CLI;           // set by the shim that `zode install` puts into Zode.app
if (!CLI) { console.error('agent-wrapper: ZCODE_TAP_CLI is not set. Run `zode install`.'); process.exit(2); }
const DIR = path.join(os.homedir(), '.zcode-tap');
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
// macOS limits unix socket paths to about 104 bytes. Fall back to a short path under /tmp for deep home directories.
const sock = (() => { const p = path.join(DIR, `${process.pid}.sock`); if (Buffer.byteLength(p) < 100) return p; const d = `/tmp/zode-${process.getuid?.() ?? 0}`; fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return path.join(d, `${process.pid}.sock`); })();
const meta = path.join(DIR, `${process.pid}.json`);

const child = spawn(process.execPath, [CLI, ...process.argv.slice(2)], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'],
});
const cwdArg = (() => { const i = process.argv.indexOf('--cwd'); return i >= 0 ? process.argv[i + 1] : process.cwd(); })();

const clients = new Map(); let nextClient = 0;
const lines = (stream, cb) => { let b = ''; stream.on('data', d => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); if (l.trim()) cb(l); } }); };

const RESOLVABLE = new Set(['interaction/requestPermission', 'interaction/requestUserInput']);
const pendingReq = new Map();         // server request id -> {method, params, at}
const tapAnswered = new Set();        // ids a tap answered; the late desktop answer is dropped
const broadcast = o => { const l = JSON.stringify(o) + '\n'; for (const cl of clients.values()) cl.write(l); };
setInterval(() => { for (const [k, v] of pendingReq) if (Date.now() - v.at > 3600_000) pendingReq.delete(k); }, 60_000).unref();

// desktop -> server (inspect responses so the first answer wins)
lines(process.stdin, l => {
  let m = null; try { m = JSON.parse(l); } catch {}
  if (m && m.id !== undefined && !m.method && typeof m.id === 'string' && m.id.startsWith('server-')) {
    if (tapAnswered.delete(m.id)) return;                   // a tap answered first: drop the late desktop answer
    if (pendingReq.delete(m.id)) broadcast({ method: 'tap/resolved', params: { id: m.id, by: 'desktop' } });
  }
  child.stdin.write(l + '\n');
});
process.stdin.on('end', () => child.kill());

// server -> desktop (+ taps)
lines(child.stdout, l => {
  let m = null; try { m = JSON.parse(l); } catch {}
  const id = m && typeof m.id === 'string' && m.id.startsWith('tap:') && !m.method ? m.id : null;
  if (id) {                                              // response to a supervisor request
    const [, c, ...rest] = id.split(':'); const cl = clients.get(Number(c));
    if (cl) { m.id = JSON.parse(rest.join(':')); m.tapReply = true; cl.write(JSON.stringify(m) + '\n'); }
    return;
  }
  if (m && m.method && m.id !== undefined && RESOLVABLE.has(m.method)) pendingReq.set(m.id, { method: m.method, params: m.params, at: Date.now() });
  process.stdout.write(l + '\n');
  for (const cl of clients.values()) cl.write(l + '\n');  // copy for observation
});

const srv = net.createServer(cl => {
  const n = ++nextClient; clients.set(n, cl);
  lines(cl, l => {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (m.id === undefined || !m.method) return;           // supervisors may only send requests
    if (m.method.startsWith('tap/')) {                      // handled here, never forwarded
      const reply = r => cl.write(JSON.stringify({ id: m.id, tapReply: true, ...r }) + '\n');
      if (m.method === 'tap/pending') return reply({ result: { pending: [...pendingReq].map(([id, v]) => ({ id, method: v.method, params: v.params, at: v.at })) } });
      if (m.method === 'tap/respond') {
        const rid = m.params?.id; const body = m.params?.result;
        if (!pendingReq.has(rid)) return reply({ error: { code: -32010, message: 'not pending (already answered?)' } });
        if (!body || typeof body !== 'object') return reply({ error: { code: -32602, message: 'result object required' } });
        pendingReq.delete(rid); tapAnswered.add(rid);
        child.stdin.write(JSON.stringify({ id: rid, result: body }) + '\n');
        broadcast({ method: 'tap/resolved', params: { id: rid, by: `tap:${n}` } });
        return reply({ result: { ok: true } });
      }
      return reply({ error: { code: -32601, message: `unknown ${m.method}` } });
    }
    m.id = `tap:${n}:${JSON.stringify(m.id)}`;
    child.stdin.write(JSON.stringify(m) + '\n');
  });
  cl.on('close', () => clients.delete(n)); cl.on('error', () => clients.delete(n));
});
srv.on('error', e => console.error('agent-wrapper: tap socket disabled:', e.message));   // the tap must never break ZCode itself
try { fs.unlinkSync(sock); } catch {}
srv.listen(sock, () => { fs.chmodSync(sock, 0o600); fs.writeFileSync(meta, JSON.stringify({ pid: process.pid, sock, cwd: cwdArg, startedAt: Date.now() })); });

const cleanup = () => { try { fs.unlinkSync(sock); fs.unlinkSync(meta); } catch {} };
child.on('exit', c => { cleanup(); process.exit(c ?? 0); });
process.on('exit', cleanup); process.on('SIGTERM', () => { child.kill(); }); process.on('SIGINT', () => { child.kill(); });
