// The menu bar (tray) menu as plain template objects, so it can be built and tested without Electron.
const HINT = 'Not encrypted. Use Tailscale away from home.';

// The ZCode-now block for the top of the menu: a disabled header, one clickable line per active
// conversation with its status light, a +N more stub, and a separator. The lights arrive as opaque
// icon values in state.icons, so this stays testable without Electron.
function workItems(state, actions) {
  const work = state.work;
  if (!work || !Array.isArray(work.lines) || work.lines.length === 0) return [];
  const icons = state.icons ?? {};
  const items = [{ label: 'ZCode right now', enabled: false }];
  for (const line of work.lines) {
    items.push({
      id: line.id != null ? `work-${line.id}` : undefined,
      label: line.label,
      icon: icons[line.light],
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
