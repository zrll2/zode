// Updates for the Zode menu bar app: version reads and compares for the engine-rebuild offer, the
// release check against scripts/update-zcode.sh --check, and the detached script that rebuilds the
// Engine from a newer original ZCode (the app itself stays running). Pure helpers where possible:
// fs reads and plutil only, nothing here throws.
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
// repo is the kit folder (the repo in development, Resources/engine-kit when packaged). Resolves to
// the parsed object, or null when there is no kit, the script fails (exit 3: no network or an
// unparsable manifest), times out, or prints nothing usable. Never rejects. execFile is injectable
// for tests; env carries ZCODE_APP and ZODE_APP for the script.
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

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The script run detached by the app (stdout/stderr go to ~/.zode/rebuild.log): ask the Engine to
// quit (it quits itself again at the end), stop it if it will not go within 10 s, build a fresh
// Engine into a temp folder with the kit's build-tap.sh, and only then swap it into place, so a
// failed build never removes the old app. The original ZCode.app is never touched and the Zode menu
// bar app keeps running throughout — there is no pid to wait for.
export function engineRebuildScript({ repo, enginePath } = {}) {
  return `#!/bin/bash
# Zode rebuilds the ZCode Engine from the original ZCode. Written by the Zode menu bar app; see ~/.zode/rebuild.log.
cd /
REPO=${shq(repo)}
ENGINE=${shq(enginePath)}
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"    # build-tap.sh may need node; a GUI app's PATH may lack it

fail() {
  echo "$(date '+%F %T') engine rebuild failed: $1"
  osascript -e 'display notification "Rebuilding the Engine failed. See ~/.zode/rebuild.log" with title "Zode"' >/dev/null 2>&1 || true
  exit 1
}

echo "$(date '+%F %T') rebuilding the Engine at $ENGINE from the original ZCode (kit: $REPO)"

# Only one copy of ZCode may run while the Engine is replaced: ask it to quit, wait up to 10 s, then stop it.
# The pgrep/pkill patterns anchor at the line start: a process that merely mentions the path is not the Engine.
osascript -e 'tell application id "dev.zode.engine" to quit' >/dev/null 2>&1 || true
n=0
while pgrep -f "^$ENGINE/Contents/MacOS/" >/dev/null 2>&1; do
  n=$((n + 1))
  if [ "$n" -eq 10 ]; then pkill -f "^$ENGINE/" >/dev/null 2>&1 || true; fi
  if [ "$n" -ge 20 ]; then fail "the Engine did not quit within 10 s"; fi
  sleep 1
done

TMP="$(mktemp -d "\${TMPDIR:-/tmp}/zode-engine.XXXXXXXX")" || fail "could not create a temp folder"
echo "building into $TMP/$(basename "$ENGINE") ..."
if ! ZODE_ENGINE=1 ZODE_TAP_APP="$TMP/$(basename "$ENGINE")" bash "$REPO/scripts/build-tap.sh"; then
  rm -rf "$TMP"
  fail "scripts/build-tap.sh failed"
fi

# Swap only now, after a successful build.
if [ -d "$ENGINE" ]; then
  mv "$ENGINE" "$ENGINE.old" || fail "could not move the old Engine aside"
fi
if ! mv "$TMP/$(basename "$ENGINE")" "$ENGINE"; then
  if [ -d "$ENGINE.old" ]; then mv "$ENGINE.old" "$ENGINE" || true; fi
  rm -rf "$TMP"
  fail "could not move the new Engine into place"
fi
rm -rf "$ENGINE.old" "$TMP"
echo "$(date '+%F %T') rebuilt $ENGINE; reopening"
open "$ENGINE"
`;
}
