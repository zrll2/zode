# Orchestration architecture (plan)

Status: planned, not built. Zode is ZCode-first today. This document describes how the same model generalizes to other project managers (PM) and other programmer backends, without rewriting what exists.

## The model
- **PM** (Claude Code, Codex or ChatGPT): decides, writes small work orders, verifies, reviews.
- **Programmer** (ZCode with GLM, OpenCode with DeepSeek or GLM, others later): does the heavy, token-intensive work inside an isolated git worktree.
- **Auditor** (a different model family from the programmer): reviews the diff before it ships.

Only four things cross the boundary: an **Order**, a **Run**, a stream of **Events**, and a **Verdict** (accept, fix, reject). Neither side knows the other's brand.

```
 PM clients            Control plane (local, one process)             Programmer backends
 ───────────           ────────────────────────────────────           ───────────────────
 Claude Code ─┐        orders → runs → events → verdicts              ┌─ ZCode (tap socket)
 Codex/ChatGPT─┼─MCP/CLI─▶  state machine · supervisor · policy ─────▶├─ OpenCode (server API)
 (any MCP/CLI)─┘        worktrees · ledger · router · audit          └─ others later
                              │
                              └─ local API ──▶ menu bar panel · phone (via relay)
```

## Design decisions
1. **Backends are agent harnesses, not models.** DeepSeek and GLM are models; a harness (ZCode, OpenCode) edits files and calls tools. The adapter wraps the harness; the model is configuration.
2. **One normalized event schema:** `run.started`, `message.delta`, `tool.call`, `permission.requested`, `permission.resolved`, `turn.ended {ok|failed|stopped}`, `usage`, `health`. Stall detection, heartbeat, approval policy and every UI read this schema, not a vendor wire format.
3. **Capabilities, not assumptions.** Each adapter declares what it supports (answer approvals from outside, stop and resume, usage, past sessions, attachments). A harness that cannot be approved remotely gets a stricter pre-set allowlist.
4. **The PM is an adapter too.** Claude Code uses a skill plus the MCP tools; Codex or ChatGPT use the same MCP tools with a generated instruction file. One source text, rendered per PM.
5. **Policy is a module.** Permission allowlist (deny by default), file-scope limits, time and token budgets, reasoning level per task type.
6. **Audit is risk-based, one per feature by default.** The auditor reviews the combined diff before merge. It also runs automatically for: authentication, payments, secrets, migrations, deletion or shell execution; release steps (build, sign, publish, public push); a cheap executor setup on a change without tests; a diff far larger than the order or touching files it did not name; two failed fix rounds. It is skipped for docs, copy and test-only changes. `--audit` forces it, `--no-audit` skips it.

## Modules
| Module | Job |
|---|---|
| `core` | Types, run state machine, event schema, ledger (runs, events, cost) |
| `supervisor` | Heartbeats, stall detection, steering, approval policy (from `zcode-task`) |
| `worktrees` | Create, scope, finish (from `zcode-finish` and `zcode-cleanup`) |
| `router` | Pick backend, model and reasoning from order size and risk; fallback chain |
| `adapters/executor-zcode`, `adapters/executor-opencode` | One per programmer backend |
| `adapters/pm-claude-code`, `adapters/pm-codex` | Instruction generators plus the MCP surface |
| `audit` | Run a second model on the diff, record the verdict |
| `server` | One local API (unix socket), an MCP server and a CLI over it |
| `ui` | Menu bar panel and phone app, reading runs rather than ZCode sessions |

Config (one file):
```
roles:   pm: claude-code | audit: codex | executors: [zcode, opencode:deepseek-chat]
routing: small mechanical → deepseek, low reasoning · design-heavy → glm, high
```

## Migration (each step ships on its own)
1. Extract `zcode-mcp` into `core` plus a `zcode` adapter; same CLI and skill as today.
2. Normalize events and add the run ledger (history, time and token cost).
3. Add the OpenCode adapter; compare it with DeepSeek on the same small orders used to compare reasoning levels.
4. Add the Codex PM adapter and instruction generator.
5. Add the router, budgets and the audit step.
6. Switch the menu bar panel and phone to read runs from any backend.

## Risks and open questions
- OpenCode's server API and permission model have to be verified before step 3. This is the biggest unknown.
- Harnesses differ on approvals; some need strict pre-set permissions instead of live approval.
- Cost differs per provider; start with tokens and time only.
- DeepSeek's tool-calling reliability inside a harness is unmeasured; step 3 produces the first numbers.
- Branding: "Zode" currently means a ZCode companion. A generic product needs a new framing.

## Decisions made
- Keep Zode ZCode-first with a plugin layer (no rebrand yet).
- OpenCode is the first additional backend.
- Audit is risk-based, one per feature by default.

## OpenCode spike (verified)
Checked against OpenCode 1.3.3 on this Mac, `opencode serve` (HTTP, localhost):
- **API fits the adapter interface.** `POST /session` (with `?directory=` to pick the worktree), `POST /session/{id}/prompt_async` (model, parts), `GET /event` (server-sent events: `message.part.delta`, `message.part.updated`, `session.status` idle or busy, `session.diff`), `GET /permission` and `POST /permission/{id}/reply` (`once`, `always`, `reject`, plus a message), `POST /session/{id}/abort`, `GET /session/{id}/message` (per-message token counts), `GET /session/{id}/diff`, `GET /session/status`.
- **Worked end to end:** the same small order used for the ZCode reasoning comparison, run through the API with GLM-5.3-flash: 26 s, about 1.5k output tokens, 16 passing tests. ZCode at low reasoning took 19 s and about 600 tokens for fewer test cases.
- **No permission asks** came up for pure file edits, so the existing approval policy (deny commands, allow read-only) maps to the reply endpoint directly.
- **DeepSeek:** the free DeepSeek model that ships with OpenCode answers 403 ("free tier can only be used from within OpenCode") when driven through the server API. A DeepSeek comparison needs the user's own DeepSeek API key configured as an OpenCode provider.
- **Credentials:** OpenCode keeps provider keys in its own store (`~/.local/share/opencode/auth.json`); Zode never needs to read them.
