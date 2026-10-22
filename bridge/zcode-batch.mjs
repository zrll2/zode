#!/usr/bin/env node
// Run several work orders in parallel, each in its own worktree, and report progress every 5 minutes.
//   node zcode-batch.mjs --plan plan.json [--max-parallel 3] [--heartbeat 300] [--stall 300] [--out batch.json]
// plan.json: [ { "name": "relay-tests", "worktree": "/path/proj-a-wt", "order": "/path/a.md", "reasoning": "low" }, ... ]
// Rules (the skill explains why): one worktree and one branch per entry, orders must touch DIFFERENT files, merge one by one afterwards.
// Output: a progress block on stdout every --heartbeat seconds (and when any task ends), then one JSON summary at the end.
// Each task is a normal zcode-task.mjs run, so permission prompts are answered by policy, stalls are detected, and every
// task writes its own events file next to --out (or in the temp dir).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const planFile = arg('plan'); if (!planFile) { console.error('usage: zcode-batch.mjs --plan plan.json [--max-parallel 3] [--heartbeat 300] [--stall 300] [--out batch.json]'); process.exit(2); }
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const maxPar = Math.max(1, Number(arg('max-parallel', 3))), beatMs = Number(arg('heartbeat', 300)) * 1000, stall = arg('stall', '300');
const out = arg('out');
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-batch-'));

if (!Array.isArray(plan) || !plan.length) { console.error('plan must be a non-empty array'); process.exit(2); }
const names = new Set(), trees = new Set();
for (const e of plan) {
  if (!e.name || !e.worktree || !e.order) { console.error('every entry needs name, worktree and order'); process.exit(2); }
  if (names.has(e.name)) { console.error('duplicate name ' + e.name); process.exit(2); }
  const wt = path.resolve(e.worktree); if (trees.has(wt)) { console.error(`two entries use the same worktree ${wt}: parallel orders need separate worktrees`); process.exit(2); }
  names.add(e.name); trees.add(wt);
}

const state = plan.map(e => ({ ...e, state: 'queued', started: null, ended: null, beat: null, result: null, buf: '', err: '' }));
const mins = ms => Math.round(ms / 60000);
const line = s => {
  const run = s.started ? mins((s.ended ?? Date.now()) - s.started) : 0;
  const b = s.beat;
  const extra = s.state === 'running' && b ? ` · ${b.changed_files} files changed · idle ${b.idle_s ?? '?'}s${b.approvals ? ` · ${b.approvals} prompts answered` : ''}` : s.result ? ` · ended: ${s.result.ended}${s.result.response ? ' · ' + String(s.result.response).split('\n')[0].slice(0, 60) : ''}` : '';
  return `  ${s.state.padEnd(8)} ${s.name.padEnd(22)} ${String(run).padStart(3)} min${extra}`;
};
const report = (why) => {
  const c = k => state.filter(s => s.state === k).length;
  console.log(`[progress ${new Date().toISOString().slice(11, 19)}Z] ${why}: ${c('done')} done, ${c('running')} running, ${c('queued')} queued, ${c('problem')} need attention`);
  for (const s of state) console.log(line(s));
  if (out) try { fs.writeFileSync(out, JSON.stringify(state.map(({ buf, err, ...s }) => s), null, 1)); } catch {}
};

let next = 0, running = 0, finish;
const done = new Promise(r => { finish = r; });
function launch(s) {
  s.state = 'running'; s.started = Date.now(); running++;
  const args = [path.join(here, 'zcode-task.mjs'), '--worktree', s.worktree, '--order', s.order, '--stall', stall, '--heartbeat', String(Math.max(30, Number(arg('heartbeat', 300)))),
    '--events', path.join(tmp, s.name.replace(/[^\w.-]/g, '_') + '.events.jsonl'), '--timeout', String(arg('timeout', 1700)), ...(s.reasoning ? ['--reasoning', s.reasoning] : [])];
  const p = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => { s.buf += d; });
  p.stderr.on('data', d => {
    s.err += d; let i; while ((i = s.err.indexOf('\n')) >= 0) {
      const l = s.err.slice(0, i); s.err = s.err.slice(i + 1);
      const m = l.match(/^\[heartbeat\] (.*)$/); if (m) { try { s.beat = JSON.parse(m[1]); } catch {} }
    }
  });
  p.on('close', code => {
    s.ended = Date.now(); running--;
    const jsonEnd = s.buf.indexOf('\n--- git status ---'); const body = jsonEnd >= 0 ? s.buf.slice(0, jsonEnd) : s.buf;
    try { s.result = JSON.parse(body); } catch { s.result = { ended: code === 0 ? 'no-result' : 'crashed', error: s.buf.slice(-300) }; }
    s.state = s.result.ended === 'turn-end' ? 'done' : 'problem';
    report(`${s.name} ${s.state === 'done' ? 'finished' : 'needs attention (' + s.result.ended + ')'}`);
    pump();
  });
}
function pump() {
  while (running < maxPar && next < state.length) launch(state[next++]);
  if (!running && next >= state.length) finish();
}
const timer = setInterval(() => report('update'), beatMs);
report('started'); pump();
await done; clearInterval(timer);
report('all finished');
console.log(JSON.stringify(state.map(s => ({ name: s.name, worktree: s.worktree, ...s.result })), null, 1));
process.exit(state.some(s => s.state === 'problem') ? 1 : 0);
