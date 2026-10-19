# Phone app and remote access

The phone app talks to a small **relay** on your Mac. The relay talks to ZCode.

```
phone ──WebSocket──▶ relay (your Mac) ──local socket──▶ Zode.app ──▶ ZCode agent
```

## Start the relay and pair

```bash
./zode relay      # listens on 127.0.0.1:8787
./zode pair       # prints a QR code and a one-time code (valid 5 minutes)
```

In the app, tap **Scan QR code** (or paste the pairing text). The phone gets its own token.

```bash
./zode devices    # list paired phones
./zode revoke <id>
```

## Run the app

The app is an Expo (React Native) project in [`app/`](../app).

```bash
cd app && npm install
npx expo start           # open in the iOS Simulator or in Expo Go
```

Try it without a Mac connection: on the Pair screen tap **Try the demo**. It uses sample data.

For a real device build see the [Expo docs](https://docs.expo.dev/build/introduction/). Android works the same way.

## Reach your Mac from outside your home

The relay has **no TLS** by design. Do not put it on the open internet. Use a private network:

1. Install [Tailscale](https://tailscale.com) on the Mac and the phone.
2. Start the relay on the Tailscale address:
   ```bash
   RELAY_HOST=100.x.y.z RELAY_PUBLIC_URL=ws://100.x.y.z:8787 ./zode relay
   ```
3. `./zode pair` now prints a QR code with that address.

Other private networks (WireGuard, a VPN) work the same way. Do not forward the port on your router.

## Relay settings

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_HOST` | `127.0.0.1` | Address to listen on. |
| `RELAY_PORT` | `8787` | Port. |
| `RELAY_PUBLIC_URL` | `ws://HOST:PORT` | The address the phone uses (put in the QR code). |
| `RELAY_STATE_DIR` | `~/.zode/relay` | Where paired devices are stored (tokens are hashed). |

## What the phone can do

- List sessions, read history, send messages, stop a turn, start a new session (`plan` or `edit`).
- Follow a running session live and catch up after a dropped connection.

What it cannot do: `yolo` or `build` modes, change settings, or call any method outside the allow list in the relay.

## Known limit

Answering permission requests from the phone is not wired up yet. The approval sheet exists in the app, and the bridge can already answer requests, but the phone does not use it yet. Use `edit` mode, which does not ask.
