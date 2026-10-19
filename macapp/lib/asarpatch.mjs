// Patch the `main` field of the package.json inside an Electron app.asar WITHOUT repacking:
// the asar integrity fuse is off, so the entry just keeps its byte length and shorter JSON is
// padded with trailing spaces. Layout (verified): bytes 0..15 are four uint32 LE
// (4, headerPickleSize, payloadSize, jsonLength), the header JSON is at 16, and file data
// starts at 8 + headerPickleSize; a file lives at dataStart + Number(entry.offset), entry.size bytes.
import fs from 'node:fs';
import path from 'node:path';

const HEADER = 16;

function withAsar(asarPath, write, fn) {
  const fd = fs.openSync(asarPath, write ? 'r+' : 'r');
  try { return fn(fd); } finally { fs.closeSync(fd); }
}

function locatePackage(fd, asarPath) {
  const sizes = Buffer.alloc(HEADER);
  if (fs.readSync(fd, sizes, 0, HEADER, 0) !== HEADER) throw new Error(`${asarPath}: too short for an asar header`);
  const dataStart = 8 + sizes.readUInt32LE(4);
  const jsonLength = sizes.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLength);
  if (fs.readSync(fd, jsonBuf, 0, jsonLength, HEADER) !== jsonLength) throw new Error(`${asarPath}: truncated asar header`);
  const entry = JSON.parse(jsonBuf.toString('utf8')).files?.['package.json'];
  if (!entry || entry.offset === undefined || entry.size === undefined) throw new Error(`${asarPath}: no package.json in the asar header`);
  const at = dataStart + Number(entry.offset);
  const buf = Buffer.alloc(entry.size);
  if (fs.readSync(fd, buf, 0, entry.size, at) !== entry.size) throw new Error(`${asarPath}: truncated package.json`);
  return { buf, at };
}

// install.mjs keeps the original main in <Resources>/zode/original-main.txt; used for the idempotent return.
function storedOriginal(asarPath) {
  try { return fs.readFileSync(path.join(path.dirname(asarPath), 'zode', 'original-main.txt'), 'utf8').trim() || null; }
  catch { return null; }
}

function writeMainValue(asarPath, newMain) {
  return withAsar(asarPath, true, (fd) => {
    const { buf, at } = locatePackage(fd, asarPath);
    const pkg = JSON.parse(buf.toString('utf8'));
    const original = pkg.main;
    const minified = Buffer.from(JSON.stringify({ ...pkg, main: newMain }));
    if (minified.length > buf.length) throw new Error(`patched package.json needs ${minified.length} bytes but the entry only holds ${buf.length}; use a shorter main`);
    fs.writeSync(fd, Buffer.concat([minified, Buffer.alloc(buf.length - minified.length, 0x20)]), 0, buf.length, at);
    return original;
  });
}

export function readMain(asarPath) {
  return withAsar(asarPath, false, fd => JSON.parse(locatePackage(fd, asarPath).buf.toString('utf8')).main);
}

export function patchMain(asarPath, newMain) {
  if (readMain(asarPath) === newMain) return { original: storedOriginal(asarPath) ?? newMain, patched: false };
  return { original: writeMainValue(asarPath, newMain), patched: true };
}

export function restoreMain(asarPath, originalMain) {
  if (readMain(asarPath) === originalMain) return { original: originalMain, patched: false };
  writeMainValue(asarPath, originalMain);
  return { original: originalMain, patched: true };
}
