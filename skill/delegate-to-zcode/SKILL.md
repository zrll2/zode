---
name: delegate-to-zcode
description: Delegate code writing to ZCode (GLM) while Claude Code decides, verifies and reviews. Use when the user says "delegate to zcode", "let zcode write it", "zcode do this", asks for parallel or autonomous coding, or when a project's CLAUDE.md says to delegate code writing to ZCode. Covers the full loop: preflight, git worktree, work order, run, verify, fix order, review, commit.
---

# Delegate code writing to ZCode

Roles: **you decide, verify and review. ZCode writes files.** Never write the feature code yourself when this skill applies, except mechanical fixes listed under "You do this yourself".

Zode lives in `__ZODE_HOME__` (installed by `zode install`). The tools are in `__ZODE_HOME__/bridge`. No MCP registration is needed; everything below is plain `node` commands.

## 0. Preflight (30 seconds)
```bash
node __ZODE_HOME__/bridge/doctor.mjs <worktree>          # add --models to also check the login
```
It checks: Zode.app running, server sockets present, branch is `zcode/*`, separate worktree.
- Not running: tell the user to quit the original ZCode (Cmd+Q) and run `open /Applications/Zode.app`. Only the Tap copy can be driven. Do not start it yourself while the user has unsaved work in ZCode.
- The project must be open in Zode.app, or any open project's server is used (sessions are not tied to one server).

## 1. One worktree per task
```bash
git worktree add ../<proj>-<task>-wt -b zcode/<task>
```
The tool refuses the main checkout and any branch not named `zcode/*`. Parallel tasks need separate worktrees and sessions; never two sessions on the same files.

## 2. Write the work order as a file
Use `order-template.md` (next to this file). Rules that decide quality:
- **Read-first docs**: put specs, API shapes, design docs and reference images INSIDE the worktree (`docs/`, `fixtures/`) and name them in the order. ZCode reads images too.
- **Give verified facts, never ask ZCode to guess**: exact RPC/API parameters, versions, file paths, real sample data. Every wrong guess so far came from a missing fact (wrong field name, outdated package version, wrong event shape).
- **Say what ZCode cannot do**: in `edit` mode it cannot run commands or delete files. You run installs, type checks, tests, and delete files.
- State scope (files it may touch), forbidden changes, and the quality bar.
- End with: `Reply with the single line: \`<name> done\`.` so the result is easy to read.
- One order = one coherent change (5 to 15 files). Split bigger work.

## 3. Send it and wait
```bash
node __ZODE_HOME__/bridge/zcode-task.mjs --worktree <wt> --order <order.md> --events <order>.events.jsonl --timeout 1700
```
- Run it with `run_in_background: true` (max reasoning takes 3 to 25 minutes). Do not poll; the completion notification arrives by itself.
- First call creates the session; the id is saved next to the worktree, so the next call to the same worktree continues the same conversation with all context.
- Output: JSON with `ended` (`turn-end`, `turn-failed`, `timeout`, `approval-needed`), the reply text, and `git status`.
- To stop a running turn: `node __ZODE_HOME__/bridge/zcode-stop.mjs <sessionId>` (the id is in the `.zcode-session-*` file). Killing the node process alone does NOT stop ZCode.

## 4. Verify yourself, with real commands
Run the project's install, type check, tests, build, and the real app when the change is user-visible (simulator, browser, curl). Most real bugs only show in the running app, not in unit tests.
- Failures go back to ZCode **verbatim** (command + exact error lines) as a short order. Do not paraphrase errors.
- Check that hidden requirements hold: no secrets logged, no extra network calls, no forbidden modes, no dead files left behind.

## 5. You do this yourself (mechanical, not feature code)
Dependency version conflicts and lockfiles, tsconfig/tool config needed by new tool versions, deleting files, running migrations or builds, committing.

## 6. Review and commit
- Read `git diff`. Audit against the order, not just against green tests.
- Commit per order, on the `zcode/*` branch, with a clear message. Never merge or push unless the user asks. Add the attribution line your harness requires.
- If the user dislikes the result, commit the old state as `wip:` (reversible), write a new spec, send a new order. Do not hand-edit around ZCode.

## Gotchas learned the hard way
- ZCode in `guarded` mode raises permission prompts that only the desktop window can answer (mobile approval is not built yet). Use `edit` (writes files) or `plan` (read only). Never `yolo`/`build`.
- Never put secrets, tokens, or credentials in an order. Never read or copy ZCode's credential files.
- A new ZCode app version needs the Tap copy rebuilt (run `zode install` again). If `doctor` says models are missing, that is usually why.
- The tap event log (`--events`) is large (mostly telemetry). Delete old `*.events.jsonl` files.
- Small screenshots lag one step in the simulator; take another one before concluding a UI is broken.
- Tell the user what you delegated, what you verified, and what you changed yourself.
