// Setup wizard: four steps in plain words. State arrives from one poll every 2 s; build progress
// also arrives as push events. Every button uses one explicit zode:setup* channel. No page data is
// trusted: all text is set with textContent, except the QR SVG from the main process.
const $ = (id) => document.getElementById(id);
let signature = '';                                  // rebuild the step body only when something visible changed
let countdown = null;
let expiresAt = 0;
let payload = null;
let knownDevices = null;                             // device ids when the phone step opened; a new one means someone just paired
let justPaired = null;                               // the name of the phone that paired while this step was open

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (label, fn, primary) => { const b = el('button', primary ? 'primary' : null, label); b.addEventListener('click', fn); return b; };

function stopCountdown() { if (countdown) { clearInterval(countdown); countdown = null; } }

function currentStepId(s) {
  const cur = (s.steps ?? []).find(st => st.state === 'current');
  return cur ? cur.id : 'phone';                     // everything done: pairing is still useful
}

function signatureOf(s) {
  return [
    currentStepId(s),
    s.build?.running ? 1 : 0,
    s.build?.error ? 1 : 0,
    s.build?.percent ?? 0,
    s.original?.exists ? 1 : 0,
    s.original?.running ? 1 : 0,
    s.oldApp?.exists ? 1 : 0,
    s.oldApp?.running ? 1 : 0,
    s.engine?.exists ? 1 : 0,
    s.tapAlive ? 1 : 0,
  ].join('|');
}

async function load() {
  let s;
  try { s = await window.zode.setupState(); } catch { return; }
  if (!s || !Array.isArray(s.steps)) return;
  renderSteps(s);
  const sig = signatureOf(s);
  if (sig === signature) return;
  signature = sig;
  stopCountdown();
  renderBody(currentStepId(s), s);
}

function renderSteps(s) {
  const ol = $('steps');
  ol.textContent = '';
  for (const st of s.steps) {
    const li = el('li', `step ${st.state}`);
    li.append(el('span', 'mark', st.state === 'done' ? '✓' : st.state === 'current' ? '›' : ''));
    li.append(el('span', null, st.title));
    ol.append(li);
  }
}

function renderBody(id, s) {
  const body = $('stepBody');
  body.textContent = '';
  if (id === 'prepare') renderPrepare(body, s);
  else if (id === 'login') renderLogin(body, s);
  else renderPhone(body, s);
}

function renderPrepare(body, s) {
  if (s.build?.running) {
    body.append(el('p', null, s.build.label || 'Working…'));
    const bar = el('div', 'bar');
    const fill = el('div', 'bar-fill');
    fill.id = 'barFill';
    fill.style.width = `${s.build.percent ?? 0}%`;
    bar.append(fill);
    body.append(bar);
    const det = el('details', 'raw');
    det.append(el('summary', null, 'Details'));
    const pre = el('pre', null, (s.build.lines ?? []).join('\n'));
    pre.id = 'buildLog';
    det.append(pre);
    body.append(det);
    return;
  }
  if (s.build?.error) {
    body.append(el('p', 'error', s.build.error.message || 'Something went wrong.'));
    if (s.build.error.hint) body.append(el('p', 'muted', s.build.error.hint));
    body.append(btn('Try again', () => { window.zode.setupStartBuild().catch(() => {}); }, true));
    return;
  }
  if (s.original?.running || s.oldApp?.running) {
    body.append(el('p', null, 'ZCode is open. Quit it to continue.'));
    body.append(btn('Quit ZCode', async () => {
      try { await window.zode.setupQuitBlocking(); } catch {}
      load();
    }, true));
    return;
  }
  body.append(el('p', null, 'Zode makes its own copy of ZCode.'));
  body.append(btn('Set up', () => { window.zode.setupStartBuild().catch(() => {}); }, true));
}

function renderLogin(body, s) {
  body.append(el('p', null, 'Sign in to ZCode and open any project.'));
  body.append(btn('Open ZCode', () => { window.zode.setupOpenEngine(); }, true));
  body.append(el('p', s.tapAlive ? 'status-ok' : 'status-wait', s.tapAlive ? 'ZCode is connected' : 'Waiting for ZCode…'));
}

async function renderPhone(body, s) {
  if (knownDevices === null) {
    try { knownDevices = new Set((await window.zode.listDevices()).map(d => d.id)); } catch { knownDevices = new Set(); }
  }
  if (justPaired) {                                  // the scan worked: say so, drop the QR code
    body.append(el('p', 'status-ok', `✓ ${justPaired} is paired`));
    body.append(el('p', null, 'You can now follow your ZCode work from your phone.'));
    body.append(btn('Done', async () => { try { await window.zode.setupDone(); } catch {} }, true));
    return;
  }
  body.append(el('p', null, 'Scan this with Zode on your phone.'));
  const msg = el('p', 'relay-message hidden');
  const card = el('div', 'qr-card hidden');
  const qr = el('div', 'qr');
  card.append(qr);
  const codeRow = el('div', 'code-row hidden');
  const code = el('span', 'code', '···· ····');
  const count = el('span', 'muted');
  codeRow.append(code, count);
  const row = el('div', 'row');
  row.append(btn('New code', async () => {
    try { await window.zode.newCode(); } catch {}
    await fillPairing(msg, card, codeRow, qr, code, count);
  }));
  const copy = btn('Copy pairing text', async () => {
    if (!payload) return;
    try { await window.zode.copy(payload); } catch {}
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy pairing text'; }, 1500);
  });
  row.append(copy);
  body.append(msg, card, codeRow, row);
  if (s.oldApp?.exists) {
    const note = el('p', 'muted', 'The old Zode.app is no longer needed.');
    const trash = btn('Move it to the Trash', async () => {
      let r = null;
      try { r = await window.zode.setupTrashOldApp(); } catch {}
      note.textContent = r && r.ok ? 'Moved to the Trash.' : (r && r.error ? r.error : 'Something went wrong.');
    });
    if (!(s.tapAlive && !s.oldApp.running)) trash.disabled = true;
    body.append(note, trash);
  }
  body.append(btn('Done', async () => { try { await window.zode.setupDone(); } catch {} }, true));
  await fillPairing(msg, card, codeRow, qr, code, count);
}

async function fillPairing(msg, card, codeRow, qr, code, count) {
  let p = null;
  try { p = await window.zode.getPairing(); } catch {}
  const ok = !!(p && p.running && p.qrSvg);
  card.classList.toggle('hidden', !ok);
  codeRow.classList.toggle('hidden', !ok);
  msg.classList.toggle('hidden', ok);
  stopCountdown();
  if (!ok) {
    msg.textContent = p && p.error ? `Problem: ${p.error}` : 'The phone connection is off. Turn it back on from the Zode menu bar icon.';
    return;
  }
  card.classList.remove('expired');
  qr.innerHTML = p.qrSvg;                          // the SVG comes from the main process, never from page data
  code.textContent = p.code;
  payload = p.payload;
  expiresAt = p.expiresAt ?? 0;
  countdown = setInterval(() => {
    const left = expiresAt - Date.now();
    if (left <= 0) {
      stopCountdown();
      count.textContent = 'Code expired. Click New code.';
      card.classList.add('expired');               // dim the QR: nothing live to scan
      return;
    }
    const sec = Math.max(0, Math.ceil(left / 1000));
    count.textContent = `Expires in ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }, 1000);
}

// Build progress lands in the open progress view without a re-render, so Details stays put.
window.zode.onSetupEvent(ev => {
  try {
    if (!ev || !ev.type) return;
    if (ev.type === 'build') {
      const fill = $('barFill');
      if (fill && typeof ev.percent === 'number') fill.style.width = `${ev.percent}%`;
      const pre = $('buildLog');
      if (pre && ev.line) {
        pre.textContent = pre.textContent ? `${pre.textContent}\n${ev.line}` : ev.line;
        pre.scrollTop = pre.scrollHeight;
      } else if (!fill) {
        signature = '';
        load();
      }
    } else if (ev.type === 'buildDone') {
      signature = '';
      load();
    }
  } catch { /* never break the wizard on one bad event */ }
});

// A phone paired while the QR code is showing: switch the step to a confirmation.
async function watchPairing() {
  try {
    if (knownDevices === null || justPaired) return;
    const devices = await window.zode.listDevices();
    const fresh = devices.find(d => !knownDevices.has(d.id));
    if (fresh) {
      justPaired = fresh.name || 'Your phone';
      stopCountdown();
      signature = '';
      load();
    }
  } catch { /* the next tick tries again */ }
}

load();
setInterval(load, 2000);
setInterval(watchPairing, 1500);
