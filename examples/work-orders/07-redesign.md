# Work order 07: redesign the whole app UI (Claude-app style)

The user rejected the green card style as ugly. Claude (supervisor) redesigned from first principles. Read `docs/DESIGN.md` first and follow it exactly: tokens, type, screens 3.1 to 3.4, rules in section 4.
Claude runs all commands (install, tsc, jest, simulator). You cannot run commands. Edit only inside the current directory. Do not commit.

## Scope
1. `src/theme.ts`: new tokens from the spec (light and dark). Remove all old tokens and every hard-coded color in `app/` and `src/ui/`.
2. Delete the old green `src/ui/*` components and `__tests__/sessionStats.test.ts`; create the new shared components listed in section 4 of the spec.
3. `app/_layout.tsx`: load Source Serif 4 (400, 500) with `expo-font` and `@expo-google-fonts/source-serif-4`; fall back to the system serif until loaded; Stack options: no header on Sessions and Pair; arrow-only back button (`headerBackButtonDisplayMode: "minimal"`, `headerBackTitle: ""`) on Chat and New session; header background `bg`, no bottom border.
4. `app/sessions.tsx`: Sessions screen per 3.1. Add `src/sessionGroups.ts` (`groupSessions(sessions, now)`) with `__tests__/sessionGroups.test.ts`.
5. `app/session/[id].tsx`: Chat screen per 3.2: Markdown (`react-native-markdown-display`), tool rows, reasoning rows, composer with send/stop, running indicator with elapsed time, jump-to-latest, history skeleton, history error with Retry (do not swallow errors from `session/messages`; show the short error text), reconnect banner.
6. `src/history.ts`: add pure `isSystemLikeUserText(text)` (true for text that starts, after trimming, with `<task-notification`, `<system-reminder`, `<command-name>`, or `Available agent types for the Agent tool`) and use it so such user messages render as the collapsed "System message" row (history and live). Add tests in `__tests__/history.test.ts`.
7. `app/pair.tsx` per 3.3 and `app/new.tsx` per 3.4. Keep all existing behavior: QR scan, tolerant paste parsing, create + subscribe flow, plan/edit only.
8. `package.json`: remove `expo-linear-gradient` and `@expo-google-fonts/plus-jakarta-sans`; add `@expo-google-fonts/source-serif-4`, `react-native-markdown-display`, `expo-haptics` (approximate versions are fine; Claude will install).
9. Update `README.md` with a short "Design" section pointing to `docs/DESIGN.md`.

## Must keep working
All existing tests (reducer, client, pairing, params, history) stay green. Do not change any RPC parameter, relay frame, reducer behavior or pairing logic. tsc must stay clean: pass `undefined`, never `null`, to FlatList component props; do not use APIs that TypeScript 6 or React 19.3 types reject.

## Quality bar
Look at the screens as a user would: spacing, alignment, text truncation, empty states, long Chinese text, very long tool output, dark mode. Prefer deleting decoration over adding it.

Reply with the single line: `redesign done`.
