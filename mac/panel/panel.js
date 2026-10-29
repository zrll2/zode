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
let sheetView = 'settings';                 // 'settings' | 'apprs': which view the sheet shows
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
    const questions = Array.isArray(n.questions) ? n.questions.filter(q => q && typeof q.question === 'string' && q.question && Array.isArray(q.options) && q.options.length > 0) : [];
    const answerable = n.requestId != null && questions.length > 0;
    if (answerable) {
      // Answer in place: every question's options as buttons. One single-select question answers on
      // click; several questions or a multiSelect toggle and a Send submits once everything is picked.
      const picks = {};
      const optionBtns = [];
      const hasPick = q => { const p = picks[q.question]; return Array.isArray(p) ? p.length > 0 : p != null; };
      const sync = () => {
        for (const b of optionBtns) b.classList.toggle('on', Array.isArray(picks[b.dataset.q]) ? picks[b.dataset.q].includes(b.dataset.label) : picks[b.dataset.q] === b.dataset.label);
        send.disabled = !questions.every(hasPick);
      };
      for (const q of questions) {
        const qwrap = el('div', 'q');
        qwrap.append(el('b', null, q.question));
        const opts = el('div', 'acts');
        for (const o of q.options) {
          const b = btn(o.label, 'btn', () => {
            if (q.multiSelect) {
              const cur = Array.isArray(picks[q.question]) ? picks[q.question].slice() : [];
              const at = cur.indexOf(o.label);
              if (at >= 0) cur.splice(at, 1); else cur.push(o.label);
              if (cur.length) picks[q.question] = cur; else delete picks[q.question];
            } else {
              picks[q.question] = o.label;
              for (const other of optionBtns) if (other.dataset.q === q.question && other !== b) other.classList.remove('on');
            }
            sync();
          });
          b.dataset.q = q.question;
          b.dataset.label = o.label;
          if (o.description) b.title = o.description;                 // the option's own tooltip; no hint text in the layout
          optionBtns.push(b);
          opts.append(b);
        }
        qwrap.append(opts);
        card.append(qwrap);
      }
      const send = el('button', 'btn pri', 'Send');
      send.disabled = true;
      send.addEventListener('click', () => {
        if (!questions.every(hasPick)) return;
        send.disabled = true;
        act('answerQuestion', { requestId: n.requestId, sock: n.sock, picks });
        toast('Answered');
      });
      const acts = el('div', 'acts');
      acts.append(
        send,
        once('Stop', 'btn ghost', () => { act('stop', { sessionId: n.sessionId, sock: n.sock }); toast(`Stopped ${project}`); }),
        btn('Show in ZCode', 'btn', () => act('show')),
      );
      card.append(acts);
      return card;
    }
    const acts = el('div', 'acts');                                   // nothing answerable here: today's card
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
  if (!on && sheetView !== 'settings') showSettingsView();
  $('sheet').classList.toggle('on', on);
  $('sheet').setAttribute('aria-hidden', on ? 'false' : 'true');
  $('gear').setAttribute('aria-expanded', on ? 'true' : 'false');
  reportHeight();
}

// The approvals history view swaps the sheet's body; the back button (and Escape) returns.
function showSettingsView() {
  sheetView = 'settings';
  $('apprs').hidden = true;
  $('scroll').hidden = false;
  $('sheetTitle').textContent = 'Settings';
  reportHeight();
}

async function showApprovalsView() {
  sheetView = 'apprs';
  $('scroll').hidden = true;
  $('apprs').hidden = false;
  $('sheetTitle').textContent = 'Approvals';
  $('apprs').textContent = '';
  reportHeight();
  let rows = null;
  try { rows = await window.zode.approvalLog(); } catch { rows = null; }
  if (sheetView !== 'apprs' || !sheetOn) return;   // the user left while the channel was in flight
  renderApprs(Array.isArray(rows) ? rows : []);
  reportHeight();
}

function renderApprs(rows) {
  const root = $('apprs');
  root.textContent = '';
  const group = el('div', 'group');
  if (!rows.length) {
    group.append(el('div', 'aempty', 'No approvals yet'));
  } else {
    const now = Date.now();
    for (const r of rows) {
      const f = window.approvalRowOf ? window.approvalRowOf(r, now) : { title: '', status: '', source: '', ago: '', risky: false };
      const row = el('div', 'arow');
      if (f.risky) row.append(el('i', 'adot'));
      row.append(el('span', 'atitle', f.title || 'Permission request'));
      const right = el('span', 'astatus');
      right.append(el('b', null, f.source ? `${f.status} ${f.source}` : f.status));
      right.append(el('span', null, f.ago));
      row.append(right);
      group.append(row);
    }
  }
  root.append(group);
}

function setSwitch(id, on) { $(id).setAttribute('aria-checked', on ? 'true' : 'false'); }

function flip(id, key) {
  setSwitch(id, $(id).getAttribute('aria-checked') !== 'true');   // instant feedback; the next push confirms
  act('toggle', { key });
}

// The settings sheet: grouped cards; the Permissions preset derived from the two stored booleans.
function renderSettings(s, voice) {
  for (const b of document.querySelectorAll('#preset button')) b.setAttribute('aria-checked', b.dataset.preset === s.preset ? 'true' : 'false');
  setSwitch('swNotify', s.notify !== false);
  setSwitch('swClaudeCode', s.claudeCode !== false);
  setSwitch('swRelay', s.relayEnabled === true);
  setSwitch('swWebClient', s.webClient === true);
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
    const body = sheetView === 'apprs' ? $('apprs') : $('scroll');
    const h = sheetOn
      ? document.querySelector('#sheet .hdr').offsetHeight + body.scrollHeight + 2    // the sheet sizes the window while it is open
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
$('back').addEventListener('click', () => { if (sheetView === 'apprs') showSettingsView(); else sheet(false); });
$('approvals').addEventListener('click', () => { if (sheetOn) showApprovalsView(); });
$('phones').addEventListener('click', () => setPhones(!phonesOpen));
document.addEventListener('click', e => {
  if (!phonesOpen) return;                                        // a click outside the popover closes it; the chip toggles
  if ($('phonesPop').contains(e.target) || $('phones').contains(e.target)) return;
  setPhones(false);
});
$('swAwake').addEventListener('click', () => flip('swAwake', 'keepAwake'));
$('swRelay').addEventListener('click', () => flip('swRelay', 'relayEnabled'));
$('swWebClient').addEventListener('click', () => flip('swWebClient', 'webClient'));
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
$('preset').addEventListener('click', e => {
  const b = e.target.closest('button[data-preset]');
  if (!b || b.getAttribute('aria-checked') === 'true') return;    // already chosen; the next push confirms
  for (const x of document.querySelectorAll('#preset button')) x.setAttribute('aria-checked', 'false');
  b.setAttribute('aria-checked', 'true');
  act('setPreset', { value: b.dataset.preset });
});
$('updatesBtn').addEventListener('click', () => act('checkUpdates'));
$('setupBtn').addEventListener('click', () => act('setup'));
$('quitBtn').addEventListener('click', () => act('quit'));
$('openZ').addEventListener('click', () => act('openZcode'));
document.addEventListener('keydown', e => {
  if (e.key === 'Tab') document.body.classList.add('kb');
  if (e.key !== 'Escape') return;
  if (phonesOpen) setPhones(false);          // the popover steps back first
  else if (sheetOn && sheetView === 'apprs') showSettingsView();   // then the approvals list
  else if (sheetOn) sheet(false);            // the sheet steps back first; Escape again closes the panel
  else act('close');
});
document.addEventListener('mousedown', () => document.body.classList.remove('kb'));

// The helpers module defines runFor and friends on window; wait for it before the first draw.
import('./helpers.mjs').catch(() => {}).then(() => load());
