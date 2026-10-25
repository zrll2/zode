// Pairing window logic: show the QR and code, refresh on expiry or relay changes. No network access.
const $ = (id) => document.getElementById(id);
let expiresAt = 0;
let payload = null;
let ticker = null;                                   // the countdown runs only while a live code is on screen

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

function tick() {
  if (!expiresAt) return;
  const left = expiresAt - Date.now();
  if (left <= 0) {
    stopTicker();                                    // the countdown stops at 0:00
    $('countdown').textContent = 'Code expired. Click New code.';
    $('qrCard').classList.add('expired');            // dim the QR: nothing live to scan
    return;
  }
  $('countdown').textContent = `Expires in ${fmt(left)}`;
}

function render(p) {
  payload = p.payload;
  const ok = !!(p.running && p.qrSvg);
  $('relayMessage').classList.toggle('hidden', ok);
  $('qrCard').classList.toggle('hidden', !ok);
  $('codeRow').classList.toggle('hidden', !ok);
  if (!ok) {
    $('relayMessage').textContent = p.error
      ? `Relay error: ${p.error}`
      : 'The relay is not running. Turn it back on from the Zode menu bar icon.';
    return;
  }
  $('qr').innerHTML = p.qrSvg;                       // the SVG comes from the main process, never from page data
  $('code').textContent = p.code;
  expiresAt = p.expiresAt;
  $('qrCard').classList.remove('expired');
  stopTicker();
  ticker = setInterval(tick, 1000);
  tick();
}

function renderDevices(devices) {
  const ul = $('devices');
  ul.textContent = '';
  if (!devices.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No phones paired yet.';
    ul.append(li);
    return;
  }
  for (const d of devices) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = d.name;
    const when = document.createElement('span');
    when.className = 'muted';
    when.textContent = new Date(d.pairedAt).toLocaleDateString();
    const revoke = document.createElement('button');
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => { await window.zode.revoke(d.id); await load(); });
    li.append(name, when, revoke);
    ul.append(li);
  }
}

async function load() {
  render(await window.zode.getPairing());
  renderDevices(await window.zode.listDevices());
}

$('newCode').addEventListener('click', async () => render(await window.zode.newCode()));
$('copy').addEventListener('click', async () => {
  if (!payload) return;
  await window.zode.copy(payload);
  const b = $('copy');
  b.textContent = 'Copied';
  setTimeout(() => { b.textContent = 'Copy pairing text'; }, 1500);
});
window.zode.onStatus(load);
load();
