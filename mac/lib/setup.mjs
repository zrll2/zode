// Pure helpers for the first-run setup wizard: the ordered steps, the build progress mapping, plain
// error words and the engine-kit folder. Nothing here touches the world, and nothing throws.
import path from 'node:path';

const STEPS = [
  { id: 'prepare', title: 'Get ZCode ready', key: 'engineExists' },
  { id: 'login', title: 'Open ZCode and sign in', key: 'tapAlive' },
  { id: 'phone', title: 'Pair your phone', key: 'setupDone' },
];

// facts: { originalExists, engineExists, tapAlive, setupDone }. The first step not done is current,
// everything after it is todo; a fully done list is all done.
export function setupSteps(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  let currentSeen = false;
  return STEPS.map(({ id, title, key }) => {
    let state;
    if (f[key] === true) state = 'done';
    else if (!currentSeen) { state = 'current'; currentSeen = true; }
    else state = 'todo';
    return { id, title, state };
  });
}

// A build-tap.sh output line → friendly label + percent for the progress bar. Anything else is null.
export function parseBuildProgress(line) {
  const t = typeof line === 'string' ? line : '';
  if (t.includes('Downloading ZCode')) return { label: 'Downloading ZCode', percent: 8 };
  if (t.includes('Verifying')) return { label: 'Checking the download', percent: 30 };
  if (t.includes('Copying')) return { label: 'Copying ZCode (this takes a minute)', percent: 10 };
  if (t.includes('Engine mode')) return { label: 'Setting things up', percent: 70 };
  if (t.includes('Signing')) return { label: 'Almost done', percent: 85 };
  if (t.includes('Built')) return { label: 'Done', percent: 100 };
  return null;
}

// One plain sentence plus a hint line for the failures people actually hit; anything unknown points
// at the log instead of showing raw errors.
export function friendlySetupError(text) {
  const t = String(text ?? '');
  if (/no space left|disk full|enospc/i.test(t)) {
    return { message: 'Your Mac is out of disk space.', hint: 'The copy of ZCode needs about 1 GB. Free up some space and try again.' };
  }
  if (/permission denied|not permitted|read-only|eacces|eperm/i.test(t)) {
    return { message: 'Zode could not save its copy of ZCode.', hint: 'That folder is protected. Ask an administrator for help, or install into your home folder instead.' };
  }
  if (/is running/i.test(t)) {
    return { message: 'ZCode is open.', hint: 'Quit ZCode (Cmd+Q) and try again.' };
  }
  if (/not found|does not look like zcode|no such file/i.test(t)) {
    return { message: 'Zode could not find the ZCode app.', hint: 'Install ZCode from zcode.z.ai, then try again.' };
  }
  return { message: 'Something went wrong. Details are in ~/.zode/mac-app.log', hint: '' };
}

// Where the kit (scripts/, bridge/) lives: a packaged app carries it in Resources/engine-kit; in
// development it is the repo root.
export function kitDir({ packaged, resourcesPath, devRoot } = {}) {
  if (packaged) return path.join(String(resourcesPath ?? ''), 'engine-kit');
  return String(devRoot ?? '');
}
