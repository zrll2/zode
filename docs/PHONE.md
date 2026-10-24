# Phone app and remote access

The phone app talks to a small **relay** on your Mac. The relay talks to ZCode.

```
phone ──WebSocket──▶ relay (your Mac) ──local socket──▶ Zode.app ──▶ ZCode agent
```

## Pair

You need: your Mac awake, Zode open on it (a **Z** in the menu bar), and the phone on the same Wi-Fi (or Tailscale, see below).

1. On the Mac, click the **Z in the menu bar** and choose **Pair a phone…**. A window shows a QR code.
2. In Zode on the phone, tap **Scan QR code** and point it at the window (or paste the pairing text under "Paste pairing text"). The phone gets its own key.

The same menu shows whether the relay is running, which addresses it is reachable on, and the paired phones (`Revoke …` removes one). `Relay on` turns it off and on.

**Reachable from** is `Automatic` by default: the relay listens on the Wi-Fi and the Tailscale address at the same time, the QR code carries all of them, and a paired phone is told the current list every time it connects. Leaving one network does not cut the other off. Picking a specific address instead restricts the relay to it.

### If the phone says it can't reach your Mac
Check these in order:
1. The Mac is awake (not asleep, lid open or a display attached) and Zode is open.
2. The phone and the Mac are on the same Wi-Fi. Guest or "isolated" Wi-Fi networks block this.
3. A VPN on the phone or Mac is off, or both use Tailscale.
4. The network changed while the Mac was asleep? Open the menu bar panel once (or restart Zode from the menu bar); the relay follows the network within 10 seconds and logs the change.

If a code stops working it has probably expired: choose **Pair a phone…** again for a new one.

## Reach your Mac from outside your home

The relay has **no TLS** by design. Do not put it on the open internet. Do not forward the port on your router.

- `Automatic` (the default) listens on the Wi-Fi and the Tailscale address at once: Wi-Fi at home, Tailscale anywhere. **Wi-Fi is not encrypted; Tailscale is.**
- **Tailscale** is the safe choice away from home: encrypted, and only your devices are in the network. Install it on the Mac and the phone; Automatic picks it up as soon as it is on.
- **Wi-Fi / local network** works at home but is **unencrypted**. Use it only on a network you trust.
- `This Mac only` (`127.0.0.1`) is for the iOS simulator on the same Mac.

If you would rather restrict the relay to one address — Tailscale only, say — pick it under **Reachable from**; the explicit choice is honoured until you change it back.

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

The app and the terminal relay share `~/.zode/relay`, so a phone paired with one works with the other. Run only one of them at a time (they would fight over the port). `RELAY_HOST` here is a single address; the Mac app runs the same relay with `Automatic`, which listens on the Wi-Fi and the Tailscale address at the same time.

## What the phone can do

- See every conversation: needs-you and running at the top, then by day. Archive a conversation on the phone (a swipe).
- Read the work live, send messages, stop a turn, start a new conversation.
- Rename a conversation, change the model and the thinking level, and see usage.
- Attach photos and documents (up to 8 MB each).
- Choose how careful ZCode is: Plan (reads only), Edit (can change files) or Guarded (asks before each change).

What it cannot do: `yolo` or `build` modes, change settings, or call anything outside the relay's allow list. Deleting a conversation is not possible from outside ZCode, so there is no delete button.

## Known limit

In Guarded mode ZCode asks before each change, and that question can only be answered in the ZCode window on the Mac for now. The phone shows the conversation as needing you; answering from the phone is not built yet. Use Edit mode if you want to work only from the phone.
