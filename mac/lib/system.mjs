// Side-effect helpers for the setup wizard: what is installed, what is running, whether the engine
// is talking, and running the Engine build. Everything returns a promise, never throws, and takes
// injectable fs/child_process so tests can stub the world.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';

const HOME = os.homedir();

const exists = (p, fsMod = fs) => {
  try { return typeof p === 'string' && p !== '' && fsMod.existsSync(p); } catch { return false; }
};

function firstExisting(paths, fsMod = fs) {
  return new Promise(resolve => {
    try {
      for (const p of paths) { if (exists(p, fsMod)) return resolve(p); }
      resolve(null);
    } catch { resolve(null); }
  });
}

// Any of the given app paths present on disk?
export function appExists(paths, fsMod = fs) {
  const list = Array.isArray(paths) ? paths : [paths];
  return new Promise(resolve => {
    try { resolve(list.some(p => exists(p, fsMod))); } catch { resolve(false); }
  });
}

export function findOriginal({ home = HOME, fs: fsMod = fs } = {}) {
  return firstExisting(['/Applications/ZCode.app', path.join(home, 'Applications', 'ZCode.app')], fsMod);
}

// The Engine lives where only Zode looks: ~/Library/Application Support/Zode/engine.noindex/ZCode.app (no
// Launchpad icon, no Spotlight hit). The old places, /Applications and ~/Applications, are still found so
// an engine from an older Zode keeps working until migrateEngine() moves it.
export const enginePathFor = (home = HOME) => path.join(home, 'Library', 'Application Support', 'Zode', 'engine.noindex', 'ZCode.app');
const legacyEngines = (home = HOME, apps = '/Applications') => [path.join(apps, 'ZCode Engine.app'), path.join(home, 'Applications', 'ZCode Engine.app')];

export function findEngine({ home = HOME, apps = '/Applications', fs: fsMod = fs } = {}) {
  return firstExisting([enginePathFor(home), ...legacyEngines(home, apps)], fsMod);
}

// Move an engine from an older Zode into the private folder, renamed "ZCode", and re-sign it (ad hoc, the
// way build-tap.sh does) since the rename edits its Info.plist. Resolves the new path, or null when there
// was nothing to move, it is running, or a step failed (the old engine then stays where it is and works).
export function migrateEngine({ home = HOME, apps = '/Applications', fs: fsMod = fs, run = execFile } = {}) {
  return new Promise(resolve => {
    try {
      const dest = enginePathFor(home);
      if (exists(dest, fsMod)) return resolve(null);
      const old = legacyEngines(home, apps).find(p => exists(p, fsMod));
      if (!old) return resolve(null);
      isRunning(old, run).then(running => {
        if (running) return resolve(null);
        try {
          fsMod.mkdirSync(path.dirname(dest), { recursive: true });
          fsMod.renameSync(old, dest);
        } catch { return resolve(null); }
        const plist = path.join(dest, 'Contents', 'Info.plist');
        run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName ZCode', plist], () => {
          run('/usr/bin/codesign', ['--force', '--deep', '-s', '-', dest], { timeout: 60000 }, () => resolve(dest));
        });
      }).catch(() => resolve(null));
    } catch { resolve(null); }
  });
}

// The old integrated copy is recognizable by the boot.cjs the old installer left inside it.
export function findOldIntegrated({ home = HOME, fs: fsMod = fs } = {}) {
  return new Promise(resolve => {
    (async () => {
      try {
        for (const p of ['/Applications/Zode.app', path.join(home, 'Applications', 'Zode.app')]) {
          if (exists(path.join(p, 'Contents', 'Resources', 'zode', 'boot.cjs'), fsMod)) return resolve(p);
        }
      } catch { /* fall through */ }
      resolve(null);
    })();
  });
}

// Is any copy of the app at appPath running right now?
export function isRunning(appPath, run = execFile) {
  return new Promise(resolve => {
    try {
      if (typeof appPath !== 'string' || !appPath) return resolve(false);
      run('pgrep', ['-f', `${appPath}/Contents/MacOS`], { timeout: 5000 }, (err, stdout) => {
        resolve(!err && String(stdout ?? '').trim() !== '');
      });
    } catch { resolve(false); }
  });
}

// Ask the app to quit politely (AppleScript), then wait up to 10 s. Resolves true when it is gone.
export async function quitApp(id, appPath, run = execFile) {
  try {
    if (typeof appPath !== 'string' || !appPath) return false;
    const pattern = `${appPath}/Contents/MacOS`;
    const running = () => new Promise(res => {
      try { run('pgrep', ['-f', pattern], { timeout: 5000 }, err => res(!err)); } catch { res(false); }
    });
    if (!(await running())) return true;
    if (id) {
      await new Promise(res => {
        try { run('/usr/bin/osascript', ['-e', `tell application id "${id}" to quit`], { timeout: 5000 }, () => res()); }
        catch { res(); }
      });
    }
    for (let n = 0; n < 20; n++) {
      await new Promise(res => setTimeout(res, 500));
      if (!(await running())) return true;
    }
    return false;
  } catch { return false; }
}

// The engine is ready when some ~/.zcode-tap/*.json points at a live process: the engine app is
// open and a project is open.
export async function tapAlive({ home = HOME, fs: fsMod = fs } = {}) {
  try {
    const dir = path.join(home, '.zcode-tap');
    let files = [];
    try { files = fsMod.readdirSync(dir); } catch { return false; }
    for (const f of files) {
      if (!String(f).endsWith('.json')) continue;
      try {
        const meta = JSON.parse(fsMod.readFileSync(path.join(dir, f), 'utf8'));
        const pid = meta?.pid;
        if (!Number.isInteger(pid)) continue;
        try { process.kill(pid, 0); return true; } catch { /* not alive */ }
      } catch { /* unreadable file */ }
    }
    return false;
  } catch { return false; }
}

// Run the Engine build (bash <kit>/scripts/build-tap.sh) and stream its output lines to onLine.
// Resolves { ok: true } or { ok: false, error }; the error carries the last output lines.
export function runBuild({ kit, dest, source, script = 'build-tap.sh', args = [], extraEnv = {}, onLine, spawn: spawnFn = spawn } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      const env = { ...process.env, ZODE_ENGINE: '1', ...extraEnv };
      if (dest) env.ZODE_TAP_APP = String(dest);
      if (source) env.ZCODE_APP = String(source);
      child = spawnFn('/bin/bash', [path.join(String(kit ?? ''), 'scripts', script), ...args], { env });
    } catch (err) { return resolve({ ok: false, error: err?.message ?? String(err) }); }
    let buf = '';
    let all = '';
    const feed = chunk => {
      all += String(chunk);
      buf += String(chunk);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { onLine?.(line); } catch { /* a bad listener never breaks the build */ }
      }
    };
    const tail = () => {
      const lines = all.split('\n').map(l => l.trim()).filter(Boolean);
      return lines.slice(-8).join(' | ');
    };
    try {
      child.stdout?.on('data', feed);
      child.stderr?.on('data', feed);           // errors stream into the same Details view
    } catch { /* stdio is optional */ }
    child.on('error', err => resolve({ ok: false, error: err?.message ?? String(err) }));
    child.on('close', code => {
      if (buf.trim()) { try { onLine?.(buf.trim()); } catch { /* ignore */ } }
      resolve(code === 0 ? { ok: true } : { ok: false, error: tail() || `the builder exited with code ${code}` });
    });
  });
}
