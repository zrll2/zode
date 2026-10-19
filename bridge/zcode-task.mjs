#!/usr/bin/env node
// Supervisor CLI: send one work order to ZCode (through zcode-mcp + ZCode-Tap), wait for the turn to end, print a summary.
//   node zcode-task.mjs --worktree W --order order.md [--session sess_...] [--mode edit|plan] [--events out.jsonl] [--timeout 1500]
// The session id is saved to <worktree>/../.zcode-session-<branch> so the next call can continue the same session.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const wt = path.resolve(arg('worktree')); const order = fs.readFileSync(arg('order'), 'utf8');
const mode = arg('mode', 'edit'); const timeout = Number(arg('timeout', 1500));
const branch = execFileSync('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
const sidFile = path.join(path.dirname(wt), `.zcode-session-${branch.replace(/\//g, '_')}`);
let sid = arg('session') ?? (fs.existsSync(sidFile) ? fs.readFileSync(sidFile, 'utf8').trim() : null);

const here = path.dirname(fileURLToPath(import.meta.url));
const p = spawn('node', [path.join(here, 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...(arg('events') ? { ZCODE_EVENT_LOG: path.resolve(arg('events')) } : {}) } });
const waiters = new Map(); let b = '', n = 0;
p.stdout.on('data', d => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const m = JSON.parse(b.slice(0, i)); b = b.slice(i + 1); waiters.get(m.id)?.(m); } });
const rpc = (method, params) => new Promise(r => { const id = ++n; waiters.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); const t = r.result?.content?.[0]?.text ?? JSON.stringify(r); try { return JSON.parse(t); } catch { return t; } };

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'zcode-task', version: '0' } });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

if (!sid) {
  const c = await tool('zcode_new', { worktree: wt, mode });
  sid = c.sessionId; if (!sid) { console.error('create failed', JSON.stringify(c).slice(0, 500)); process.exit(2); }
  fs.writeFileSync(sidFile, sid);
} else {
  const r = await tool('zcode_resume', { session: sid, worktree: wt });
  if (!r?.ok) console.error('resume failed:', JSON.stringify(r).slice(0, 300));
}
const sent = await tool('zcode_send', { session: sid, content: order });
if (!sent.response?.result?.accepted) { console.error('send failed', JSON.stringify(sent).slice(0, 500)); process.exit(3); }

let cursor = sent.since ?? 0, why = 'timeout', events = [];
const end = Date.now() + timeout * 1000;
while (Date.now() < end) {
  const w = await tool('zcode_wait', { session: sid, since: cursor, timeout_s: 30, max_events: 150 });
  events.push(...(w.events ?? [])); cursor = w.next ?? cursor;
  if (w.why === 'turn-end' || w.why === 'turn-failed' || w.why === 'approval-needed') { why = w.why; break; }
}
const payloads = events.map(e => e.p).join('\n');
let resp = [...payloads.matchAll(/"response":"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).pop();
if (!resp && arg('events') && fs.existsSync(arg('events'))) {
  for (const l of fs.readFileSync(arg('events'), 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(l); if (r.sessionId === sid && typeof r.msg?.params?.payload?.response === 'string') resp = JSON.stringify(r.msg.params.payload.response).slice(1, -1); } catch {}
  }
}
const err = payloads.match(/"message":"([^"]*)","det/)?.[1];
console.log(JSON.stringify({ session: sid, branch, ended: why, response: resp ? (() => { try { return JSON.parse(`"${resp}"`).slice(0, 4000); } catch { return resp.slice(0, 4000); } })() : null, error: why === 'turn-failed' ? err : undefined, events: events.length }, null, 1));
console.log('--- git status ---'); console.log(execFileSync('git', ['-C', wt, 'status', '--short'], { encoding: 'utf8' }));
p.kill(); process.exit(0);
