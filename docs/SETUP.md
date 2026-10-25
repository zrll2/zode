# Setup

Zode runs on macOS. Setup takes about two minutes.

## You need

| Thing | Why |
|---|---|
| macOS 13 or newer | Zode builds a copy of the ZCode Mac app. |
| [ZCode](https://z.ai) installed in `/Applications`, logged in | The agent that writes the code. |
| [Claude Code](https://claude.com/claude-code) | The supervisor. |
| Node.js 20 or newer, Git | The bridge, relay and scripts. |

## Install

The easy way is the packaged app: download **Zode for Mac** from the [latest release](https://github.com/zrll2/zode/releases/latest), open the DMG and drag **Zode** to Applications — its setup window walks you through the rest (see the README's Quick start). Everything below is the developer/legacy path that builds from this repo.

```bash
git clone https://github.com/zrll2/zode.git
cd zode
./zode install
```

`zode install` does four things:

1. Checks the tools above.
2. Runs `npm install` for `bridge/`, `relay/` and `macapp/`.
3. Builds **Zode.app** at `/Applications/Zode.app` (see below) — the phone relay runs inside it.
4. Installs the `delegate-to-zcode` skill into `~/.claude/skills` and remembers where Zode lives (`~/.zode/home`).

Then:

```bash
open /Applications/Zode.app    # quit the original ZCode first; log in once; open any project
./zode doctor                        # every line should say OK
```

Add `--models` to `doctor` to also check that your login gives you models. (This creates one empty probe session in the ZCode list.)

To use the phone app: click the **Zode icon in the menu bar** of Zode.app → **Pair a phone…** → scan the QR code with Zode on your phone. Details in [PHONE.md](PHONE.md).

## What is the copy of ZCode for?

`./zode install` builds its copy as **Zode.app** with the relay inside — the original integrated product. The current menu bar app builds its copy as **ZCode Engine.app** and runs the relay itself; why a copy exists at all is the same in both cases.

ZCode keeps your login inside the app, so another program cannot start its own agent and reuse the login. Zode needs to talk to the app's **own** agent. So `zode install` makes a copy of your ZCode app and replaces one small file inside the copy with a shim:

- When ZCode starts its agent, the shim runs the agent through Zode's wrapper (`bridge/agent-wrapper.mjs`).
- The wrapper passes everything through to ZCode unchanged, and also opens a local socket in `~/.zcode-tap/` so Zode can use the same agent.
- If the Zode folder is missing, the shim runs the real agent and ZCode works as usual.

The copy is made from your own installation on your own Mac. Nothing from ZCode is stored in this repository, and your original app is not changed. The copy is signed with an ad hoc signature, so it is yours only; it cannot be shared.

Only one ZCode can run at a time (they share one data folder). Use Zode.app for your daily work while you use Zode.

## Update

```bash
./zode update-zcode
```

One command updates everything: it downloads the official ZCode release (the same zip ZCode's own updater would use), checks its size, SHA-512 and developer signature, quits ZCode and Zode, swaps in the new original, rebuilds Zode.app from it and reopens Zode. `--check` only prints whether an update is available, and `--no-rebuild` leaves Zode.app alone. If the rebuild fails, the new ZCode is already in place and your old Zode.app is untouched — run `./zode install` (log: `~/.zode/update.log`).

ZCode's own updater cannot do this job: it aborts while any copy of the app is still running, and in Zode.app it cannot install at all because that copy is re-signed — which is why its updater is switched off on purpose.

The easy way is the menu bar: within about 6 hours of a release, Zode shows **ZCode x.y.z is available. Update ZCode and rebuild Zode…** there. Click it, confirm, and Zode quits, runs the whole update and reopens by itself a few minutes later. `./zode update-zcode` is the same thing from a terminal.

To keep ZCode's own update check in the copy anyway, start it with `ZODE_KEEP_UPDATER=1`.

Changed something in this repo, or copied ZCode by hand, and only want to (re-)apply the integration to your existing Zode.app?

```bash
./zode app                 # installs macapp/dist into the app, patches it, re-signs
./zode app --uninstall     # back to a plain ZCode copy
```

## Uninstall

```bash
rm -rf /Applications/Zode.app ~/.zode ~/.zcode-tap ~/.claude/skills/delegate-to-zcode
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `doctor` says Zode.app is not running | Quit ZCode, then `open /Applications/Zode.app`. |
| `doctor` says no tap sockets | Open a project in Zode.app. The sockets appear when ZCode starts an agent. |
| `doctor --models` says no models | Log in inside Zode.app (it may ask once). |
| `install` says Zode.app is running | Quit it (Cmd+Q) and run `./zode install` again. |
| **Rebuild Zode…** ended with a "Rebuild failed" notification | Read `~/.zode/rebuild.log`; the old Zode.app is still in place. Then run `./zode install` by hand. |
| The menu says the relay could not start | Another relay is using the port (an old `./zode relay` in a terminal, or a second Zode.app). Quit it, then tick `Relay on` in the menu. |
| `zcode/*` branch error | Use a separate worktree: `git worktree add ../x-wt -b zcode/my-task`. |
