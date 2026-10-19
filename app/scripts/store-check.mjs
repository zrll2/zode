#!/usr/bin/env node
// Pre-flight for App Store Connect and Google Play.  npm run store:check
// Errors (exit 1) block a submission. TODO lines are things only you can fill in.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
let errors = 0, todos = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const err = (m) => { errors++; console.log(`  ERROR ${m}`); };
const todo = (m) => { todos++; console.log(`  TODO  ${m}`); };
const section = (t) => console.log(`\n${t}`);

function pngInfo(p) {                      // size, colour type, from the IHDR chunk
  const b = fs.readFileSync(path.join(root, p));
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };   // 2 = RGB, 6 = RGBA
}

// ---------------------------------------------------------------- app config
section('App config');
const app = JSON.parse(read('app.json')).expo;
app.name && app.name.length <= 30 ? ok(`name "${app.name}" (${app.name.length}/30)`) : err('name missing or over 30 characters');
/^\d+\.\d+\.\d+$/.test(app.version || '') ? ok(`version ${app.version}`) : err('version must look like 1.0.0');
/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/i.test(app.ios?.bundleIdentifier || '') ? ok(`iOS bundle id ${app.ios.bundleIdentifier}`) : err('ios.bundleIdentifier missing or invalid');
/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(app.android?.package || '') ? ok(`Android package ${app.android.package}`) : err('android.package missing or invalid');
app.ios?.supportsTablet === false ? ok('iPhone only (no iPad screenshots needed)') : todo('supportsTablet is not false: iPad screenshots are required');
app.ios?.config?.usesNonExemptEncryption === false ? ok('export compliance declared (no non-exempt encryption)') : err('ios.config.usesNonExemptEncryption must be false (or declared)');
const ats = app.ios?.infoPlist?.NSAppTransportSecurity || {};
ats.NSAllowsArbitraryLoads ? err('NSAllowsArbitraryLoads is on: App Review will ask why. Use NSAllowsLocalNetworking') : ok('no global ATS opt-out');
ats.NSAllowsLocalNetworking ? ok('ATS: local networking only') : err('NSAllowsLocalNetworking is missing: the relay is on a local or private IP');
for (const k of ['NSCameraUsageDescription', 'NSLocalNetworkUsageDescription']) (app.ios?.infoPlist?.[k] || '').length >= 20 ? ok(`${k} present`) : err(`${k} missing or too short`);
app.ios?.privacyManifests?.NSPrivacyAccessedAPITypes?.length ? ok('privacy manifest declares required-reason APIs') : err('ios.privacyManifests.NSPrivacyAccessedAPITypes missing');
const plug = JSON.stringify(app.plugins || []);
plug.includes('expo-build-properties') && plug.includes('usesCleartextTraffic') ? ok('Android cleartext (ws://) enabled through expo-build-properties') : err('Android needs expo-build-properties with usesCleartextTraffic, or ws:// pairing fails');
plug.includes('"recordAudioAndroid":false') ? ok('camera plugin: microphone off') : err('expo-camera should set recordAudioAndroid:false and microphonePermission:false');
Number.isInteger(app.android?.versionCode) ? ok(`Android versionCode ${app.android.versionCode}`) : err('android.versionCode missing');
(app.android?.blockedPermissions || []).includes('android.permission.RECORD_AUDIO') ? ok('microphone permission blocked') : err('block RECORD_AUDIO');

// ---------------------------------------------------------------- eas
section('EAS');
if (exists('eas.json')) {
  const eas = JSON.parse(read('eas.json'));
  eas.build?.production ? ok('production build profile') : err('eas.json has no production profile');
  eas.build?.production?.android?.buildType === 'app-bundle' ? ok('Android builds an AAB (Play requires it)') : err('production Android buildType must be app-bundle');
  eas.build?.production?.autoIncrement ? ok('build numbers auto-increment') : todo('production.autoIncrement is off: bump build numbers yourself');
} else err('eas.json missing');
app.extra?.eas?.projectId ? ok('EAS project linked') : todo('run `npx eas-cli init` once (needs your Expo login) to link the EAS project id');

// ---------------------------------------------------------------- icons
section('Icons and graphics');
const icon = pngInfo('assets/icon.png');
icon && icon.w === 1024 && icon.h === 1024 ? ok('iOS icon 1024x1024') : err('assets/icon.png must be 1024x1024');
icon && icon.colorType === 2 ? ok('iOS icon has no alpha channel') : err('iOS icon must not have transparency (RGB, not RGBA)');
const play = 'store/play/metadata/android/en-US/images';
const picon = pngInfo(`${play}/icon.png`);
picon && picon.w === 512 && picon.h === 512 ? ok('Play icon 512x512') : err('Play icon must be 512x512');
fs.existsSync(path.join(root, play, 'icon.png')) && fs.statSync(path.join(root, play, 'icon.png')).size <= 1024 * 1024 ? ok('Play icon under 1 MB') : err('Play icon over 1 MB');
const fg = pngInfo(`${play}/featureGraphic.png`);
fg && fg.w === 1024 && fg.h === 500 ? ok('Play feature graphic 1024x500') : err('Play feature graphic must be 1024x500');

// ---------------------------------------------------------------- Apple metadata
section('App Store metadata');
if (exists('store.config.json')) {
  const sc = JSON.parse(read('store.config.json')).apple;
  for (const [loc, i] of Object.entries(sc.info)) {
    const lim = (v, n, name) => (v || '').length <= n && (v || '').length > 0 ? ok(`${loc} ${name} ${(v || '').length}/${n}`) : err(`${loc} ${name} missing or over ${n}`);
    lim(i.title, 30, 'title'); lim(i.subtitle, 30, 'subtitle'); lim(i.promoText, 170, 'promo text'); lim(i.description, 4000, 'description');
    lim((i.keywords || []).join(','), 100, 'keywords'); lim(i.releaseNotes, 4000, 'release notes');
    for (const k of ['privacyPolicyUrl', 'supportUrl']) /^https:\/\//.test(i[k] || '') ? ok(`${loc} ${k} is https`) : err(`${loc} ${k} must be an https URL`);
  }
  for (const [k, v] of Object.entries(sc.review || {})) if (/REPLACE_ME|example\.com/.test(String(v))) todo(`store.config.json review.${k} (your contact details for App Review)`);
} else err('store.config.json missing');

// ---------------------------------------------------------------- Play metadata
section('Google Play metadata');
for (const loc of ['en-US', 'zh-CN']) {
  const d = `store/play/metadata/android/${loc}`;
  const lim = (f, n) => { const t = exists(`${d}/${f}`) ? read(`${d}/${f}`) : ''; t.length > 0 && t.length <= n ? ok(`${loc} ${f} ${t.length}/${n}`) : err(`${loc} ${f} missing or over ${n}`); };
  lim('title.txt', 30); lim('short_description.txt', 80); lim('full_description.txt', 4000); lim('changelogs/1.txt', 500);
}

// ---------------------------------------------------------------- screenshots
section('Screenshots');
const IOS = new Set(['1320x2868', '1290x2796', '1284x2778', '1242x2688']);
const shotsDir = 'store/screenshots/ios';
const ios = exists(shotsDir) ? fs.readdirSync(path.join(root, shotsDir)).filter((f) => f.endsWith('.png')) : [];
ios.length >= 1 && ios.length <= 10 ? ok(`${ios.length} iPhone screenshot(s)`) : err('need 1 to 10 iPhone screenshots in store/screenshots/ios');
for (const f of ios) { const i = pngInfo(`${shotsDir}/${f}`); IOS.has(`${i?.w}x${i?.h}`) ? ok(`${f} ${i.w}x${i.h}`) : err(`${f} is ${i?.w}x${i?.h}, not an accepted iPhone size`); }
const pdir = `${play}/phoneScreenshots`;
const ps = exists(pdir) ? fs.readdirSync(path.join(root, pdir)).filter((f) => f.endsWith('.png')) : [];
ps.length >= 2 && ps.length <= 8 ? ok(`${ps.length} Play phone screenshot(s)`) : err('Play needs 2 to 8 phone screenshots');
for (const f of ps) { const i = pngInfo(`${pdir}/${f}`); const okSize = i && Math.min(i.w, i.h) >= 320 && Math.max(i.w, i.h) <= 3840 && Math.max(i.w, i.h) <= 2 * Math.min(i.w, i.h); okSize ? ok(`${f} ${i.w}x${i.h}`) : err(`${f} breaks Play size rules (320 to 3840 px, long side at most 2x the short side)`); }

// ---------------------------------------------------------------- source hygiene
section('Source hygiene');
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const src = [...walk('app'), ...walk('src')].filter((f) => /\.(ts|tsx)$/.test(f));
const logs = src.filter((f) => /console\.(log|debug)\(/.test(read(f)));
logs.length ? err(`console.log left in: ${logs.join(', ')}`) : ok('no console.log in app/ and src/');
exists('app/dev/_layout.tsx') && /__DEV__/.test(read('app/dev/_layout.tsx')) ? ok('dev routes are gated by __DEV__') : err('app/dev is reachable in release builds (add app/dev/_layout.tsx that redirects when !__DEV__)');
const secrets = walk('.').filter((f) => !f.includes('node_modules') && /(\.keystore|\.jks|\.p8|\.p12|\.mobileprovision|play-service-account.*\.json)$/.test(f));
secrets.length ? err(`signing material in the project: ${secrets.join(', ')}`) : ok('no keystores, keys or service-account files in the project');

console.log(`\n${errors} error(s), ${todos} to-do item(s).`);
process.exit(errors ? 1 : 0);
