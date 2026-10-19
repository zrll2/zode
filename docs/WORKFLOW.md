# Workflow: Claude Code decides, ZCode writes

This is the loop the `delegate-to-zcode` skill teaches Claude Code. You can also run every step by hand.

```
you ──ask──▶ Claude Code ──work order──▶ ZCode
                  ▲                         │
                  └── diff, errors, tests ◀─┘
```

## The loop

1. **Preflight.** `./zode doctor <worktree>`.
2. **One worktree per task.** `git worktree add ../myapp-dark-mode-wt -b zcode/dark-mode`. ZCode never works on `main`. The bridge refuses a branch that is not named `zcode/*`.
3. **Write a work order** (a Markdown file; see below).
4. **Send it.** `./zode task --worktree ../myapp-dark-mode-wt --order order.md`. Run it in the background; a turn can take minutes. The first call creates a ZCode session. The next call to the same worktree continues the same conversation, with all context.
5. **Verify with real commands.** Claude Code runs install, type check, tests, build, and the app itself. In `edit` mode ZCode cannot run commands, so nothing is verified until Claude Code does it.
6. **Fix loop.** If something fails, Claude Code sends the exact error text back as the next order. Never paraphrase an error.
7. **Review and commit.** Claude Code reads the diff against the order, commits on the `zcode/*` branch, and tells you. You decide about merging.

## What makes a good work order

Use [`skill/delegate-to-zcode/order-template.md`](../skill/delegate-to-zcode/order-template.md). The rules that matter most:

- **Read-first files.** Put specs, API shapes, sample data and reference images inside the worktree and name them. ZCode reads images too.
- **Give facts, not hopes.** Exact field names, package versions, file paths, real sample responses. Every wrong result in our own use came from a missing fact: a wrong field name, an outdated package version, a wrong event shape.
- **Say what ZCode cannot do.** It cannot run commands or delete files. Claude Code does those.
- **Scope.** List the files it may touch and what it must not change.
- **One clear ending.** "Reply with the single line: `done`."
- **One order, one coherent change.** Five to fifteen files is a good size.

See [`examples/work-orders/`](../examples/work-orders) for real orders that built this project's mobile app.

## Modes

| Mode | What ZCode may do | Use it for |
|---|---|---|
| `plan` | Read and propose. Changes nothing. | Reviews, investigations. |
| `edit` | Write files. Cannot run commands. | Normal coding work (default). |
| `guarded` | Asks before risky tools. | Needs someone at the ZCode window to answer. |

Zode never uses `yolo` or `build`.

## Run several tasks at once

Use one worktree and one session per task. Two sessions must never touch the same files.

## Stop a running turn

```bash
./zode stop <sessionId>     # the id is in the .zcode-session-* file next to the worktree
```

Killing the Node process alone does not stop ZCode.

## Use it from Claude Code

After `./zode install`, the skill is available in every project. Say "delegate this to ZCode: ..." or add this line to a project's `CLAUDE.md`:

```
Delegate all code writing to ZCode following the `delegate-to-zcode` skill (~/.claude/skills/delegate-to-zcode/SKILL.md): you decide, verify and review; ZCode writes the files.
```

## Optional: MCP tools

The skill needs no MCP. If you prefer tools, register the bridge once:

```bash
claude mcp add --scope user zode -- node "$(pwd)/bridge/server.mjs"
```

Tools: `zcode_new`, `zcode_send`, `zcode_wait`, `zcode_events`, `zcode_pending`, `zcode_approve`, `zcode_stop`, `zcode_close`, `zcode_resume`, `zcode_sessions`.
