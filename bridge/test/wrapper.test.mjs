// The tee wrapper: the first answer to a permission request wins (desktop or a tap client); other requests pass through untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('first answer wins; late answers are dropped; other requests pass through', async () => {
  const home = fs.mkdtempSync(path.join('/tmp', 'zode-test-'));
  const log = path.join(home, 'stub.log'); fs.writeFileSync(log, '');
  const wrapper = spawn(process.execPath, [path.join(here, '..', 'agent-wrapper.mjs'), 'x'], {
    env: { ...process.env, HOME: home, ZCODE_TAP_CLI: path.join(here, 'stub-agent.mjs'), STUB_LOG: log },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    await sleep(1500);
    const dir = path.join(home, '.zcode-tap');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json'))), 'utf8'));
    const tap = net.connect(meta.sock); const got = []; let buf = '';
    tap.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    await new Promise((r) => tap.on('connect', r));
    const call = (id, method, params) => tap.write(JSON.stringify({ id, method, params }) + '\n');
    await sleep(300);

    call(1, 'tap/pending', {}); await sleep(300);
    const pending = got.find((g) => g.tapReply && g.id === 1).result.pending.map((p) => p.id);
    assert.deepEqual(pending, ['server-1', 'server-3']);             // the ordinary request is not tracked

    call(2, 'tap/respond', { id: 'server-1', result: { decision: 'allow' } }); await sleep(300);
    wrapper.stdin.write(JSON.stringify({ id: 'server-1', result: { decision: 'deny' } }) + '\n'); await sleep(300);
    assert.equal(got.find((g) => g.tapReply && g.id === 2).result.ok, true);
    assert.ok(got.some((g) => g.method === 'tap/resolved' && g.params.id === 'server-1' && g.params.by.startsWith('tap:')));

    wrapper.stdin.write(JSON.stringify({ id: 'server-3', result: { decision: 'allow' } }) + '\n'); await sleep(300);
    call(3, 'tap/respond', { id: 'server-3', result: { decision: 'deny' } }); await sleep(300);
    assert.match(got.find((g) => g.tapReply && g.id === 3).error.message, /not pending/);
    assert.ok(got.some((g) => g.method === 'tap/resolved' && g.params.id === 'server-3' && g.params.by === 'desktop'));

    wrapper.stdin.write(JSON.stringify({ id: 'server-2', result: { nativeSearchEnhancementsEnabled: false } }) + '\n'); await sleep(300);
    const received = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(received.map((l) => [l.id, l.result.decision ?? 'prefs']), [['server-1', 'allow'], ['server-3', 'allow'], ['server-2', 'prefs']]);
    tap.destroy();
  } finally { wrapper.kill(); fs.rmSync(home, { recursive: true, force: true }); }
});
