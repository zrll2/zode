// The running truth the session list is missing: while a turn runs, the agent's session/list keeps
// saying status: 'idle'. The event stream every server already sends tells the real story, and the
// relay forwards all of it anyway, so this tracker watches the same lines. A turn starts with a
// state.updated whose reason is prompt_started (or a patch.status of running); it settles with
// prompt_completed, a failed or cancelled reason, or patch.status idle. In between, session/event
// lines keep arriving — which also covers a relay or app that joins mid-turn. An open permission or
// question request makes a session waiting. Pure: no I/O, no timers; the clock is injected and every
// status is decided on demand, so tests move time by hand and a crashed turn expires by itself.
// Applying also rewrites a running session's updatedAt to its last event, so "quiet for N min" only
// ever means the events really stopped.

const ACTIVITY_MS = 20 * 1000;            // an event this fresh means running even without an explicit mark
const STALE_MS = 120 * 1000;              // a running mark with no event for this long expires to idle
const IDLE_GRACE_MS = 3 * 1000;           // events this soon after a settle are the old turn trailing off
const FORGET_MS = 6 * 60 * 60 * 1000;     // a session unseen for this long is dropped from memory
const WAITING = new Set(['interaction/requestPermission', 'interaction/requestUserInput']);

export function createLiveStatus({ now = Date.now } = {}) {
  const sessions = new Map();             // sessionId -> { seenAt, explicit, since, lastEventAt, activityAt, idleAt }
  const waiting = new Map();              // sessionId -> when the pending list last said so

  const record = id => {
    let r = sessions.get(id);
    if (!r) sessions.set(id, r = { seenAt: 0, explicit: null, since: 0, lastEventAt: 0, activityAt: 0, idleAt: 0 });
    return r;
  };
  function forget(t) {
    if (sessions.size < 64) return;
    for (const [id, r] of sessions) if (t - r.seenAt > FORGET_MS) sessions.delete(id);
  }

  function observe(msg) {
    const method = msg?.method;
    if (typeof method !== 'string') return;
    if (method.startsWith('v4/telemetry') || method.startsWith('process/') || method === 'startup/storageState') return;
    const p = msg.params;
    if (method === 'state.updated') {
      if (p?.scope !== 'session' || p.sessionId == null) return;
      const t = now(), r = record(String(p.sessionId));
      r.seenAt = t; forget(t);
      const patch = p.patch && typeof p.patch === 'object' ? p.patch : {};
      const reason = typeof p.reason === 'string' ? p.reason : '';
      if (reason === 'prompt_started' || patch.status === 'running') { r.explicit = 'running'; r.since = t; r.idleAt = 0; }
      else if (reason === 'prompt_completed' || patch.status === 'idle' || /failed|cancel/i.test(reason)) { r.explicit = 'idle'; r.idleAt = t; r.since = 0; }
      return;
    }
    if (method === 'session/event') {
      if (p?.sessionId == null) return;
      const t = now(), r = record(String(p.sessionId));
      r.seenAt = t; r.lastEventAt = t; forget(t);
      if (!(r.idleAt && t - r.idleAt <= IDLE_GRACE_MS)) r.activityAt = t;   // a flush right after a settle is not a new turn
    }
  }

  // null means the tracker has no opinion and the list's own status stands.
  function statusOf(id, t) {
    if (waiting.has(id)) return 'waiting';
    const r = sessions.get(id);
    if (!r) return null;
    if (r.explicit === 'running') {
      if (t - Math.max(r.since, r.lastEventAt) <= STALE_MS) return 'running';
      r.explicit = 'idle'; r.idleAt = Math.max(r.since, r.lastEventAt); r.since = 0;       // no event for 120 s: the turn is gone
    }
    if (r.activityAt && t - r.activityAt <= ACTIVITY_MS && r.activityAt > r.idleAt) return 'running';
    return null;
  }

  function setPending(list) {
    waiting.clear();
    const t = now();
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || typeof p !== 'object' || !WAITING.has(p.method) || p.sessionId == null) continue;
      waiting.set(String(p.sessionId), t);
    }
  }

  function apply(list) {
    if (!Array.isArray(list)) return list;
    const t = now();
    return list.map(s => {
      if (!s || typeof s !== 'object' || s.sessionId == null) return s;
      const id = String(s.sessionId);
      const status = statusOf(id, t);
      if (status === 'waiting') return { ...s, status: 'waiting' };
      if (status !== 'running') return s;
      const r = sessions.get(id);
      const at = Math.max(r.since, r.lastEventAt) || 0;
      return { ...s, status: 'running', updatedAt: Math.max(Number(s.updatedAt) || 0, at), liveSince: r.since || undefined };
    });
  }

  return { observe, setPending, apply };
}
