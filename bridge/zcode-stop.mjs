#!/usr/bin/env node
// Stop a running ZCode turn.  node zcode-stop.mjs <sessionId>
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const sid = process.argv[2]; if (!sid) { console.error('usage: zcode-stop.mjs <sessionId>'); process.exit(2); }
const dir = path.join(os.homedir(), '.zcode-tap');
const metas = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
let stopped = false;
for (const m of metas) {
  await new Promise(done => {
    const c = net.connect(m.sock); let b = '';
    c.on('data', x => { b += x; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); try { const o = JSON.parse(l); if (o.tapReply && !o.error) { stopped = true; console.log('stopped on', m.cwd); } } catch {} } });
    c.on('connect', () => c.write(JSON.stringify({ id: 1, method: 'session/stop', params: { sessionId: sid } }) + '\n'));
    c.on('error', () => {}); setTimeout(() => { c.destroy(); done(); }, 1200);
  });
}
console.log(stopped ? 'done' : 'session not active on any server');
process.exit(0);
