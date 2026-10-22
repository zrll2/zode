// The menu bar (tray) menu as plain template objects, so it can be built and tested without Electron.
const HINT = 'Not encrypted. Use Tailscale away from home.';

// The ZCode-now block for the top of the menu: a disabled header, one clickable line per active
// conversation with its status light, a +N more stub, and a separator. The lights arrive as opaque
// icon values in state.icons, so this stays testable without Electron.
// Rough text width in em (San Francisco at menu size): menus cannot right-align a second piece of text, so
// the status is pushed into its own column with em/en/thin spaces. An estimate is enough for a clean column.
const EM = '\u2003', EN = '\u2002', THIN = '\u2009';
export function textWidth(str) {
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
export function padTo(width) {                                       // spaces totalling about `width` em
  let out = '';
  let left = Math.max(0, width);
  while (left >= 1) { out += EM; left -= 1; }
  if (left >= 0.5) { out += EN; left -= 0.5; }
  while (left >= 0.1) { out += THIN; left -= 0.2; }
  return out;
}
// "<project>   <status>" with every status starting in the same column.
export function alignedLabels(lines) {
  const widest = Math.max(0, ...lines.map(l => textWidth(l.project)));
  return lines.map(l => `${l.project}${padTo(widest - textWidth(l.project) + 2)}${l.status}`);
}

function workItems(state, actions) {
  const work = state.work;
  if (!work || !Array.isArray(work.lines) || work.lines.length === 0) return [];
  const icons = state.icons ?? {};
  const items = [{ label: 'ZCode right now', enabled: false }];
  const labels = alignedLabels(work.lines);
  for (const [i, line] of work.lines.entries()) {
    items.push({
      id: line.id != null ? `work-${line.id}` : undefined,
      label: labels[i],
      icon: line.done ? (icons.tick ?? icons[line.light]) : icons[line.light],
      click: () => actions.showZCode(),
    });
  }
  if (work.more > 0) items.push({ label: `+${work.more} more`, enabled: false });
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
