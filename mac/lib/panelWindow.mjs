// Pure helpers for the menu bar panel window: where it goes on screen and which tray icon shows the
// current state. No Electron here, so both are unit testable; the app (main.mjs) applies the results.

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 560;
const MARGIN = 8;                                    // the panel never comes closer than this to the work area's edge
const GAP = 4;                                       // between the icon's bottom edge and the panel's top edge

const num = (v, d) => (Number.isFinite(v) ? v : d);

// Where the panel window goes: centered under the tray icon, clamped to stay MARGIN px inside the
// work area, its top GAP px under the icon, and its height clamped to 120..560 and to what fits
// below the icon. Broken input falls back to sane numbers; this never throws.
export function panelBounds(opts) {
  const { trayBounds, workArea, width, height } = opts && typeof opts === 'object' ? opts : {};
  const tb = {
    x: num(trayBounds?.x, 0), y: num(trayBounds?.y, 0),
    width: num(trayBounds?.width, 0), height: num(trayBounds?.height, 0),
  };
  const wa = {
    x: num(workArea?.x, 0), y: num(workArea?.y, 0),
    width: num(workArea?.width, 0), height: num(workArea?.height, 0),
  };
  const w = Math.max(1, num(width, 340));
  const want = num(height, MAX_HEIGHT);
  const x = Math.min(
    Math.max(tb.x + tb.width / 2 - w / 2, wa.x + MARGIN),
    Math.max(wa.x + MARGIN, wa.x + wa.width - w - MARGIN),
  );
  const y = tb.y + tb.height + GAP;
  const fits = Math.max(MIN_HEIGHT, wa.y + wa.height - y - MARGIN);
  return { x: Math.round(x), y: Math.round(y), width: w, height: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, want, fits)) };
}

// The tray icon per panel glyph: the quiet state is the template glyph (macOS tints it for the menu
// bar itself); working and "needs you" are colored PNGs with a white glyph, always, carrying the status
// light (green dot for running work, amber when something needs you). The app theme says nothing about
// the menu bar (it follows the wallpaper), and a dark glyph vanished on a dark bar. The number of
// running conversations is the tray title next to the icon, see trayTitle.
export function trayImageName({ glyph } = {}) {
  if (glyph === 'working') return 'trayWorkingDark.png';
  if (glyph === 'needs') return 'trayNeedsDark.png';
  return 'trayTemplate.png';
}

// Whether the icon file is a macOS template image (only the quiet one is).
export function isTemplate(glyph) { return glyph !== 'working' && glyph !== 'needs'; }

// The text beside the icon: how many conversations are running (nothing at zero).
export function trayTitle({ working } = {}) {
  const n = Math.floor(Number(working));
  return Number.isFinite(n) && n > 0 ? ` ${Math.min(n, 99)}` : '';
}
