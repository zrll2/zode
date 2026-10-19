# Security

Zode lets a process (and a phone) start and steer a coding agent on your Mac. Treat it like remote access to your machine.

## What each part can do

| Part | Power | Limits |
|---|---|---|
| Bridge / skill | Send work orders to ZCode in a `zcode/*` worktree. | Refuses the main checkout and any other branch. Never uses `yolo` or `build`. |
| ZCode agent in `edit` mode | Write files in the worktree. | Cannot run commands. Claude Code runs all commands. |
| Relay | Forward 16 session methods from a paired phone. | Only `plan` and `edit` modes. No settings, no provider or workspace calls. |
| Phone app | Whatever the relay allows. | Token is stored in the system secure store (Keychain on iOS). |

## Your ZCode login

Zode never reads, copies or sends your ZCode credentials. ZCode-Tap is a copy of your own app that keeps its own login on your Mac, exactly like the original. The only change inside the copy is one shim file (`Resources/glm/zcode.cjs`).

## The relay

- Listens on `127.0.0.1` unless you set `RELAY_HOST`.
- **No TLS.** Use a private network (Tailscale or WireGuard). Never expose the port to the internet.
- Pairing codes work once and expire after 5 minutes. Each phone gets its own random token; only a hash is stored (`~/.zode/relay/devices.json`, mode 0600).
- Five failed attempts from one address block it for a minute.
- A frame above 800 KB is never sent to a phone.
- Revoke a phone any time: `./zode revoke <id>`.

## The tap socket

`~/.zcode-tap/*.sock` are unix sockets with mode 0600 in a directory with mode 0700. Any process running as you can use them, which is the same trust level as running ZCode yourself. Another user on the Mac cannot.

## Before you share a project

`./zode scan` looks for home paths, emails, tokens, real session ids, private IPs and files that must not be published (ZCode's own files, event logs). Put your own names and project names in `~/.zode-scan-denylist` (one regex per line) to catch them too. Work-order event logs (`*.events.jsonl`) contain full conversations; do not commit them.

## Report a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository (Security tab, "Report a vulnerability"). Do not open a public issue for a security problem.
