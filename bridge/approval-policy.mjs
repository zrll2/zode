// Decides ZCode permission requests for a delegated task, so a turn never hangs waiting for a human.
// ZCode (edit mode, writes files only) still asks before running shell commands, even `ls`. Claude Code runs all
// commands itself, so: read-only inspection inside nothing-sensitive is allowed, everything else is denied with a
// reason that tells the model to carry on with file tools. Pure functions, unit tested.
import path from 'node:path';

export const DENY_REASON = 'Denied by the supervisor: in this session you only write files with the file tools (Read, Edit, Write, Grep, Glob). ' +
  'Claude Code runs every command, install, build and test. Do not retry this command; continue the task without it, and say in your reply what you could not check.';

const SENSITIVE = /(\.ssh\b|id_rsa|id_ed25519|\.aws\b|\.npmrc|\.netrc|\.env\b|\.env\.|keychain|credentials|provider_config|\.zcode\/(v2|cli)\/|\.zode\/|secret|password|token)/i;
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'file', 'stat', 'echo', 'pwd', 'which', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'basename', 'dirname', 'readlink', 'realpath', 'du', 'df', 'true', 'test', '[', 'cd', 'tree', 'jq']);
// tee, awk, xargs and friends stay off the list on purpose: they can write files or run code in ways
// argv alone cannot vouch for (tee's target argument, awk's own language, xargs builds new commands).

// Flags that make an otherwise read-only tool write a file instead of stdout (sort/tree -o, git diff --output).
const OUTPUT_FLAG = w => /^-o/.test(w) || w.startsWith('--output');

const GIT_SUBS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'branch', 'remote', 'config']);
const GIT_BRANCH_FLAGS = new Set(['-a', '-r', '--list', '--show-current']);

const SED_FLAGS = new Set(['n', 'E', 'r', 's', 'u', 'a', 'l', 'z', 'H', 'S']);
const SED_LONG = new Set(['--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data', '--posix', '--line-length', '--follow-symlinks', '--debug']);

// s/PAT/REP/flags and y/IN/OUT/: walk pattern and replacement (backslash escapes allowed) so the flags
// after the closing delimiter are checked too — `w` (write to file) and `e` (execute) must not slip
// through as s-flags. Returns the index just past the command, or -1 when it is not a read-only form.
function sedEditAt(script, i, cmd) {
  const head = new RegExp('^' + cmd + '\\\\?(.)').exec(script.slice(i));
  if (!head) return -1;
  const d = head[1];
  if (/[a-zA-Z0-9;\s]/.test(d)) return -1;                     // the delimiter is punctuation
  const q = d.replace(/[.*+?^${}()|[\]\\^-]/g, '\\$&');
  const one = '(?:\\\\.|[^' + q + '\\\\])';                      // an escape pair (regex \\.) or any other character
  let at = i + head[0].length;
  for (let k = 0; k < 2; k++) {                                // s: pattern + replacement; y: two lists
    const m = new RegExp('^' + one + '*' + q).exec(script.slice(at));
    if (!m) return -1;
    at += m[0].length;
  }
  if (cmd === 's') at += /^[0-9gpImM]*/.exec(script.slice(at))[0].length;
  return at;
}

// Every command in the script must be provably read-only: after addresses ($, N, N~M, /re/, ranges,
// optional !) only p = d n g G h H x, s///[0-9gpImM] and y/// are allowed. The write/append/exec
// commands (w W r R e), q, blocks, labels and branches are denied.
function safeSedScript(script) {
  let i = 0;
  while (i < script.length) {
    if (/[ \t\n;]/.test(script[i])) { i++; continue; }
    for (let k = 0; k < 2; k++) {
      const a = /^(\$|[0-9]+(?:~[0-9]+)?|\/(?:\\.|[^/\n])*\/|\\(?:\\.|[^\\\n])*\\)/.exec(script.slice(i));
      if (!a) break;
      i += a[0].length;
      const r = /^,(\$|[0-9]+(?:~[0-9]+)?|\/(?:\\.|[^/\n])*\/|\+[0-9]+|\\(?:\\.|[^\\\n])*\\)/.exec(script.slice(i));
      if (!r) break;
      i += r[0].length;
    }
    while (i < script.length && /[ \t]/.test(script[i])) i++;   // sed allows space around the address and the !
    i += /^!?/.exec(script.slice(i))[0].length;
    while (i < script.length && /[ \t]/.test(script[i])) i++;
    const cmd = script[i];
    if (cmd === undefined) return true;
    if ('pdn=GgHhx'.includes(cmd)) { i++; continue; }
    if (cmd === 's' || cmd === 'y') {
      const next = sedEditAt(script, i, cmd);
      if (next < 0) return false;
      i = next;
      continue;
    }
    return false;
  }
  return true;
}

const unquote = s => (s.length >= 2 && ((s[0] === "'" && s[s.length - 1] === "'") || (s[0] === '"' && s[s.length - 1] === '"')) ? s.slice(1, -1) : s);
const startsOpen = w => (w[0] === "'" || w[0] === '"') && (w.length === 1 || w[w.length - 1] !== w[0]);

// Collect the sed script(s) from argv — joining the pieces of a quoted script back together — and
// validate each one. Deny the option forms that cannot be checked this way: -i/-I (in place), -f
// (script from a file we would have to read), and anything unvetted.
function sedOk(raw) {
  const words = [];
  for (const w of raw) {
    if (words.length && startsOpen(words[words.length - 1])) words[words.length - 1] += ' ' + w;
    else words.push(w);
  }
  const scripts = [];
  let fromFlag = false;                                          // with -e/--expression the positionals are input files
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--expression') { scripts.push(unquote(words[i + 1] ?? '')); fromFlag = true; i++; continue; }
    if (w.startsWith('--expression=')) { scripts.push(unquote(w.slice(13))); fromFlag = true; continue; }
    if (w === '-e') { scripts.push(unquote(words[i + 1] ?? '')); fromFlag = true; i++; continue; }
    if (/^-e/.test(w) && w.length > 2) { scripts.push(unquote(w.slice(2))); fromFlag = true; continue; }
    if (/^-[a-zA-Z]+$/.test(w)) {
      if (w.slice(1).split('').every(ch => SED_FLAGS.has(ch))) continue;
      return false;
    }
    if (w.startsWith('--')) return SED_LONG.has(w);
    if (!fromFlag) scripts.push(unquote(w));                     // first positional: the script
    for (i += fromFlag ? 0 : 1; i < words.length; i++) {         // input files, plus options getopt may have moved here
      if (/-[a-z]*[if]/i.test(words[i]) || words[i].startsWith('--in-place') || words[i].startsWith('--file') ||
          words[i] === '-e' || words[i] === '--expression' || words[i].startsWith('--expression=')) return false;
    }
    break;
  }
  return scripts.every(safeSedScript);
}

// git: only a fixed set of read subcommands. `-c` is denied outright (a one-shot config can arm
// diff.external, and `git diff` runs external diff drivers), unknown global options are denied, and
// the diff family may not use --output (it writes a file instead of stdout).
function gitOk(words) {
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (w === '-C') { i += 2; continue; }                       // -C <dir>: only moves the working directory
    if (w === '--no-pager' || w === '--paginate') { i++; continue; }
    if (w.startsWith('-')) return false;
    break;
  }
  const sub = words[i];
  if (!sub || !GIT_SUBS.has(sub)) return false;
  const rest = words.slice(i + 1);
  if ((sub === 'diff' || sub === 'log' || sub === 'show') && rest.some(OUTPUT_FLAG)) return false;
  if (sub === 'branch') return rest.every(w => GIT_BRANCH_FLAGS.has(w));
  if (sub === 'remote') return rest.every(w => w === '-v');
  if (sub === 'config') return rest.includes('--get') || rest.includes('--list');
  return true;
}

function segmentOk(seg) {
  const words = seg.trim().split(/\s+/).filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();   // VAR=value prefixes
  if (!words.length) return true;
  const cmd = path.basename(words[0]);
  if (READ_ONLY.has(cmd)) {
    if (cmd === 'sort' || cmd === 'tree') return !words.slice(1).some(OUTPUT_FLAG);
    if (cmd === 'uniq') {                                       // uniq IN OUT writes OUT
      const args = words.slice(1);
      const dd = args.indexOf('--');
      return (dd >= 0 ? args.slice(dd + 1) : args.filter(w => !w.startsWith('-'))).length <= 1;
    }
    return true;
  }
  if (cmd === 'find') return !words.some(w => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(w));
  if (cmd === 'sed') return sedOk(words);
  if (cmd === 'git') return gitOk(words);
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
