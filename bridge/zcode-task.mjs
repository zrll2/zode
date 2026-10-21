#!/usr/bin/env node
// Supervisor CLI: send one work order to ZCode (through zcode-mcp + Zode.app), wait for the turn to end, print a summary.
//   node zcode-task.mjs --worktree W --order order.md [--session sess_...] [--mode edit|plan] [--events out.jsonl] [--timeout 1500] [--stall 300] [--heartbeat 300] [--max-denials 8] [--reasoning low|high|max]
// Permission prompts are answered automatically (approval-policy.mjs): read-only commands allowed, everything else denied with a
// reason that sends ZCode back to its file tools. More than --max-denials denials, or a question for a human, ends with approval-needed.
// ended = turn-end | turn-failed | approval-needed | stalled (no event for --stall s) | zcode-gone | disconnected | timeout
// The session id is saved to <worktree>/../.zcode-session-<branch> so the next call can continue the same session.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decidePermission } from './approval-policy.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const wt = path.resolve(arg('worktree')); const order = fs.readFileSync(arg('order'), 'utf8');
const mode = arg('mode', 'edit'); const timeout = Number(arg('timeout', 1500)); const stall = Number(arg('stall', 300)); const beatEvery = Number(arg('heartbeat', 300)) * 1000; const reasoning = arg('reasoning');
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
const sent = await tool('zcode_send', { session: sid, content: order, ...(reasoning ? { reasoning } : {}) });
if (!sent.response?.result?.accepted) { console.error('send failed', JSON.stringify(sent).slice(0, 500)); process.exit(3); }

let cursor = sent.since ?? 0, why = 'timeout', events = [], idle, lastBeat = Date.now(), tools = 0;
const t0 = Date.now(); let denied = 0, steers = 0; const denials = new Map(); const maxDenied = Number(arg('max-denials', 8)); const approvals = [];
const end = Date.now() + timeout * 1000;
outer: while (Date.now() < end) {
  const w = await tool('zcode_wait', { session: sid, since: cursor, timeout_s: 30, max_events: 150, stall_s: stall });
  events.push(...(w.events ?? [])); cursor = w.next ?? cursor;
  tools += (w.events ?? []).filter(e => /tool/i.test(e.p ?? '') && /"(toolName|tool_call|toolCall)/.test(e.p ?? '')).length;
  if (Date.now() - lastBeat >= beatEvery) {                 // probe every 5 min: stderr line + <events>.heartbeat.json
    lastBeat = Date.now();
    const list = await tool('zcode_sessions', {}); const me = (list?.sessions ?? []).find(x => x.sessionId === sid);
    const beat = { at: new Date().toISOString(), elapsed_min: Math.round((Date.now() - t0) / 60000), events: events.length, idle_s: w.idle_s, agent_status: me?.status ?? 'unknown', last: events.at(-1)?.m ?? null };
    console.error('[heartbeat] ' + JSON.stringify(beat));
    if (arg('events')) try { fs.writeFileSync(path.resolve(arg('events')).replace(/\.jsonl$/, '') + '.heartbeat.json', JSON.stringify(beat)); } catch {}
  }
  if (w.why === 'approval-needed') {                       // never hang on a human: answer by policy (approval-policy.mjs), then keep waiting
    const pend = (await tool('zcode_pending', {}) ?? []).filter(a => a.sessionId === sid);
    if (!pend.length) continue;                              // answered elsewhere (the desktop window)
    let escalate = false;
    for (const a of pend) {
      if (a.method !== 'interaction/requestPermission') { escalate = true; continue; }     // a question for a human: report it
      const v = decidePermission(a.params, wt);
      if (v.decision === 'deny' && ++denied > maxDenied) { escalate = true; break; }
      const what = String(a.params?.input?.command ?? a.params?.input?.file_path ?? a.method);
      if (v.decision === 'deny') {
        const again = (denials.get(what) ?? 0) + 1; denials.set(what, again);
        if (again >= 2 && steers < 2) {                   // the model keeps retrying a denied command: interrupt the turn and tell it plainly
          steers++;
          await tool('zcode_approve', { key: a.key, decision: 'deny', reason: v.reason });
          await new Promise(r => setTimeout(r, 1500));
          await tool('zcode_stop', { session: sid });
          await new Promise(r => setTimeout(r, 2500));
          const s2 = await tool('zcode_send', { session: sid, content: `You are not allowed to run \`${what.slice(0, 200)}\` or any other command in this session; it was denied ${again} times. Skip every step that needs a command and note in your final reply what you could not check. Do NOT call Bash again. Continue the original order with the file tools only (Read, Edit, Write, Grep, Glob), then reply with the single line the order asked for.`, ...(reasoning ? { reasoning } : {}) });
          cursor = s2.since ?? cursor; console.error('[approval] steered: stopped the turn and told ZCode to continue without commands');
          approvals.push({ decision: 'steer', what: what.slice(0, 200) });
          continue outer;
        }
      }
      await tool('zcode_approve', { key: a.key, decision: v.decision, reason: v.reason });
      console.error(`[approval] ${v.decision} ${String(a.params?.input?.command ?? a.params?.input?.file_path ?? a.method).replace(/\s+/g, ' ').slice(0, 120)}`);
      approvals.push({ decision: v.decision, what: String(a.params?.input?.command ?? a.params?.input?.file_path ?? a.method).slice(0, 200) });
    }
    if (escalate) { why = 'approval-needed'; break; }
    continue;
  }
  if (w.why === 'turn-end' || w.why === 'turn-failed' || w.why === 'stalled' || w.why === 'zcode-gone' || w.why === 'disconnected') { why = w.why; idle = w.idle_s; break; }
}
const payloads = events.map(e => e.p).join('\n');
let resp = [...payloads.matchAll(/"response":"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).pop();
if (!resp && arg('events') && fs.existsSync(arg('events'))) {
  for (const l of fs.readFileSync(arg('events'), 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(l); if (r.sessionId === sid && typeof r.msg?.params?.payload?.response === 'string') resp = JSON.stringify(r.msg.params.payload.response).slice(1, -1); } catch {}
  }
}
const err = payloads.match(/"message":"([^"]*)","det/)?.[1];
console.log(JSON.stringify({ session: sid, branch, ended: why, response: resp ? (() => { try { return JSON.parse(`"${resp}"`).slice(0, 4000); } catch { return resp.slice(0, 4000); } })() : null, error: why === 'turn-failed' ? err : undefined, idle_s: idle, hint: ['stalled', 'zcode-gone', 'disconnected'].includes(why) ? 'ZCode produced no events for ' + idle + 's. Check Zode.app is running (zode doctor), stop the session with zcode-stop.mjs, and resend.' : undefined, events: events.length, auto_approvals: approvals.length ? approvals : undefined }, null, 1));
console.log('--- git status ---'); console.log(execFileSync('git', ['-C', wt, 'status', '--short'], { encoding: 'utf8' }));
p.kill(); process.exit(0);
