// POST /api/push — the Mac presents a push id and its secret; the service decrypts the device token
// and forwards the sealed notification to APNs. Thin handler; the logic is in lib/handlers.mjs.
import { serveApi, handlePush, defaultDeps, ipOf } from '../lib/handlers.mjs';

const deps = defaultDeps(process.env);

export default async function handler(req, res) {
  await serveApi({
    req, res, route: '/api/push', method: 'POST', deps,
    run: (body) => handlePush(body, { ...deps, ip: ipOf(req) }),
  });
}
