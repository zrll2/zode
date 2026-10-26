// live: the running tracker built from the event stream every server already sends. The fake clock
// moves by hand; every message here is exactly the shape the wrapper puts on its tap socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveStatus } from '../live.mjs';

const T0 = 1_750_000_000_000;
const clock = () => {
  let t = T0;
  return { at: () => t, move: ms => { t += ms; } };
};
const stateUpdated = (sessionId, over = {}) => ({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId, revision: 1, ...over } });
const started = sessionId => stateUpdated(sessionId, { patch: { status: 'running' }, reason: 'prompt_started' });
const completed = sessionId => stateUpdated(sessionId, { patch: {}, reason: 'prompt_completed', revision: 2 });
const event = sessionId => ({ method: 'session/event', params: { sessionId } });
const listed = (sessionId, over = {}) => ({ sessionId, status: 'idle', updatedAt: T0 - 60_000, ...over });

test('prompt_started marks the session running and bumps its time; prompt_completed settles it back to the list', () => {
  const c = clock();
  const live = createLiveStatus({ now: c.at });
  const row = listed('s1');
  live.observe(started('s1'));
  const [run] = live.apply([row]);
  assert.deepEqual(run, { ...row, status: 'running', updatedAt: T0, liveSince: T0 });   // updatedAt = the turn's start; liveSince feeds the panel's duration
  assert.notEqual(run, row);                                                   // a copy; the list's object is untouched

  c.move(4_000);
  live.observe(completed('s1'));                                               // the settings patch carries no status key at all
  assert.deepEqual(live.apply([row]), [row]);
});

test('a turn also settles through patch.status idle, or a failed or cancelled reason', () => {
  const c = clock();
  const live = createLiveStatus({ now: c.at });
  const ends = [
    { patch: { status: 'idle' }, reason: 'state_sync' },
    { patch: {}, reason: 'prompt_failed' },
    { patch: {}, reason: 'prompt_cancelled' },
    { patch: {}, reason: 'turn_failed_upstream' },
  ];
  for (const [i, end] of ends.entries()) {
    const id = 's' + i;
    live.observe(started(id));
    assert.equal(live.apply([listed(id)])[0].status, 'running', id);
    live.observe(stateUpdated(id, { ...end, revision: 2 }));
    assert.deepEqual(live.apply([listed(id)]), [listed(id)], id);
  }
});

test('telemetry and non-session traffic are ignored: nothing looks running because of them', () => {
  const c = clock();
  const live = createLiveStatus({ now: c.at });
  live.observe({ method: 'v4/telemetry/tokens', params: { sessionId: 's1', n: 5 } });
  live.observe({ method: 'process/mcpTelemetry', params: { sessionId: 's1' } });
  live.observe({ method: 'process/spawned', params: { sessionId: 's1' } });
  live.observe({ method: 'startup/storageState', params: {} });
  live.observe({ method: 'session/event', params: { text: 'no sessionId' } });
  live.observe({ method: 'state.updated', params: { scope: 'workspace', patch: {} } });
  live.observe({ id: 9, tapReply: true, result: {} });                         // a copied desktop reply
  live.observe('junk');
  live.observe(null);
  assert.deepEqual(live.apply([listed('s1')]), [listed('s1')]);
});

test('activity fallback: events alone mean running, and 20 s after the last one the list stands again', () => {
  const c = clock();
  const live = createLiveStatus({ now: c.at });
  live.observe(event('s1'));
  assert.equal(live.apply([listed('s1')])[0].status, 'running');
  c.move(10_000);
  live.observe(event('s1'));
  c.move(15_000);
  assert.equal(live.apply([listed('s1')])[0].status, 'running');               // 15 s since the last event
  c.move(6_000);
  assert.deepEqual(live.apply([listed('s1')]), [listed('s1')]);               // 21 s: quiet again
});

test('events within 3 s of a settle are the old turn trailing off, not a new one', () => {
  const c = clock();
  const live = createLiveStatus({ now: c.at });
  live.observe(started('s1'));
  c.move(2_000);
  live.observe(completed('s1'));
  live.observe(event('s1'));                                                   // 0 s after the settle
  assert.deepEqual(live.apply([listed('s1')]), [listed('s1')]);
  c.move(4_000);
  live.observe(event('s1'));                                                   // 6 s after the settle: real activity again
  assert.equal(live.apply([listed('s1')])[0].status, 'running');
});

test('a running mark with no event for 120 s expires: a crashed turn stops looking running', () => {
  const c = clock();
  const live = createLiveStatus({ now: c.at });
  live.observe(started('s1'));
  c.move(60_000);
  live.observe(event('s1'));                                                   // the mark stays fresh while events come
  c.move(119_000);
  assert.equal(live.apply([listed('s1')])[0].status, 'running');               // 119 s without an event
  c.move(2_000);
  assert.deepEqual(live.apply([listed('s1')]), [listed('s1')]);               // 121 s without an event
});

test('a started turn that never emits an event expires 120 s after the mark', () => {
  const c = clock();
  const live = createLiveStatus({ now: c.at });
  live.observe(started('s1'));
  c.move(120_000);
  assert.equal(live.apply([listed('s1')])[0].status, 'running');               // 120 s exactly
  c.move(1_000);
  assert.deepEqual(live.apply([listed('s1')]), [listed('s1')]);
});

test('an open permission or question means waiting, and waiting beats running', () => {
  const c = clock();
  const live = createLiveStatus({ now: c.at });
  live.observe(started('s1'));
  live.setPending([{ sessionId: 's1', method: 'interaction/requestPermission' }]);
  const [w] = live.apply([listed('s1')]);
  assert.equal(w.status, 'waiting');
  assert.equal(w.updatedAt, T0 - 60_000);                                      // waiting does not touch the time

  live.setPending([{ sessionId: 's2', method: 'interaction/requestUserInput' }]);
  assert.equal(live.apply([listed('s1')])[0].status, 'running');               // answered: the running mark stands again
  assert.equal(live.apply([listed('s2')])[0].status, 'waiting');

  live.setPending([]);
  live.observe(completed('s1'));
  live.setPending([{ sessionId: 's1', method: 'interaction/requestUserInput' }]);
  assert.equal(live.apply([listed('s1')])[0].status, 'waiting');               // a question on a settled session waits too
  live.setPending([{ sessionId: 's1', method: 'session/ping' }]);              // not a user request: nobody waits
  assert.deepEqual(live.apply([listed('s1')]), [listed('s1')]);
});

test("the list's own error stands unless the session is really running or waiting", () => {
  const c = clock();
  const live = createLiveStatus({ now: c.at });
  const broken = listed('s1', { status: 'error' });
  assert.deepEqual(live.apply([broken]), [broken]);
  live.observe(event('s1'));
  assert.equal(live.apply([broken])[0].status, 'running');                     // live activity beats the list's error
  live.setPending([{ sessionId: 's1', method: 'interaction/requestPermission' }]);
  assert.equal(live.apply([broken])[0].status, 'waiting');
  live.setPending([]);
  c.move(30_000);                                                              // the activity goes stale
  assert.deepEqual(live.apply([broken]), [broken]);                           // and error stands again
});

test('memory is bounded: nothing observed for 6 hours leaves no stale truth behind', () => {
  const c = clock();
  const live = createLiveStatus({ now: c.at });
  live.observe(started('s1'));
  c.move(6 * 60 * 60 * 1000 + 1);
  live.observe(started('s2'));                                                 // the walk that drops s1
  c.move(200_000);                                                             // s2's own mark expires too
  assert.deepEqual(live.apply([listed('s1'), listed('s2')]), [listed('s1'), listed('s2')]);
  live.observe(event('s2'));                                                   // and the tracker still works afterwards
  assert.equal(live.apply([listed('s2')])[0].status, 'running');
});

test('apply tolerates junk entries, never mutates its input, and passes a junk list through', () => {
  const c = clock();
  const live = createLiveStatus({ now: c.at });
  live.observe(started('s1'));
  const row = listed('s1');
  const out = live.apply([null, 42, 'x', { no: 'sessionId' }, row]);
  assert.equal(out.length, 5);
  assert.equal(out[0], null);
  assert.equal(out[1], 42);
  assert.equal(out[2], 'x');
  assert.deepEqual(out[3], { no: 'sessionId' });
  assert.equal(out[4].status, 'running');
  assert.equal(row.status, 'idle');                                            // the input object is untouched
  assert.equal(live.apply(undefined), undefined);
  assert.equal(live.apply('nope'), 'nope');
});
