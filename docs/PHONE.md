# Phone app and remote access

The phone app talks to a small **relay** on your Mac. The relay talks to ZCode.

```
phone ──WebSocket──▶ relay (your Mac) ──local socket──▶ Zode.app ──▶ ZCode agent
```

## Pair

After `./zode install` the relay runs inside Zode.app — there is nothing to start.

1. Click the **Zode icon in the menu bar** of your Mac.
2. Choose **Pair a phone…**. A window shows a QR code and an 8 character code.
3. In Zode on your phone, tap **Scan QR code** and point it here (or paste the pairing text). The phone gets its own token.

The same menu shows whether the relay is running, which address it is reachable on, and the paired phones (`Revoke …` removes one). `Relay on` turns the relay off and on.

## Reach your Mac from outside your home

The relay has **no TLS** by design. Do not put it on the open internet. Do not forward the port on your router.

- **Tailscale** is the safe choice away from home: encrypted, and only your devices are in the network. Install it on the Mac and the phone, then pick `Tailscale (100.x.y.z)` under **Reachable from** in the menu.
- **Wi-Fi / local network** works at home but is **unencrypted**. Use it only on a network you trust.
- `This Mac only` (`127.0.0.1`) is for the iOS simulator on the same Mac.

## Run the app

The app is an Expo (React Native) project in [`app/`](../app).

```bash
cd app && npm install
npx expo start           # open in the iOS Simulator or in Expo Go
```

Try it without a Mac connection: on the Pair screen tap **Try the demo**. It uses sample data.

For a real device build see the [Expo docs](https://docs.expo.dev/build/introduction/). Android works the same way.

## Headless use (terminal only)

You can run the same relay without the app window, for example over SSH:

```bash
./zode relay      # RELAY_HOST (default 127.0.0.1), RELAY_PORT (default 8787)
./zode pair       # prints a QR code and a one-time code (valid 5 minutes)
./zode devices    # list paired phones
./zode revoke <id>
```

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_HOST` | `127.0.0.1` | Address to listen on. |
| `RELAY_PORT` | `8787` | Port. |
| `RELAY_PUBLIC_URL` | `ws://HOST:PORT` | The address the phone uses (put in the QR code). |
| `RELAY_STATE_DIR` | `~/.zode/relay` | Where paired devices are stored (tokens are hashed). |

The app and the terminal relay share `~/.zode/relay`, so a phone paired with one works with the other. Run only one of them at a time (they would fight over the port).

## What the phone can do

- List sessions, read history, send messages, stop a turn, start a new session (`plan` or `edit`).
- Follow a running session live and catch up after a dropped connection.

What it cannot do: `yolo` or `build` modes, change settings, or call any method outside the allow list in the relay.

## Known limit

Answering permission requests from the phone is not wired up yet. The approval sheet exists in the app, and the bridge can already answer requests, but the phone does not use it yet. Use `edit` mode, which does not ask.
