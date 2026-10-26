// The Claude Code skill Zode installs: a small instruction file that tells any Claude Code session
// to follow Zode's event feed (mac/bin/zode-watch.mjs). The app owns the file — it is rewritten on
// every launch while the setting is on and removed when the setting goes off; only files carrying
// the managed marker are ever deleted.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join('.claude', 'skills', 'zode-results');
const MARKER = 'managed-by: zode';

export function skillFile(home) {
  return path.join(home, DIR, 'SKILL.md');
}

export function skillBody({ command, version } = {}) {
  return `---
name: zode-results
description: Learn when ZCode conversations started through Zode finish, fail, need an answer or get stuck. Use whenever you delegate work to ZCode or wait for a ZCode result.
managed-by: zode ${version ?? 'dev'}
---

When you delegate work to ZCode, or the user asks you to wait for ZCode work, listen for the result instead of polling or guessing.

Start ONE persistent Monitor on this command if one is not already running in this session. Every line it prints is an event from Zode:

\`\`\`
${command ?? ''}
\`\`\`

The lines come from the Zode event feed, ~/.zode/events.jsonl, and look like this:

- \`finished: <project> - <title> (session <id>)\` — the ZCode conversation finished. Check the result (read the conversation or the worktree diff, run the tests) and continue without asking the user.
- \`failed: ...\` — the conversation failed. Read the error, then retry or report it.
- \`needs you: ...\` — the conversation waits for a permission or an answer in the Zode panel or on the phone. Tell the user in one line.
- \`stuck: ...\` — the conversation has been quiet for a while. Check on it; nudge or stop it.

This skill and the feed file are managed by Zode and rewritten on every launch. If you edit this file, your edit is overwritten the next time Zode starts.
`;
}

export function installSkill({ home, command, version } = {}) {
  const dir = path.join(home, DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillBody({ command, version }), { mode: 0o644 });
  return true;
}

function hasMarker(home) {
  try {
    return fs.readFileSync(skillFile(home), 'utf8').includes(MARKER);
  } catch {
    return false;                                                     // missing or unreadable: nothing of ours
  }
}

export function removeSkill({ home }) {
  if (!hasMarker(home)) return false;                                 // a file without the marker is not ours: never deleted
  fs.rmSync(path.join(home, DIR), { recursive: true, force: true });
  return true;
}

export function skillStatus({ home }) {
  return hasMarker(home);
}
