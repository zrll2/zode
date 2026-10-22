// The menu bar (tray) menu as plain template objects, so it can be built and tested without Electron.
const HINT = 'Not encrypted. Use Tailscale away from home.';

// The ZCode-now block for the top of the menu: a disabled header, one clickable line per active
// conversation with its status light, a +N more stub, and a separator. The lights arrive as opaque
// icon values in state.icons, so this stays testable without Electron.
// Menus cannot right-align a second piece of text, so each line is padded with spaces until the whole line has
// the same width: the status then ends at one right edge. Widths are measured in the real font by the app
// (state.work.metrics) and fall back to a rough per-character estimate (em) in tests and before the first measure.
const EM = '\u2003', EN = '\u2002', THIN = '\u2009';
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
const ESTIMATE = { em: 1, en: 0.5, thin: 0.2 };                      // space widths in the same unit
export function padTo(width, sp = ESTIMATE) {                         // spaces totalling about `width`
  let out = '';
  let left = Math.max(0, width);
  while (left >= sp.em) { out += EM; left -= sp.em; }
  if (left >= sp.en) { out += EN; left -= sp.en; }
  while (left >= sp.thin * 0.5) { out += THIN; left -= sp.thin; }
  return out;
}
// "<project><spaces><status>" with every status ending at the same right edge.
// lines[i].px = { project, status } (measured) when available; metrics = { em, en, thin, gap } in the same unit.
export function alignedLabels(lines, metrics) {
  const measured = !!metrics && lines.every(l => l.px && Number.isFinite(l.px.project) && Number.isFinite(l.px.status));
  const w = l => (measured ? { p: l.px.project, s: l.px.status } : { p: textWidth(l.project), s: textWidth(l.status) });
  const sp = measured ? metrics : ESTIMATE;
  const gap = measured && Number.isFinite(metrics.gap) ? metrics.gap : 0.7;
  const total = Math.max(0, ...lines.map(l => w(l).p + w(l).s)) + gap;
  return lines.map(l => `${l.project}${padTo(total - w(l).p - w(l).s, sp)}${l.status}`);
}

// The ZCode-now block for the top of the menu: a disabled header, one clickable line per conversation with its
// status light (a green tick when finished), an optional "Finished (N)" submenu when the user folded them, a
// +N more stub and a separator. Icons arrive as opaque values in state.icons, so this stays testable.
function workItems(state, actions) {
  const work = state.work;
  if (!work || !Array.isArray(work.lines) || work.lines.length === 0) return [];
  const icons = state.icons ?? {};
  const fold = state.foldFinished === true;
  // The header line carries a right-aligned "↻ Refresh" and is itself the button: it re-reads ZCode and reopens the menu.
  const HEADER = { project: 'ZCode right now', status: 'Refresh', px: work.headerPx };
  const aligned = alignedLabels([HEADER, ...work.lines], work.metrics);
  const headerLabel = aligned[0];
  const labels = aligned.slice(1);
  const entry = (line, i) => ({
    id: line.id != null ? `work-${line.id}` : undefined,
    label: labels[i],
    icon: line.done ? (icons.tick ?? icons[line.light]) : icons[line.light],
    click: () => actions.showZCode(),
  });
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
  const update = state.update;                                     // { available, originalVersion, runningVersion }
  const release = state.release;                                   // { available, latest, installed } from the release check
  return [
    // What ZCode is doing right now: one line per active conversation, red first.
    ...workItems(state, actions),
    // A newer release online: one click runs scripts/update-zcode.sh, which includes the rebuild,
    // so the plain rebuild item is not shown next to it.
    ...(release?.available ? [
      {
        label: release.latest
          ? `ZCode ${release.latest} is available. Update ZCode and rebuild Zode…`
          : 'A new ZCode is available. Update ZCode and rebuild Zode…',
        click: () => actions.updateZcode(),
      },
      { type: 'separator' },
    ] : []),
    ...(update?.available && !release?.available ? [
      { label: `ZCode ${update.originalVersion} is installed. Rebuild Zode…`, click: () => actions.rebuild() },
      { type: 'separator' },
    ] : []),
    { label: line, enabled: false },
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
    { type: 'separator' },
    { label: 'Open ZCode window', click: () => actions.showZCode() },
    { label: 'About Zode', click: () => actions.about() },
  ];
}
