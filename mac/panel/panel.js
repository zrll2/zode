// The panel renderer: it only draws. One model in (window.zode.panelState, pushed again through
// onPanelState), user actions out (window.zode.panelAction), its needed height out
// (window.zode.panelResize). No page data is trusted: every string lands through textContent, and
// the only markup is the static HTML plus the tick SVG template.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', cls, label); b.addEventListener('click', fn); return b; };
// One click per state: the button disables itself until the next model re-renders the lists.
const once = (label, cls, fn) => { const b = btn(label, cls, () => { b.disabled = true; fn(); }); return b; };

const MAX_HEIGHT = 560;
let model = null;
let sheetOn = false;
let finishedOpen = null;                     // null = follow the foldFinished setting; else the user's choice
let olderOpen = false;
let toastTimer = null;

function act(name, payload) { try { window.zode.panelAction(name, payload); } catch { /* the next push still arrives */ } }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1800);
}

function render() {
  if (!model) return;
  const s = model.settings ?? {};
  const title = $('sumTitle');
  title.textContent = model.summary?.title ?? '';
  title.style.color = model.summary?.tone === 'warn' ? 'var(--warn)' : '';
  $('sumSub').textContent = model.summary?.sub ?? '';

  renderBanner(model.banner);
  renderNeeds(model.needs ?? []);
  renderWorking(model.working ?? []);
  renderDone(model.done ?? [], model.earlier ?? [], s);

  const phones = Number.isFinite(model.phones) ? model.phones : 0;
  $('phoneTxt').textContent = phones ? `${phones} phone${phones > 1 ? 's' : ''}` : 'No phone yet';
  document.querySelector('#phones i').style.background = phones ? 'var(--good)' : 'var(--muted)';

  setSwitch('swAwake', s.keepAwake === true);
  setSwitch('swRelay', s.relayEnabled === true);
  setSwitch('swLogin', s.launchAtLogin === true);
  renderAddresses(s.addresses ?? [], s.addressId);
  renderVoice(model.voice);
  $('version').textContent = s.version ? `Zode ${s.version}` : 'Zode';

  reportHeight();
}

function renderBanner(banner) {
  const root = $('banner');
  root.textContent = '';
  if (!banner) return;
  const box = el('div', 'banner');
  const text = el('div');
  text.append(el('b', null, banner.title ?? ''), el('span', null, banner.detail ?? ''));
  box.append(text, btn(banner.button ?? 'OK', 'btn pri', () => act('banner', { kind: banner.kind })));
  root.append(box);
}

function renderNeeds(needs) {
  const root = $('needs');
  root.textContent = '';
  if (!needs.length) return;
  const sec = el('div', 'sec');
  sec.append(el('h3', null, 'Needs you'));
  for (const n of needs) sec.append(needCard(n));
  root.append(sec);
}

function needCard(n) {
  const project = n.project ?? '';
  const card = el('div', 'need' + (n.kind === 'stalled' || n.kind === 'failed' ? ' bad' : ''));
  const head = el('div', 't');
  head.append(el('b', null, project));
  if (n.waiting) {
    const prefix = n.kind === 'stalled' ? 'quiet ' : n.kind === 'failed' ? '' : 'waiting ';
    head.append(el('span', null, `${prefix}${n.waiting}`));
  }
  card.append(head);
  card.append(n.kind === 'ask' ? el('code', null, n.ask ?? '') : el('p', null, n.ask ?? ''));
  const acts = el('div', 'acts');
  if (n.kind === 'ask') {
    acts.append(
      once('Allow once', 'btn pri', () => {
        act('approve', { requestId: n.requestId, sock: n.sock, risky: n.risky === true, summary: n.ask });
        toast(`Allowed. ${project} continues.`);
      }),
      once('Deny', 'btn', () => {
        act('deny', { requestId: n.requestId, sock: n.sock });
        toast(`Denied. ${project} is told to carry on without it.`);
      }),
      btn('Show in ZCode', 'btn quiet', () => act('show')),
    );
  } else if (n.kind === 'question') {
    acts.append(btn('Answer in ZCode', 'btn pri', () => act('show')));
  } else if (n.kind === 'stalled') {
    acts.append(
      once('Nudge', 'btn pri', () => { act('nudge', { sessionId: n.sessionId, sock: n.sock }); toast(`Nudged ${project}.`); }),
      once('Stop', 'btn', () => { act('stop', { sessionId: n.sessionId, sock: n.sock }); toast(`Stopped ${project}.`); }),
      btn('Show in ZCode', 'btn quiet', () => act('show')),
    );
  } else {
    acts.append(
      once('Try again', 'btn pri', () => { act('retry', { sessionId: n.sessionId, sock: n.sock }); toast(`Asked ${project} to try again.`); }),
      btn('Show in ZCode', 'btn quiet', () => act('show')),
    );
  }
  card.append(acts);
  return card;
}

function renderWorking(rows) {
  const root = $('working');
  root.textContent = '';
  if (!rows.length) return;
  const sec = el('div', 'sec');
  sec.append(el('h3', null, 'Working'));
  for (const x of rows) {
    const row = el('div', 'row');
    row.append(el('span', 'dot run'));
    const p = el('div', 'p', x.project ?? '');
    p.append(el('small', null, x.doing ?? ''));
    row.append(p, el('span', 'w', x.t ?? ''));
    sec.append(row);
  }
  root.append(sec);
}

function renderDone(done, earlier, s) {
  const root = $('done');
  root.textContent = '';
  const total = done.length + earlier.length;
  if (!total) {
    const q = el('div', 'quietstate');
    q.append(el('b', null, 'Nothing has finished lately'), el('span', null, 'New work shows up here.'));
    root.append(q);
    return;
  }
  const open = finishedOpen ?? s.foldFinished !== true;
  const sec = el('div', 'sec');
  const h3 = el('h3');
  h3.append(el('span', null, `Finished · ${total}`));
  h3.append(btn(open ? 'Hide' : 'Show', null, () => { finishedOpen = !open; act('foldFinished'); render(); }));
  sec.append(h3);
  if (open) {
    for (const x of done) sec.append(doneRow(x));
    if (earlier.length) {
      if (olderOpen) {
        for (const x of earlier) sec.append(doneRow(x));
        sec.append(btn('Hide older', 'more', () => { olderOpen = false; render(); }));
      } else {
        sec.append(btn(`${earlier.length} older than an hour`, 'more', () => { olderOpen = true; render(); }));
      }
    }
  }
  root.append(sec);
}

function doneRow(x) {
  const row = el('div', 'row');
  row.append($('tickTpl').content.firstElementChild.cloneNode(true));
  row.append(el('div', 'p', x.project ?? ''));
  row.append(el('span', 'w', x.t ?? ''));
  return row;
}

function sheet(on) {
  sheetOn = on;
  $('sheet').classList.toggle('on', on);
  $('sheet').setAttribute('aria-hidden', on ? 'false' : 'true');
  $('gear').setAttribute('aria-expanded', on ? 'true' : 'false');
}

function setSwitch(id, on) { $(id).setAttribute('aria-checked', on ? 'true' : 'false'); }

function flip(id, key) {
  setSwitch(id, $(id).getAttribute('aria-checked') !== 'true');   // instant feedback; the next push confirms
  act('toggle', { key });
}

function renderAddresses(addresses, addressId) {
  const sel = $('addr');
  sel.textContent = '';
  for (const a of addresses) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.label;
    sel.append(opt);
  }
  if (addresses.some(a => a.id === addressId)) sel.value = addressId;
}

// The Voice group in the settings sheet: the language segmented control, the model's state in plain
// words, and the download button (self-disabled while downloading; replaced by the missing-engine
// note when the binary is not there). Only draws — the app pushes a fresh model after every action.
function renderVoice(v) {
  const voice = v && typeof v === 'object' ? v : {};
  for (const b of document.querySelectorAll('#voiceLang .segopt')) b.setAttribute('aria-checked', b.dataset.lang === voice.language ? 'true' : 'false');
  const state = $('voiceState');
  const slot = $('voiceAction');
  slot.textContent = '';
  if (voice.engine !== true) { state.textContent = 'Voice engine missing'; return; }
  const download = voice.download && typeof voice.download === 'object' ? voice.download : {};
  const mb = voice.model?.bytes > 0 ? ` (${Math.floor(voice.model.bytes / 1e6)} MB)` : '';
  if (voice.model?.state === 'ready') { state.textContent = 'Ready'; return; }
  if (download.state === 'downloading') {
    const pct = download.total > 0 ? Math.min(100, Math.floor((download.received / download.total) * 100)) : 0;
    state.textContent = `Downloading ${pct}%`;
    const b = el('button', 'btn', `Downloading ${pct}%`);
    b.disabled = true;
    slot.append(b);
    return;
  }
  state.textContent = download.state === 'failed' ? 'Failed. Try again' : 'Not downloaded';
  slot.append(btn(`Download${mb}`, 'btn', () => act('downloadVoiceModel')));
}

// The panel's height follows its content up to MAX_HEIGHT; past that, .mid scrolls. The app sizes
// the window from this number (W2), so measure the natural content height, not the clipped one.
function reportHeight() {
  try {
    const h = $('top').offsetHeight + $('mid').scrollHeight + $('foot').offsetHeight + 2;   // + the panel's top and bottom border
    window.zode.panelResize(Math.min(MAX_HEIGHT, Math.max(1, Math.ceil(h))));
  } catch { /* the app keeps the last size */ }
}

async function load() {
  try {
    const m = await window.zode.panelState();
    if (m) { model = m; render(); }
  } catch { /* the next push brings state */ }
}

try {
  window.zode.onPanelState(m => { if (m) { model = m; render(); } });
} catch { /* a standalone preview without the bridge just shows the empty panel */ }

$('refresh').addEventListener('click', () => {
  const r = $('refresh');
  r.classList.add('spin');
  act('refresh');
  setTimeout(() => r.classList.remove('spin'), 700);
});
$('gear').addEventListener('click', () => sheet(!sheetOn));
$('back').addEventListener('click', () => sheet(false));
$('swAwake').addEventListener('click', () => flip('swAwake', 'keepAwake'));
$('swRelay').addEventListener('click', () => flip('swRelay', 'relayEnabled'));
$('swLogin').addEventListener('click', () => flip('swLogin', 'launchAtLogin'));
$('addr').addEventListener('change', e => act('setAddress', { id: e.target.value }));
$('voiceLang').addEventListener('click', e => {
  const b = e.target.closest('.segopt');
  if (!b || b.getAttribute('aria-checked') === 'true') return;   // already chosen; the next push confirms
  for (const x of document.querySelectorAll('#voiceLang .segopt')) x.setAttribute('aria-checked', 'false');
  b.setAttribute('aria-checked', 'true');
  act('setVoiceLanguage', { language: b.dataset.lang });
});
$('pairBtn').addEventListener('click', () => act('pair'));
$('updatesBtn').addEventListener('click', () => act('checkUpdates'));
$('setupBtn').addEventListener('click', () => act('setup'));
$('quitBtn').addEventListener('click', () => act('quit'));
$('phones').addEventListener('click', () => act('phones'));
$('openZ').addEventListener('click', () => act('openZcode'));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (sheetOn) sheet(false);                 // the sheet steps back first; Escape again closes the panel
  else act('close');
});

load();
