import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activityTimes, withRealActivity } from '../activity.mjs';

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zode-activity-'));
  const db = path.join(dir, 'db.sqlite');
  execFileSync('sqlite3', [db, "CREATE TABLE session (id text primary key, time_updated integer not null); INSERT INTO session VALUES ('sess_a', 1000), ('sess_b', 2000);"]);
  return { dir, db };
}

test('activityTimes reads the real times for the ids it finds', async () => {
  const { dir, db } = makeDb();
  try {
    const t = await activityTimes(['sess_a', 'sess_b', 'sess_missing'], db);
    assert.equal(t.get('sess_a'), 1000);
    assert.equal(t.get('sess_b'), 2000);
    assert.equal(t.has('sess_missing'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('withRealActivity replaces updatedAt and leaves unknown sessions alone', async () => {
  const { dir, db } = makeDb();
  try {
    const out = await withRealActivity([{ sessionId: 'sess_a', updatedAt: 9_999_999, title: 'x' }, { sessionId: 'sess_zzz', updatedAt: 5 }, null], db);
    assert.deepEqual(out[0], { sessionId: 'sess_a', updatedAt: 1000, title: 'x' });
    assert.deepEqual(out[1], { sessionId: 'sess_zzz', updatedAt: 5 });
    assert.equal(out[2], null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failing database answers from the cache while it is young, then gives up', async () => {
  const { dir, db } = makeDb();
  try {
    const first = await activityTimes(['sess_a', 'sess_b'], db);          // warms the cache for this database
    assert.equal(first.get('sess_a'), 1000);
    fs.rmSync(db);                                                        // from now on every query fails
    const stale = await activityTimes(['sess_a', 'sess_b'], db, { now: () => Date.now() + 1000 });
    assert.deepEqual([...stale], [...first]);                             // the last good answer stands in
    const gone = await activityTimes(['sess_a'], db, { now: () => Date.now() + 6000 });
    assert.equal(gone.size, 0);                                           // past 5 s the cache is too old to trust
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('never throws: missing database, junk ids, non-arrays', async () => {
  assert.equal((await activityTimes(['sess_a'], '/nonexistent/db.sqlite')).size, 0);
  assert.equal((await activityTimes(["x'; DROP TABLE session; --", 42, null], '/nonexistent/db.sqlite')).size, 0);
  assert.deepEqual(await withRealActivity(undefined), undefined);
  assert.deepEqual(await withRealActivity([], '/x'), []);
  const same = [{ sessionId: 'sess_a', updatedAt: 7 }];
  assert.deepEqual(await withRealActivity(same, '/nonexistent/db.sqlite'), same);
});
