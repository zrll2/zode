# Work order NN: permission presets and approval history in the panel

You write code. Claude Code supervises and runs every command (install, type check, tests, the app). You cannot run commands or delete files: every shell command is refused, so do not try. If a step needs a command, skip it and say in your reply what you could not check.
Edit only inside the current directory. Do not commit. Do not add secrets, analytics, or network calls.

## Read first
- `mac/panel/index.html` (the Settings sheet: `#sheet`, group with `#swAutoAllow` and `#swAskRisky`, the `.seg` radiogroups `#addr` and `#voiceLang`)
- `mac/panel/panel.js` (`renderSettings`, `setSwitch`, `flip`, the `$('voiceLang')` click handler, `act(...)`, `reportHeight`, how the sheet opens and closes)
- `mac/panel/panel.css` (`.seg`, `.set`, `.group`, `.sheet`, theme variables)
- `mac/main.mjs` (`actions.toggleAutoAllow/toggleAskRisky`, the `toggle` branch ~line 1115 of the panel action handler, `pushPanel`, the `approvalLog` handler added by the previous order, `mac/preload.cjs` allow-list)
- `mac/lib/panel.mjs` (the settings object sent to the panel, ~lines 220-255) and `mac/lib/settings.mjs`
- `relay/audit.mjs` (rows from `recent()`: `{ id, at, tool, summary, risky, outcome, by, device, askedAt }`, outcome in allowed|rejected|cancelled|unavailable|pending, by in auto|phone|panel|none)

## Goal
1. The two Settings switches "Allow ZCode requests automatically" and "Keep asking for risky commands" become ONE segmented control "Permissions" with three choices: `Ask`, `Auto`, `Careful`.
   - Ask = autoAllow false. Auto = autoAllow true, askRisky false (today's default). Careful = autoAllow true, askRisky true.
   - The stored settings stay the same two booleans (no migration, no new setting key): the control is derived from them.
2. A row "Approvals" in the Settings sheet opens a history list of the last 30 approval decisions, with a back button that returns to Settings.

## Design (use exactly this; follow the user's UI rule: no secondary labels, descriptions or hint text; the layout explains)
- Presets: add pure helpers in `mac/lib/settings.mjs`: `presetOf({autoAllow, askRisky}) -> 'ask'|'auto'|'careful'` (autoAllow !== true means 'ask' regardless of askRisky; askRisky true means 'careful', else 'auto') and `applyPreset(settings, name)` which sets the two booleans (invalid name changes nothing, returns false). Export both.
- `mac/lib/panel.mjs`: add `preset: presetOf(s)` to the settings object sent to the panel (keep `autoAllow` and `askRisky` fields too).
- `mac/main.mjs`: new panel action `setPreset` with `p.value` in ask|auto|careful (reject anything else), calls `applyPreset`, `save()`, `refresh()`/`pushPanel()` like `toggleAutoAllow` does. Remove the two `toggle` keys `autoAllow`/`askRisky` handling only if nothing else (menu, tray, tests) uses them; if something does, keep them. Tray/menu items that toggle these keep working.
- `index.html`: replace the two `.set` rows with one `.set` row: `<span>Permissions</span><div class="seg" id="preset" role="radiogroup" aria-label="Permissions">` with three `<button data-preset="ask|auto|careful" role="radio">` labelled Ask, Auto, Careful. No other text.
- `panel.js`: render `aria-checked` from `s.preset`; click handler like `voiceLang` sends `act('setPreset', { value })`, with instant feedback. Remove the dead code for the two switches.
- Approvals row: a `.set` row with the text "Approvals" and a chevron icon, at the end of the same group; clicking it swaps the sheet content to a list view (title "Approvals", back button returns to Settings; reuse the sheet container, no new window). Data comes from the `approvalLog` channel (call it each time the view opens). Each row: left side the summary (single line, monospace, ellipsis; fall back to tool name), right side a short status and when: status text is `Allowed` / `Denied` / `Pending` / `Cancelled` / `Failed` for allowed/rejected/pending/cancelled/unavailable, followed by `· auto`, `· phone` (with the device name if present) or `· Mac` for by=auto/phone/panel (nothing for none), and a relative time like the panel already shows ("2 min ago"; reuse its helper). Risky rows get the same small warning dot or tint the panel already uses for risky requests (reuse an existing CSS variable; no new colours). Empty state: a single muted line "No approvals yet". No headings, no explanations. Works in light and dark.
- `reportHeight` must still report the full sheet height when the list is showing (see how settings handles it).

## Tests (node:test and the existing panel/helpers test style)
- `mac/test/settings.test.mjs` (or the existing settings test): presetOf for all four boolean combos, applyPreset round trip, invalid name leaves settings unchanged.
- a panel.mjs test: `preset` present in the settings payload.
- a main/preload test: `setPreset` accepted, junk values ignored.
- if there is a panel helper module (`mac/panel/helpers.mjs`), put the pure formatting of an approval row (status word, source text, risky flag) there and test it.

## Rules
- Do not change defaults (Auto stays the default), the relay, the audit module, risk logic or the phone app.
- No new dependencies. Keep files small; short comments only where not obvious.

## Quality bar
Claude runs `npm test --prefix mac` and the panel in a browser and checks: the three-way control matches the old two-switch behaviour in all four combos, long commands do not overflow, empty and error states, dark mode, back button, no leftover references to the removed switch ids.

Reply with the single line: `presets done`.
