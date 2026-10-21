#!/usr/bin/env node
// Finish a delegated task: archive its ZCode conversations, remove the worktree folder, delete the merged branch.
//   node zcode-finish.mjs --worktree W [--base main] [--dry-run] [--force]
// Refuses (and removes nothing) unless every check passes:
//   - W is a linked git worktree on a zcode/* branch (never the main checkout)
//   - no uncommitted or untracked files (git status is clean)
//   - the branch is fully merged into --base (default: the repo's main/master), so no commit is lost
//   - no ZCode turn is running for it right now
// --force skips the "merged" check only (use it when the user says the branch can be thrown away); dirty and running always refuse.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = k => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : undefined; };
const dry = process.argv.includes('--dry-run'), force = process.argv.includes('--force');
const wtArg = arg('worktree'); if (!wtArg) { console.error('usage: zcode-finish.mjs --worktree W [--base main] [--dry-run] [--force]'); process.exit(2); }
const wt = fs.realpathSync(path.resolve(wtArg));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const refuse = msg => { console.error('refused: ' + msg); process.exit(1); };

const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
if (!branch.startsWith('zcode/')) refuse(`branch '${branch}' is not zcode/*`);
const gitDir = path.resolve(wt, git(wt, 'rev-parse', '--git-dir')), common = path.resolve(wt, git(wt, 'rev-parse', '--git-common-dir'));
if (gitDir === common) refuse('this is the main checkout, not a linked worktree');
const repo = path.dirname(common);                                    // the repository the worktree belongs to
const base = arg('base') ?? ['main', 'master'].find(b => { try { git(repo, 'rev-parse', '--verify', '-q', b); return true; } catch { return false; } });
if (!base) refuse('cannot find main or master in ' + repo + '; pass --base');

const dirty = git(wt, 'status', '--porcelain');
if (dirty) refuse('uncommitted or untracked files:\n' + dirty.split('\n').slice(0, 8).join('\n') + '\nCommit or move them first.');
const unmerged = git(repo, 'rev-list', '--count', `${base}..${branch}`);
if (unmerged !== '0' && !force) refuse(`${unmerged} commit(s) on ${branch} are not in ${base}. Merge first (or --force to discard them).`);

// A zcode-task supervisor still attached to this worktree means work is in flight.
const procs = spawnSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).stdout.split('\n').filter(l => /zcode-task\.mjs/.test(l) && l.includes('--worktree ' + wt));
if (procs.length) refuse('a zcode-task process is still running for this worktree (' + procs.length + ')');
// A running turn? Ask the one-shot probe for each session of this worktree.
const here = path.dirname(fileURLToPath(import.meta.url));
const ls = spawnSync('node', [path.join(here, 'zcode-cleanup.mjs'), '--worktree', wt, '--dry-run'], { encoding: 'utf8' }).stdout;
const ids = [...ls.matchAll(/sess_[0-9a-f-]+/g)].map(m => m[0]);
for (const id of ids) {
  const p = spawnSync('node', [path.join(here, 'zcode-probe.mjs'), id], { encoding: 'utf8' });
  try { if (JSON.parse(p.stdout).turn === 'running') refuse(`a ZCode turn is still running in session ${id}`); } catch {}
}

console.log(`worktree ${wt}\n  branch ${branch}, ${unmerged === '0' ? 'merged into ' + base : unmerged + ' unmerged commit(s), DISCARDED (--force)'}\n  ${ids.length} ZCode session(s) to archive\n  folder ${(() => { try { return execFileSync('du', ['-sh', wt], { encoding: 'utf8' }).split('\t')[0]; } catch { return '?'; } })()} to remove`);
if (dry) { console.log('(dry run: nothing changed)'); process.exit(0); }

const r = spawnSync('node', [path.join(here, 'zcode-cleanup.mjs'), '--worktree', wt], { stdio: 'inherit' });
if (r.status !== 0) refuse('archiving the ZCode sessions failed; nothing was removed');
git(repo, 'worktree', 'remove', wt);                                   // refuses on its own if something is off
try { git(repo, 'branch', force ? '-D' : '-d', branch); } catch (e) { console.error('worktree removed, branch kept:', String(e.message).split('\n')[0]); }
console.log('removed worktree and branch ' + branch);
