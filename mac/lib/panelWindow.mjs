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

// The tray icon per panel glyph and menu bar appearance: the quiet state is a template image that
// macOS tints itself; the dot variants are colored PNGs — the 'Light' files are for a light menu bar
// (a dark glyph), the 'Dark' ones for a dark bar.
export function trayImageName({ glyph, dark } = {}) {
  if (glyph === 'working') return dark === true ? 'trayWorkingDark.png' : 'trayWorkingLight.png';
  if (glyph === 'needs') return dark === true ? 'trayNeedsDark.png' : 'trayNeedsLight.png';
  return 'trayTemplate.png';
}

// Whether the icon file is a macOS template image (only the quiet one is).
export function isTemplate(glyph) { return glyph !== 'working' && glyph !== 'needs'; }
