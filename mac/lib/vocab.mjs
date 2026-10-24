// The vocabulary hint fed to whisper (--prompt): project names and recent conversation titles first
// (that is what the user will say), then the built-in code words. For zh it must begin with a
// Simplified sentence, or whisper prints Traditional characters. Hard cap of 200 characters,
// trimmed by dropping from the end.
const BUILTINS = ['Zode', 'ZCode', 'worktree', 'merge', 'rebase', 'commit', 'sudo', 'npm', 'type check', 'tests', 'dark mode', 'TestFlight', 'OpenCode'];
const ZH_LEADIN = '以下是简体中文的句子。';
const MAX_CHARS = 200;

export function buildPrompt({ language, projects = [], titles = [], extra = [] } = {}) {
  const seen = new Set();
  const words = [];
  for (const item of [...projects, ...titles, ...extra, ...BUILTINS]) {
    const word = String(item ?? '').trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;                       // dedupe case-insensitively, keep the first casing
    seen.add(key);
    words.push(word);
  }
  let out = language === 'zh' ? ZH_LEADIN : '';
  for (const word of words) {
    const next = out ? `${out}, ${word}` : word;
    if (next.length > MAX_CHARS) break;
    out = next;
  }
  return out;
}
