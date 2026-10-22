// The menu bar (tray) menu as plain template objects, so it can be built and tested without Electron.
const HINT = 'Not encrypted. Use Tailscale away from home.';

// Menus cannot right-align a second piece of text, so each line is padded with spaces until the whole line has
// the same width: the status then ends at one right edge. Widths are measured in the real font by the app
// (state.work.metrics) and fall back to a rough per-character estimate (em) in tests and before the first measure.
const NBSP = '\u00a0';                                               // a plain no-break space: the same glyph (and width) in the menu font and in the measuring canvas
export function textWidth(str) {                                      // estimate, in em
  let w = 0;
  for (const ch of String(str)) {
    if (/[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch)) w += 1;                    // CJK and full-width
    else if (/[ijl.,:;'|!]/.test(ch)) w += 0.28;
    else if (/[ftr\- ()]/.test(ch)) w += 0.36;
    else if (/[mwMW]/.test(ch)) w += 0.88;
    else if (/[A-Z]/.test(ch)) w += 0.66;
    else if (/[0-9]/.test(ch)) w += 0.58;
    else w += 0.56;
  }
  return w;
}
const ESTIMATE = { space: 0.26 };                                     // width of one space in the same unit
export function padTo(width, sp = ESTIMATE) {                         // as many spaces as come closest to `width`
  return NBSP.repeat(Math.max(0, Math.round(width / sp.space)));
}
// "<project><spaces><status>" with every status ending at the same right edge.
// lines[i].px = { project, status } (measured) when available; metrics = { space, gap } in the same unit.
export function alignedLabels(lines, metrics) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const measured = !!metrics && lines.every(l => l.px && Number.isFinite(l.px.project) && Number.isFinite(l.px.status));
  const w = l => (measured ? { p: l.px.project, s: l.px.status } : { p: textWidth(l.project), s: textWidth(l.status) });
  const sp = measured ? metrics : ESTIMATE;
  const gap = measured && Number.isFinite(metrics.gap) ? metrics.gap : 0.5;
  const total = Math.max(0, ...lines.map(l => w(l).p + w(l).s)) + gap;
  return lines.map(l => `${l.project}${padTo(total - w(l).p - w(l).s, sp)}${l.status}`);
}

// The submenu for a conversation that needs the user: allow/deny per pending permission request
// (state.work.pending, keyed by sessionId, oldest first), answer-in-ZCode for a question or when
// nothing matches, nudge and stop for a stalled turn, try again for a failed one. Finished and
// normally-running lines keep their plain click and get no submenu (null).
function lineSubmenu(line, work, actions) {
  if (line.done) return null;
  const pending = (work.pending ?? {})[line.id] ?? [];
  if (line.light === 'amber' && line.status === 'Waiting for you') {
    const requests = pending.filter(p => p.kind === 'permission').slice(0, 3);     // oldest first, three at most
    const question = pending.some(p => p.kind === 'question');
    if (requests.length === 0) return [{ label: 'Answer in ZCode…', click: () => actions.openEngine() }];   // a question (or nothing we can answer): the Engine only
    const items = [];
    for (const r of requests) {
      items.push(
        { label: r.summary || r.toolName || 'Permission request', enabled: false },
        { label: 'Allow once', click: () => actions.approve(r.requestId, r.sock, r.risky === true, r.summary) },
        { label: 'Deny', click: () => actions.deny(r.requestId, r.sock) },
      );
    }
    if (question) items.push({ label: 'Answer in ZCode…', click: () => actions.openEngine() });
    items.push({ type: 'separator' }, { label: 'Show in ZCode', click: () => actions.openEngine() });
    return items;
  }
  if (line.light === 'amber') {                                    // Quiet for N min: the turn may be stuck
    return [
      { label: 'Nudge (stop and continue)', click: () => actions.nudge(line.id, line.sock) },
      { label: 'Stop', click: () => actions.stop(line.id, line.sock) },
      { label: 'Show in ZCode', click: () => actions.openEngine() },
    ];
  }
  if (line.light === 'red') {                                      // Failed: send the try-again message
    return [
      { label: 'Try again', click: () => actions.retry(line.id, line.sock) },
      { label: 'Show in ZCode', click: () => actions.openEngine() },
    ];
  }
  return null;
}

// The ZCode-now block for the top of the menu: a header that carries a right-aligned "Refresh" and is
// itself the button, one clickable line per conversation with its status light (a green tick when
// finished), an optional "Finished (N)" submenu when the user folded them, a +N more stub and a
// separator. Icons arrive as opaque values in state.icons, so this stays testable. A line opens the
// Engine app.
function workItems(state, actions) {
  const work = state.work;
  if (!work || !Array.isArray(work.lines) || work.lines.length === 0) return [];
  const icons = state.icons ?? {};
  const fold = state.foldFinished === true;
  const HEADER = { project: 'ZCode right now', status: 'Refresh', px: work.headerPx };
  const aligned = alignedLabels([HEADER, ...work.lines], work.metrics);
  const headerLabel = aligned[0];
  const labels = aligned.slice(1);
  const entry = (line, i) => {
    const submenu = lineSubmenu(line, work, actions);
    return {
      id: line.id != null ? `work-${line.id}` : undefined,
      label: labels[i],
      icon: line.done ? (icons.tick ?? icons[line.light]) : icons[line.light],
      ...(submenu ? { submenu } : {}),                 // the arrow appears on its own; the label stays as measured
      click: () => actions.openEngine(),
    };
  };
  const rows = work.lines.map((line, i) => ({ line, item: entry(line, i) }));
  // Finished more than an hour ago folds into its own submenu by default; "Fold finished" folds every finished line.
  const folded = r => r.line.done && (fold || r.line.older);
  const active = rows.filter(r => !folded(r)).map(r => r.item);
  const tucked = rows.filter(folded).map(r => r.item);
  const items = [{ label: headerLabel, click: () => actions.refreshWork?.() }, ...active];
  if (tucked.length) items.push({ label: fold ? `Finished (${tucked.length})` : `Finished over an hour ago (${tucked.length})`, submenu: tucked });
  if (work.more > 0) items.push({ label: `+${work.more} more`, enabled: false });
  if (work.lines.some(l => l.done)) items.push({ label: 'Fold finished', type: 'checkbox', checked: fold, click: () => actions.toggleFoldFinished?.() });
  items.push({ type: 'separator' });
  return items;
}

export function buildMenuTemplate(state, actions) {
  const devices = state.devices ?? [];
  const phones = state.phones ?? devices.length;
  let line;
  if (state.error) line = ('Relay error: ' + state.error).slice(0, 80);
  else if (state.running) line = phones === 1 ? 'Relay running · 1 phone' : phones > 1 ? `Relay running · ${phones} phones` : 'Relay running · no phones paired';
  else line = 'Relay stopped';
  const addresses = state.addresses ?? [];
  const engine = state.engine ?? { path: null };
  const connected = state.tapAlive === true;
  const update = state.update;                                     // { available, originalVersion, engineVersion }
  const release = state.release;                                   // { available, latest, installed } from the release check
  const self = state.selfUpdate ?? null;                           // { phase, version, percent, ... } from the self-updater
  const selfHead = [];
  if (self && self.phase === 'ready') {
    selfHead.push({ label: `Restart to update Zode (${self.version ?? 'new version'})`, click: () => actions.installSelfUpdate() });
    selfHead.push({ type: 'separator' });
  } else if (self && self.phase === 'downloading') {
    selfHead.push({ label: `Downloading the Zode update…${Number.isFinite(self.percent) ? ` ${self.percent}%` : ''}`, enabled: false });
    selfHead.push({ type: 'separator' });
  }
  return [
    // The app's own update, when there is something to show for it right now.
    ...selfHead,
    // What ZCode is doing right now: one line per conversation, red first, status in its own column.
    ...workItems(state, actions),
    // A newer release online: one click updates ZCode and rebuilds the Engine, so the plain
    // engine-rebuild item is not shown next to it.
    ...(release?.available ? [
      {
        label: release.latest
          ? `ZCode ${release.latest} is available. Update ZCode…`
          : 'A new ZCode is available. Update ZCode…',
        click: () => actions.updateZcode(),
      },
      { type: 'separator' },
    ] : []),
    ...(update?.available && !release?.available ? [
      { label: `ZCode ${update.originalVersion} is installed. Rebuild the engine…`, click: () => actions.rebuildEngine() },
      { type: 'separator' },
    ] : []),
    { label: line, enabled: false },
    { label: connected ? 'ZCode connected' : 'Waiting for ZCode', enabled: false },
    { label: 'Pair a phone…', click: () => actions.pair() },
    {
      label: 'Paired phones',
      enabled: devices.length > 0,
      submenu: devices.map(d => ({ label: `Revoke ${d.name}`, click: () => actions.revoke(d.id) })),
    },
    { type: 'separator' },
    { label: 'Relay on', type: 'checkbox', checked: !!state.running, click: () => actions.toggleRelay() },
    {
      label: 'Reachable from',
      submenu: [
        ...addresses.map(a => ({ label: a.label, type: 'radio', checked: a.id === state.addressId, click: () => actions.selectAddress(a.id) })),
        ...(state.addressId === 'lan' ? [{ label: HINT, enabled: false }] : []),
      ],
    },
    { label: 'Start Zode when you log in', type: 'checkbox', checked: !!state.launchAtLogin, click: () => actions.toggleLaunchAtLogin() },
    { label: 'Keep my Mac awake while Zode is on', type: 'checkbox', checked: !!state.keepAwake, click: () => actions.toggleKeepAwake() },
    { type: 'separator' },
    { label: 'Set up ZCode…', click: () => actions.setup() },
    // Open the Engine app (the user's own ZCode); disabled while it does not exist.
    ...(engine.path
      ? [{ label: 'Open ZCode…', enabled: true, click: () => actions.openEngine() }]
      : [{ label: 'ZCode Engine not found', enabled: false }]),
    ...(self ? [{ label: 'Check for Zode updates…', click: () => actions.checkSelfUpdate() }] : []),
    { label: 'About Zode', click: () => actions.about() },
    { label: 'Quit Zode', click: () => actions.quit() },
  ];
}
