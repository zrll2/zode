// asarpatch against a tiny fake asar built with the real layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readMain, patchMain, restoreMain } from '../lib/asarpatch.mjs';

const ORIGINAL_MAIN = 'out/main/index.js';
const NEW_MAIN = '../zode/boot.cjs';
const tmp = () => fs.mkdtempSync(path.join('/tmp', 'zode-asar-'));

// 4 uint32 LE (4, headerPickleSize, payloadSize, jsonLength), header JSON at 16, data at 8 + headerPickleSize.
function fakeAsar(pkgObj) {
  const pkg = Buffer.from(JSON.stringify(pkgObj));
  const other = Buffer.from('hello other file\n');
  const header = Buffer.from(JSON.stringify({
    files: {
      'package.json': { size: pkg.length, offset: '0' },
      'other.txt': { size: other.length, offset: String(pkg.length) },
    },
  }));
  const sizes = Buffer.alloc(16);
  sizes.writeUInt32LE(4, 0);
  sizes.writeUInt32LE(header.length + 8, 4);          // headerPickleSize → dataStart = 8 + that = end of header
  sizes.writeUInt32LE(pkg.length + other.length, 8);  // payloadSize
  sizes.writeUInt32LE(header.length, 12);             // jsonLength
  return { buf: Buffer.concat([sizes, header, pkg, other]), pkgAt: 16 + header.length, pkgLen: pkg.length };
}

const writeAsar = (dir, asar) => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'app.asar');
  fs.writeFileSync(p, asar);
  return p;
};

test('readMain returns the packaged main', () => {
  const dir = tmp();
  const p = writeAsar(dir, fakeAsar({ name: 'zcode', type: 'module', main: ORIGINAL_MAIN }).buf);
  assert.equal(readMain(p), ORIGINAL_MAIN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch: same size, other bytes unchanged, main replaced', () => {
  const dir = tmp();
  const layout = fakeAsar({ name: 'zcode', type: 'module', main: ORIGINAL_MAIN });
  const p = writeAsar(dir, layout.buf);
  const before = fs.readFileSync(p);

  const { original, patched } = patchMain(p, NEW_MAIN);
  assert.equal(patched, true);
  assert.equal(original, ORIGINAL_MAIN);

  const after = fs.readFileSync(p);
  assert.equal(after.length, before.length);
  assert.deepEqual(after.subarray(0, layout.pkgAt), before.subarray(0, layout.pkgAt));
  assert.deepEqual(after.subarray(layout.pkgAt + layout.pkgLen), before.subarray(layout.pkgAt + layout.pkgLen));
  assert.equal(JSON.parse(after.subarray(layout.pkgAt, layout.pkgAt + layout.pkgLen).toString('utf8')).main, NEW_MAIN);
  assert.equal(readMain(p), NEW_MAIN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch is idempotent and reports the stored original', () => {
  const dir = tmp();
  const p = writeAsar(dir, fakeAsar({ name: 'zcode', type: 'module', main: ORIGINAL_MAIN }).buf);
  patchMain(p, NEW_MAIN);
  const before = fs.readFileSync(p);

  const again = patchMain(p, NEW_MAIN);               // no stored original yet → falls back to the new main
  assert.equal(again.patched, false);
  assert.equal(again.original, NEW_MAIN);
  assert.deepEqual(fs.readFileSync(p), before);

  fs.mkdirSync(path.join(dir, 'zode'));
  fs.writeFileSync(path.join(dir, 'zode', 'original-main.txt'), ORIGINAL_MAIN + '\n');
  const third = patchMain(p, NEW_MAIN);
  assert.equal(third.patched, false);
  assert.equal(third.original, ORIGINAL_MAIN);        // the stored original wins
  assert.deepEqual(fs.readFileSync(p), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('throws when the patched package.json does not fit, and leaves the file alone', () => {
  const dir = tmp();
  const p = writeAsar(dir, fakeAsar({ name: 'x', main: 'a' }).buf);   // already minimal: no slack
  const before = fs.readFileSync(p);
  assert.throws(() => patchMain(p, 'x'.repeat(200)), /bytes/);
  assert.deepEqual(fs.readFileSync(p), before);
  assert.equal(readMain(p), 'a');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restore brings back the original main, byte for byte', () => {
  const dir = tmp();
  const layout = fakeAsar({ name: 'zcode', type: 'module', main: ORIGINAL_MAIN });
  const p = writeAsar(dir, layout.buf);
  const before = fs.readFileSync(p);
  patchMain(p, NEW_MAIN);
  const r = restoreMain(p, ORIGINAL_MAIN);
  assert.equal(r.patched, true);
  const after = fs.readFileSync(p);
  assert.equal(after.length, before.length);
  assert.deepEqual(after.subarray(layout.pkgAt, layout.pkgAt + layout.pkgLen), before.subarray(layout.pkgAt, layout.pkgAt + layout.pkgLen));
  assert.equal(readMain(p), ORIGINAL_MAIN);
  fs.rmSync(dir, { recursive: true, force: true });
});
