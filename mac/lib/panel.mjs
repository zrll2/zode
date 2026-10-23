// The menu bar panel's view model: one pure function from the app's state to the JSON-safe object
// the panel window draws. Nothing here touches Electron, sockets or the disk, so it is fully
// testable; nothing here throws — missing or broken input yields the quiet empty model.
//
// input is menuState() plus what the panel adds on top: `version` (the app's own version), and on
// every work line `at` (ms since the epoch, the session's last activity) so the panel can show ages
// relative to `now`. work.pending stays keyed by sessionId, oldest request first, exactly as
// refreshSessions() builds it.

const MIN = 60 * 1000;

// An age the way the panel shows it: 'now', '3 min', '1 h'; '' when there is nothing to show.
function relAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < MIN) return 'now';
  if (ms < 60 * MIN) return `${Math.floor(ms / MIN)} min`;
  return `${Math.floor(ms / (60 * MIN))} h`;
}

const str = v => (typeof v === 'string' ? v : '');
const ageOf = (line, now) => (Number.isFinite(line.at) ? Math.max(0, now - line.at) : NaN);

// One "needs you" card from one amber or red line. A waiting conversation with a permission request
// shows that request (the oldest one: listPending hands them over oldest first); a waiting one with
// only a question — or nothing we can answer — points at ZCode; a quiet turn may be stuck; a failed
// one can be retried.
function needOf(line, pending, now) {
  const base = {
    id: line.id,
    project: str(line.project) || 'Zode',
    sessionId: line.sessionId != null ? line.sessionId : line.id,
    sock: str(line.sock),
  };
  const waiting = relAge(ageOf(line, now));
  if (line.light === 'red') return { ...base, kind: 'failed', ask: 'The last attempt failed.', waiting };
  if (line.light !== 'amber') return null;
  if (line.status === 'Waiting for you') {
    const oldest = (Array.isArray(pending) ? pending : []).find(r => r && r.kind === 'permission');
    if (oldest) {
      return {
        ...base, kind: 'ask',
        ask: str(oldest.summary) || str(oldest.toolName) || 'Permission request',
        waiting, requestId: oldest.requestId, risky: oldest.risky === true,
      };
    }
    return { ...base, kind: 'question', ask: 'Needs an answer in ZCode', waiting };
  }
  const m = /^Quiet for (\d+) min/.exec(str(line.status));
  const n = m ? m[1] : null;
  return {
    ...base, kind: 'stalled',
    ask: n ? `No activity for ${n} min. It may be stuck.` : 'No activity. It may be stuck.',
    waiting: n ? `${n} min` : waiting,
  };
}

// One banner at most, by precedence: setup first, then Zode's own downloaded update, then a newer
// ZCode release online (one click updates and rebuilds, so the plain rebuild hides next to it), then
// the engine rebuild when the original ZCode on disk is newer than the Engine copy. The setup checks
// read the explicit fields a real menuState always carries, so junk input stays quiet instead of
// nagging about setup.
function bannerOf(s) {
  const engine = s.engine && typeof s.engine === 'object' ? s.engine : null;
  const engineMissing = !!engine && !str(engine.path);
  const setupUndone = s.tapAlive === false && s.setupDone === false;
  if (engineMissing || setupUndone) {
    return {
      kind: 'setup', title: 'Finish setting up',
      detail: 'Zode needs its own copy of ZCode before your phone can connect.',
      button: 'Set up',
    };
  }
  const self = s.selfUpdate;
  if (self && self.phase === 'ready') {
    return {
      kind: 'update',
      title: str(self.version) ? `Zode ${self.version} is ready` : 'A Zode update is ready',
      detail: 'Restart to finish updating. Your work is not interrupted.',
      button: 'Restart',
    };
  }
  const release = s.release;
  if (release && release.available === true) {
    return {
      kind: 'zcode',
      title: str(release.latest) ? `ZCode ${release.latest} is available` : 'A new ZCode is available',
      detail: 'Zode updates ZCode and rebuilds the Engine.',
      button: 'Update ZCode',
    };
  }
  const update = s.update;
  if (update && update.available === true) {
    return {
      kind: 'zcode',
      title: str(update.originalVersion) ? `ZCode ${update.originalVersion} is installed` : 'A newer ZCode is installed',
      detail: 'The Engine is older. Rebuild it from this ZCode.',
      button: 'Rebuild the engine',
    };
  }
  return null;
}

export function buildPanelModel(input, now = Date.now()) {
  try {
    const s = input && typeof input === 'object' ? input : {};
    const work = s.work && typeof s.work === 'object' ? s.work : {};
    const lines = Array.isArray(work.lines) ? work.lines.filter(l => l && typeof l === 'object') : [];
    const pendingBySession = work.pending && typeof work.pending === 'object' ? work.pending : {};
    const connected = s.tapAlive === true;
    const t = Number.isFinite(now) ? now : Date.now();

    const needs = [];
    const working = [];
    const done = [];
    const earlier = [];
    for (const line of lines) {
      const pending = Array.isArray(pendingBySession[line.id]) ? pendingBySession[line.id] : [];
      if (!line.done && (line.light === 'red' || line.light === 'amber')) {
        const need = needOf(line, pending, t);
        if (need) needs.push(need);
      } else if (!line.done && line.light === 'green') {
        working.push({ id: line.id, project: str(line.project) || 'Zode', doing: 'Working', t: relAge(ageOf(line, t)) });
      } else if (line.done) {
        const row = { id: line.id, project: str(line.project) || 'Zode', t: str(line.status) || relAge(ageOf(line, t)) };
        (line.older ? earlier : done).push(row);
      }
    }
    // Red before amber: a failed conversation cannot continue on its own. The ambers keep their
    // order (summarize already sorts each group newest first), and sort is stable, so this suffices.
    needs.sort((a, b) => (a.kind === 'failed' ? 0 : 1) - (b.kind === 'failed' ? 0 : 1));

    const n = needs.length;
    const w = working.length;
    const self = s.selfUpdate && typeof s.selfUpdate === 'object' ? s.selfUpdate : {};
    return {
      glyph: n ? 'needs' : w ? 'working' : 'idle',
      summary: {
        title: n ? `${n} need${n > 1 ? '' : 's'} you${w ? ` · ${w} working` : ''}` : w ? `${w} working` : 'All quiet',
        tone: n ? 'warn' : 'plain',
        sub: !connected ? 'ZCode is not connected yet' : s.keepAwake === true ? 'Mac awake · ZCode connected' : 'ZCode connected',
      },
      banner: bannerOf(s),
      needs,
      working,
      done,
      earlier,
      phones: Number.isFinite(s.phones) && s.phones >= 0 ? Math.floor(s.phones) : 0,
      connected,
      settings: {
        keepAwake: s.keepAwake === true,
        relayEnabled: s.running === true,
        launchAtLogin: s.launchAtLogin === true,
        foldFinished: s.foldFinished === true,
        addressId: str(s.addressId),
        addresses: (Array.isArray(s.addresses) ? s.addresses : [])
          .filter(a => a && typeof a === 'object' && str(a.id) && str(a.label))
          .map(a => ({ id: str(a.id), label: str(a.label) })),
        version: str(s.version),
        selfUpdate: self.phase === 'ready' ? 'ready' : self.phase === 'downloading' ? 'downloading' : 'idle',
      },
    };
  } catch {
    // The quiet empty panel: what a fresh, disconnected, do-nothing Zode looks like.
    return {
      glyph: 'idle',
      summary: { title: 'All quiet', tone: 'plain', sub: 'ZCode is not connected yet' },
      banner: null,
      needs: [], working: [], done: [], earlier: [],
      phones: 0,
      connected: false,
      settings: {
        keepAwake: false, relayEnabled: false, launchAtLogin: false, foldFinished: false,
        addressId: '', addresses: [], version: '', selfUpdate: 'idle',
      },
    };
  }
}
