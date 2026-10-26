// notify: the pure diff between two snapshots of the Zode-now lines — what deserves a notification,
// and what must stay quiet (baseline, short runs, repeats, never-seen-running, bursts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineStates, notificationsFor } from '../lib/notify.mjs';

const NOW = 1_750_000_000_000;
const line = over => ({ id: 's1', project: 'zode', title: 'Refactor', status: 'Working', light: 'green', done: false, at: NOW - 1000, ...over });

test('lineStates maps the summary lines to their simplified state', () => {
  assert.deepEqual(lineStates([
    line({ id: 'a' }),
    line({ id: 'b', light: 'amber', status: 'Waiting for you' }),
    line({ id: 'c', light: 'amber', status: 'Quiet for 7 min' }),
    line({ id: 'd', light: 'red', status: 'Failed' }),
    line({ id: 'e', status: '3 min ago', done: true }),
    line({ id: 'f', light: 'weird' }),
    null, 42,
    { status: 'Working', light: 'green' },                       // no id: dropped
  ]), [
    { id: 'a', project: 'zode', title: 'Refactor', state: 'running', at: NOW - 1000 },
    { id: 'b', project: 'zode', title: 'Refactor', state: 'waiting', at: NOW - 1000 },
    { id: 'c', project: 'zode', title: 'Refactor', state: 'stalled', at: NOW - 1000 },
    { id: 'd', project: 'zode', title: 'Refactor', state: 'failed', at: NOW - 1000 },
    { id: 'e', project: 'zode', title: 'Refactor', state: 'finished', at: NOW - 1000 },
    { id: 'f', project: 'zode', title: 'Refactor', state: 'idle', at: NOW - 1000 },
  ]);
  assert.deepEqual(lineStates(undefined), []);
});

test('baseline: the very first snapshot after launch is silent', () => {
  assert.deepEqual(notificationsFor(null, lineStates([line({ id: 'a' }), line({ id: 'b', light: 'red', status: 'Failed' })]), { now: NOW }), []);
});

test('finish: running to finished notifies, short runs stay quiet, idle with a fresh at counts', () => {
  const ran = [{ id: 's1', project: 'zode', title: 'T', state: 'running', at: NOW - 60_000, since: NOW - 60_000 }];
  assert.deepEqual(notificationsFor(ran, [{ id: 's1', project: 'zode', title: 'T', state: 'finished', at: NOW }], { now: NOW }),
    [{ id: 's1', kind: 'finished', project: 'zode', title: 'T' }]);
  // a 5 s run is silent (unless it failed); exactly minRunMs is long enough
  const short = [{ id: 's1', project: 'zode', title: 'T', state: 'running', at: NOW - 5_000, since: NOW - 5_000 }];
  assert.deepEqual(notificationsFor(short, [{ id: 's1', project: 'zode', title: 'T', state: 'finished', at: NOW }], { now: NOW }), []);
  assert.deepEqual(notificationsFor(short, [{ id: 's1', project: 'zode', title: 'T', state: 'failed', at: NOW }], { now: NOW }),
    [{ id: 's1', kind: 'failed', project: 'zode', title: 'T' }]);
  const edge = [{ id: 's1', project: 'zode', title: 'T', state: 'running', at: NOW - 20_000, since: NOW - 20_000 }];
  assert.equal(notificationsFor(edge, [{ id: 's1', project: 'zode', title: 'T', state: 'finished', at: NOW }], { now: NOW }).length, 1);
  // the run start can ride on the previous snapshot
  const carried = [{ id: 's1', project: 'zode', title: 'T', state: 'running', at: NOW - 60_000, since: NOW - 90_000 }];
  assert.equal(notificationsFor(carried, [{ id: 's1', project: 'zode', title: 'T', state: 'finished', at: NOW }], { now: NOW }).length, 1);
  // a run start nobody knows: never suppressed
  const unknown = [{ id: 's1', project: 'zode', title: 'T', state: 'running', at: NOW - 1000 }];
  assert.equal(notificationsFor(unknown, [{ id: 's1', project: 'zode', title: 'T', state: 'finished', at: NOW }], { now: NOW }).length, 1);
  // idle with a fresh at after running counts as finished; a stale one does not
  assert.equal(notificationsFor(ran, [{ id: 's1', project: 'zode', title: 'T', state: 'idle', at: NOW - 1000 }], { now: NOW }).length, 1);
  assert.deepEqual(notificationsFor(ran, [{ id: 's1', project: 'zode', title: 'T', state: 'idle', at: NOW - 60 * 60_000 }], { now: NOW }), []);
  // finished from stalled counts too
  const stalled = [{ id: 's1', project: 'zode', title: 'T', state: 'stalled', at: NOW - 10 * 60_000, since: NOW - 30 * 60_000 }];
  assert.equal(notificationsFor(stalled, [{ id: 's1', project: 'zode', title: 'T', state: 'finished', at: NOW }], { now: NOW }).length, 1);
});

test('needs and failed fire even for a conversation that was never seen running', () => {
  assert.deepEqual(notificationsFor([], [{ id: 'w1', project: 'p', title: 'T', state: 'waiting', at: NOW }], { now: NOW }),
    [{ id: 'w1', kind: 'needs', project: 'p', title: 'T' }]);
  assert.deepEqual(notificationsFor([], [{ id: 'f1', project: 'p', title: '', state: 'failed', at: NOW }], { now: NOW }),
    [{ id: 'f1', kind: 'failed', project: 'p', title: '' }]);
  // never seen running: running, finished and stalled stay quiet
  assert.deepEqual(notificationsFor([], [
    { id: 'r1', project: 'p', title: '', state: 'running', at: NOW },
    { id: 'd1', project: 'p', title: '', state: 'finished', at: NOW },
    { id: 's1', project: 'p', title: '', state: 'stalled', at: NOW },
  ], { now: NOW }), []);
});

test('stalled notifies once; same-state refreshes never repeat', () => {
  const running = [{ id: 's1', project: 'p', title: 'T', state: 'running', at: NOW - 10 * 60_000, since: NOW - 10 * 60_000 }];
  const stalled = [{ id: 's1', project: 'p', title: 'T', state: 'stalled', at: NOW - 10 * 60_000, since: NOW - 10 * 60_000 }];
  assert.deepEqual(notificationsFor(running, stalled, { now: NOW }), [{ id: 's1', kind: 'stalled', project: 'p', title: 'T' }]);
  assert.deepEqual(notificationsFor(stalled, stalled, { now: NOW }), []);        // still stalled: quiet
  assert.deepEqual(notificationsFor(running, running, { now: NOW }), []);        // still running: quiet
  assert.deepEqual(notificationsFor(running, [{ ...running[0], at: NOW }], { now: NOW }), []);   // same state, fresh at
  // a waiting conversation never seen running does not get stalled
  const waiting = [{ id: 'w1', project: 'p', title: 'T', state: 'waiting', at: NOW }];
  assert.deepEqual(notificationsFor(waiting, [{ id: 'w1', project: 'p', title: 'T', state: 'stalled', at: NOW }], { now: NOW }), []);
});

test('a state that comes back notifies again; junk in, nothing out', () => {
  const running = [{ id: 's1', project: 'p', title: 'T', state: 'running', at: NOW - 60_000, since: NOW - 60_000 }];
  const finished = [{ id: 's1', project: 'p', title: 'T', state: 'finished', at: NOW }];
  assert.equal(notificationsFor(running, finished, { now: NOW }).length, 1);
  assert.deepEqual(notificationsFor(finished, [{ id: 's1', project: 'p', title: 'T', state: 'running', at: NOW, since: NOW }], { now: NOW }), []);
  assert.equal(notificationsFor([{ id: 's1', project: 'p', title: 'T', state: 'running', at: NOW + 60_000, since: NOW }],
    [{ id: 's1', project: 'p', title: 'T', state: 'finished', at: NOW + 60_000 }], { now: NOW + 60_000 }).length, 1);
  for (const [prev, next] of [['junk', 'junk'], [null, [null, 7]], [[null, 7, { id: 'x' }], [null, 7]], [[], [null, 7, 'x', { no: 'id', state: 'failed' }]]]) {
    assert.deepEqual(notificationsFor(prev, next, { now: NOW }), []);
  }
});

test('bursts merge into one many; exactly three stay three', () => {
  const prev = ['a', 'b', 'c', 'd'].map(id => ({ id, project: 'p', title: id.toUpperCase(), state: 'running', at: NOW - 60_000, since: NOW - 60_000 }));
  const next = prev.map(s => ({ ...s, state: 'finished', at: NOW }));
  assert.deepEqual(notificationsFor(prev, next, { now: NOW }), [{ kind: 'many', count: 4 }]);
  assert.equal(notificationsFor(prev.slice(0, 3), next.slice(0, 3), { now: NOW }).length, 3);
});

test('mergeAbove: Infinity keeps every member of a burst (the event feed wants each one)', () => {
  const prev = ['a', 'b', 'c', 'd'].map(id => ({ id, project: 'p', title: id.toUpperCase(), state: 'running', at: NOW - 60_000, since: NOW - 60_000 }));
  const next = prev.map(s => ({ ...s, state: 'finished', at: NOW }));
  const out = notificationsFor(prev, next, { now: NOW, mergeAbove: Infinity });
  assert.deepEqual(out.map(e => [e.id, e.kind]), [['a', 'finished'], ['b', 'finished'], ['c', 'finished'], ['d', 'finished']]);
});
