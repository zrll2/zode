// voiceHint: the live half of the vocabulary hint, extracted from the panel's work lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceHint } from '../lib/voiceHint.mjs';

const NOW = 1_800_000_000_000;
const min = 60 * 1000;
const line = over => ({ id: 's1', project: 'web', status: 'Working', done: false, light: 'green', at: NOW, ...over });

test('projects: distinct and in order; blanks, junk and the No workspace placeholder dropped', () => {
  const { projects } = voiceHint({ lines: [
    line({ id: 'a', project: 'web' }),
    line({ id: 'b', project: 'voice' }),
    line({ id: 'c', project: 'web' }),                        // duplicate
    line({ id: 'd', project: '   ' }),                        // blank
    line({ id: 'e', project: 'No workspace' }),               // summarize's placeholder, not a name
    line({ id: 'f', project: 42 }),
  ], now: NOW });
  assert.deepEqual(projects, ['web', 'voice']);
});

test('titles: the most recent first, capped at 10, deduped case-insensitively', () => {
  const lines = Array.from({ length: 14 }, (_, i) => line({ id: `t${i}`, title: `conversation ${i}`, at: NOW - i * min }));
  assert.deepEqual(voiceHint({ lines, now: NOW }).titles, Array.from({ length: 10 }, (_, i) => `conversation ${i}`));
  const dupe = [line({ id: 'a', title: 'Fix the relay' }), line({ id: 'b', title: '  fix the relay  ', at: NOW - min })];
  assert.deepEqual(voiceHint({ lines: dupe, now: NOW }).titles, ['Fix the relay']);   // the newest casing wins
  assert.deepEqual(voiceHint({ lines: [line({ title: 'x', at: 'nope' }), line({ title: 'y' })], now: NOW }).titles, ['x', 'y']);   // an untimed line counts as now
});

test('work orders are excluded from the titles but keep their project', () => {
  const { projects, titles } = voiceHint({ lines: [
    line({ id: 'a', project: 'web', title: 'Ship the release' }),
    line({ id: 'b', project: 'voice', title: 'an automated order', order: true, at: NOW - min }),
  ], now: NOW });
  assert.deepEqual(projects, ['web', 'voice']);
  assert.deepEqual(titles, ['Ship the release']);
});

test('junk input never throws and yields the empty hint', () => {
  const empty = { projects: [], titles: [] };
  assert.deepEqual(voiceHint(), empty);
  assert.deepEqual(voiceHint({}), empty);
  assert.deepEqual(voiceHint({ lines: 'nope' }), empty);
  assert.deepEqual(voiceHint({ lines: [null, 7, 'x', {}] }), empty);
});
