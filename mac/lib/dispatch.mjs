// The dispatcher: one event in, at most one wake out. Rules are re-read at most every 5 s (the
// file can change under us), every event goes through plan()'s matching, de-duplication and rate
// cap, and the rendered prompt — never the raw event text — is what reaches the session. Logs name
// sources, types and rule names only; event text and prompts never reach the log.
import { parseRules, plan } from './triggers.mjs';

const RULES_TTL_MS = 5000;
const SKIP_LOG_MS = 60 * 1000;

export function createDispatcher({ loadRules, limiter, findSession, send, log, now = Date.now }) {
  let cache = { rules: [], at: -Infinity, errors: '' };              // the last good rules + their error signature
  const skipLoggedAt = new Map();                                    // rule name -> when 'duplicate'/'rate' last logged

  function reload(t) {
    if (t - cache.at < RULES_TTL_MS) return;
    cache.at = t;
    let raw = null;
    try { raw = loadRules(); } catch (err) {
      log(`event rules: unreadable: ${err?.message ?? err}`);
      cache.rules = [];
      cache.errors = '';
      return;
    }
    const { rules, errors } = parseRules(raw);
    const signature = errors.join('|');
    if (signature !== cache.errors) for (const e of errors) log(`event rules: ${e}`);   // once per change, not per event
    cache.errors = signature;
    cache.rules = rules;
  }

  return {
    async handle(event) {
      const t = now();
      reload(t);
      const p = plan(cache.rules, event, limiter);
      if (p.action === 'skip') {
        if (p.reason === 'no-rule') return;                            // silence is the point: unknown events are routine
        const last = skipLoggedAt.get(p.rule.name) ?? -Infinity;
        if (t - last >= SKIP_LOG_MS) {
          skipLoggedAt.set(p.rule.name, t);
          log(`event skipped: ${p.reason} (${p.rule.name})`);
        }
        return;
      }
      if (p.action === 'start') {
        log('event skipped: new sessions are not supported yet');
        return;
      }
      const target = findSession(p.session);
      if (!target || !target.sock) {
        log('event skipped: session not found');
        return;
      }
      let failure = null;
      try { failure = await send({ sock: target.sock, sessionId: target.sessionId, content: p.prompt }); }
      catch (err) { failure = err?.message ?? String(err); }
      log(failure
        ? `event ${event.source}/${event.type} -> ${p.rule.name}: did not work: ${failure}`
        : `event ${event.source}/${event.type} -> ${p.rule.name}`);
    },
  };
}
