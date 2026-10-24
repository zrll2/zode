# Code health audit (work order A1)

Date: 2026-10-25 · Branch `zcode/audit` · Reviewer: read-only audit, nothing changed but this file.

Method: every `.mjs`/`.ts`/`.tsx` source in `relay/`, `mac/`, `macapp/`, `app/src`, the two big `app/app` screens, the main scripts and docs were read end to end. Not read: renderer JS (`mac/panel/panel.js`, `mac/pair/*`, `mac/setup/*` beyond their HTML), `bridge/server.mjs` past line 60, `bridge/approval-policy.mjs`, `scripts/scan-secrets.mjs`, `scripts/apply-app.sh`, `assets/` Python generators, `packaging/`. All numbers below were counted from the files themselves (no shell available); anything uncertain is marked.

---

## 中文摘要

总体判断：**不是屎山，是一个两周赶出来的、底子干净的年轻代码库**。叶子模块（relay 的纯函数、mac 的 lib、app/src 的纯逻辑）写得很好：防御性强、依赖注入、几乎每个文件都有测试。真正的问题是两个"上帝函数"（`mac/main.mjs` 的 `start()` 约 1070 行、`app/session/[id].tsx` 的 `SessionScreen` 约 840 行）和两套 Mac 产品之间的复制粘贴已经出现行为漂移：

- 最严重的一个漂移：新菜单栏应用把"真实活跃时间"修复弄丢了。`macapp/lib/sessions.mjs:95` 会用 sqlite 修正 `updatedAt`，而 `mac/lib/sessions.mjs:8` 导入了 `withRealActivity` 却**从未调用**——托盘菜单会把几天前的会话显示成 "Just now"。
- 两套应用共用 `~/.zode/settings.json`，但 `macapp/lib/settings.mjs:4` 只认 5 个键，保存时会**抹掉**新应用的 `setupDone/keepAwake/voiceLanguage`。
- 文档明显落后于代码：README 的目录表没有 `mac/`；SECURITY.md 还说"只有 plan/edit、16 个方法"（实际 22 个方法、3 种模式）；PHONE.md 和 relay/README 的"known limit：guarded 只能在 Mac 上回答"已被 `relay/service.mjs:436-446` 的 respond 功能推翻。
- 最大的未测风险：`mac/main.mjs` 的全部接线（Electron 主进程）零测试；两个手机大屏也零测试。

建议优先做下面 12 条里的前 4 条（都是一次小订单能完成的 S 级改动），然后再动结构。

---

## 1. Size and shape

Biggest non-test source files (lines counted from the read files):

| File | Lines | What it does too much of |
|---|---|---|
| `app/app/session/[id].tsx` | 1273 | One screen component owns: history bootstrap, 3 attachment pickers + upload, optimistic send, rename/model/usage/mode sheets, approval bar, scroll pinning, 6 row components and all styles. |
| `mac/main.mjs` | 1150 | Relay lifecycle, addresses polling, tray menu, panel window, pairing window, setup wizard, voice/STT, self-update, engine update/rebuild, ~20 IPC handlers — all inside one closure. |
| `app/app/sessions.tsx` | 856 | Home list, search/filter, approvals, prefs, toasts, menus, all styles. |
| `macapp/main.mjs` | 432 | The older in-app variant of the above (relay, tray, pair window, update flows). |
| `relay/service.mjs` | 521 | Relay: policy, pairing, uploads, STT relay, servers, framing. Dense but cohesive; this is the best big file in the repo. |
| `mac/lib/sessions.mjs` / `macapp/lib/sessions.mjs` | 326 / 276 | Tap discovery + listing + pending + usage + summarize (see duplication below). |

Functions over 80 lines (counted, not guessed):

- `mac/main.mjs`: **1** — `start()` at `mac/main.mjs:74`–`1142` ≈ **1069 lines**. Everything else in the file is < 55 lines.
- `relay/service.mjs`: **2** — `createRelay()` `relay/service.mjs:95`–`521` ≈ 427 lines, and the nested `start()` `relay/service.mjs:393`–`500` ≈ 108 lines (request handling inline inside it).
- `app/app/session/[id].tsx`: **1** — `SessionScreen` `app/app/session/[id].tsx:131`–`968` ≈ **838 lines**.
- `app/app/sessions.tsx`: **1** — `SessionsScreen` `app/app/sessions.tsx:85`–`738` ≈ **654 lines**.

**Most worrying single unit: `start()` in `mac/main.mjs:74`.** It closes over ~30 mutable locals (`relay`, `settings`, `work`, `enginePath`, `update`, `release`, `panelWindow`, …), owns five timers, three windows and ~20 IPC handlers, and is the only nontrivial module in the repo with no test at all. `SessionScreen` is the same shape on the phone. `relay/createRelay` is nearly as big but stays readable because its pieces (policy, STT, pending reconcile) are already extracted and tested.

## 2. Duplication

Deliberate (two shipped products, shared file per design): `mac/lib/*.mjs` vs `macapp/lib/*.mjs`, and the second half of `mac/main.mjs` mirroring `macapp/main.mjs` (relay setup `mac/main.mjs:227` vs `macapp/main.mjs:85`, `checkUpdate`/`checkReleaseOnce`, `workTooltip`, `measureTexts`/`withMeasures`, `refreshSessions`, `runWorkAction`, `findPending`, `actions`, `pairingView`, `showPairWindow`, the IPC handlers). Roughly 40–50% of `macapp/main.mjs` exists again in `mac/main.mjs`. This is a fork, not an accident — but it is drifting.

Accidental drift — same function, different behaviour **today**:

1. **Real activity times (user-visible bug).** `macapp/lib/sessions.mjs:95` calls `withRealActivity(...)` to replace the agent's lying `updatedAt` with sqlite truth; `mac/lib/sessions.mjs:8` imports `withRealActivity` and **never calls it** (dead import), and `mac/main.mjs:350`–`384` (`refreshSessions`) doesn't apply it either. Result: the old app's tray shows honest ages; the new menu bar app shows days-old conversations as "Just now" / "3 min ago", which also feeds `describeSession` (`mac/lib/sessions.mjs:269`). The relay still fixes it for phones (`relay/service.mjs:226`) — so phone and Mac disagree about the same session.
2. **Shared settings file, different schemas.** Both apps read/write `~/.zode/settings.json` (`mac/main.mjs:28`, `macapp/main.mjs:17`). `macapp/lib/settings.mjs:4` sanitizes to 5 keys and `saveSettings` writes only those (`macapp/lib/settings.mjs:21`–`26`), so a running old Zode.app **strips** `setupDone`, `keepAwake`, `voiceLanguage`, `voiceModel` written by the new app (defaults in `mac/lib/settings.mjs:5`). `setupDone=false` makes the setup wizard pop again (`mac/main.mjs:1138`).
3. `detectAddresses`: `mac/lib/addresses.mjs:12` has the `auto` multi-address mode; `macapp/lib/addresses.mjs:11` predates it and `defaultAddress` prefers Tailscale-only. Semi-deliberate (old product binds one address), but the identical `parseIPv4/isTailscale/isPrivate` helpers are copy-pasted (`mac/lib/addresses.mjs:5`–`10` vs `macapp/lib/addresses.mjs:4`–`9`).
4. `macapp/lib/menu.mjs:29` comment says `metrics = { em, en, thin, gap }`; the code and the mac copy use `{ space, gap }` (`mac/lib/menu.mjs:26`). Stale copy of a stale comment; `macapp/lib/menu.mjs:4`–`6` duplicates the same header comment twice (lines 4–6 and 78–80).
5. Inside single files: `panelApprove` (`mac/main.mjs:812`) duplicates `actions.approve` (`mac/main.mjs:589`) except the dialog anchor; `mac/lib/menu.mjs` `lineSubmenu` vs `mac/lib/panel.mjs` `needOf` re-encode the same "waiting / stalled / failed" rules in two notations (tested, but a rules change must now happen twice).
6. **Tap-socket client re-implemented five times**: `mac/lib/sessions.mjs:35` (`defaultConnect`) + `readTapServers:15`; the byte-identical copies in `macapp/lib/sessions.mjs:15,35`; `bridge/doctor.mjs:27`–`31` (inline `net.connect`); `bridge/server.mjs:32`–`49` (`findTap` + its own call loop); `relay/service.mjs:151`–`173` (`livePids`/`syncUpstream` persistent sockets with the `tapReply` convention). Same discovery logic ("readdir `~/.zcode-tap/*.json`, keep live pids") in five places; one protocol fix (e.g. the `tapReply` id match) must be replicated.

Relay logic mirrored in the phone: moderately — the phone re-encodes "risky command" lists independently: `mac/lib/sessions.mjs:126` (`RISKY_BITS`, 11 entries) vs `app/src/approvals.ts:23`–`26` (`RISKY_SUBSTRINGS` 4 entries + word regex). `summarizeRequest` exists three times with slightly different outputs: `mac/lib/sessions.mjs:131`, `macapp/lib/sessions.mjs:120`, `app/src/approvals.ts:61`. They already disagree (the phone adds a `description` fallback and better word-boundary matching the Mac menu lacks).

## 3. Dead and stale code

- `mac/lib/sessions.mjs:8` — dead import `withRealActivity` (see above). This one hides a real bug.
- `dotIcons.grey` is loaded in `mac/main.mjs:86` and `macapp/main.mjs:47` but no menu/panel model ever references `grey` (`mac/lib/menu.mjs` uses red/amber/green/tick only).
- `macapp/lib/menu.mjs:163` — the old app has no Quit item (by design, it's ZCode's app), but `macapp/lib/menu.mjs:158` still offers "Start Zode when you log in" toggling login items for the *patched ZCode copy* — questionable leftover.
- `boot.cjs`/`macapp` chain is legacy but **not dead**: `scripts/build-tap.sh:83`–`87` still installs it and `scripts/update-zcode.sh:27`–`30` still targets an old integrated Zode.app. It is "kept-alive legacy", clearly the riskiest kind.
- `relay/relay.mjs:6` re-exports `checkPolicy` "to keep the import surface stable" — nobody imports it from the CLI; harmless.
- Options never passed: `runBuild({ source })` (`mac/lib/system.mjs:117`) is never set by the only caller `mac/main.mjs:965`; `nudgeSession`'s `waitMs`, `usageFrom`'s `now` — fine (injected for tests). No dead options found in the phone code.
- **TODO/FIXME/HACK: zero found** in every file read. Commented-out code: none found. The codebase is unusually clean on this axis.
- Unused dependencies (grep-by-eye over every import in the packages): all `relay` (`ws`, `qrcode-terminal`), `mac` (`electron-updater`, `qrcode`, `esbuild`, `electron`) and `macapp` deps are used. In `app/package.json`: fonts, markdown, pickers, camera, secure-store all used. **`react-dom` (`app/package.json:35`) is imported nowhere I read** — likely a jest-expo/expo-web artifact; verify before removing. `mac/build.mjs:34`–`35` still "borrows macapp's copies" of the tray icons because `mac/assets/` doesn't exist — a small packaging smell, not dead code.
- Version drift between manifests: `mac` 1.1.0 (`mac/package.json:3`) and `app.json` 1.1.0, but `app/package.json:3` says 0.1.0, `relay` 0.1.0, `macapp` 0.1.0 (`macapp/package.json:3`).

## 4. Hidden coupling and risk

Style note first: the codebase is systematically defensive — nearly every `catch` logs (`appendLog`) or returns a safe value. Counts of *empty or comment-only* `catch {}` blocks, counted by reading: `relay/service.mjs` 11 (e.g. `relay/service.mjs:153,254,405,511–515`), `mac/main.mjs` ~7 comment-only + ~30 logging ones, `app/session/[id].tsx` 3 true swallows (`:190` subscribe, `:230` stop, `:1168` JSON parse) + 1 that keeps state but drops the message (`:265`), `app/src/storage.ts` 4 silent (`:46,62,108`). Most are deliberate best-effort; the ones that hide user-visible causes are the upload failure (`session/[id].tsx:265` — tray shows "failed" with no reason) and `savePrefs` failures.

Top risks, ranked by "would hurt a user":

1. **Settings clobber between the two apps** (`macapp/lib/settings.mjs:4` vs shared file) — old app silently resets the new app's setup/voice settings. Section 2 item 2.
2. **Unwrapped upstream write in the phone `respond` path** — `relay/service.mjs:444` `u.sock.write(...)` is not inside `try`, unlike every other write (`relay/service.mjs:264`–`265`, `:461`–`462`). If the upstream socket just errored, the throw escapes the ws `message` handler and can take the relay process down (wss `error` handler at `:418` does not catch listener exceptions).
3. **Tray ages lie** (dead import drift) — user trusts "Just now" for days-old work; `mac/lib/sessions.mjs:8`.
4. **`mac/main.mjs` wiring is untested** — every behavior above lives there; a regression in `applyRelay`/`pollAddressesOnce` (`mac/main.mjs:405`) only shows up on a real machine. The address poll *restarting the relay* on network change is exactly the kind of code that needed a test.
5. **`startVoiceDownload`** (`mac/main.mjs:183`–`208`) mutates `voiceDownload` from concurrent callbacks with no guard against the app quitting mid-download; benign today, but the closure-state style makes this class of bug easy.
6. **Passthrough RPC params reach the agent unvalidated** — `checkPolicy` validates only some methods (`relay/service.mjs:58`–`89`); `session/setModel`, `session/usage`, `session/subscribe` etc. forward whatever the phone sent (`relay/service.mjs:452`, test-asserted as "params untouched" in `relay/test/service.test.mjs:517`–`530`). Contained by the tap protocol, but a hostile paired phone can feed junk shapes into the agent.
7. **`server.mjs` hardcodes `/Applications/ZCode.app`** (`bridge/server.mjs:15`) while every other component knows about `~/Applications` and the Engine copy (`mac/lib/system.mjs:32`–`37`). Only matters when no tap socket exists.
8. **Shell/scripts**: the two generated bash scripts (`mac/lib/updates.mjs:97`–`143`, `macapp/lib/updates.mjs:64`–`107`) build commands from interpolated paths but quote everything through `shq()` (`mac/lib/updates.mjs:90`) — correct. `scripts/update-zcode.sh` verifies size, SHA-512, codesign and Team ID before touching anything (`scripts/update-zcode.sh:260`–`305`) — this is the most carefully verified code in the repo. `sqlite` access in `relay/activity.mjs:19` interpolates ids into SQL **but only after** `SAFE_ID` filtering (`:11,17`), and the test proves injection strings are dropped (`relay/test/activity.test.mjs:38`). No unquoted shell found.
9. **Paths with spaces**: `engineDest()` returns "/Applications/ZCode Engine.app" (`mac/main.mjs:906`–`911`); all spawns use argument arrays (`mac/main.mjs:482,531`), so spaces are safe; only the generated scripts interpolate, and they quote. OK.
10. **Secrets in logs**: checked deliberately. The relay never logs transcripts or tokens (`relay/service.mjs:377,381` + asserted in `relay/test/service.test.mjs:718`); `devices.json` is 0600 and `listDevices` strips `tokenHash` (`relay/service.mjs:299`, asserted `relay/test/service.test.mjs:230`). No leak found. The only mildly sensitive log line is the upload file name (`relay/service.mjs:321`).

Timers: all long-lived timers are `unref()`'d and app-scoped; `relay.stop()` clears `syncTimer`/`pendingTimer` (`relay/service.mjs:502`–`507`, asserted `relay/test/service.test.mjs:399`–`403`). Phone timers are all cleaned in effects (`session/[id].tsx:224`, `sessions.tsx:157`). `measureWin` (`mac/main.mjs:309`) is a hidden BrowserWindow kept forever — intentional cache, one per app. No runaway timers found.

## 5. Test health

Strong suites, all `node --test` / jest, no external assertion libs:

- `relay/`: service (863 lines — lifecycle, pairing, policy, uploads, STT, replay, reconcile), `live`, `stt`, `activity`. Excellent: fakes for sockets and engines, injected clocks, and it even asserts logging discipline.
- `mac/test/`: `menu`, `sessions`, `panel`, `selfupdate`, `setup`, `updates`, `settings`, `addresses`, `panelWindow`, `stt`, `models`, `vocab`, `voiceHint` (existence probed for each). Only `mac/lib/system.mjs` has **no test file**.
- `app/__tests__/`: `reducer`, `approvals`, `client`, `pairing`, `homeList`, `chatSettings`, `history`, `usage`, `backoff`, `sessionGroups`, `compat`, `attachments`, `sessionActions`, `DemoClient`, `params`, `scrollPin`, `friendlyError`. Untested: `src/storage.ts`, `src/util.ts` (`parseSessionList` may be covered indirectly), `src/theme.ts`, and **all of `src/ui/*` and both screens**.
- `bridge/`: CONTRIBUTING says `(cd bridge && npm test)` (`CONTRIBUTING.md:15`) but no test files were found under the names probed for the bridge (only `relay`, `mac`, `macapp`, `app` have `test/` dirs confirmed). The tee wrapper the sentence refers to may be untested or live elsewhere — **uncertain, flagging rather than claiming**.

Mirroring/fragility:

- The relay tests are behavior tests, not mirrors — they assert protocol shapes from the outside (e.g. `relay/test/service.test.mjs:458`–`465`). The `mac/test/menu.test.mjs` assertions on label *positions* (`:71`, `:281`–`283`) do mirror the template closely; reordering the menu breaks them, which is partly the point.
- The risky-command lists are tested against the implementation's own lists (`mac/test/sessions.test.mjs:166`), so tightening `RISKY_BITS` requires editing both — the phone list is *not* tested for parity with the Mac list, and they already diverge (Section 2).
- Flaky-by-design: the multi-address relay tests need a real LAN IPv4 and otherwise `test.skip` (`relay/test/service.test.mjs:139`–`141`) — on a CI machine or offline Mac the two-host coverage silently disappears. Real ports are handled well (OS-assigned via `freePort`), and `activity.test.mjs` needs the `sqlite3` binary (`relay/test/activity.mjs:12`) — absent sqlite fails those tests rather than skipping.

Where the real risk is NOT covered:

1. **`mac/main.mjs`: 0%** — relay restart on address change, panel lifecycle, IPC payload validation (`handlePanelAction`, `mac/main.mjs:826`), update orchestration. This is the file where a typo bricks the menu bar.
2. **Both phone screens: 0%** — `SessionScreen` bootstrap/send/approval flows and `sessions.tsx` list building. The pure logic underneath is tested; the composition is not.
3. Cross-product behavior: nothing tests that `macapp` and `mac` settings/address code stay compatible (they demonstrably aren't, Section 2).
4. `bridge/` and `scripts/*.sh` — the highest-stakes file (`update-zcode.sh`) has no automated test at all; it is "tested" by reading.

## 6. Consistency

Good news: naming, error handling ("never throw, return null/[]") and logging (`appendLog` with a `zode:`/`relay:` prefix) are remarkably uniform across all four packages. The remaining inconsistencies:

- **Four different ways to make one tap-socket request** (Section 2 item 6): `mac/lib/sessions.mjs:35` one-shot collect-until-id; `bridge/doctor.mjs:27` inline; `bridge/server.mjs:25`–`60` its own pending/id-rewrite scheme; `relay/service.mjs:258` (`callUpstream`) persistent socket with a routes map and 30 s timeouts. Only the relay has timeouts *and* rejection semantics; the mac/app helpers resolve `[]`/`null` on silence, which is why the menu can't distinguish "slow" from "dead".
- Two error styles on the Mac: `runWorkAction` surfaces failures as dialogs (`mac/main.mjs:563`), background polls only log (`mac/main.mjs:381`), and IPC handlers return `{ok:false}` — three contracts, all reasonable, none documented in one place.
- Phone code consistently uses `catch {}` + typed result objects (`{ok, message}`), Mac code uses null-returns — fine, but `respondApproval`'s error strings are matched by *substring* in `respondFailureText` (`app/src/approvals.ts:183`–`188`), a fragile contract with the relay's wording (`relay/service.mjs:439`).
- Comment density is high and generally explains *why* (excellent in `relay/live.mjs:1`–`10`, `relay/service.mjs:184`–`188`). Stale-comment hotspots: `macapp/lib/menu.mjs:29`, the duplicated header at `:4`–`6`, and two "watch" leftovers from a previous product: `mac/lib/vocab.mjs:2` ("what they tend to say to the watch") and `mac/panel/index.html:36` ("from your phone or watch").

## 7. Docs vs code

- `README.md:91`–`99` "What is inside" lists `bridge/ skill/ relay/ app/ docs/` — **`mac/` (the flagship menu bar app) and `macapp/` are missing** from the table, and `docs/ARCHITECTURE.md:1`–`21` still describes a four-part system with the relay inside Zode.app.
- `docs/SECURITY.md:11` "Relay … Only `plan` and `edit` modes", `:20` "Listens on `127.0.0.1` unless you set `RELAY_HOST`", and `docs/ARCHITECTURE.md:46` "allows 16 session methods and two safe modes" are all stale: the allow list is 22 methods (`relay/service.mjs:29`–`34`), three modes (`relay/service.mjs:35`), and the Mac app defaults to Automatic = Wi-Fi + Tailscale (`mac/lib/addresses.mjs:22`, `docs/PHONE.md:18` has it right).
- `docs/PHONE.md:83`–`85` ("Known limit: Guarded … answering from the phone is not built yet"), `README.md:115` ("In Guarded, approvals are answered on the Mac for now") and `relay/README.md:89` ("Permission requests … the phone … cannot answer") are contradicted by `relay/service.mjs:436`–`446` and the whole `app/src/approvals.ts` flow. Only *user-input questions* still can't be answered from the phone (`relay/service.mjs:440`).
- Old product name: `relay/README.md:3` ("see `../zcode-mcp`"), `bridge/server.mjs:2` ("zcode-mcp:"), `bridge/zcode-task.mjs:2` ("through zcode-mcp") — the project has been Zode for a while.
- `docs/SETUP.md:22`–`38` documents only the old `./zode install` → Zode.app flow as *the* install; the README's primary flow is now the DMG + menu bar app (`README.md:52`–`54`). `./zode install` still works (README FAQ, `README.md:139`), but SETUP never mentions the new app.
- Version claims: `docs/PROTOCOL.md:3` honestly pins "ZCode 3.15.3 (agent 0.16.9)" — fine by design. `relay/README.md:23` still says "Zode.app runs the relay inside its own process" — true only for the old product.

## 8. Verdict

Scores (1–10): **structure 5 · duplication 4 · testability 6 · safety 7 · readability 7**.

Honest verdict: **not a 屎山 — a busy young codebase with a clean spine and two god-functions.** The leaf modules are the best I've seen in a two-week sprint: pure, injected, defensive, tested, commented with reasons. The rot is concentrated exactly where the deadline pressure landed: `mac/main.mjs` `start()` (1069 lines, 0 tests), `SessionScreen` (838 lines, 0 tests), and a duplicated Mac codebase (`macapp`) that is still shipped by the builder and is now *quietly diverging* — one divergence is already a user-visible bug (tray ages) and one is a settings-loss footgun. Fix the drift while the two copies still match in memory; after another month the diffs will be too many to reconcile and the fork becomes permanent.

Prioritised refactor plan (each item fits one small Zode order unless noted):

| # | What | Why | Size | Risk |
|---|---|---|---|---|
| 1 | Call `withRealActivity` in `mac/lib/sessions.mjs` (or drop the import and apply it in `mac/main.mjs:354`) | Fixes the "Just now" lie in the tray; the fix already exists one copy over | S | Low |
| 2 | Make `macapp/lib/settings.mjs` preserve unknown keys on write (merge instead of replace) | Stops the old app wiping `setupDone/keepAwake/voice*` in the shared file | S | Low |
| 3 | Wrap the `respond` write at `relay/service.mjs:444` in try + `fail()` | One bad socket write can crash the relay process | S | Low |
| 4 | Docs pass: README folder table (+`mac/`), SECURITY.md modes/methods/bind, PHONE.md + relay/README known-limit, `zcode-mcp` name, SETUP.md old-flow caveat | Docs currently understate both features and surface; store reviewers read these | S | None |
| 5 | One shared `tap-client.mjs` (readTapServers + ask + summarizeRequest) used by mac, macapp, bridge/doctor | Five copies of discovery/request code must be fixed in five places today | M | Medium (touches protocol callers; keep tests green) |
| 6 | Extract `mac/main.mjs` into modules: relay-controller, panel-window, setup-wizard, update-orchestrator, each with its state passed in, `start()` becomes ~100 lines of wiring | The single riskiest file; makes it testable at all | L (2–3 orders) | Medium — no behavior change, pure extraction |
| 7 | Extract `useSessionChat` (bootstrap/send/approvals/attachments) from `SessionScreen`; screens keep JSX only | 838-line component, zero tests, every feature order lands in it | M/L | Medium |
| 8 | Test the risky-command parity: one fixture list imported by both `mac/lib/sessions.mjs` and `app/src/approvals.ts` (or a test asserting the same summary for the same params) | The Mac and phone already disagree on what "risky" means | S | Low |
| 9 | Align versions: `app/package.json` → 1.1.0 (or derive from `app.json`), decide relay/macapp versioning | Store builds vs npm metadata drift invites mistakes | S | None |
| 10 | Delete or use `dotIcons.grey`; confirm `react-dom` in `app/package.json` is needed by jest-expo, else drop | Dead weight, and every dead thing makes the next audit longer | S | None |
| 11 | LAN-dependent relay tests: run the two-host tests against a loopback pair (e.g. `127.0.0.2`/`::1`) so CI actually covers multi-bind | Today they silently skip on CI (`relay/test/service.test.mjs:139`) | S | Low |
| 12 | After 6: add a wiring smoke test for `mac/main.mjs` with a fake `electron` module (menu state + panel model from a scripted relay) | Locks in the extraction; currently nothing would catch a broken `applyRelay` | M | Low |

**What I would NOT touch:** `relay/service.mjs`'s policy/protocol surface and its tests (security-critical and in good shape — only fix #3 inside it); `scripts/update-zcode.sh` and `boot.cjs`/`asarpatch.mjs` (fragile, verified, working — refactor invites disaster); `macapp/` as a product (deprecated; don't invest, just stop the settings clobber per #2 and consider a sunset date); `DemoClient` and `src/demo/` (isolated); the generated bash in `mac/lib/updates.mjs` beyond quoting (works, hard to test).
