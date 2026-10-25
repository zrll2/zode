// GET /api/health — the deployment check. No secrets, no config echo.
const log = (line) => console.log(line);              // the one allowed log line

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method-not-allowed' });
    log(`GET /api/health 405`);
    return;
  }
  res.status(200).json({ ok: true });
  log(`GET /api/health 200`);
}
