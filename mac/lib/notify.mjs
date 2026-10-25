// Notifications for changes between two snapshots of the Zode-now lines. Pure: the caller keeps the
// previous snapshot and passes it back in — nothing here remembers anything. States are the panel's
// own classification: running (green), waiting for you (amber), stalled (amber, quiet), failed
// (red), finished (done), idle (anything else).
const FINISHED_RECENT_MS = 5 * 60 * 1000;     // idle-after-running only counts as a finish while fresh

// The simplified line states the diff works with. Junk in, nothing out.
export function lineStates(lines) {
  const states = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || typeof line !== 'object' || line.id == null) continue;
    states.push({
      id: line.id,
      project: typeof line.project === 'string' ? line.project : '',
      title: typeof line.title === 'string' ? line.title : '',
      state: line.light === 'red' ? 'failed'
        : line.status === 'Waiting for you' ? 'waiting'
        : line.light === 'amber' ? 'stalled'                       // "Quiet for N min"
        : line.done === true ? 'finished'
        : line.light === 'green' ? 'running'
        : 'idle',
      at: Number.isFinite(line.at) ? line.at : 0,
    });
  }
  return states;
}

function byId(states) {
  const map = new Map();
  for (const s of Array.isArray(states) ? states : []) {
    if (s && typeof s === 'object' && s.id != null) map.set(s.id, s);
  }
  return map;
}

const entry = (id, kind, e) => ({ id, kind, project: typeof e.project === 'string' ? e.project : '', title: typeof e.title === 'string' ? e.title : '' });

// A run shorter than this stays quiet when it ends (a failed one never does). The run's start rides
// on the snapshot entries as `since` — the caller remembers it, the diff only reads it.
function shortRun(e, was, now, minRunMs) {
  const since = Number.isFinite(e.since) && e.since > 0 ? e.since : Number.isFinite(was.since) && was.since > 0 ? was.since : 0;
  if (!since) return false;                                     // unknown start: do not suppress
  return (Number(e.at) || now) - since < minRunMs;
}

// What changed between the two snapshots, as [{ id, kind, project, title }] with kind one of
// finished | failed | needs | stalled — or a single { kind: 'many', count } when more than three
// fire at once. The first snapshot (prev null) is the baseline and is always silent; a conversation
// that was never seen running is only announced when it needs the user or failed; every (id, kind)
// fires once per state change, never again while the state stays.
export function notificationsFor(prev, next, { now = Date.now(), minRunMs = 20000 } = {}) {
  if (prev == null) return [];                                  // baseline
  const before = byId(prev);
  const out = [];
  for (const [id, e] of byId(next)) {
    if (!e || typeof e.state !== 'string') continue;
    const was = before.get(id);
    if (!was) {                                                 // never seen before: only the loud ones
      if (e.state === 'waiting') out.push(entry(id, 'needs', e));
      else if (e.state === 'failed') out.push(entry(id, 'failed', e));
      continue;
    }
    if (was.state === e.state) continue;                        // no change, no repeat
    if (e.state === 'failed') out.push(entry(id, 'failed', e));
    else if (e.state === 'waiting') out.push(entry(id, 'needs', e));
    else if (e.state === 'stalled') {
      if (was.state === 'running') out.push(entry(id, 'stalled', e));
    } else if (e.state === 'finished' || (e.state === 'idle' && now - (Number(e.at) || 0) <= FINISHED_RECENT_MS)) {
      if ((was.state === 'running' || was.state === 'stalled') && !shortRun(e, was, now, minRunMs)) out.push(entry(id, 'finished', e));
    }
  }
  if (out.length > 3) return [{ kind: 'many', count: out.length }];
  return out;
}
