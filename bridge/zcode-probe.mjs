#!/usr/bin/env node
// One-shot health probe for a ZCode session.  node zcode-probe.mjs <sessionId> [--stall 300]
// Prints JSON: is a ZCode server alive, the session's status, and how long ago its last message/turn activity was.
// Exit code 0 healthy, 1 problem (no server, or a running turn silent for longer than --stall seconds).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const sid = process.argv[2]; if (!sid) { console.error('usage: zcode-probe.mjs <sessionId> [--stall 300]'); process.exit(2); }
const stallArg = process.argv.indexOf('--stall'); const stall = stallArg > 0 ? Number(process.argv[stallArg + 1]) : 300;
const dir = path.join(os.homedir(), '.zcode-tap');
let servers = 0;
try { for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) { try { process.kill(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).pid, 0); servers++; } catch {} } } catch {}
const DB = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const q = sql => execFileSync('sqlite3', ['-readonly', '-cmd', '.timeout 3000', '-separator', '\t', DB, sql], { encoding: 'utf8' }).trim();
const id = `'${sid.replace(/'/g, "''")}'`;
const turn = q(`SELECT status, started_at, ifnull(completed_at,0), model_request_count, tool_call_count FROM turn_usage WHERE session_id=${id} ORDER BY started_at DESC LIMIT 1`).split('\t');
const lastMsg = Number(q(`SELECT ifnull(max(time_updated),0) FROM message WHERE session_id=${id}`)) || 0;
const lastPart = Number(q(`SELECT ifnull(max(time_updated),0) FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id=${id})`)) || 0;
const last = Math.max(lastMsg, lastPart);
const idle = last ? Math.round((Date.now() - last) / 1000) : null;
const running = turn[0] === 'running';
const problems = [];
if (!servers) problems.push('no ZCode server running (Zode.app closed or killed)');
if (running && idle !== null && idle > stall) problems.push(`turn running but no new message for ${idle}s`);
console.log(JSON.stringify({ servers, turn: turn[0] || null, requests: Number(turn[3]) || 0, toolCalls: Number(turn[4]) || 0, idle_s: idle, healthy: problems.length === 0, problems }, null, 1));
process.exit(problems.length ? 1 : 0);
