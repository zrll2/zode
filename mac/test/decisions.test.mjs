// Remembered answers: keyOf normalisation, remember/lookup, stale labels, cap, corrupt file, forget,
// persistence across two store instances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { keyOf, createDecisions } from '../lib/decisions.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zode-decisions-'));
const q = over => ({ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], ...over });

test('keyOf normalises text and ignores option order', () => {
  const a = keyOf(q());
  assert.equal(a, keyOf({ question: '  which   Database? ', options: [{ label: ' SQLite ' }, { label: 'postgres' }] }));
  assert.notEqual(a, keyOf(q({ question: 'Which cache?' })));
  assert.notEqual(a, keyOf(q({ options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'Mongo' }] })));
});

test('free-text questions (no options) never get a key', () => {
  assert.equal(keyOf(q({ options: [] })), null);
  assert.equal(keyOf(q({ options: [{ label: '' }] })), null);
  assert.equal(keyOf({ question: 'What port?' }), null);
  assert.equal(keyOf(null), null);
  assert.equal(keyOf({ options: [{ label: 'x' }] }), null);
});

test('remember and lookup round trip, newest answer wins', () => {
  const d = createDecisions({ file: path.join(tmp(), 'd.json') });
  assert.equal(d.size(), 0);
  assert.equal(d.lookup(q()), null);
  assert.equal(d.remember(q(), 'Postgres'), true);
  assert.equal(d.size(), 1);
  assert.equal(d.lookup(q()), 'Postgres');
  d.remember(q(), 'SQLite');
  assert.equal(d.lookup(q()), 'SQLite');
  assert.equal(d.size(), 1);                                           // the same question, not a second row
});

test('multiSelect answers round trip', () => {
  const d = createDecisions({ file: path.join(tmp(), 'd.json') });
  d.remember(q({ multiSelect: true }), ['Postgres', 'SQLite']);
  assert.deepEqual(d.lookup(q()), ['Postgres', 'SQLite']);
});

test('a remembered label that is no longer offered returns null', () => {
  const d = createDecisions({ file: path.join(tmp(), 'd.json') });
  d.remember(q(), 'Postgres');
  assert.equal(d.lookup(q({ options: [{ label: 'MySQL' }, { label: 'SQLite' }] })), null);
  d.remember(q({ multiSelect: true }), ['Postgres', 'SQLite']);
  assert.equal(d.lookup(q({ options: [{ label: 'SQLite' }] })), null);   // one stale label spoils the set
});

test('junk answers and free-text questions are refused', () => {
  const d = createDecisions({ file: path.join(tmp(), 'd.json') });
  assert.equal(d.remember(q(), ''), false);
  assert.equal(d.remember(q(), ['Postgres', '']), false);
  assert.equal(d.remember(q(), []), false);
  assert.equal(d.remember(q({ options: [] }), 'Postgres'), false);
  assert.equal(d.size(), 0);
});

test('the cap keeps the newest answers only', () => {
  const d = createDecisions({ file: path.join(tmp(), 'd.json'), cap: 3 });
  for (let i = 0; i < 5; i++) d.remember(q({ question: `Q${i}` }), 'Postgres');
  assert.equal(d.size(), 3);
  assert.notEqual(d.lookup(q({ question: 'Q4' })), null);              // newest kept
  assert.equal(d.lookup(q({ question: 'Q0' })), null);                 // oldest dropped
});

test('a corrupt file means empty, and a save repairs it', () => {
  const dir = tmp();
  const f = path.join(dir, 'd.json');
  fs.writeFileSync(f, '{ not json');
  const d = createDecisions({ file: f });
  assert.equal(d.size(), 0);
  d.remember(q(), 'Postgres');
  assert.equal(createDecisions({ file: f }).lookup(q()), 'Postgres');
});

test('forget empties the memory and persists; answers survive across two instances', () => {
  const f = path.join(tmp(), 'd.json');
  const d = createDecisions({ file: f });
  d.remember(q(), 'Postgres');
  d.remember(q({ question: 'Which port?' }), '8080');
  const fresh = createDecisions({ file: f });                          // a second instance reads the same file
  assert.equal(fresh.lookup(q()), 'Postgres');
  assert.equal(fresh.size(), 2);
  assert.equal(fresh.forget(), 2);
  assert.equal(fresh.size(), 0);
  assert.equal(createDecisions({ file: f }).lookup(q()), null);        // the empty memory was written too
});

test('the file is mode 0600 and no temp file is left behind', () => {
  const dir = tmp();
  const f = path.join(dir, 'd.json');
  createDecisions({ file: f }).remember(q(), 'Postgres');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp')), []);
});
