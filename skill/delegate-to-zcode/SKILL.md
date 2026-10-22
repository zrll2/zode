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
- **Small orders, always.** Big orders make ZCode silent for 10 to 60 minutes (measured: worktree turns averaged 10 min, the worst ran 2 hours, with 38k to 50k output tokens). Split every feature into steps that each take ZCode about 5 minutes: at most 3 to 5 files and about 150 lines of change, one concern per order (for example: pure logic + its tests; then the UI that uses it; then docs). Send them one after another in the same session, verify each (tsc/tests) before sending the next. If an order needs more than one of "new module", "wire into UI", "docs", it is too big. Prefer 4 small orders over 1 big one: each turn end is a heartbeat.
- **Reasoning level** (`--reasoning low|high|max`, default `low`): measured on the same small order (a 17-line function plus tests, identical working code): `low` took 19 s and 596 output tokens, `max` took 144 s and 6644 tokens. Orders are small, so `low` is the default. Use `high` when a step needs real design or touches unfamiliar code, `max` only for hard debugging, and expect it to be slow. If a `low` result is wrong, send the exact error back first; raise the level only if it keeps failing.

## 3. Send it and wait
```bash
node __ZODE_HOME__/bridge/zcode-task.mjs --worktree <wt> --order <order.md> --events <order>.events.jsonl --timeout 1700
```
- Run it with `run_in_background: true` (max reasoning takes 3 to 25 minutes). Do not poll; the completion notification arrives by itself.
- First call creates the session; the id is saved next to the worktree, so the next call to the same worktree continues the same conversation with all context.
- **Heartbeat probe every 5 minutes**: `zcode-task` prints a `[heartbeat] {...}` line to stderr every 5 min (`--heartbeat 300`: elapsed, event count, idle seconds, agent status) and keeps the latest in `<events>.heartbeat.json`. Run it as `... > out.txt 2>&1` in the background and watch `out.txt` (Monitor, or Read it when you check in). Independent one-shot check any time: `node __ZODE_HOME__/bridge/zcode-probe.mjs <sessionId>` (exit 1 and `problems` when no ZCode server is alive or a running turn has been silent for more than 5 min).
- **Permission prompts never hang a turn.** ZCode asks before running any shell command, even `ls`, and a human-only prompt was the main cause of stalls. `zcode-task` now answers by policy (`approval-policy.mjs`): read-only inspection (ls, cat, grep, find, git status/diff/log, plist Print) is allowed unless it touches credentials or secrets; everything else (installs, builds, writes, network, substitutions, redirects) is denied. If ZCode retries a denied command it stops the turn and sends one plain steer message ("skip it, use file tools only"). The JSON has `auto_approvals`. More than `--max-denials 8`, or a question for a human, ends with `approval-needed`: read what ZCode asked, answer it in a short order. `guarded` mode is not for delegation.
- `--stall 300` (default): if ZCode emits no meaningful event for 300 s (telemetry does not count) the tool returns `ended: stalled` (hung), `zcode-gone` (Zode.app/server died) or `disconnected` (socket dropped) with `idle_s` and a hint. Then run `zode doctor`, stop the session, resend (or relaunch Zode.app), and tell the user.
- Output: JSON with `ended` (`turn-end`, `turn-failed`, `timeout`, `approval-needed`, `stalled`, `zcode-gone`, `disconnected`), the reply text, and `git status`.
- To stop a running turn: `node __ZODE_HOME__/bridge/zcode-stop.mjs <sessionId>` (the id is in the `.zcode-session-*` file). Killing the node process alone does NOT stop ZCode.

## 3b. Parallel orders (several ZCode tasks at once)
Use this when a job splits into pieces that do not touch the same files (for example: relay tests, a phone screen, a docs page). Do NOT parallelize steps that depend on each other or edit the same file: they would conflict at merge time.
1. One worktree and one `zcode/*` branch per piece (`git worktree add ../<proj>-<piece>-wt -b zcode/<piece>`). Two orders in one worktree is refused.
2. Write one small order per piece (same rules as above: at most 3 to 5 files, about 5 minutes each). Tell each order which files it may touch.
3. Write `plan.json`: `[{"name": "relay-tests", "worktree": "/abs/path-wt", "order": "/abs/order.md", "reasoning": "low"}, ...]`.
4. Run: `node __ZODE_HOME__/bridge/zcode-batch.mjs --plan plan.json --max-parallel 3 --out batch.json > batch.log 2>&1` in the background. Three at once is the practical limit; more only slows every task.
5. Progress arrives on its own: a block every 5 minutes (`--heartbeat 300`) and whenever a task ends, one line per task: state (queued, running, done, problem), minutes, files changed, idle seconds, prompts answered. Read `batch.log` (or follow it with Monitor) when you check in; `batch.json` always holds the latest state. A task in `problem` (stalled, zcode-gone, approval-needed, turn-failed) does not stop the others: handle it with the stall steps above, resend the fix as a normal order.
6. When the batch ends, verify and commit each worktree separately (tsc, tests), then merge the branches one at a time and rerun the checks after each merge. Finish each worktree with `zcode-finish.mjs` (step 6b).

## 4. Verify yourself, with real commands
Run the project's install, type check, tests, build, and the real app when the change is user-visible (simulator, browser, curl). Most real bugs only show in the running app, not in unit tests.
- Failures go back to ZCode **verbatim** (command + exact error lines) as a short order. Do not paraphrase errors.
- Check that hidden requirements hold: no secrets logged, no extra network calls, no forbidden modes, no dead files left behind.

## 5. You do this yourself (mechanical, not feature code)
Dependency version conflicts and lockfiles, tsconfig/tool config needed by new tool versions, deleting files, running migrations or builds, committing.

## 6b. Finish: remove the worktree and tidy the conversations
Every task leaves a sibling folder (`<proj>-<task>-wt`), a `zcode/*` branch and one ZCode conversation per worktree. When the work is merged and the user has what they asked for, always finish the task (not before: a later fix order reuses the worktree and session):
```bash
node __ZODE_HOME__/bridge/zcode-finish.mjs --worktree <wt> --dry-run   # shows what it will do, or why it refuses
node __ZODE_HOME__/bridge/zcode-finish.mjs --worktree <wt>              # archive sessions, remove the folder, delete the merged branch
```
It refuses and removes nothing unless: the branch is merged into main/master, `git status` is clean (no uncommitted or untracked files), and no ZCode turn or `zcode-task` is still running for it. Fix what it names (merge, commit, wait) and run it again. `--force` skips only the "merged" check; use it only when the user says the branch can be thrown away. Never `rm -rf` a worktree by hand.
- Session cleanup alone: `node __ZODE_HOME__/bridge/zcode-cleanup.mjs --worktree <wt>` archives (reversible, hidden from lists); `--purge` deletes for good (ask first).
- Orders and event logs (`*.events.jsonl`, `*.out.json`) belong in a scratch folder outside the worktree and outside `~/Projects`; delete them when the task is finished.
- Before you tell the user a task is done, run the finish command or say why it was not run.

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
