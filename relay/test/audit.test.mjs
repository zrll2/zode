// The approval audit log as a pure module: pair merge, first-wins, trimming, coercion, truncation,
// file mode, and the never-throw rule. File contents are checked as lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuditLog, OUTCOMES, ANSWERERS } from '../audit.mjs';

const tmp = () => fs.mkdtempSync(path.join('/tmp', 'audit-test-'));
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());

test('asked + decided merge into one row; an asked with no decision is pending', () => {
  const dir = tmp();
  try {
    const log = createAuditLog({ file: path.join(dir, 'a.jsonl'), now: () => 1000 });
    log.asked({ id: '1:r1', tool: 'Bash', summary: 'Run: npm test', risky: false, sessionId: 'sess_1' });
    assert.deepEqual(log.recent(10).map(r => ({ id: r.id, outcome: r.outcome })), [{ id: '1:r1', outcome: 'pending' }]);
    log.decided({ id: '1:r1', outcome: 'allowed', by: 'auto' });
    const [row] = log.recent(10);
    assert.deepEqual(row, { id: '1:r1', at: 1000, tool: 'Bash', summary: 'Run: npm test', risky: false, outcome: 'allowed', by: 'auto', device: null, askedAt: 1000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('duplicate asked and decided rows are ignored, in memory and from a reloaded file', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'a.jsonl');
    const log = createAuditLog({ file, now: () => 1 });
    log.asked({ id: '1:r1', tool: 'Bash', summary: 'one' });
    log.asked({ id: '1:r1', tool: 'Edit', summary: 'second wins nothing' });   // first wins
    log.decided({ id: '1:r1', outcome: 'allowed', by: 'auto' });
    log.decided({ id: '1:r1', outcome: 'rejected', by: 'phone' });
    assert.equal(readLines(file).length, 2);
    assert.deepEqual(log.recent().map(r => r.summary), ['one']);
    assert.deepEqual(log.recent().map(r => r.outcome), ['allowed']);
    // a fresh instance rebuilds the set from the file lazily and still keeps the first
    const again = createAuditLog({ file, now: () => 2 });
    again.asked({ id: '1:r1', tool: 'Edit', summary: 'late' });
    again.decided({ id: '1:r1', outcome: 'cancelled', by: 'none' });
    assert.equal(readLines(file).length, 2);
    assert.deepEqual(again.recent().map(r => r.outcome), ['allowed']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('summary is whitespace-collapsed and capped at 160, tool at 60', () => {
  const dir = tmp();
  try {
    const log = createAuditLog({ file: path.join(dir, 'a.jsonl') });
    log.asked({ id: '1:r1', tool: '  Bash\t\n with   spaces '.padEnd(100, 'x'), summary: `a  b\n\t c${' d'.repeat(200)}` });
    const [row] = log.recent();
    assert.equal(row.tool.length, 60);
    assert.ok(!row.tool.includes('\n'));
    assert.equal(row.summary.length, 160);
    assert.equal(row.summary, `a  b\n\t c${' d'.repeat(200)}`.replace(/\s+/g, ' ').trim().slice(0, 160));
    assert.ok(!readLines(path.join(dir, 'a.jsonl'))[0].includes('x'.repeat(61)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unknown outcome and answerer are coerced; missing device stays out of the row', () => {
  const dir = tmp();
  try {
    const log = createAuditLog({ file: path.join(dir, 'a.jsonl') });
    log.decided({ id: '1:r1', outcome: 'maybe', by: 'who-knows' });
    const [row] = log.recent();
    assert.deepEqual([row.outcome, row.by, row.device], ['unavailable', 'none', null]);
    log.decided({ id: '1:r2', outcome: 'rejected', by: 'phone', device: 'Richard iPhone' });
    assert.deepEqual([log.recent()[0].outcome, log.recent()[0].by, log.recent()[0].device], ['rejected', 'phone', 'Richard iPhone']);
    for (const o of OUTCOMES) log.decided({ id: `1:${o}`, outcome: o, by: 'auto' });
    for (const b of ANSWERERS) log.decided({ id: `1:${b}`, outcome: 'allowed', by: b });   // every listed value passes through
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('past maxLines the file is truncated to the newest half, atomically', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'a.jsonl');
    const log = createAuditLog({ file, maxLines: 10 });
    for (let i = 1; i <= 15; i++) log.asked({ id: `1:r${i}`, tool: 'Bash', summary: `n${i}` });
    const lines = readLines(file);
    assert.ok(lines.length <= 10, `${lines.length} lines after truncation`);
    const ids = lines.map(l => JSON.parse(l).id);
    assert.ok(!ids.includes('1:r1'));                                   // the oldest is gone
    assert.deepEqual(log.recent(3).map(r => r.id), ['1:r15', '1:r14', '1:r13']);   // newest first
    assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);   // no temp file left behind
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the file is created mode 0600', () => {
  const dir = tmp();
  try {
    const log = createAuditLog({ file: path.join(dir, 'nested', 'a.jsonl') });
    log.asked({ id: '1:r1', tool: 'Bash', summary: 'x' });
    const mode = fs.statSync(path.join(dir, 'nested', 'a.jsonl')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unwritable path never throws and recent() stays empty', () => {
  const dir = tmp();
  try {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'a file where a directory would be');
    const log = createAuditLog({ file: path.join(blocker, 'deep', 'a.jsonl') });
    assert.doesNotThrow(() => {
      log.asked({ id: '1:r1', tool: 'Bash', summary: 'x' });
      log.decided({ id: '1:r1', outcome: 'allowed', by: 'auto' });
      log.recent();
    });
    assert.deepEqual(log.recent(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recent() returns at most limit rows, newest first, across many ids', () => {
  const dir = tmp();
  try {
    let t = 0;
    const log = createAuditLog({ file: path.join(dir, 'a.jsonl'), now: () => ++t });
    for (let i = 1; i <= 5; i++) {
      log.asked({ id: `1:r${i}`, tool: 'Bash', summary: `n${i}` });
      log.decided({ id: `1:r${i}`, outcome: 'allowed', by: 'panel' });
    }
    const rows = log.recent(3);
    assert.deepEqual(rows.map(r => r.id), ['1:r5', '1:r4', '1:r3']);
    assert.deepEqual(rows.map(r => r.at), [10, 8, 6]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
