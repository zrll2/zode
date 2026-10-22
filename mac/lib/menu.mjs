// The menu bar (tray) menu as plain template objects, so it can be built and tested without Electron.
const HINT = 'Not encrypted. Use Tailscale away from home.';

// The ZCode-now block for the top of the menu: a disabled header, one clickable line per active
// conversation with its status light, a +N more stub, and a separator. The lights arrive as opaque
// icon values in state.icons, so this stays testable without Electron. A line opens the Engine app.
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
      click: () => actions.openEngine(),
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
  const engine = state.engine ?? { path: null };
  const connected = state.tapAlive === true;
  const update = state.update;                                     // { available, originalVersion, engineVersion }
  const release = state.release;                                   // { available, latest, installed } from the release check
  return [
    // What ZCode is doing right now: one line per active conversation, red first.
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
    { label: 'About Zode', click: () => actions.about() },
    { label: 'Quit Zode', click: () => actions.quit() },
  ];
}
