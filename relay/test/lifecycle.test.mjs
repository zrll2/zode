// lifecycle: the permission request statechart — total and closed table, terminal absorption, the
// model-based replay through the real audit log, the safety invariants, and the illegal hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATES, EVENTS, TABLE, TERMINAL, step, outcomeOf, paths } from '../lifecycle.mjs';
import { createAuditLog } from '../audit.mjs';

const tmp = () => fs.mkdtempSync(path.join('/tmp', 'lifecycle-test-'));
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());

test('the table is total and closed; a terminal state ignores every event', () => {
  for (const state of STATES) {
    for (const event of EVENTS) {
      const { state: next, legal } = step(state, event);
      assert.ok(STATES.includes(next), `${state} + ${event} -> ${next}`);
      assert.equal(typeof legal, 'boolean');
      if (TERMINAL.includes(state)) {
        assert.equal(legal, false, `${state} + ${event}`);
        assert.equal(next, state);
      }
    }
  }
  // pending: every event is legal and lands where the table says
  for (const event of EVENTS) {
    assert.equal(step('pending', event).legal, true, event);
    assert.equal(step('pending', event).state, TABLE.pending[event], event);
  }
  assert.equal(step('pending', 'asked').state, 'pending');            // a repeated asked stays pending
});

test('step: unknown events, unknown states and junk are illegal and change nothing', () => {
  assert.deepEqual(step('pending', 'explode'), { state: 'pending', legal: false });
  assert.deepEqual(step('limbo', 'asked'), { state: 'limbo', legal: false });
  assert.deepEqual(step(undefined, 'asked'), { state: undefined, legal: false });
  assert.deepEqual(step('pending', undefined), { state: 'pending', legal: false });
});

test('outcomeOf: the audit outcome names, pending while undecided', () => {
  assert.equal(outcomeOf('pending'), 'pending');
  for (const s of TERMINAL) assert.equal(outcomeOf(s), s);
  assert.equal(outcomeOf('limbo'), 'pending');
  assert.equal(outcomeOf(undefined), 'pending');
});

test('paths: every sequence starts from pending and only follows legal moves', () => {
  const all = paths(4);
  assert.equal(all[0].length, 0);                                     // the empty sequence is the start
  assert.ok(all.length > 20);                                         // the model has real depth
  for (const seq of all) {
    assert.ok(seq.length <= 4);
    let state = 'pending';
    for (const event of seq) {
      const { state: next, legal } = step(state, event);
      assert.equal(legal, true, `${state} + ${event} in ${seq.join(' -> ')}`);
      state = next;
    }
  }
  // a terminal state ends every path that reaches it: no path continues past a decision
  for (const seq of all) {
    const end = seq.reduce((s, e) => step(s, e).state, 'pending');
    if (TERMINAL.includes(end)) {
      for (const longer of all) {
        if (longer.length > seq.length && longer.slice(0, seq.length).join() === seq.join()) {
          assert.fail(`a path continues past the terminal ${end}: ${longer.join(' -> ')}`);
        }
      }
    }
  }
});

test('model-based: every path of length <= 4 replays through the audit to the same outcome, one decided row', async () => {
  const dir = tmp();
  try {
    const DECIDE = {
      auto_allow_ok: { outcome: 'allowed', by: 'auto' },
      auto_allow_failed: { outcome: 'unavailable', by: 'auto' },
      phone_allow: { outcome: 'allowed', by: 'phone' },
      phone_deny: { outcome: 'rejected', by: 'phone' },
      phone_write_failed: { outcome: 'unavailable', by: 'none' },
      panel_allow: { outcome: 'allowed', by: 'panel' },
      panel_deny: { outcome: 'rejected', by: 'panel' },
      panel_write_failed: { outcome: 'unavailable', by: 'none' },
      vanished: { outcome: 'cancelled', by: 'none' },
    };
    let n = 0;
    for (const seq of paths(4)) {
      if (!seq.length) continue;                                       // the empty sequence writes nothing
      const id = `42:r${n}`;
      const file = path.join(dir, `p${n}.jsonl`);
      n += 1;
      const log = createAuditLog({ file, now: () => 1000 });
      let state = 'pending';
      for (const event of seq) {
        if (event === 'asked') log.asked({ id, tool: 'Bash', summary: 'Run: npm test', sessionId: 'sess_1' });
        else log.decided({ id, ...DECIDE[event] });
        state = step(state, event).state;
      }
      const [row] = log.recent(10);
      assert.equal(row.outcome, outcomeOf(state), seq.join(' -> '));   // the file agrees with the model
      const decided = readLines(file).filter(l => JSON.parse(l).e === 'decided');
      assert.ok(decided.length <= 1, `more than one decided row: ${seq.join(' -> ')}`);
      if (!seq.includes('asked')) continue;
      const [only] = readLines(file).filter(l => JSON.parse(l).e === 'asked');
      assert.equal(only !== undefined, true);                          // exactly one asked row when asked fired
      assert.equal(readLines(file).filter(l => JSON.parse(l).e === 'asked').length, 1);
    }
    assert.ok(n >= 20);                                                // the replay really covered the model
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('safety: a failed-before-allow path never ends allowed, and allowed always needs an allow', () => {
  const FAILED = ['auto_allow_failed', 'phone_write_failed', 'panel_write_failed'];
  const ALLOW = ['auto_allow_ok', 'phone_allow', 'panel_allow'];
  for (const seq of paths(4)) {
    const firstFailed = seq.findIndex(e => FAILED.includes(e));
    const firstAllow = seq.findIndex(e => ALLOW.includes(e));
    const end = outcomeOf(seq.reduce((s, e) => step(s, e).state, 'pending'));
    if (firstFailed >= 0 && (firstAllow < 0 || firstFailed < firstAllow)) {
      assert.notEqual(end, 'allowed', `failed before allow: ${seq.join(' -> ')}`);
    }
    if (end === 'allowed') {
      assert.ok(firstAllow >= 0, `allowed without an allow: ${seq.join(' -> ')}`);
      assert.ok(firstFailed < 0 || firstAllow < firstFailed, `allowed after a failed: ${seq.join(' -> ')}`);
    }
  }
});

test('onIllegal: fires once for a second decided, never for the first, also after a reload', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'a.jsonl');
    const illegal = [];
    const log = createAuditLog({ file, now: () => 1, onIllegal: (x) => illegal.push(x) });
    log.decided({ id: '1:r1', outcome: 'allowed', by: 'auto' });
    assert.deepEqual(illegal, []);                                      // the first decision is the legal one
    log.decided({ id: '1:r1', outcome: 'rejected', by: 'phone' });
    assert.deepEqual(illegal, [{ id: '1:r1', state: 'allowed', event: 'decided' }]);
    // a fresh instance over the same file knows the state from the file and still reports
    const log2 = createAuditLog({ file, now: () => 2, onIllegal: (x) => illegal.push(x) });
    log2.decided({ id: '1:r1', outcome: 'unavailable', by: 'none' });
    assert.deepEqual(illegal[1], { id: '1:r1', state: 'allowed', event: 'decided' });
    assert.equal(readLines(file).length, 1);                            // the duplicate writes were all ignored
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
