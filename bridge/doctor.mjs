#!/usr/bin/env node
// Preflight for delegating work to ZCode.  node doctor.mjs [worktree] [--models]
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ok = (m) => console.log('OK   ' + m), bad = (m) => { console.log('FAIL ' + m); failed++; }; let failed = 0;
const sh = (c, a) => { try { return execFileSync(c, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

// 1. Zode.app (the signed copy with the tee wrapper) must be running
const tapApp = ['/Applications/Zode.app', path.join(os.homedir(), 'Applications/Zode.app'), path.join(os.homedir(), 'Applications/ZCode-Tap.app')].find(p => fs.existsSync(p)) || '/Applications/Zode.app';  // old name and location still work
if (!fs.existsSync(tapApp)) bad('Zode.app missing at /Applications. Run `zode install`.');
else if (!sh('pgrep', ['-f', path.basename(tapApp) + '/Contents/Frameworks'])) bad('Zode.app is not running. Start it:  open /Applications/Zode.app   (quit the original ZCode first)');
else ok('Zode.app is running');

// 2. tap sockets
const dir = path.join(os.homedir(), '.zcode-tap');
let metas = [];
try { metas = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter(m => { try { process.kill(m.pid, 0); return true; } catch { return false; } }); } catch {}
metas.length ? ok(`${metas.length} ZCode server socket(s)`) : bad('no tap sockets in ~/.zcode-tap (open a project in Zode.app first)');

// 3. model available (opt-in: creates and closes one probe session, which stays in the ZCode list)
if (metas.length && process.argv.includes('--models')) {
  const m = metas[0];
  const res = await new Promise(done => {
    const c = net.connect(m.sock); let b = '';
    c.on('data', x => { b += x; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); try { const o = JSON.parse(l); if (o.tapReply && o.id === 1) { c.destroy(); done(o); } } catch {} } });
    c.on('connect', () => c.write(JSON.stringify({ id: 1, method: 'session/create', params: { workspace: { workspacePath: m.cwd, workspaceKey: m.cwd }, mode: 'plan' } }) + '\n'));
    c.on('error', () => done(null)); setTimeout(() => { c.destroy(); done(null); }, 8000);
  });
  const av = res?.result?.settings?.model?.available ?? [];
  if (res?.result?.session?.sessionId) {                       // do not leave the probe session behind
    const c = net.connect(m.sock); c.on('connect', () => { c.write(JSON.stringify({ id: 2, method: 'session/close', params: { sessionId: res.result.session.sessionId } }) + '\n'); setTimeout(() => c.destroy(), 500); });
  }
  av.length ? ok('models: ' + av.map(a => a.ref.modelId).filter((v, i, a) => a.indexOf(v) === i).join(', ')) : bad('no models available (is Zode.app logged in?)');
}

// 4. worktree rules
const wt = process.argv.slice(2).find(a => !a.startsWith('--'));
if (wt) {
  const git = (...a) => sh('git', ['-C', wt, ...a]);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch) bad(`${wt} is not a git repository`);
  else {
    branch.startsWith('zcode/') ? ok(`branch ${branch}`) : bad(`branch is '${branch}', it must be zcode/*`);
    const r = p => path.resolve(wt, p);
    r(git('rev-parse', '--git-dir')) !== r(git('rev-parse', '--git-common-dir')) ? ok('separate git worktree') : bad('this is the main checkout. Use: git worktree add ../x-wt -b zcode/<task>');
    git('status', '--porcelain') ? console.log('NOTE worktree has uncommitted changes (commit them before the next order so the diff stays readable)') : ok('worktree is clean');
  }
}
console.log(failed ? `\n${failed} problem(s). Fix them, then retry.` : '\nReady to delegate.');
process.exit(failed ? 1 : 0);
