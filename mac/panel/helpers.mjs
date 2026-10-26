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

if (typeof window !== 'undefined') {
  window.runFor = runFor;
  window.finishedDefaultOpen = finishedDefaultOpen;
  window.addressSegOptions = addressSegOptions;
}

export { runFor, finishedDefaultOpen, addressSegOptions };
