// Pure display helpers for the panel renderer (and for the tests that pin them). Loaded as a module
// before panel.js and attached to the window, so the classic renderer script sees them as globals.
function runFor(since, now) {
  if (!Number.isFinite(since) || since <= 0 || !Number.isFinite(now)) return '';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// The finished group starts expanded only when it is the whole show; the fold-finished setting
// always collapses it (the user asked for that).
function finishedDefaultOpen({ needs = [], working = [], done = [], foldFinished = false } = {}) {
  if (foldFinished === true) return false;
  const list = Array.isArray(done) ? done : [];
  return list.length > 0
    && (Array.isArray(needs) ? needs : []).length === 0
    && (Array.isArray(working) ? working : []).length === 0;
}

// The Reachable-from segments: Automatic always; the others only when the Mac has that address.
function addressSegOptions(addresses) {
  const ids = new Set((Array.isArray(addresses) ? addresses : []).map(a => (a && typeof a === 'object' ? String(a.id ?? '') : '')));
  const out = [{ id: 'auto', label: 'Automatic' }];
  if (ids.has('lan')) out.push({ id: 'lan', label: 'Wi-Fi' });
  if (ids.has('tailscale')) out.push({ id: 'tailscale', label: 'Tailscale' });
  return out;
}

// How long ago something last happened: `now`, `42s ago`, `5m ago`, `2h ago`.
function agoFor(at, now) {
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(now)) return '';
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// The running-time counter: `4:07`, or `1:05:09` past an hour. Blank when the start is unknown.
function clockFor(since, now) {
  if (!Number.isFinite(since) || since <= 0 || !Number.isFinite(now)) return '';
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  const two = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

if (typeof window !== 'undefined') {
  window.agoFor = agoFor;
  window.clockFor = clockFor;
  window.runFor = runFor;
  window.finishedDefaultOpen = finishedDefaultOpen;
  window.addressSegOptions = addressSegOptions;
}

export { runFor, agoFor, clockFor, finishedDefaultOpen, addressSegOptions };
