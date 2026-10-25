// POST /api/register — a phone hands over its APNs device token and gets an opaque push id plus a
// secret. The handler is thin: method guard, body cap, one log line; the logic is in lib/handlers.mjs.
import { serveApi, handleRegister, defaultDeps, ipOf } from '../lib/handlers.mjs';

const deps = defaultDeps(process.env);

export default async function handler(req, res) {
  await serveApi({
    req, res, route: '/api/register', method: 'POST', deps,
    run: (body) => handleRegister(body, { ...deps, ip: ipOf(req) }),
  });
}
