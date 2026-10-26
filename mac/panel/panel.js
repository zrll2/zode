// The panel renderer: it only draws. One model in (window.zode.panelState, pushed again through
// onPanelState), user actions out (window.zode.panelAction), its needed height out
// (window.zode.panelResize). No page data is trusted: every string lands through textContent, and
// the only markup is the static HTML plus the tick/chevron SVGs.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', cls, label); b.addEventListener('click', fn); return b; };
const txtBtn = (label, fn) => btn(label, 'txtbtn', fn);
// One click per state: the button disables itself until the next model re-renders the lists.
const once = (label, cls, fn) => { const b = btn(label, cls, () => { b.disabled = true; fn(); }); return b; };

const MAX_HEIGHT = 560;
let model = null;
let sheetOn = false;
let phonesOpen = false;                     // the paired phones popover above the footer
let finishedOpen = null;                    // null = follow the default/fold-finished; else the user's choice
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

  // Top bar: the phones chip (count + live dot), refresh, settings. Nothing else.
  const phones = Number.isFinite(model.phones) ? model.phones : 0;
  $('phoneTxt').textContent = String(phones);
  $('phoneDot').classList.toggle('off', !(model.phoneList ?? []).some(p => p.connected === true));
  $('phones').setAttribute('aria-label', phones === 1 ? '1 phone' : `${phones} phones`);

  renderBanner(model.banner);
  renderNeeds(model.needs ?? []);
  renderRunning(model.working ?? []);
  renderFinished(model.done ?? [], model.earlier ?? [], s);
  renderPhones(model.phoneList ?? []);

  renderMonitor(model.flow);
  renderSettings(s, model.voice);
  $('version').textContent = s.version ? `Zode ${s.version}` : 'Zode';

  reportHeight();
}

function renderBanner(banner) {
  const root = $('banner');
  root.textContent = '';
  if (!banner) return;
  const box = el('div', 'warn');
  box.append(el('i', banner.dot === 'red' ? 'red' : 'amber'), el('b', null, banner.title ?? ''),
    btn(banner.button ?? 'OK', 'btn pri', () => act('banner', { kind: banner.kind })));
  root.append(box);
}

// Needs-you cards. Ask: project, waited, the command, the answers. Pile: bulk buttons and the
// "+N more" line; the fine-grained choices stay as text buttons. Question: stop or show. Stalled
// and failed: their buttons; the right-hand value already said what is going on.
function renderNeeds(needs) {
  const root = $('needs');
  root.textContent = '';
  for (const n of needs) root.append(needCard(n));
}

function needCard(n) {
  const project = n.project ?? '';
  const card = el('div', 'need');
  const head = el('div', 'top');
  head.append(el('b', null, project));
  if (n.waiting) head.append(el('span', null, n.waiting));
  card.append(head);

  if (n.kind === 'ask') {
    card.append(el('code', null, n.ask ?? ''));
    const pile = Array.isArray(n.pile) ? n.pile : [];
    if (pile.length > 1) {
      card.append(el('div', 'more', Number(n.sameCount) === pile.length ? `+${pile.length - 1} more, the same` : `+${pile.length - 1} more`));
    } else if (n.more > 0) {
      card.append(el('div', 'more', Number(n.same) === Number(n.more) ? `+${n.more} more, the same` : `+${n.more} more`));
    }
    const acts = el('div', 'acts');
    const stopTask = () => once('Stop', 'btn ghost', () => { act('stop', { sessionId: n.sessionId, sock: n.sock }); toast(`Stopped ${project}`); });
    const all = pile.map(({ requestId, sock }) => ({ requestId, sock }));
    const rest = pile.filter(p => p.requestId !== n.requestId).map(({ requestId, sock }) => ({ requestId, sock }));
    if (pile.length > 1) {
      const mixed = Number(n.sameCount) < pile.length;
      acts.append(
        once(mixed ? `Allow these ${pile.length}` : `Allow all ${pile.length}`, 'btn pri', () => {
          act('approveMany', { requests: all });
          toast(`Allowed ${pile.length}`);
        }),
        once('Deny all', 'btn', () => {
          act('denyMany', { requests: all });
          toast(`Denied ${pile.length}`);
        }),
      );
      if (n.canAlways === true) {                                   // ZCode's own "always allow in this project" rule
        acts.append(once('Always allow', 'btn', () => {
          act('alwaysAllow', { requestId: n.requestId, sock: n.sock, rest });
          toast('Always allowed');
        }));
      }
      if (n.more >= 2) acts.append(stopTask());                     // a repeated-request loop needs a way out
      if (mixed && Number(n.sameCount) > 1) {
        acts.append(txtBtn(`Allow only the same ${n.sameCount}`, () => {
          act('approveMany', { requests: all, summaryOnly: n.ask });
          toast(`Allowed ${n.sameCount}`);
        }));
      }
      acts.append(txtBtn('Just this one', () => {
        act('approve', { requestId: n.requestId, sock: n.sock, risky: n.risky === true, summary: n.ask });
        toast('Allowed');
      }));
    } else {
      acts.append(
        once('Allow', 'btn pri', () => {
          act('approve', { requestId: n.requestId, sock: n.sock, risky: n.risky === true, summary: n.ask });
          toast('Allowed');
        }),
        once('Deny', 'btn', () => {
          act('deny', { requestId: n.requestId, sock: n.sock });
          toast('Denied');
        }),
        once('Stop', 'btn ghost', () => { act('stop', { sessionId: n.sessionId, sock: n.sock }); toast(`Stopped ${project}`); }),
      );
    }
    card.append(acts);
    return card;
  }

  if (n.kind === 'question') {
    const acts = el('div', 'acts');
    acts.append(
      once('Stop', 'btn ghost', () => { act('stop', { sessionId: n.sessionId, sock: n.sock }); toast(`Stopped ${project}`); }),
      btn('Show in ZCode', 'btn pri', () => act('show')),
    );
    card.append(acts);
    return card;
  }

  const acts = el('div', 'acts');
  if (n.kind === 'stalled') {
    acts.append(
      once('Nudge', 'btn pri', () => { act('nudge', { sessionId: n.sessionId, sock: n.sock }); toast(`Nudged ${project}`); }),
      once('Stop', 'btn ghost', () => { act('stop', { sessionId: n.sessionId, sock: n.sock }); toast(`Stopped ${project}`); }),
    );
  } else {
    acts.append(
      once('Try again', 'btn pri', () => { act('retry', { sessionId: n.sessionId, sock: n.sock }); toast(`Retrying ${project}`); }),
      once('Stop', 'btn ghost', () => { act('stop', { sessionId: n.sessionId, sock: n.sock }); toast(`Stopped ${project}`); }),
    );
  }
  card.append(acts);
  return card;
}

// The token monitor: the last hour as an area chart (each minute a point, scaled to the hour's peak), the rate
// now, and the average tokens and time of a work order. Nothing to show hides the whole block.
function renderMonitor(f) {
  const mon = $('mon');
  mon.hidden = !f;
  if (!f) return;
  const n = f.series.length, top = Math.max(f.peak, 1) * 1.1;
  const pts = f.series.map((v, i) => `${(i * 340 / Math.max(n - 1, 1)).toFixed(1)},${(94 - (v / top) * 84).toFixed(1)}`);
  $('plotLine').setAttribute('points', pts.join(' '));
  $('plotArea').setAttribute('points', `0,96 ${pts.join(' ')} 340,96`);
  $('rateNum').textContent = f.rateLabel;
  $('rate').classList.toggle('idle', f.rate === 0);
  $('stats').hidden = !(f.avgTokensLabel && f.avgTimeLabel);
  $('avgTok').lastElementChild.textContent = f.avgTokensLabel;
  $('avgTime').lastElementChild.textContent = f.avgTimeLabel;
}

// Running rows: pulsing dot, project, summary; on the right when it last did something and, under it,
// a running-time counter that ticks every second (the tracker's start; no counter when unknown).
let clockTimer = null;
function renderRunning(rows) {
  const root = $('running');
  root.textContent = '';
  clearInterval(clockTimer);
  const now = Date.now();
  const clocks = [];
  for (const x of rows) {
    const row = el('div', 'row');
    row.append(el('span', 'dot run'));
    const p = el('div', 'p');
    p.append(el('b', null, x.project ?? ''));
    if (x.doing) p.append(el('span', null, x.doing));
    const t = el('div', 't2');
    t.append(el('span', 'ago', agoFor(x.at, now) || (x.since ? agoFor(x.since, now) : '')));
    if (x.since) {
      const c = el('span', 'clock', clockFor(x.since, now));
      clocks.push([c, x.since]);
      t.append(c);
    }
    row.append(p, t);
    root.append(row);
  }
  if (clocks.length) clockTimer = setInterval(() => { const n = Date.now(); for (const [c, since] of clocks) c.textContent = clockFor(since, n); }, 1000);
}

function relAgeText(at, now) {
  if (!Number.isFinite(at) || at <= 0) return '';
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Finished: one toggle row, then the rows when open (the older-than-an-hour group kept).
function renderFinished(done, earlier, s) {
  const toggle = $('finToggle');
  const rows = $('finRows');
  rows.textContent = '';
  const total = done.length + earlier.length;
  toggle.hidden = total === 0;
  if (!total) return;
  const defaultOpen = window.finishedDefaultOpen
    ? window.finishedDefaultOpen({ needs: model.needs ?? [], working: model.working ?? [], done, foldFinished: s.foldFinished === true })
    : false;
  const open = finishedOpen ?? defaultOpen;
  $('finTxt').textContent = `${total} finished`;
  $('finChev').classList.toggle('open', open);
  toggle.onclick = () => { finishedOpen = !open; act('foldFinished'); render(); };
  if (!open) return;
  for (const x of done) rows.append(doneRow(x));
  if (earlier.length) {
    if (olderOpen) {
      for (const x of earlier) rows.append(doneRow(x));
      rows.append(btn('Hide older', 'more', () => { olderOpen = false; render(); }));
    } else {
      rows.append(btn(`${earlier.length} older than an hour`, 'more', () => { olderOpen = true; render(); }));
    }
  }
}

function doneRow(x) {
  const row = el('div', 'row');
  row.append($('tickTpl').content.firstElementChild.cloneNode(true));
  const p = el('div', 'p');
  p.append(el('b', null, x.project ?? ''));
  if (x.doing) p.append(el('span', null, x.doing));
  const t = el('div', 't2');
  t.append(el('span', 'ago', x.t ?? ''));
  if (x.took) t.append(el('span', 'took', x.took));
  row.append(p, t);
  return row;
}

// The paired phones popover: one row per phone (live dot, name, last seen), a pair button, and a
// two-click remove. Only draws; every action goes through act().
function renderPhones(phones) {
  const pop = $('phonesPop');
  pop.textContent = '';
  const list = el('div');
  if (!phones.length) list.append(el('div', 'pempty', 'No phone paired yet.'));
  for (const p of phones) {
    const row = el('div', 'prow');
    row.append(el('span', 'dot' + (p.connected === true ? '' : ' off')));
    const info = el('div', 'pinfo');
    info.append(el('b', null, p.name ?? ''));
    info.append(el('small', null, p.when ?? ''));
    row.append(info);
    row.append(removeBtn(p));
    list.append(row);
  }
  pop.append(list, btn('Pair a new phone', 'btn pri pairall', () => { setPhones(false); act('phones'); }));
}

// Two clicks to remove a phone: the first arms the button for 3 s, the second revokes it.
function removeBtn(p) {
  const b = el('button', 'premove', 'Remove');
  let armedUntil = 0;
  b.addEventListener('click', () => {
    if (Date.now() >= armedUntil) {
      armedUntil = Date.now() + 3000;
      b.textContent = 'Sure?';
      setTimeout(() => { if (b.isConnected) { b.textContent = 'Remove'; armedUntil = 0; } }, 3000);
      return;
    }
    b.disabled = true;
    act('removePhone', { id: p.id });
  });
  return b;
}

function setPhones(open) {
  phonesOpen = open;
  $('phonesPop').hidden = !open;
}

function sheet(on) {
  sheetOn = on;
  $('sheet').classList.toggle('on', on);
  $('sheet').setAttribute('aria-hidden', on ? 'false' : 'true');
  $('gear').setAttribute('aria-expanded', on ? 'true' : 'false');
  reportHeight();
}

function setSwitch(id, on) { $(id).setAttribute('aria-checked', on ? 'true' : 'false'); }

function flip(id, key) {
  setSwitch(id, $(id).getAttribute('aria-checked') !== 'true');   // instant feedback; the next push confirms
  act('toggle', { key });
}

// The settings sheet: three grouped cards, same settings, new layout.
function renderSettings(s, voice) {
  setSwitch('swAutoAllow', s.autoAllow === true);
  const risky = $('swAskRisky');
  risky.disabled = s.autoAllow !== true;                          // it only matters while auto-allow is on
  setSwitch('swAskRisky', s.autoAllow === true && s.askRisky === true);
  setSwitch('swNotify', s.notify !== false);
  setSwitch('swClaudeCode', s.claudeCode !== false);
  setSwitch('swRelay', s.relayEnabled === true);
  setSwitch('swAwake', s.keepAwake === true);
  setSwitch('swLogin', s.launchAtLogin === true);
  renderAddressSeg(s.addresses ?? [], s.addressId);
  renderVoice(voice);
}

function renderAddressSeg(addresses, addressId) {
  const seg = $('addr');
  seg.textContent = '';
  const options = window.addressSegOptions ? window.addressSegOptions(addresses) : [{ id: 'auto', label: 'Automatic' }];
  for (const o of options) {
    const b = el('button', o.id === addressId ? 'on' : null, o.label);
    b.addEventListener('click', () => { if (o.id !== addressId) act('setAddress', { id: o.id }); });
    seg.append(b);
  }
}

// The Voice group: the language segmented control, the model's state in plain words, and the
// download button (self-disabled while downloading). Only draws — the app pushes a fresh model.
function renderVoice(v) {
  const voice = v && typeof v === 'object' ? v : {};
  for (const b of document.querySelectorAll('#voiceLang button')) b.setAttribute('aria-checked', b.dataset.lang === voice.language ? 'true' : 'false');
  const state = $('voiceState');
  const slot = $('voiceAction');
  slot.textContent = '';
  if (voice.engine !== true) { state.textContent = 'Voice engine missing'; return; }
  const download = voice.download && typeof voice.download === 'object' ? voice.download : {};
  const mb = voice.model?.bytes > 0 ? ` (${Math.floor(voice.model.bytes / 1e6)} MB)` : '';
  if (voice.model?.state === 'ready') { state.textContent = 'Ready'; return; }
  if (download.state === 'downloading') {
    const pct = download.total > 0 ? Math.min(100, Math.floor((download.received / download.total) * 100)) : 0;
    state.textContent = `${pct}%`;
    const b = el('button', 'btn', `Downloading ${pct}%`);
    b.disabled = true;
    slot.append(b);
    return;
  }
  state.textContent = download.state === 'failed' ? 'Failed' : 'Not downloaded';
  slot.append(btn(`Download${mb}`, 'btn', () => act('downloadVoiceModel')));
}

// The panel's height follows its content up to MAX_HEIGHT; past that, .mid scrolls. The app sizes
// the window from this number, so measure the natural content height, not the clipped one.
function reportHeight() {
  try {
    const h = sheetOn
      ? document.querySelector('#sheet .hdr').offsetHeight + $('scroll').scrollHeight + 2    // the settings sheet sizes the window while it is open
      : $('bar').offsetHeight + $('mid').scrollHeight + ($('mon').hidden ? 0 : $('mon').offsetHeight) + 2;          // + the panel's top and bottom border
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
$('phones').addEventListener('click', () => setPhones(!phonesOpen));
document.addEventListener('click', e => {
  if (!phonesOpen) return;                                        // a click outside the popover closes it; the chip toggles
  if ($('phonesPop').contains(e.target) || $('phones').contains(e.target)) return;
  setPhones(false);
});
$('swAwake').addEventListener('click', () => flip('swAwake', 'keepAwake'));
$('swRelay').addEventListener('click', () => flip('swRelay', 'relayEnabled'));
$('swAutoAllow').addEventListener('click', () => flip('swAutoAllow', 'autoAllow'));
$('swAskRisky').addEventListener('click', () => { if (!$('swAskRisky').disabled) flip('swAskRisky', 'askRisky'); });
$('swNotify').addEventListener('click', () => flip('swNotify', 'notify'));
$('swClaudeCode').addEventListener('click', () => flip('swClaudeCode', 'claudeCode'));
$('swLogin').addEventListener('click', () => flip('swLogin', 'launchAtLogin'));
$('voiceLang').addEventListener('click', e => {
  const b = e.target.closest('button[data-lang]');
  if (!b || b.getAttribute('aria-checked') === 'true') return;    // already chosen; the next push confirms
  for (const x of document.querySelectorAll('#voiceLang button')) x.setAttribute('aria-checked', 'false');
  b.setAttribute('aria-checked', 'true');
  act('setVoiceLanguage', { language: b.dataset.lang });
});
$('updatesBtn').addEventListener('click', () => act('checkUpdates'));
$('setupBtn').addEventListener('click', () => act('setup'));
$('quitBtn').addEventListener('click', () => act('quit'));
$('openZ').addEventListener('click', () => act('openZcode'));
document.addEventListener('keydown', e => {
  if (e.key === 'Tab') document.body.classList.add('kb');
  if (e.key !== 'Escape') return;
  if (phonesOpen) setPhones(false);          // the popover steps back first
  else if (sheetOn) sheet(false);            // the sheet steps back first; Escape again closes the panel
  else act('close');
});
document.addEventListener('mousedown', () => document.body.classList.remove('kb'));

// The helpers module defines runFor and friends on window; wait for it before the first draw.
import('./helpers.mjs').catch(() => {}).then(() => load());
