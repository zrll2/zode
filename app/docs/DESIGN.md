# Zode: design spec

Reference: the Claude mobile app (calm, warm paper background, content first, no cards, one accent color, serif titles).
This document replaces the green card style. Do not reuse anything from `src/ui/` of the previous style; delete it.

## 1. First principles

The app has one job: supervise coding agents that run on a Mac, from a phone, in short sessions of attention.

1. The user wants to know **what needs me** (waiting, failed), **what is running**, and **what happened** (in that order).
2. When the user opens a session they want to **read the agent's words** and **answer fast**. The text is the product. Chrome, borders, boxes and color compete with it, so remove them.
3. Typing is hard on a phone. The composer is always one tap away and never hidden by other controls.
4. One hand, one thumb: primary actions sit in the bottom third (composer, new session). The top bar only navigates.
5. Color carries meaning, never decoration. One accent (ZCode black, white in dark mode) marks only: running, send, new session, primary buttons, links. Everything else is ink on paper.
6. Hierarchy comes from type size, weight and spacing, not from containers. Use hairline dividers only where a list needs them.

## 2. Tokens (put them in `src/theme.ts`; no hard-coded colors anywhere else)

| token | light | dark |
|---|---|---|
| `bg` (screen) | `#FAF9F5` | `#1F1E1D` |
| `surface` (composer, sheets) | `#FFFFFF` | `#2B2A28` |
| `muted` (user bubble, code block, pressed row) | `#F0EEE6` | `#34332F` |
| `border` (hairline) | `#E8E5DA` | `#3A3935` |
| `text` | `#141413` | `#F5F4ED` |
| `subtext` | `#6F6D66` | `#A8A59B` |
| `accent` (ZCode black) | `#141413` | `#F5F4ED` |
| `onAccent` (text and icons on accent) | `#FAF9F5` | `#1F1E1D` |
| `danger` | `#B3261E` | `#F2958D` |
| `ok` | `#4C8B5F` | `#7FC495` |
| `warn` | `#B7791F` | `#E3B341` |

Radii: row/pill buttons 999, composer 26, user bubble 20, code block 12. Spacing scale 4/8/12/16/24/32. Side padding 20.
Contrast must be at least 4.5:1 for body text in both themes. Follow the system light/dark setting.

Type (use `PixelRatio`-friendly sizes; allow Dynamic Type, never set `allowFontScaling={false}`):
- Display / screen title: **Source Serif 4**, 30/36, weight 500 (`@expo-google-fonts/source-serif-4`, load 400 and 500 in `app/_layout.tsx`; render with the system serif until loaded; never block the app on fonts).
- Section header: system sans, 13/18, weight 600, `subtext`, sentence case.
- Row title: system sans, 17/22, weight 500. Row subtitle: 14/20, `subtext`.
- Body (agent text): system sans, 16/25, weight 400.
- Code and tool text: monospace (`Menlo` on iOS, `monospace` on Android), 13.5/20.
- Buttons: 16/20, weight 600.

Icons: Feather from `@expo/vector-icons`, stroke style, 20-22 px, color `text` or `subtext`.
Motion: 150-200 ms fades and presses only. A pressed row changes background to `muted`. One pulsing dot for "running" (opacity 0.35 to 1, 900 ms loop, `Animated` from React Native; no new animation library). Light haptic (`expo-haptics`) on send and on approve/deny.

## 3. Screens

### 3.1 Sessions (home)
The home answers three questions in order: **Needs you** (waiting or error), **Running**, then **Today / Yesterday / Previous 7 days / Earlier** (via `groupSessions`), and — when the "Show work orders" setting is on — **Work orders** below the rest. Empty sections are hidden; every section header carries its count.

Every row is one card: `surface` fill, radius 18, no border or shadow, 8 px between cards, min height 56. Left: a 10 px status light with a 3 px ring of the same color at 18 % opacity — green (`ok`) done or idle, amber (`warn`) waiting, red (`danger`) failed, pulsing `accent` for running. Middle: the project name (last path segment of the workspace, 15/20, weight 600, one line) over the status in plain words (12.5/17, `subtext`: "Waiting for you", "Failed", "Working" with the three thinking dots, "Completed", "Stopped"). Right: the relative time in tabular numbers; needs-you rows also show a chevron. Cards are `PressScale` buttons that open the chat, with labels like "shop-api, Waiting for you, 2 minutes ago".

Header: the Zode mark (34 px) next to "Zode" in Nunito 800 (29/36, tracking −0.3); on the right the "Mac" connection pill (dot `ok`/`warn`/`subtext`; tapping it shows the connection line) and a 32 px `muted` "…" button for the action sheet. The sheet offers the work-orders toggle, privacy policy, support, and unpair (destructive, confirm first).

Bottom: an "Ask ZCode…" bar fixed above the safe area — `surface`, radius 26, soft shadow, a 36 px `accent` circle with an arrow-up — one button that opens the new-session screen. Conversations titled with a leading "#" are work orders: urgent ones never hide, finished ones leave the normal sections unless the setting is on (stored under `zode.prefs.v1`, default off, with a quiet "N work orders hidden · Show" line when hidden). Pull to refresh, the empty state and loading skeleton cards stay.

Long-press a card (or use the chat "…" menu) to archive a conversation on this phone or delete it on the Mac via `session/delete` (confirm alert, light haptic; running sessions must be stopped first). Archived conversations disappear from every section — urgent ones never hide — and appear under **Archived** when "Show archived" is on from the "…" sheet, with a quiet "N archived · Show" line otherwise.

### 3.6 Chat settings and usage
The chat "…" menu gains Rename, Model and thinking, and Usage (above the archive/delete items), with a small `subtext` caption under the title showing the current model and thinking level ("GLM-5.3-Flash · max") once `session/resume` settings are known. Rename is a centred modal (autofocus, preselected, 120-char cap; Save disabled while empty or unchanged). "Model and thinking" is a bottom sheet: available models with their provider labels and a check on the current one, then a segmented thinking-level row; picking calls `session/setModel` (keeping a reasoning level the model supports, else its default) or `session/setThoughtLevel`, disabled with a note while the conversation runs. "Usage" opens a scrollable sheet — this conversation's context bar plus Input / Output / Cache read / Requests, then account totals for 7 days / 30 days / All (big K/M/B total, Sessions, Turns, Cache hit rate, Favorite model) and a 14-day mini bar chart (accent for today) with the first and last date. The home "…" sheet gets the same Usage view without the conversation part.

### 3.2 Chat (session)
```
 ‹                Fix login redirect       ⋯     <- icon-only back arrow, small centered title (sans 16/600), overflow ⋯
                                                    (Stop / Copy session id)
        ┌───────────────────────────────┐
        │ Please fix the redirect bug   │          <- user: right-aligned, `muted` bubble, radius 20, max width 85%
        └───────────────────────────────┘
 I'll start by reading the router.                 <- assistant: full width, no bubble, markdown
 ▸ Read  src/router.ts                             <- tool: one muted line (mono 13.5), tap to expand input/output
 ▸ Thinking                                        <- reasoning: one muted line, collapsed
 The bug is in `redirect()`: ...
 ┌ code block, `muted` bg, mono, h-scroll ┐

 ◉ Working...  0:42                                <- only while running; pulsing accent dot + elapsed time

 ┌───────────────────────────────────────┐
 │ Message ZCode                    (↑)  │         <- composer: `surface`, hairline border, radius 26,
 └───────────────────────────────────────┘            grows to 6 lines; send = 36 px `accent` circle with `onAccent` arrow-up;
                                                       while running the same circle shows a square (stop)
```
- Render assistant text as **Markdown** with `react-native-markdown-display`, styled from tokens: headings (sans, bold, no huge sizes: h1 22, h2 19, h3 17), lists, tables (hairline borders, horizontal scroll), inline code (`muted` bg, mono), fenced code (block above), links in `text` with underline (open with `Linking`), blockquote with a 3 px `border` bar.
- Tool rows: `Feather chevron-right` + tool name (weight 600) + a short summary of the input (file path or command, one line). Expanded: input and output in mono inside a `muted` block, output cut at 600 characters with "Show more".
- Reasoning: collapsed "Thinking" row in `subtext`; expanded text in `subtext`, 15/23.
- System-looking user messages (see `isSystemLikeUserText`) render as a collapsed muted row "System message" (first 120 characters preview), never as a bubble.
- Auto-scroll to the newest item unless the user scrolled up; then show a small "Jump to latest" pill (`surface`, hairline border, arrow-down) above the composer.
- History loading: skeleton lines (3 muted bars) while loading. On failure show an inline notice "Could not load history" + short error + Retry button. Show "No messages yet" only when the call succeeded with zero messages.
- A banner under the title (`warn` text, no box) when reconnecting. Read-only notice when a permission request cannot be answered here.
- Keyboard: the composer sticks above the keyboard (`KeyboardAvoidingView`); safe-area bottom padding.
- Back button is the arrow only (`headerBackButtonDisplayMode: "minimal"`, `headerBackTitle: ""`).

### 3.3 Pair
Centered column, generous whitespace: a 64 px serif "Z" in `accent`, serif title "Connect to your Mac", one muted paragraph ("Run `./zode pair` in the Zode folder on your Mac, then scan the code."), primary pill button (`accent` fill, `onAccent` text) "Scan QR code", secondary text button "Paste pairing text" which reveals a multiline field with the existing smart-quote-safe settings and a "Connect" pill. Errors appear inline in `danger`, below the control. No header bar.

### 3.4 New session
Simple page, title serif "New session". Section "Folder": list of workspaces (folder name 17/500, full path 13 `subtext`), single choice shown with a check icon. Section "Mode": two segmented options **Plan** ("Reads and proposes, changes nothing") and **Edit** ("Can change files"). Primary pill "Start" fixed above the keyboard/safe area. After start, go to the Chat screen with the composer focused. Only `plan` and `edit`; never offer other modes.

## 4. Rules for the implementation
- Do not change `src/relay/*`, RPC parameters, the reducer logic or pairing logic. Presentation only, plus the pure helpers named here.
- Delete the previous style: `src/ui/` (green), `expo-linear-gradient`, Plus Jakarta Sans. New shared pieces go in `src/ui/` again (fresh files): `Screen`, `Text` (typography variants), `Pill` button, `Dot`, `Markdown`, `ToolRow`, `Composer`, `SectionHeader`, `Row`.
- Accessibility: every touchable has `accessibilityRole` and a label; hit targets at least 44 px; status is not conveyed by color alone (the subtitle also says it).
- Keep files small. Short comments only where the code is not obvious.

### 3.5 Approval sheet (permission requests; built with the permission work)
A bottom sheet over the Chat screen (dimmed background, `surface` fill, top radius 24, grab handle). Content: serif title ("Allow this edit?" / "Allow this command?"), one muted sentence naming the folder, a `muted` block with the tool name, the target (file path or command, mono) and the reason, then two pills side by side: **Deny** (outline) and **Allow** (`accent` fill). Allow is the only filled button. Light haptic on both. The sheet closes when the request is answered anywhere (desktop, another device) and shows a short "Answered on your Mac" line. Mobile can only Allow or Deny.

## 5. Visual reference
`design-preview.html` (in the orders folder) shows all screens in light and dark. When this document and the preview differ, this document wins.

## 6. Motion and scroll
- Running dot: opacity 0.35 → 1 loop, 1.2 s period. Working/Thinking indicator (ThinkingDots): three 3 px dots, 3.5 px apart, 0.3 → 1 fade over 1.9 s, staggered 0.15 s.
- History skeleton: three muted bars with a translucent band sweeping left to right every 2 s.
- Press feedback: spring scale to 0.98 on press, back on release (stiffness 600, damping 30, mass 1).
- Tool and Thinking expand/collapse: LayoutAnimation, 200 ms, easeInEaseOut, created rows fade in.
- Reconnect backoff: exponential with 0.85–1.15 jitter, capped at 30 s. The banner counts down to the next try; "Retry now" appears after the 3rd failed attempt in a row.
- Scroll pinning: pinned within 40 px of the bottom; "Jump to latest" beyond 120 px; streaming re-pins only 150 ms after the last user drag.
- All loops, springs and the sweep are skipped while Reduce Motion is on.
