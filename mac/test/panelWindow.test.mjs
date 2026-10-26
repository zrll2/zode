// panelBounds and the tray icon helpers for every documented case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelBounds, trayImageName, isTemplate, trayTitle } from '../lib/panelWindow.mjs';

// A 1440x925 display minus the menu bar.
const WA = { x: 0, y: 25, width: 1440, height: 900 };
const tray = { x: 700, y: 0, width: 22, height: 24 };

test('panelBounds centers the panel under the icon, just below it', () => {
  assert.deepEqual(
    panelBounds({ trayBounds: tray, workArea: WA, width: 340, height: 400 }),
    { x: 700 + 11 - 170, y: 0 + 24 + 4, width: 340, height: 400 },
  );
});

test('panelBounds clamps x to stay 8 px inside the work area, left and right', () => {
  const left = panelBounds({ trayBounds: { x: 40, y: 0, width: 22, height: 24 }, workArea: WA, width: 340, height: 400 });
  assert.equal(left.x, WA.x + 8);
  const right = panelBounds({ trayBounds: { x: 1400, y: 0, width: 22, height: 24 }, workArea: WA, width: 340, height: 400 });
  assert.equal(right.x, WA.x + WA.width - 340 - 8);
  // a work area narrower than the panel: the left margin wins over the right one
  const narrow = panelBounds({ trayBounds: { x: 10, y: 0, width: 22, height: 24 }, workArea: { x: 0, y: 25, width: 200, height: 900 }, width: 340, height: 400 });
  assert.equal(narrow.x, 8);
});

test('panelBounds clamps the height into 120..560', () => {
  assert.equal(panelBounds({ trayBounds: tray, workArea: WA, width: 340, height: 900 }).height, 560);
  assert.equal(panelBounds({ trayBounds: tray, workArea: WA, width: 340, height: 40 }).height, 120);
  assert.equal(panelBounds({ trayBounds: tray, workArea: WA, width: 340 }).height, 560);   // no ask: the max
});

test('panelBounds shrinks to what fits below the icon on a small display, floor 120', () => {
  const small = { x: 0, y: 25, width: 800, height: 300 };
  const b = panelBounds({ trayBounds: { x: 380, y: 0, width: 22, height: 24 }, workArea: small, width: 340, height: 560 });
  assert.equal(b.y, 28);
  assert.equal(b.height, 25 + 300 - 28 - 8);                       // down to the work area bottom, minus the margin
  const tiny = { x: 0, y: 25, width: 800, height: 130 };
  const c = panelBounds({ trayBounds: { x: 380, y: 0, width: 22, height: 24 }, workArea: tiny, width: 340, height: 560 });
  assert.equal(c.height, 120);                                     // less than the floor fits: the floor wins
});

test('panelBounds survives junk input without throwing', () => {
  for (const junk of [{}, null, undefined, { trayBounds: null, workArea: null }, { trayBounds: {}, workArea: {}, width: 'x', height: NaN }, { trayBounds: { x: 'a' }, workArea: { height: 'b' } }]) {
    const b = panelBounds(junk);
    assert.equal(typeof b.x, 'number');
    assert.equal(typeof b.y, 'number');
    assert.ok(Number.isFinite(b.width) && b.width > 0);
    assert.ok(b.height >= 120 && b.height <= 560);
  }
});

test('trayImageName and isTemplate for every glyph and both bar appearances', () => {
  // idle is the quiet template image on both bars; macOS tints it itself
  assert.equal(trayImageName({ glyph: 'idle', dark: false }), 'trayTemplate.png');
  assert.equal(trayImageName({ glyph: 'idle', dark: true }), 'trayTemplate.png');
  // working is the same template glyph: the number of running conversations is the tray title instead
  assert.equal(trayImageName({ glyph: 'working', dark: false }), 'trayTemplate.png');
  assert.equal(trayImageName({ glyph: 'working', dark: true }), 'trayTemplate.png');
  assert.equal(trayImageName({ glyph: 'needs', dark: false }), 'trayNeedsDark.png');
  assert.equal(trayImageName({ glyph: 'needs', dark: true }), 'trayNeedsDark.png');
  assert.equal(trayImageName({ glyph: 'weird', dark: false }), 'trayTemplate.png');   // junk glyph: the quiet icon
  assert.ok(isTemplate('idle'));
  assert.ok(isTemplate('working'));
  assert.equal(isTemplate('needs'), false);
  assert.ok(isTemplate('weird'));
});

test('trayTitle: the running count beside the icon, nothing at zero, junk, or a huge number', () => {
  assert.equal(trayTitle({ working: 0 }), '');
  assert.equal(trayTitle({ working: 3 }), ' 3');
  assert.equal(trayTitle({ working: 250 }), ' 99');
  for (const bad of [undefined, null, 'x', -2, NaN]) assert.equal(trayTitle({ working: bad }), '');
  assert.equal(trayTitle(), '');
});
