#!/usr/bin/env node
// zcode-mcp: lets Claude Code drive ZCode's `app-server --stdio` (newline JSON, no "jsonrpc" key).
// Safety: only modes plan/edit/guarded; workspace must be a git worktree on a zcode/* branch.
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The Zode.app copy that `zode install` builds. Override with ZODE_TAP_APP.
const TAP_APP = process.env.ZODE_TAP_APP || [path.join(os.homedir(), 'Applications', 'Zode.app'), path.join(os.homedir(), 'Applications', 'ZCode-Tap.app')].find(p => fs.existsSync(p)) || path.join(os.homedir(), 'Applications', 'Zode.app');
const ELECTRON = path.join(TAP_APP, 'Contents', 'MacOS', 'ZCode');
const CLI = process.env.ZCODE_CLI || path.join(TAP_APP, 'Contents', 'Resources', 'glm', 'zcode.real.cjs');
const DEFAULT_MODEL = {
  providerId: process.env.ZCODE_PROVIDER_ID || 'account:zai-individual-coding-plan',
  modelId: process.env.ZCODE_MODEL_ID || 'GLM-5.3-Flash',
  options: { reasoningLevel: process.env.ZCODE_REASONING || 'max' },
};
const ALLOWED_MODES = ['plan', 'edit', 'guarded'];

// ---- stdio client ----------------------------------------------------------
let child = null, nextId = 0, buf = '';
const pending = new Map();           // id -> resolve
const events = new Map();            // sessionId -> [{seq, msg}]
const approvals = new Map();         // key -> {sessionId, requestId, method, params}
const raw = [];                      // ring of recent unattributed messages

let tapMode = false, writeLine = null;
function findTap() {                       // live wrapper sockets from agent-wrapper.mjs
  const dir = path.join(os.homedir(), '.zcode-tap');
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      .filter(m => { try { process.kill(m.pid, 0); return true; } catch { return false; } });
  } catch { return []; }
}
function feed(d) { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l); } }
function ensureServer(cwd) {
  if (child && !child.killed) return;
  const taps = process.env.ZCODE_NO_TAP ? [] : findTap();
  if (taps.length) {                       // attach to the desktop app's own (logged-in) server
    const t = taps.find(m => m.cwd === cwd) ?? taps[0];
    const sk = net.connect(t.sock); tapMode = true;
    child = { killed: false, kill() { sk.destroy(); } }; writeLine = l => sk.write(l);
    sk.on('data', feed); sk.on('close', () => { child = null; for (const r of pending.values()) r({ error: { message: 'tap closed' } }); pending.clear(); });
    sk.on('error', () => {});
    sk.once('connect', () => call('tap/pending', {}).then(r => { for (const p of r.result?.pending ?? []) { const key = `${p.params?.sessionId ?? 'x'}:${p.id}`; approvals.set(key, { key, sessionId: p.params?.sessionId, requestId: p.id, method: p.method, params: p.params }); push(p.params?.sessionId, { kind: 'approval-needed', key, method: p.method, params: p.params }); } }));
    return;
  }
  tapMode = false;
  child = spawn(ELECTRON, [CLI, 'app-server', '--stdio', '--cwd', cwd || HERE], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  writeLine = l => child.stdin.write(l);
  child.stderr.on('data', d => { raw.push({ stderr: String(d).slice(0, 500) }); raw.splice(0, Math.max(0, raw.length - 50)); });
  child.on('exit', () => { child = null; for (const r of pending.values()) r({ error: { message: 'server exited' } }); pending.clear(); });
  child.stdout.on('data', feed);
}
const tx = o => writeLine(JSON.stringify(o) + '\n');
function call(method, params, cwd) {
  ensureServer(cwd);
  return new Promise(res => { const id = ++nextId; pending.set(id, res); tx({ id, method, params }); });
}
function push(sessionId, msg) {
  if (process.env.ZCODE_EVENT_LOG) { try { fs.appendFileSync(process.env.ZCODE_EVENT_LOG, JSON.stringify({ sessionId, msg }) + '\n'); } catch {} }
  if (!sessionId) { raw.push(msg); raw.splice(0, Math.max(0, raw.length - 50)); return; }
  const a = events.get(sessionId) ?? []; events.set(sessionId, a);
  a.push({ seq: a.length, msg });
}
function onLine(l) {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === 'startup/storageState') return;
  if (m.id !== undefined && !m.method) {
    if (tapMode && !m.tapReply) return;      // copy of a desktop response
    pending.get(m.id)?.(m); pending.delete(m.id); return;
  }
  if (m.method === 'tap/resolved') {                            // someone answered (desktop, phone, or us)
    for (const [k, a] of approvals) if (a.requestId === m.params?.id) approvals.delete(k);
    return push(undefined, m);
  }
  if (m.method && m.id !== undefined && tapMode) {              // desktop also sees these; the first answer wins
    const sid = m.params?.sessionId; const key = `${sid ?? 'x'}:${m.id}`;
    if (m.method === 'interaction/requestPermission' || m.method === 'interaction/requestUserInput') {
      approvals.set(key, { key, sessionId: sid, requestId: m.id, method: m.method, params: m.params });
      push(sid, { kind: 'approval-needed', key, method: m.method, params: m.params });
    }
    return;
  }
  if (m.method && m.id !== undefined) {                       // server -> client request
    if (m.method === 'session/requestRuntimePreferences')
      return tx({ id: m.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' } });
    if (m.method === 'interaction/requestPermission' || m.method === 'interaction/requestUserInput') {
      const key = `${m.params?.sessionId ?? 'x'}:${m.id}`;
      approvals.set(key, { key, sessionId: m.params?.sessionId, requestId: m.id, method: m.method, params: m.params });
      return push(m.params?.sessionId, { kind: 'approval-needed', key, method: m.method, params: m.params });
    }
    return tx({ id: m.id, error: { code: -32601, message: 'unsupported by zcode-mcp' } });
  }
  push(m.params?.sessionId ?? m.params?.session?.sessionId, m);   // notification
}

// ---- helpers ---------------------------------------------------------------
function checkWorktree(wt) {
  const git = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' }).trim();
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch.startsWith('zcode/')) throw new Error(`refused: branch '${branch}' must be zcode/*`);
  const p = d => path.resolve(wt, d);
  if (p(git('rev-parse', '--git-dir')) === p(git('rev-parse', '--git-common-dir')))
    throw new Error('refused: main checkout, use a separate git worktree');
  return branch;
}
const text = o => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1).slice(0, 600000) }] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isTurnEnd = m => {
  const j = JSON.stringify(m).slice(0, 1500);
  return /turn\.terminal|turn-failed|turn-completed|turn_completed|turn-ended|turn_failed/i.test(j) || (m.method === 'state.updated' && m.params?.patch?.status === 'idle');
};
const sessionModel = new Map();

// ---- MCP tools -------------------------------------------------------------
const srv = new McpServer({ name: 'zcode-mcp', version: '0.1.0' });

srv.tool('zcode_sessions', 'List ZCode sessions (same store as the desktop app).', {}, async () => text((await call('session/list', {})).result ?? 'error'));

srv.tool('zcode_new', 'Create a ZCode session in a git worktree on a zcode/* branch.',
  { worktree: z.string(), mode: z.enum(['plan', 'edit', 'guarded']).default('guarded'), model_id: z.string().optional() },
  async ({ worktree, mode, model_id }) => {
    if (!ALLOWED_MODES.includes(mode)) return text('refused mode');
    const branch = checkWorktree(worktree);
    const model = { ...DEFAULT_MODEL, modelId: model_id ?? DEFAULT_MODEL.modelId };
    const r = await call('session/create', { workspace: { workspacePath: worktree, workspaceKey: worktree }, model, mode }, worktree);
    const sid = r.result?.sessionId ?? r.result?.session?.sessionId;
    if (sid) sessionModel.set(sid, model);
    if (sid) await call('session/subscribe', { sessionId: sid, deliveryKind: 'web-remote-replayable' });
    return text({ branch, sessionId: sid, response: r });
  });

srv.tool('zcode_resume', 'Re-attach to an existing session (after the MCP server restarted).',
  { session: z.string(), worktree: z.string(), model_id: z.string().optional() },
  async ({ session, worktree, model_id }) => {
    checkWorktree(worktree);
    sessionModel.set(session, { ...DEFAULT_MODEL, modelId: model_id ?? DEFAULT_MODEL.modelId });
    const r = await call('session/resume', { sessionId: session }, worktree);
    if (!r.error) await call('session/subscribe', { sessionId: session, deliveryKind: 'web-remote-replayable' });
    return text({ ok: !r.error, error: r.error?.message });
  });

srv.tool('zcode_send', 'Send a work order / follow-up to a session. Returns the event cursor to wait from.',
  { session: z.string(), content: z.string() },
  async ({ session, content }) => {
    const since = (events.get(session) ?? []).length;
    const r = await call('session/send', { sessionId: session, content, modelSelection: sessionModel.get(session) ?? DEFAULT_MODEL });
    return text({ since, response: r });
  });

srv.tool('zcode_wait', 'Block until the turn ends, an approval is needed, or timeout. Returns new events since cursor.',
  { session: z.string(), since: z.number().default(0), timeout_s: z.number().default(300), max_events: z.number().default(60) },
  async ({ session, since, timeout_s, max_events }) => {
    const end = Date.now() + timeout_s * 1000; let why = 'timeout';
    while (Date.now() < end) {
      const ev = (events.get(session) ?? []).slice(since);
      if (ev.some(e => e.msg.kind === 'approval-needed')) { why = 'approval-needed'; break; }
      if (ev.some(e => isTurnEnd(e.msg))) { why = ev.some(e => /turn-failed|turn_failed/.test(JSON.stringify(e.msg).slice(0, 1500))) ? 'turn-failed' : 'turn-end'; break; }
      await sleep(500);
    }
    const all = (events.get(session) ?? []).slice(since);
    const brief = e => ({ seq: e.seq, m: e.msg.method ?? e.msg.kind, p: JSON.stringify(e.msg.params ?? e.msg).replace(/"available":\[.*?\]\},/s, '').slice(0, 500) });
    return text({ why, next: since + all.length, total: all.length, events: all.slice(-max_events).map(brief) });
  });

srv.tool('zcode_events', 'Read raw events for a session from a cursor.',
  { session: z.string(), since: z.number().default(0), limit: z.number().default(100) },
  async ({ session, since, limit }) => text((events.get(session) ?? []).slice(since, since + limit)));

srv.tool('zcode_pending', 'List open approval / user-input requests.', {}, async () => text([...approvals.values()]));

srv.tool('zcode_approve', 'Answer a pending permission request: decision allow or deny. First answer wins (desktop, phone or this tool).',
  { key: z.string(), decision: z.enum(['allow', 'deny']), reason: z.string().max(500).optional() },
  async ({ key, decision, reason }) => {
    const a = approvals.get(key); if (!a) return text('no such pending request (already answered?)');
    if (a.method !== 'interaction/requestPermission') return text('only permission requests can be answered with this tool');
    const result = { decision, ...(reason ? { reason } : {}) };
    if (tapMode) {
      const r = await call('tap/respond', { id: a.requestId, result });
      if (r.error) return text({ error: r.error.message });
    } else tx({ id: a.requestId, result });
    approvals.delete(key);
    return text({ sent: result });
  });

srv.tool('zcode_stop', 'Stop the running turn of a session.', { session: z.string() },
  async ({ session }) => text(await call('session/stop', { sessionId: session })));

srv.tool('zcode_close', 'Close a session and kill the server if none remain.', { session: z.string() },
  async ({ session }) => text(await call('session/close', { sessionId: session })));

await srv.connect(new StdioServerTransport());
process.on('exit', () => child?.kill());
