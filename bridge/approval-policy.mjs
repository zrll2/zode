// Decides ZCode permission requests for a delegated task, so a turn never hangs waiting for a human.
// ZCode (edit mode, writes files only) still asks before running shell commands, even `ls`. Claude Code runs all
// commands itself, so: read-only inspection inside nothing-sensitive is allowed, everything else is denied with a
// reason that tells the model to carry on with file tools. Pure functions, unit tested.
import path from 'node:path';

export const DENY_REASON = 'Denied by the supervisor: in this session you only write files with the file tools (Read, Edit, Write, Grep, Glob). ' +
  'Claude Code runs every command, install, build and test. Do not retry this command; continue the task without it, and say in your reply what you could not check.';

const SENSITIVE = /(\.ssh\b|id_rsa|id_ed25519|\.aws\b|\.npmrc|\.netrc|\.env\b|\.env\.|keychain|credentials|provider_config|\.zcode\/(v2|cli)\/|\.zode\/|secret|password|token)/i;
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'file', 'stat', 'echo', 'pwd', 'which', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'basename', 'dirname', 'readlink', 'realpath', 'du', 'df', 'true', 'test', '[', 'cd', 'tree', 'jq']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep', 'blame', 'branch', 'remote', 'config', 'describe', 'shortlog', 'cat-file', 'ls-tree']);

function segmentOk(seg) {
  const words = seg.trim().split(/\s+/).filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();   // VAR=value prefixes
  if (!words.length) return true;
  const cmd = path.basename(words[0]);
  if (READ_ONLY.has(cmd)) return true;
  if (cmd === 'find') return !words.some(w => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(w));
  if (cmd === 'sed') return words.includes('-n') && !words.some(w => /^-[a-zA-Z]*i/.test(w) || w === '--in-place');
  if (cmd === 'git') { let sub; for (let i = 1; i < words.length; i++) { if (words[i] === '-C' || words[i] === '-c') { i++; continue; } if (!words[i].startsWith('-')) { sub = words[i]; break; } } return GIT_READ.has(sub) && !(sub === 'branch' && words.some(w => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)/.test(w))) && !(sub === 'config' && !words.includes('--get') && !words.includes('--list')); }
  if (cmd === 'PlistBuddy') return words.includes('-c') && /\bPrint\b/.test(seg) && !/\b(Set|Add|Delete|Import|Merge)\b/.test(seg);
  if (cmd === 'plutil') return words.includes('-p') || (words.includes('-convert') && words.includes('-o') && words[words.indexOf('-o') + 1] === '-');
  return false;
}

// True when the whole command line only inspects things.
export function isReadOnlyCommand(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4000) return false;
  if (/`|\$\(|<\(|>\(/.test(command)) return false;                                   // no substitution
  const noSafeRedirects = command.replace(/\d?>\s*\/dev\/null/g, '').replace(/\d?>&\d/g, '');
  if (/>/.test(noSafeRedirects) || /<</.test(command)) return false;                  // no writes, no heredocs
  if (SENSITIVE.test(command)) return false;
  return command.split(/&&|\|\||;|\||\n/).every(segmentOk);
}

const insideOrSafe = (p, worktree) => typeof p === 'string' && (path.resolve(worktree, p) + path.sep).startsWith(path.resolve(worktree) + path.sep);

// params = the `interaction/requestPermission` params; returns { decision: 'allow' | 'deny', reason }.
export function decidePermission(params, worktree) {
  const input = params?.input ?? {};
  if (typeof input.command === 'string') {
    return isReadOnlyCommand(input.command) ? { decision: 'allow', reason: 'Read-only command approved by the supervisor' } : { decision: 'deny', reason: DENY_REASON };
  }
  const paths = [input.file_path, input.filePath, input.path, input.notebook_path].filter(p => typeof p === 'string');
  if (paths.length && paths.every(p => insideOrSafe(p, worktree)) && !paths.some(p => SENSITIVE.test(p))) return { decision: 'allow', reason: 'Inside the worktree' };
  return { decision: 'deny', reason: DENY_REASON };
}
