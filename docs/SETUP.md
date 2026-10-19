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

```bash
git clone https://github.com/zrll2/zode.git
cd zode
./zode install
```

`zode install` does four things:

1. Checks the tools above.
2. Runs `npm install` for `bridge/` and `relay/`.
3. Builds **ZCode-Tap** at `~/Applications/ZCode-Tap.app` (see below).
4. Installs the `delegate-to-zcode` skill into `~/.claude/skills` and remembers where Zode lives (`~/.zode/home`).

Then:

```bash
open ~/Applications/ZCode-Tap.app    # quit the original ZCode first; log in once; open any project
./zode doctor                        # every line should say OK
```

Add `--models` to `doctor` to also check that your login gives you models. (This creates one empty probe session in the ZCode list.)

## What is ZCode-Tap?

ZCode keeps your login inside the app, so another program cannot start its own agent and reuse the login. Zode needs to talk to the app's **own** agent. So `zode install` makes a copy of your ZCode app and replaces one small file inside the copy with a shim:

- When ZCode starts its agent, the shim runs the agent through Zode's wrapper (`bridge/agent-wrapper.mjs`).
- The wrapper passes everything through to ZCode unchanged, and also opens a local socket in `~/.zcode-tap/` so Zode can use the same agent.
- If the Zode folder is missing, the shim runs the real agent and ZCode works as usual.

The copy is made from your own installation on your own Mac. Nothing from ZCode is stored in this repository, and your original app is not changed. The copy is signed with an ad hoc signature, so it is yours only; it cannot be shared.

Only one ZCode can run at a time (they share one data folder). Use ZCode-Tap for your daily work while you use Zode.

## Update

When ZCode updates, rebuild the copy:

```bash
# quit ZCode-Tap first
./zode install
```

## Uninstall

```bash
rm -rf ~/Applications/ZCode-Tap.app ~/.zode ~/.zcode-tap ~/.claude/skills/delegate-to-zcode
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `doctor` says ZCode-Tap is not running | Quit ZCode, then `open ~/Applications/ZCode-Tap.app`. |
| `doctor` says no tap sockets | Open a project in ZCode-Tap. The sockets appear when ZCode starts an agent. |
| `doctor --models` says no models | Log in inside ZCode-Tap (it may ask once). |
| `install` says ZCode-Tap is running | Quit it (Cmd+Q) and run `./zode install` again. |
| `zcode/*` branch error | Use a separate worktree: `git worktree add ../x-wt -b zcode/my-task`. |
