#!/usr/bin/env node
// zcode-relay CLI: thin wrapper over the relay service (service.mjs), which Zode.app embeds directly.
// Upstream : unix sockets from Zode.app (~/.zcode-tap/*.json), one per workspace server.
// Downstream: paired phones over WebSocket. Pair with `relay.mjs pair`; list/revoke with `devices` / `revoke <id>`.
import { createRelay } from './service.mjs';
export { checkPolicy } from './service.mjs';   // was exported by the old monolith; keep the import surface stable
import qr from 'qrcode-terminal';

const relay = createRelay({
  host: process.env.RELAY_HOST || undefined,
  port: process.env.RELAY_PORT ? Number(process.env.RELAY_PORT) : undefined,
  publicUrl: process.env.RELAY_PUBLIC_URL || undefined,
  stateDir: process.env.RELAY_STATE_DIR || undefined,
});

const cmd = process.argv[2] ?? 'serve';
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (cmd === 'serve') {
    const stop = () => relay.stop().catch(() => {}).then(() => process.exit(0));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    relay.start().catch(err => { console.error(`relay failed to start: ${err.message}`); process.exit(1); });
  } else if (cmd === 'pair') {
    const { code, publicUrl, payload } = relay.createPairing();
    console.log(`Pair code ${code} (valid 5 minutes, one use). Relay: ${publicUrl}`);
    qr.generate(payload, { small: true }); console.log(payload);
  } else if (cmd === 'devices') for (const d of relay.listDevices()) console.log(d.id, d.name, new Date(d.pairedAt).toISOString());
  else if (cmd === 'revoke') { relay.revokeDevice(process.argv[3]); console.log('revoked', process.argv[3]); }
  else console.log('usage: relay.mjs [serve|pair|devices|revoke <id>]');
  if (cmd !== 'serve') process.exit(0);
}
