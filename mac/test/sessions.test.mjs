// sessions: tap-server discovery from ~/.zcode-tap, the session/list round-trip against fake sockets,
// the status-light rules, and the summary that feeds the top of the tray menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readTapServers, listSessions, listPending, readUsage, describeSession, summarize, summarizeRequest, respondPermission, stopSession, sendToSession, nudgeSession, withLiveStatus, NUDGE_MESSAGE } from '../lib/sessions.mjs';
import { createLiveStatus } from '../../relay/live.mjs';

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
  assert.deepEqual(describeSession(session({ status: 'idle', updatedAt: NOW - 30 * 1000 }), NOW), { light: 'green', text: 'Just now', done: true, older: false });
  assert.deepEqual(describeSession(session({ status: 'idle', updatedAt: NOW - 90 * 1000 }), NOW), { light: 'green', text: '1 min ago', done: true, older: false });
  assert.deepEqual(describeSession(session({ status: 'idle', updatedAt: NOW - 20 * min }), NOW), { light: 'green', text: '20 min ago', done: true, older: false });
  assert.deepEqual(describeSession(session({ status: 'idle', updatedAt: NOW - 61 * min }), NOW), { light: 'green', text: '1 h ago', done: true, older: true });
  assert.deepEqual(describeSession(session({ status: 'idle', updatedAt: NOW - 179 * min }), NOW), { light: 'green', text: '2 h ago', done: true, older: true });
  assert.equal(describeSession(session({ status: 'idle', updatedAt: NOW - 180 * min - 1 }), NOW), null);                  // finished too long ago
  assert.equal(describeSession(session({ status: 'paused' }), NOW), null);
  assert.equal(describeSession(session({ status: undefined }), NOW), null);
  assert.equal(describeSession(null, NOW), null);
});

test('summarize: failed, waiting, working, done — each group newest first, everything shown, finished counted', () => {
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
    session({ sessionId: 'old', status: 'idle', updatedAt: NOW - 240 * min }),       // finished too long ago
  ];
  const s = summarize(sessions, NOW);
  assert.deepEqual(s.lines.map(l => l.id), ['f1', 'f2', 'w1', 'w2', 'w3', 'r1', 'r2', 'd1', 'd2']);   // all of them, no six-line cap any more
  assert.deepEqual(s.lines.map(l => l.light), ['red', 'red', 'amber', 'amber', 'amber', 'green', 'green', 'green', 'green']);
  assert.equal(s.more, 0);
  assert.equal(s.finished, 2);                                                       // d1 and d2
  assert.deepEqual(s.counts, { working: 2, waiting: 3, failed: 2 });
  assert.deepEqual([s.lines[0].project, s.lines[0].status], ['zode', 'Failed']);       // always the project, then the status, even for a work-order title
  assert.deepEqual([s.lines[4].project, s.lines[4].status], ['No workspace', 'Quiet for 30 min']);
  assert.deepEqual([s.lines[5].project, s.lines[5].status], ['zode', 'Working']);
});

test('summarize: project from the workspace path, No workspace when empty, junk input shows nothing', () => {
  const s = summarize([
    session({ sessionId: 'p1', workspace: { workspacePath: '/a/b/', workspaceKey: '' } }),
    session({ sessionId: 'p2', status: 'idle', updatedAt: NOW - 30 * 1000, workspace: { workspacePath: '', workspaceKey: '' } }),
  ], NOW);
  assert.deepEqual(s.lines.map(l => [l.project, l.status, l.done]), [['b', 'Working', false], ['No workspace', 'Just now', true]]);
  assert.deepEqual(summarize([], NOW), { lines: [], more: 0, finished: 0, counts: { working: 0, waiting: 0, failed: 0 } });
  assert.deepEqual(summarize(undefined, NOW), { lines: [], more: 0, finished: 0, counts: { working: 0, waiting: 0, failed: 0 } });
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
  assert.equal(sessions.find(s => s.sessionId === 's1').sock, '/a');             // and it remembers which socket it came from
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

test('summarize: caps at 16 lines and reports how many more', () => {
  const many = Array.from({ length: 20 }, (_, i) => session({ sessionId: 'r' + i, updatedAt: NOW - i * 1000 }));
  const s = summarize(many, NOW);
  assert.equal(s.lines.length, 16);
  assert.equal(s.more, 4);
});

test('summarize: every line names its sessionId and the socket it came from', () => {
  const s = summarize([session({ sessionId: 's1', sock: '/a' }), session({ sessionId: 's2', status: 'idle', updatedAt: NOW - min })], NOW);
  assert.deepEqual(s.lines.map(l => [l.sessionId, l.sock]), [['s1', '/a'], ['s2', '']]);
});

test('summarizeRequest: Run/Edit text, the 80-character cap, and the risky patterns (only at high risk)', () => {
  assert.deepEqual(summarizeRequest({ toolName: 'Bash', input: { command: 'git status' }, riskLevel: 'low' }),
    { text: 'Run: git status', detail: 'Run: git status', risky: false });
  assert.deepEqual(summarizeRequest({ toolName: 'Edit', input: { file_path: '/a/b/notes.md' }, riskLevel: 'medium' }),
    { text: 'Edit: notes.md', detail: 'Edit: notes.md', risky: false });
  assert.deepEqual(summarizeRequest({ toolName: 'WebFetch', input: { url: 'https://x' }, riskLevel: 'low' }),
    { text: 'WebFetch', detail: 'WebFetch', risky: false });
  const long = 'rm -rf ' + 'x'.repeat(200);
  const cut = summarizeRequest({ toolName: 'Bash', input: { command: long }, riskLevel: 'high' });
  assert.equal(cut.text.length, 80);                                            // never more than 80 chars
  assert.ok(cut.text.endsWith('…') && cut.text.startsWith('Run: rm -rf'));
  assert.equal(cut.detail, `Run: ${long}`);                                     // the dialog detail stays untruncated
  assert.equal(cut.risky, true);
  for (const bit of ['rm -rf', 'sudo', 'curl ', 'wget ', 'git push', 'npm publish', 'chmod', 'chown', 'dd ', 'mkfs', '> /dev/']) {
    assert.equal(summarizeRequest({ toolName: 'Bash', input: { command: `${bit} something` }, riskLevel: 'high' }).risky, true, bit);
  }
  assert.equal(summarizeRequest({ toolName: 'Bash', input: { command: 'sudo ls' }, riskLevel: 'medium' }).risky, false);   // only high risk
  assert.equal(summarizeRequest({ toolName: 'Bash', input: { command: 'curl.js run' }, riskLevel: 'high' }).risky, false); // 'curl ' needs the space
  assert.equal(summarizeRequest({}).text, 'Permission request');
  assert.equal(summarizeRequest(null).text, 'Permission request');
});

test('listPending: permissions and questions from every server, oldest first, sock remembered, failures ignored', async () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'zode-sessions-'));
  for (const [name, sock] of [['1.json', '/a'], ['2.json', '/b'], ['3.json', '/dead']]) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid: process.pid, sock, cwd: '/w' }));
  }
  const asks = [];
  const connect = async (sock, request) => {
    asks.push({ sock, request: JSON.parse(request) });
    if (sock === '/dead') throw new Error('ECONNREFUSED');
    if (sock === '/a') return [
      { tapReply: true, id: 1, result: { pending: [
        { id: 'server-2', method: 'interaction/requestUserInput', params: { sessionId: 'sq' }, at: 20 },           // a question, not a permission
        { id: 'server-1', method: 'interaction/requestPermission', params: { sessionId: 's1', toolName: 'Bash', input: { command: 'sudo rm -rf /tmp/x' }, riskLevel: 'high' }, at: 10 },
        { id: 'server-3', method: 'session/ping', params: {}, at: 5 },                                             // not a user request at all
      ] } },
    ];
    return [{ tapReply: true, id: 1, result: { pending: [{ id: 'server-1', method: 'interaction/requestPermission', params: { sessionId: 's2', toolName: 'Edit', input: { file_path: '/w/main.mjs' }, riskLevel: 'low' }, at: 30 }] } }];
  };
  const pending = await listPending({ dir, timeoutMs: 50, connect });
  assert.equal(asks.length, 3);
  assert.deepEqual(asks[0].request, { id: 1, method: 'tap/pending', params: {} });
  assert.deepEqual(pending.map(p => [p.requestId, p.kind, p.sock, p.sessionId]), [
    ['server-1', 'permission', '/a', 's1'],     // oldest first, across servers
    ['server-2', 'question', '/a', 'sq'],
    ['server-1', 'permission', '/b', 's2'],     // request ids are per wrapper: the same id on two sockets is two requests
  ]);
  assert.deepEqual(pending[0], { requestId: 'server-1', sessionId: 's1', kind: 'permission', toolName: 'Bash', summary: 'Run: sudo rm -rf /tmp/x', detail: 'Run: sudo rm -rf /tmp/x', risky: true, sock: '/a' });
  assert.deepEqual(pending[1], { requestId: 'server-2', sessionId: 'sq', kind: 'question', toolName: '', summary: '', detail: '', risky: false, sock: '/a' });
  assert.equal(pending[2].summary, 'Edit: main.mjs');
  assert.deepEqual(await listPending({ dir: '/tmp/zode-sessions-missing', timeoutMs: 20 }), []);   // no dir, never throws
  fs.rmSync(dir, { recursive: true, force: true });
});

test('respondPermission: one tap/respond line per decision; a late answer is just the error text', async () => {
  const seen = [];
  const connect = async (sock, request) => {
    seen.push({ sock, request: JSON.parse(request) });
    return [{ tapReply: true, id: 1, result: { ok: true } }];
  };
  assert.equal(await respondPermission({ sock: '/a', requestId: 'server-9', decision: 'allow', reason: 'Approved from the menu bar', connect }), null);
  assert.deepEqual(seen, [{ sock: '/a', request: { id: 1, method: 'tap/respond', params: { id: 'server-9', result: { decision: 'allow', reason: 'Approved from the menu bar' } } } }]);
  const answered = async () => [{ tapReply: true, id: 1, error: { code: -32010, message: 'not pending (already answered?)' } }];
  assert.equal(await respondPermission({ sock: '/a', requestId: 'server-9', decision: 'deny', reason: 'Denied from the menu bar', connect: answered }),
    'not pending (already answered?)');
  assert.equal(await respondPermission({ sock: '', requestId: 'server-9', decision: 'deny', connect }), null);   // no socket, no throw
});

test('stopSession and sendToSession: the session methods, refusals surfaced, junk tolerated', async () => {
  const seen = [];
  const connect = async (sock, request) => { seen.push(JSON.parse(request)); return [{ tapReply: true, id: 1, result: {} }]; };
  assert.equal(await stopSession({ sock: '/a', sessionId: 's1', connect }), null);
  assert.equal(await sendToSession({ sock: '/a', sessionId: 's1', content: 'hi', connect }), null);
  assert.deepEqual(seen, [
    { id: 1, method: 'session/stop', params: { sessionId: 's1' } },
    { id: 1, method: 'session/send', params: { sessionId: 's1', content: 'hi' } },
  ]);
  const refused = async () => [{ tapReply: true, id: 1, error: { code: -32000, message: 'no such session' } }];
  assert.equal(await stopSession({ sock: '/a', sessionId: 's1', connect: refused }), 'no such session');
  assert.equal(await sendToSession({ sock: '/a', sessionId: 's1', content: 'x', connect: async () => ['junk'] }), null);
});

test('nudgeSession: stop first, then the continue message, on the same socket', async () => {
  const seen = [];
  const connect = async (sock, request) => { seen.push([sock, JSON.parse(request)]); return [{ tapReply: true, id: 1, result: {} }]; };
  assert.equal(await nudgeSession({ sock: '/x', sessionId: 's1', connect, waitMs: 1 }), null);
  assert.deepEqual(seen, [
    ['/x', { id: 1, method: 'session/stop', params: { sessionId: 's1' } }],
    ['/x', { id: 1, method: 'session/send', params: { sessionId: 's1', content: NUDGE_MESSAGE } }],
  ]);
});

test('readUsage: week from the summary, today from the last heatmap day that matches the local date', async () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'zode-sessions-'));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: process.pid, sock: '/a', cwd: '/w' }));
  const now = new Date('2026-10-24T12:00:00');
  const connect = async (sock, request) => {
    assert.deepEqual(JSON.parse(request), { id: 1, method: 'usage/stats', params: { range: '7d' } });
    return [{ tapReply: true, id: 1, result: {
      summary: { totalTokens: 5810000000 },
      heatmap: { weeks: [{ days: [{ date: '2026-10-22', totalTokens: 5 }, null, { date: '2026-10-23', totalTokens: 100 }, { date: '2026-10-24', totalTokens: 172000000 }] }] },
    } }];
  };
  assert.deepEqual(await readUsage({ dir, timeoutMs: 50, connect, now }), { today: 172000000, week: 5810000000 });

  // the agent's last day is not the Mac's today (another time zone, or nothing yet today): today is 0
  const behind = async () => [{ tapReply: true, id: 1, result: {
    summary: { totalTokens: 42 },
    heatmap: { weeks: [{ days: [{ date: '2026-10-23', totalTokens: 100 }] }] },
  } }];
  assert.deepEqual(await readUsage({ dir, timeoutMs: 50, connect: behind, now }), { today: 0, week: 42 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readUsage: hangs and garble are skipped, the first usable answer wins, nothing at all gives null', async () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'zode-sessions-'));
  for (const [name, sock] of [['1.json', '/a'], ['2.json', '/b'], ['3.json', '/c']]) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid: process.pid, sock, cwd: '/w' }));
  }
  const now = new Date('2026-10-24T12:00:00');
  const asked = [];
  const connect = async (sock) => {
    asked.push(sock);
    if (sock === '/a') return new Promise(() => {});                     // never answers: its deadline drops it
    if (sock === '/b') return [{ tapReply: true, id: 1, result: { nonsense: true } }];
    return [{ tapReply: true, id: 1, result: { summary: { totalTokens: 7 }, heatmap: { weeks: [{ days: [null, { date: '2026-10-24', totalTokens: 3 }] }] } } }];
  };
  assert.deepEqual(await readUsage({ dir, timeoutMs: 30, connect, now }), { today: 3, week: 7 });
  assert.equal(asked.length, 3);                                         // every server was asked, in parallel
  const garbage = async () => [{ tapReply: true, id: 1, result: { summary: {} } }];
  assert.equal(await readUsage({ dir, timeoutMs: 30, connect: garbage, now }), null);
  assert.equal(await readUsage({ dir: '/tmp/zode-sessions-missing', timeoutMs: 20, connect, now }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the live running status -------------------------------------------------------------------

const startedMsg = sessionId => ({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId, patch: { status: 'running' }, reason: 'prompt_started', revision: 1 } });
const completedMsg = sessionId => ({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId, patch: {}, reason: 'prompt_completed', revision: 2 } });
const eventMsg = sessionId => ({ method: 'session/event', params: { sessionId } });

test('withLiveStatus: no relay, no tracker, or a throwing apply all leave the list alone', () => {
  const rows = [session({ sessionId: 's1', status: 'idle', updatedAt: NOW - min })];
  assert.deepEqual(withLiveStatus(rows, null), rows);
  assert.deepEqual(withLiveStatus(rows, undefined), rows);
  assert.deepEqual(withLiveStatus(rows, {}), rows);                                   // no apply method
  assert.deepEqual(withLiveStatus(rows, { apply: () => { throw new Error('boom'); } }), rows);
  assert.deepEqual(withLiveStatus(undefined, null), []);
  assert.deepEqual(withLiveStatus(undefined, { apply: v => v }), []);
});

test('withLiveStatus: a running turn shows Working even though the list says idle with an old time', () => {
  let t = NOW;
  const live = createLiveStatus({ now: () => t });
  live.observe(startedMsg('s1'));
  const rows = [session({ sessionId: 's1', status: 'idle', updatedAt: NOW - 40 * min })];
  const applied = withLiveStatus(rows, live);
  assert.notEqual(applied, rows);
  assert.equal(applied[0].status, 'running');
  assert.equal(applied[0].updatedAt, NOW);                                            // bumped to the tracker's last event time
  const s = summarize(applied, NOW);
  assert.deepEqual(s.counts, { working: 1, waiting: 0, failed: 0 });
  assert.deepEqual([s.lines[0].status, s.lines[0].light], ['Working', 'green']);
});

test('withLiveStatus: quiet minutes only count when events really stop; a settled turn hands the list back', () => {
  let t = NOW;
  const live = createLiveStatus({ now: () => t });
  live.observe(startedMsg('s1'));
  const rows = [session({ sessionId: 's1', status: 'idle', updatedAt: NOW - 40 * min })];
  for (let i = 1; i <= 6; i++) { t = NOW + i * 60_000; live.observe(eventMsg('s1')); }   // events keep the turn fresh
  const applied = withLiveStatus(rows, live);
  assert.equal(applied[0].updatedAt, NOW + 6 * 60_000);
  assert.deepEqual(describeSession(applied[0], NOW + 6 * 60_000), { light: 'green', text: 'Working' });
  t = NOW + 6 * 60_000 + 121_000;                                                     // events stop: the mark expires
  assert.deepEqual(withLiveStatus(rows, live), rows);
  t += 60_000;
  live.observe(completedMsg('s1'));                                                   // an explicit settle: the list's object stands
  assert.deepEqual(withLiveStatus(rows, live), rows);
});

test('withLiveStatus: an open permission request shows Waiting for you', () => {
  const live = createLiveStatus({ now: () => NOW });
  live.setPending([{ sessionId: 's1', method: 'interaction/requestPermission' }]);
  const rows = [session({ sessionId: 's1', status: 'idle', updatedAt: NOW - min })];
  const s = summarize(withLiveStatus(rows, live), NOW);
  assert.deepEqual([s.lines[0].status, s.lines[0].light], ['Waiting for you', 'amber']);
});
