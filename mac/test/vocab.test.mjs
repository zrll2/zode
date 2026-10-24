// buildPrompt: ordering, dedupe, the Simplified lead-in for zh, and the 200-character cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../lib/vocab.mjs';

test('en: projects, then titles, then the built-in words', () => {
  const p = buildPrompt({ language: 'en', projects: ['Voice Engine'], titles: ['fix the relay'] });
  assert.ok(p.startsWith('Voice Engine, fix the relay, '));
  assert.ok(p.includes('worktree'));
  assert.ok(p.includes('OpenCode'));
  assert.ok(p.indexOf('Voice Engine') < p.indexOf('worktree'));
});

test('extra words rank above the built-ins', () => {
  const p = buildPrompt({ language: 'en', extra: ['kubectl'] });
  assert.ok(p.indexOf('kubectl') < p.indexOf('commit'));
});

test('dedupe is case-insensitive and keeps the first casing; blanks are dropped', () => {
  const p = buildPrompt({ language: 'en', projects: ['Zode'], titles: ['  zode ', ''], extra: ['ZODE'] });
  assert.equal(p.split('Zode').length - 1, 1);                      // one occurrence, first casing kept
  assert.ok(!/zode/i.test(p.replace('Zode', '')));
});

test('zh: starts with the Simplified lead-in, then the words', () => {
  const p = buildPrompt({ language: 'zh', projects: ['Voice Engine'] });
  assert.ok(p.startsWith('以下是简体中文的句子。, Voice Engine, '));
  assert.ok(p.length <= 200);
});

test('trimmed to 200 characters by dropping from the end', () => {
  const a = 'a'.repeat(90), b = 'b'.repeat(90), c = 'c'.repeat(90);
  const p = buildPrompt({ language: 'en', projects: [a, b, c] });
  assert.equal(p, `${a}, ${b}`);                                    // c does not fit and is dropped whole
  assert.ok(p.length <= 200);
});

test('zh: the lead-in counts against the cap', () => {
  const p = buildPrompt({ language: 'zh', projects: ['x'.repeat(195)] });
  assert.equal(p, '以下是简体中文的句子。');                          // the 195-char word cannot fit after it
});

test('the built-ins are always present', () => {
  const p = buildPrompt({ language: 'en' });
  assert.ok(p.startsWith('Zode, ZCode, worktree'));
  assert.ok(p.length <= 200);
});
