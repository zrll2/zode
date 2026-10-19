<p align="center">
  <img src="assets/logo.png" width="88" alt="Zode logo">
</p>

<h1 align="center">Zode</h1>

<p align="center">
  <b>Claude Code decides. ZCode writes. You watch from your phone.</b><br>
  An autonomous coding loop for macOS, with a pocket-sized remote control.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-141413?style=flat-square"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-13%2B-141413?style=flat-square">
  <img alt="Status: beta" src="https://img.shields.io/badge/status-beta-C4623F?style=flat-square">
  <img alt="Unofficial" src="https://img.shields.io/badge/ZCode-unofficial-6F6D66?style=flat-square">
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/images/hero.png" width="860" alt="Zode: sessions, chat and approval screens, light and dark">
</p>

---

## What is Zode?

You pay for a coding plan on [ZCode](https://z.ai). You also use [Claude Code](https://claude.com/claude-code).
Zode connects them, so the two do the jobs they are best at:

- **Claude Code** plans the work, writes the work order, runs the tests and reviews the diff.
- **ZCode** (GLM) writes the code, inside a safe git worktree.
- **You** can follow every session, and answer questions, from your phone.

No copy and paste. No API key. Zode drives the ZCode app you already have, with your own login.

## Why you might want it

| Without Zode | With Zode |
|---|---|
| You paste instructions into ZCode, then paste the answer back. | Claude Code sends the order and reads the reply by itself. |
| You read every diff yourself. | Claude Code runs the tests, sends errors back, and reviews. |
| You sit at the Mac while the agent works. | You check progress from the sofa. |

## Quick start

You need: a Mac, [ZCode](https://z.ai) (logged in), [Claude Code](https://claude.com/claude-code), Node.js 20 or newer, Git.

```bash
git clone https://github.com/zrll2/zode.git && cd zode
./zode install        # builds a "Zode.app" copy of your ZCode, installs the skill
open ~/Applications/Zode.app   # log in once, open any project
./zode doctor         # everything green?
```

Now open any project in Claude Code and say:

> **Delegate this to ZCode:** add a dark mode toggle to the settings page.

That is all. Claude Code creates a worktree, writes the order, sends it to ZCode, checks the result and shows you the diff.

### Add the phone app (optional)

```bash
./zode relay          # starts the relay on your Mac
./zode pair           # prints a QR code
```

Open Zode on your phone, tap **Scan QR code**. Done. See [docs/PHONE.md](docs/PHONE.md) to reach your Mac when you are away from home.

## How it works

```mermaid
flowchart LR
  CC["Claude Code<br/><sub>decides, tests, reviews</sub>"] -->|work order| BR["Zode bridge<br/><sub>on your Mac</sub>"]
  BR -->|stdio| ZC["ZCode agent<br/><sub>writes the code</sub>"]
  ZC -->|reply + events| BR
  BR -->|result| CC
  PH["Zode phone app"] <-->|WebSocket| RL["Zode relay"] <--> BR
```

1. You ask Claude Code for a change.
2. Claude Code makes a git worktree on a `zcode/*` branch and writes a **work order** (a Markdown file).
3. The bridge sends the order to ZCode and waits for the answer.
4. Claude Code runs install, type check, tests and the app. Errors go back to ZCode, word for word.
5. Claude Code reviews the diff and commits. You decide whether to merge.

## What is inside

| Folder | What it is |
|---|---|
| [`bridge/`](bridge) | The MCP server and command line tools that drive ZCode. |
| [`skill/`](skill) | The `delegate-to-zcode` skill: the whole workflow, learned the hard way. |
| [`relay/`](relay) | A small WebSocket gateway so your phone can reach your Mac safely. |
| [`app/`](app) | The mobile app (Expo, React Native) for iOS and Android. |
| [`docs/`](docs) | Setup, architecture, protocol and security notes. |

## The phone app

<p align="center">
  <img src="docs/images/sessions.png" width="230" alt="Sessions">
  &nbsp;
  <img src="docs/images/chat.png" width="230" alt="Chat">
  &nbsp;
  <img src="docs/images/approval.png" width="230" alt="Approval">
</p>

- **Needs you** first, then **Running**, then history by day.
- Read the agent like a document: Markdown, tool calls and thinking collapsed to one line.
- Allow or deny an edit with one tap.
- Light and dark, black and white, nothing loud.

## Safe by default

- ZCode only works in a **separate git worktree** on a `zcode/*` branch. It never touches `main`.
- ZCode **writes files only**. Claude Code runs every command.
- The phone can use `plan` and `edit` modes only. `yolo` and `build` are blocked in the relay.
- Phones pair with a one-time code and get their own revocable token.
- The relay listens on `127.0.0.1` unless you choose a private network address (we suggest Tailscale).
- Zode never reads or copies your ZCode credentials.

Read [docs/SECURITY.md](docs/SECURITY.md) before you expose the relay beyond your own machine.

## FAQ

**Is this an official ZCode project?** No. Zode is independent and not affiliated with Z.AI. It talks to your local ZCode app the same way the app talks to its own agent.

**Do I need an API key?** No. Zode uses the login of your ZCode app.

**Why does Zode.app exist?** ZCode keeps your login inside the app, so another program cannot reuse it. The copy adds a tiny shim that shares the app's own agent over a local socket. It is built from your own installation, on your own Mac. Your original app is not changed.

**Windows or Linux?** Not yet. Zode is built and tested on macOS.

**What happens when ZCode updates?** Run `./zode install` again to rebuild the copy.

## Documentation

[Setup](docs/SETUP.md) · [Workflow](docs/WORKFLOW.md) · [Phone and remote access](docs/PHONE.md) · [Architecture](docs/ARCHITECTURE.md) · [Protocol notes](docs/PROTOCOL.md) · [App Store and Google Play](docs/STORE_SUBMISSION.md) · [Privacy](docs/PRIVACY.md) · [Security](docs/SECURITY.md) · [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE). ZCode and Claude Code are trademarks of their owners. Zode contains no code from either product.
