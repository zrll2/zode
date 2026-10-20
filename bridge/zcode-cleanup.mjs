#!/usr/bin/env node
// Tidy up after a task is fully done, so work-order conversations stop cluttering the ZCode sidebar and the phone list.
//   node zcode-cleanup.mjs --worktree W [--purge] [--dry-run]     every session whose directory is W
//   node zcode-cleanup.mjs --session sess_... [--purge] [--dry-run]
// ZCode has no agent command that deletes or archives a persisted session (`deleteSession` only closes it in memory),
// so this edits the agent's own database (~/.zcode/cli/db/db.sqlite, table `session`):
//   default  sets `time_archived` (what the ZCode Archive action sets; reversible, hidden from lists)
//   --purge  deletes the session row; messages and parts go with it (ON DELETE CASCADE). Not reversible.
// Run it only after the work is merged. Live sessions are stopped and closed first.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = k => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : undefined; };
const dry = process.argv.includes('--dry-run');
const DB = process.env.ZCODE_TASKS_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const q = sql => execFileSync('sqlite3', ['-cmd', '.timeout 8000', '-cmd', 'PRAGMA foreign_keys=ON;', '-separator', '\t', DB, sql], { encoding: 'utf8' }).trim();
const purge = process.argv.includes('--purge');
const lit = s => `'${String(s).replace(/'/g, "''")}'`;

let where;
if (arg('worktree')) { let wt = path.resolve(arg('worktree')); try { wt = fs.realpathSync(wt); } catch {} where = `directory = ${lit(wt)} OR directory = ${lit(path.resolve(arg('worktree')))}`; }
else if (arg('session')) where = `id = ${lit(arg('session'))}`;
else { console.error('usage: zcode-cleanup.mjs --worktree W | --session sess_... [--dry-run]'); process.exit(2); }

const rows = q(`SELECT id, title, ifnull(time_archived, 0) FROM session WHERE parent_id IS NULL AND (${where})`).split('\n').filter(Boolean).map(l => l.split('\t'));
const todo = purge ? rows : rows.filter(r => r[2] === '0');
console.log(`${rows.length} session(s) found, ${todo.length} to ${purge ? 'delete' : 'archive'}${dry ? ' (dry run)' : ''}`);
for (const [id, title] of todo) console.log(' ', id, '|', (title || '').slice(0, 50));
if (dry || !todo.length) process.exit(0);

// 1. Close in memory on every live ZCode server (a running turn is stopped first).
const dir = path.join(os.homedir(), '.zcode-tap');
const metas = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
for (const m of metas) for (const [id] of todo) await new Promise(done => {
  const c = net.connect(m.sock); c.on('error', () => done());
  c.on('connect', () => { c.write(JSON.stringify({ id: 1, method: 'session/stop', params: { sessionId: id } }) + '\n'); c.write(JSON.stringify({ id: 2, method: 'session/close', params: { sessionId: id } }) + '\n'); });
  setTimeout(() => { c.destroy(); done(); }, 600);
});

// 2. Archive (or delete) in the agent database. Subagent sessions (parent_id) follow their parent.
const ids = todo.map(r => lit(r[0])).join(',');
if (purge) q(`DELETE FROM session WHERE id IN (${ids}) OR parent_id IN (${ids})`);
else q(`UPDATE session SET time_archived = ${Date.now()} WHERE id IN (${ids}) OR parent_id IN (${ids})`);
console.log(purge ? 'deleted' : 'archived', todo.length, purge ? '.' : '. Restore from the ZCode sidebar (Archived) if needed.');

// 3. Forget the saved session id so the next order in this worktree starts a fresh conversation.
if (arg('worktree')) {
  const wt = path.resolve(arg('worktree'));
  const dirOf = path.dirname(wt);
  for (const f of fs.readdirSync(dirOf).filter(f => f.startsWith('.zcode-session-'))) {
    const p = path.join(dirOf, f); try { if (todo.some(r => fs.readFileSync(p, 'utf8').trim() === r[0])) fs.unlinkSync(p); } catch {}
  }
}
