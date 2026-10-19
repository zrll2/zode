# Work order NN: <short name>

You write code. Claude Code supervises and runs every command (install, type check, tests, the app). You cannot run commands or delete files.
Edit only inside the current directory. Do not commit. Do not add secrets, analytics, or network calls beyond the stated ones.

## Read first
- `docs/<spec>.md` (what to build, exact tokens or API shapes)
- `fixtures/<sample>` (real data), `docs/reference/<image>` (visual reference)

## Goal
<one paragraph: the outcome the user sees>

## Verified facts (do not guess; use exactly these)
- <API call with exact params and a real example response shape>
- <package versions that are known to work>
- <existing function or file to reuse, with its path>

## Files to create or change
- `path/one`: <what it does>
- `path/two`: <what it does>
- tests: `__tests__/<name>.test.ts` covering <cases>

## Rules
- Do not change <protocol / public API / unrelated modules>.
- Keep type check and tests clean (Claude runs them). Never pass `null` where `undefined` is expected.
- Keep files small; short comments only where the code is not obvious.

## Quality bar
<what Claude will check: edge cases, empty states, long text, errors visible to the user, dark mode, etc.>

Reply with the single line: `<name> done`.
