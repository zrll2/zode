// sessions: tap-server discovery from ~/.zcode-tap, the session/list round-trip against fake sockets,
// the status-light rules, and the summary that feeds the top of the tray menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readTapServers, listSessions, describeSession, summarize } from '../lib/sessions.mjs';

const NOW = 1_700_000_000_000;
const min = 60 * 1000;
const session = over => ({
  sessionId: 's1', title: 'Refactor the relay', status: 'running', createdAt: NOW, updatedAt: NOW,
  mode: 'code', sessionKind: 'interactive',
  workspace: { workspacePath: '/Users/o/Projects/zode', workspaceKey: 'zode' },
  ...over,
});

test('describeSession: every rule, with a fixed now', () => {
  assert.deepEqual(describeSession(session({ status: 'error', updatedAt: NOW - 99 * min }), NOW), { light: 'red', text: 'Failed' });
  assert.deepEqual(describeSession(session({ status: 'waiting', updatedAt: NOW - 90 * min }), NOW), { light: 'amber', text: 'Waiting for you' });
  assert.deepEqual(describeSession(session({ updatedAt: NOW - 4 * min }), NOW), { light: 'green', text: 'Working' });
  assert.deepEqual(describeSession(session({ updatedAt: NOW - 5 * min }), NOW), { light: 'green', text: 'Working' });     // 5 min exactly still counts as working
  assert.deepEqual(describeSession(session({ updatedAt: NOW - 5 * min - 1 }), NOW), { light: 'amber', text: 'Quiet for 5 min' });
  assert.deepEqual(describeSession(session({ updatedAt: NOW - 47 * min }), NOW), { light: 'amber', text: 'Quiet for 47 min' });
  assert.deepEqual(describeSession(session({ status: 'idle', updatedAt: NOW - 30 * 1000 }), NOW), { light: 'green', text: 'Done just now' });
  assert.deepEqual(describeSession(session({ status: 'idle', updatedAt: NOW - 90 * 1000 }), NOW), { light: 'green', text: 'Done 1 min ago' });
  assert.deepEqual(describeSession(session({ status: 'idle', updatedAt: NOW - 20 * min }), NOW), { light: 'green', text: 'Done 20 min ago' });
  assert.equal(describeSession(session({ status: 'idle', updatedAt: NOW - 20 * min - 1 }), NOW), null);                   // finished too long ago
  assert.equal(describeSession(session({ status: 'paused' }), NOW), null);
  assert.equal(describeSession(session({ status: undefined }), NOW), null);
  assert.equal(describeSession(null, NOW), null);
});

test('summarize: failed, waiting, working, done — each group newest first, six lines and +N more', () => {
  const sessions = [
    session({ sessionId: 'w2', status: 'waiting', updatedAt: NOW - 2 * min }),
    session({ sessionId: 'r1', updatedAt: NOW - min }),
    session({ sessionId: 'd1', status: 'idle', updatedAt: NOW - min }),
    session({ sessionId: 'f1', status: 'error', updatedAt: NOW - 3 * min, title: '#12 ship it' }),
    session({ sessionId: 'w3', status: 'running', updatedAt: NOW - 30 * min, title: 'Work order: fix login', workspace: { workspacePath: '', workspaceKey: '' } }),
    session({ sessionId: 'f2', status: 'error', updatedAt: NOW - 10 * min }),
    session({ sessionId: 'w1', status: 'waiting', updatedAt: NOW - min }),
    session({ sessionId: 'r2', updatedAt: NOW - 2 * min, workspace: { workspacePath: '', workspaceKey: '' } }),
    session({ sessionId: 'd2', status: 'idle', updatedAt: NOW - 2 * min }),
    session({ sessionId: 'x', status: 'paused' }),                                   // unknown status, never shown
    session({ sessionId: 'old', status: 'idle', updatedAt: NOW - 60 * min }),        // finished too long ago
  ];
  const s = summarize(sessions, NOW);
  assert.deepEqual(s.lines.map(l => l.id), ['f1', 'f2', 'w1', 'w2', 'w3', 'r1']);
  assert.deepEqual(s.lines.map(l => l.light), ['red', 'red', 'amber', 'amber', 'amber', 'green']);
  assert.equal(s.more, 3);                                                           // r2, d1 and d2 did not fit
  assert.deepEqual(s.counts, { working: 2, waiting: 3, failed: 2 });
  assert.equal(s.lines[0].label, 'zode — Failed');                                   // always project then status, even for a work-order title
  assert.equal(s.lines[4].label, 'No workspace — Quiet for 30 min');
  assert.equal(s.lines[5].label, 'zode — Working');
});

test('summarize: project from the workspace path, No workspace when empty, junk input shows nothing', () => {
  const s = summarize([
    session({ sessionId: 'p1', workspace: { workspacePath: '/a/b/', workspaceKey: '' } }),
    session({ sessionId: 'p2', status: 'idle', updatedAt: NOW - 30 * 1000, workspace: { workspacePath: '', workspaceKey: '' } }),
  ], NOW);
  assert.deepEqual(s.lines.map(l => l.label), ['b — Working', 'No workspace — Done just now']);
  assert.deepEqual(summarize([], NOW), { lines: [], more: 0, counts: { working: 0, waiting: 0, failed: 0 } });
  assert.deepEqual(summarize(undefined, NOW), { lines: [], more: 0, counts: { working: 0, waiting: 0, failed: 0 } });
  assert.deepEqual(summarize([null, 42, 'x'], NOW).lines, []);
});

test('readTapServers: live pids only; junk files, dead pids and bad metadata ignored', () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'zode-sessions-'));
  fs.writeFileSync(path.join(dir, '111.json'), JSON.stringify({ pid: process.pid, sock: '/tmp/zode-test-a.sock', cwd: '/w/a' }));
  fs.writeFileSync(path.join(dir, '222.json'), JSON.stringify({ pid: 2147483000, sock: '/tmp/zode-test-b.sock', cwd: '/w/b' }));  // no such process
  fs.writeFileSync(path.join(dir, '333.json'), 'not json');
  fs.writeFileSync(path.join(dir, '444.json'), JSON.stringify({ pid: process.pid }));                     // no socket
  fs.writeFileSync(path.join(dir, '555.json'), JSON.stringify({ pid: 'later', sock: '/tmp/zode-test-c.sock' }));
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'wrong extension');
  const servers = readTapServers(dir);
  assert.equal(servers.length, 1);
  assert.deepEqual(servers[0], { pid: process.pid, sock: '/tmp/zode-test-a.sock', cwd: '/w/a' });
  assert.deepEqual(readTapServers(path.join(dir, 'gone')), []);                                           // missing dir, never throws
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSessions: asks every server the one question, merges and dedupes by sessionId', async () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'zode-sessions-'));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: process.pid, sock: '/a', cwd: '/w' }));
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ pid: process.pid, sock: '/b', cwd: '/w' }));
  const asks = [];
  const connect = async (sock, request, timeoutMs) => {
    asks.push({ sock, request, timeoutMs });
    if (sock === '/a') return [
      'junk line',
      { method: 'session/update', params: {} },                                  // copied desktop traffic
      { tapReply: true, id: 7, result: { sessions: [] } },                       // not our reply
      { tapReply: true, id: 1, result: { sessions: [session({ sessionId: 's1', updatedAt: NOW }), session({ sessionId: 's2', updatedAt: NOW - min })] } },
    ];
    return [{ tapReply: true, id: 1, result: { sessions: [session({ sessionId: 's1', updatedAt: NOW - min })] } }];
  };
  const sessions = await listSessions({ dir, timeoutMs: 50, connect });
  assert.equal(asks.length, 2);
  assert.equal(asks[0].request, '{"id":1,"method":"session/list","params":{}}\n');
  assert.equal(asks[0].timeoutMs, 50);
  assert.deepEqual(sessions.map(s => s.sessionId).sort(), ['s1', 's2']);
  assert.equal(sessions.find(s => s.sessionId === 's1').updatedAt, NOW);         // the freshest copy of the shared session won
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSessions: a hanging server, a failing server and a weird reply cost nothing', async () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'zode-sessions-'));
  for (const [name, sock] of [['1.json', '/a'], ['2.json', '/b'], ['3.json', '/c']]) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid: process.pid, sock, cwd: '/w' }));
  }
  const connect = async sock => {
    if (sock === '/a') return new Promise(() => {});                             // never settles
    if (sock === '/b') throw new Error('ECONNREFUSED');
    return [{ tapReply: true, id: 1, result: { sessions: [session({ sessionId: 's9' })] } }, 'junk', 42];
  };
  const sessions = await listSessions({ dir, timeoutMs: 25, connect });
  assert.deepEqual(sessions.map(s => s.sessionId), ['s9']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSessions: no dir, no servers, or the real connector against a dead socket all give []', async () => {
  assert.deepEqual(await listSessions({ dir: '/tmp/zode-sessions-missing-dir', timeoutMs: 20 }), []);
  const empty = fs.mkdtempSync(path.join('/tmp', 'zode-sessions-'));
  let asked = 0;
  assert.deepEqual(await listSessions({ dir: empty, timeoutMs: 20, connect: async () => { asked += 1; return []; } }), []);
  assert.equal(asked, 0);                                                        // nothing live, nobody asked
  fs.rmSync(empty, { recursive: true, force: true });
  const dir = fs.mkdtempSync(path.join('/tmp', 'zode-sessions-'));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: process.pid, sock: '/tmp/zode-sessions-dead.sock', cwd: '/w' }));
  assert.deepEqual(await listSessions({ dir, timeoutMs: 250 }), []);             // real net.connect, refused, still []
  fs.rmSync(dir, { recursive: true, force: true });
});
