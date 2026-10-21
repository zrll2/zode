// Updates for Zode.app. ZCode's own updater is off in the copy (see boot.cjs); instead the original
// ZCode.app is compared with the running copy and, when the original is newer, the copy is rebuilt
// from it by a detached shell script, and checkRelease asks the official manifest whether a newer
// release exists online (the menu then offers to run scripts/update-zcode.sh). Pure helpers: fs
// reads and plutil only, nothing here throws.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const XML_VERSION = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/;
const clean = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

// CFBundleShortVersionString of the bundle at appPath, or null. Electron apps ship an XML Info.plist,
// which a regex reads; a binary plist goes through plutil.
export function readVersion(appPath) {
  return new Promise(resolve => {
    try {
      if (typeof appPath !== 'string' || !appPath) return resolve(null);
      const file = path.join(appPath, 'Contents', 'Info.plist');
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { return resolve(null); }
      const m = text.match(XML_VERSION);
      if (m) return resolve(clean(m[1]));
      if (!text.startsWith('bplist')) return resolve(null);
      execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: 5000 }, (err, out) => {
        if (err) return resolve(null);
        try { resolve(clean(JSON.parse(out).CFBundleShortVersionString)); } catch { resolve(null); }
      });
    } catch { resolve(null); }
  });
}

const numbers = v => {
  if (typeof v !== 'string') return null;
  const n = v.split(/[^0-9]+/).filter(t => t !== '').map(Number);
  return n.length ? n : null;
};

// Semver-like numeric compare: negative when a < b, positive when a > b, 0 when equal or when either
// side is not a version at all (junk or missing never decides anything).
export function compareVersions(a, b) {
  const pa = numbers(a), pb = numbers(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// available: the original app exists and is newer than the running copy.
export async function updateState({ original, running } = {}) {
  const [originalVersion, runningVersion] = await Promise.all([readVersion(original), readVersion(running)]);
  const available = !!(originalVersion && runningVersion && compareVersions(originalVersion, runningVersion) > 0);
  return { available, originalVersion, runningVersion };
}

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The script run detached by the app (stdout/stderr go to ~/.zode/rebuild.log): wait for the running
// Zode.app (pid) to quit, build a fresh copy into a temp folder with the repo's build-tap.sh, and only
// then swap it into appPath, so a failed build never removes the old app. Failures end in a
// notification. The original ZCode.app is never touched.
export function rebuildScript({ pid, repo, appPath } = {}) {
  return `#!/bin/bash
# Zode rebuilds itself from the original ZCode. Written by Zode.app; see ~/.zode/rebuild.log.
cd /
PID=${shq(pid)}
REPO=${shq(repo)}
APP=${shq(appPath)}
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"    # build-tap.sh needs node; a GUI app's PATH may lack it

fail() {
  echo "$(date '+%F %T') rebuild failed: $1"
  osascript -e 'display notification "Rebuild failed. See ~/.zode/rebuild.log" with title "Zode"' >/dev/null 2>&1 || true
  exit 1
}

echo "$(date '+%F %T') rebuilding $APP from the original ZCode (repo: $REPO)"
n=0
while kill -0 "$PID" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -ge 60 ]; then fail "the old Zode (pid $PID) did not quit within 60 s"; fi
  sleep 1
done

TMP="$(mktemp -d "\${TMPDIR:-/tmp}/zode-rebuild.XXXXXXXX")" || fail "could not create a temp folder"
echo "building into $TMP/Zode.app ..."
if ! ZODE_TAP_APP="$TMP/Zode.app" bash "$REPO/scripts/build-tap.sh"; then
  rm -rf "$TMP"
  fail "scripts/build-tap.sh failed"
fi

# Swap only now, after a successful build.
if [ -d "$APP" ]; then
  mv "$APP" "$APP.old" || fail "could not move the old app aside"
fi
if ! mv "$TMP/Zode.app" "$APP"; then
  if [ -d "$APP.old" ]; then mv "$APP.old" "$APP" || true; fi
  rm -rf "$TMP"
  fail "could not move the new app into place"
fi
rm -rf "$APP.old" "$TMP"
echo "$(date '+%F %T') rebuilt $APP; reopening"
open "$APP"
`;
}

// parseCheckOutput: the one JSON line `scripts/update-zcode.sh --check` prints, as
// { installed, latest, available, zode } with strings or null and a strict boolean. Anything else
// (garbage, wrong shape, an error message) is null. Pure and total: never throws.
export function parseCheckOutput(text) {
  try {
    if (typeof text !== 'string') return null;
    const lines = text.split('\n').map(l => l.trim()).filter(l => l !== '');
    if (lines.length !== 1 || !lines[0].startsWith('{') || !lines[0].endsWith('}')) return null;
    const raw = JSON.parse(lines[0]);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    if (typeof raw.available !== 'boolean') return null;
    const field = key => {
      const v = raw[key];
      if (v === null) return null;
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    const installed = field('installed'), latest = field('latest'), zode = field('zode');
    if (installed === undefined || latest === undefined || zode === undefined) return null;
    return { installed, latest, available: raw.available, zode };
  } catch { return null; }
}

// checkRelease: run `<repo>/scripts/update-zcode.sh --check` (30 s timeout) and parse its output.
// Resolves to the parsed object, or null when there is no repo, the script fails (exit 3: no
// network or an unparsable manifest), times out, or prints nothing usable. Never rejects.
// execFile is injectable for tests; env carries ZCODE_APP and ZODE_APP for the script.
export function checkRelease({ repo, env, execFile: run = execFile } = {}) {
  return new Promise(resolve => {
    try {
      if (typeof repo !== 'string' || !repo) return resolve(null);
      const script = path.join(repo, 'scripts', 'update-zcode.sh');
      run('/bin/bash', [script, '--check'], { timeout: 30000, env }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseCheckOutput(String(stdout ?? '')));
      });
    } catch { resolve(null); }
  });
}
