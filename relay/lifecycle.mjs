// The approval request's life, written down once: the statechart every answer path is measured
// against. Model-based tests replay it against the real audit log (relay/test/lifecycle.test.mjs)
// and the relay wraps its audit calls with it to spot illegal moves.

export const STATES = ['pending', 'allowed', 'rejected', 'cancelled', 'unavailable'];   // last four are terminal
export const EVENTS = ['asked', 'auto_allow_ok', 'auto_allow_failed', 'phone_allow', 'phone_deny',
  'phone_write_failed', 'panel_allow', 'panel_deny', 'panel_write_failed', 'vanished'];
export const TERMINAL = STATES.filter(s => s !== 'pending');

export const TABLE = {
  pending: {
    asked: 'pending',                    // a repeated asked changes nothing
    auto_allow_ok: 'allowed',
    auto_allow_failed: 'unavailable',
    phone_allow: 'allowed',
    phone_deny: 'rejected',
    phone_write_failed: 'unavailable',
    panel_allow: 'allowed',
    panel_deny: 'rejected',
    panel_write_failed: 'unavailable',
    vanished: 'cancelled',
  },
  allowed: {}, rejected: {}, cancelled: {}, unavailable: {},   // terminal: every event is ignored
};

// The next state for one event: { state, legal }. A terminal state ignores every event; an unknown
// state or event is never legal. Neither is ever thrown away.
export function step(state, event) {
  if (!STATES.includes(state) || !EVENTS.includes(event)) return { state, legal: false };
  const next = TABLE[state][event];
  if (next === undefined) return { state, legal: false };
  return { state: next, legal: true };
}

// The audit outcome a state stands for: the audit's own names, 'pending' while undecided.
export function outcomeOf(state) {
  return TERMINAL.includes(state) ? state : 'pending';
}

// Every event sequence that starts from `pending` and follows legal transitions, depth-first,
// including the empty one. Used by the model-based tests; small at maxLen 4.
export function paths(maxLen = 4) {
  const out = [];
  const walk = (state, seq) => {
    out.push(seq.slice());
    if (seq.length >= maxLen) return;
    for (const event of EVENTS) {
      const { state: next, legal } = step(state, event);
      if (legal) walk(next, seq.concat(event));
    }
  };
  walk('pending', []);
  return out;
}
