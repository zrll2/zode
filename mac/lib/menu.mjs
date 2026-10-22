// The menu bar (tray) menu as plain template objects, so it can be built and tested without Electron.
const HINT = 'Not encrypted. Use Tailscale away from home.';

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
  return [
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
