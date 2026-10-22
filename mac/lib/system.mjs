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

export function findEngine({ home = HOME, fs: fsMod = fs } = {}) {
  return firstExisting(['/Applications/ZCode Engine.app', path.join(home, 'Applications', 'ZCode Engine.app')], fsMod);
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
export function runBuild({ kit, dest, source, onLine, spawn: spawnFn = spawn } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      const env = { ...process.env, ZODE_ENGINE: '1' };
      if (dest) env.ZODE_TAP_APP = String(dest);
      if (source) env.ZCODE_APP = String(source);
      child = spawnFn('/bin/bash', [path.join(String(kit ?? ''), 'scripts', 'build-tap.sh')], { env });
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
