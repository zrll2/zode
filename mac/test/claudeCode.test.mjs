// claudeCode: the skill the app installs into ~/.claude/skills/zode-results — content, install,
// refresh, and the rule that only managed files are ever removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSkill, removeSkill, skillStatus, skillFile, skillBody } from '../lib/claudeCode.mjs';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zode-claude-'));
const COMMAND = 'ELECTRON_RUN_AS_NODE=1 "/Applications/Zode.app/Contents/MacOS/Zode" "/Applications/Zode.app/Contents/Resources/bin/zode-watch.mjs"';

test('skillBody: carries the command, the feed file, the marker and the overwrite warning', () => {
  const body = skillBody({ command: COMMAND, version: '1.2.3' });
  assert.match(body, /^---\nname: zode-results\n/);
  assert.match(body, /managed-by: zode 1\.2\.3/);
  assert.ok(body.includes(COMMAND));
  assert.ok(body.includes('~/.zode/events.jsonl'));
  assert.ok(body.includes('rewritten on every launch'));
  for (const kind of ['finished', 'failed', 'needs you', 'stuck']) assert.ok(body.includes(`\`${kind}:`), kind);
});

test('install, status, refresh and remove in a temp home', async () => {
  const home = tmpHome();
  assert.equal(skillStatus({ home }), false);
  assert.equal(installSkill({ home, command: COMMAND, version: '1.0.0' }), true);
  const file = skillFile(home);
  const st = fs.statSync(file);
  assert.equal(st.mode & 0o777, 0o644);
  assert.ok(fs.readFileSync(file, 'utf8').includes(COMMAND));
  assert.equal(skillStatus({ home }), true);
  // refresh: a new version rewrites the file in place
  installSkill({ home, command: COMMAND, version: '2.0.0' });
  assert.match(fs.readFileSync(file, 'utf8'), /managed-by: zode 2\.0\.0/);
  // remove takes the managed directory with it
  assert.equal(removeSkill({ home }), true);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'zode-results')), false);
  assert.equal(skillStatus({ home }), false);
  assert.equal(removeSkill({ home }), false);                         // already gone
});

test('removeSkill: a file without the managed marker is never deleted', () => {
  const home = tmpHome();
  const dir = path.join(home, '.claude', 'skills', 'zode-results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: zode-results\n---\nMy own notes.');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
  assert.equal(removeSkill({ home }), false);
  assert.equal(fs.existsSync(path.join(dir, 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true);
  // junk homes never throw
  assert.equal(removeSkill({ home: '/tmp/zode-claude-missing-home' }), false);
  assert.equal(skillStatus({ home: '/tmp/zode-claude-missing-home' }), false);
});
