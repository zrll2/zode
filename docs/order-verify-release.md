# Work order 22: verify a release after publishing

You write code. Claude Code supervises and runs every command (install, type check, tests, the app). You cannot run commands or delete files: every shell command is refused, so do not try. If a step needs a command, skip it and say in your reply what you could not check.
Edit only inside the current directory. Do not commit. Do not add secrets, analytics, or network calls beyond the stated ones.

## Read first
- `mac/scripts/publish.sh` and `mac/scripts/release.sh`
- `packaging/homebrew/zode.rb` (version, sha256, url)
- `mac/release/latest-mac.yml` format (electron-updater: `version`, `files[].url`, `files[].sha512`, `files[].size`, `path`)
- `app/store.config.json` (`privacyPolicyUrl` per locale) and `docs/RELEASE_NOTES.md`

## Goal
After `publish.sh --publish`, the script asks the outside world whether the release is really live and correct, and fails loudly if not. A release is not done until it is verified.

## Design
- New Node script `mac/scripts/verify-release.mjs` (ESM, no dependencies, Node 20 `fetch`). Usage: `node scripts/verify-release.mjs [--version X.Y.Z] [--repo owner/name]`. Defaults: version from `mac/package.json`; repo from the `homepage`/`repository` field of `mac/package.json` or, if absent, `zrll2/zode`.
- Pure checks, each returns `{ name, ok, detail }`, exported and testable with injected `fetchImpl`:
  1. `releasePublished`: GET `https://api.github.com/repos/<repo>/releases/tags/v<version>`: exists, `draft === false`, has assets named `Zode-<version>-arm64.dmg`, `Zode-<version>-arm64-mac.zip`, and `latest-mac.yml`.
  2. `updateFeed`: download `latest-mac.yml` from the release asset URL; its `version` equals the version; the listed file names exist among the assets.
  3. `dmgReachable`: HEAD (follow redirects) on the DMG asset URL returns 200 and `content-length` equals the asset `size`.
  4. `homebrewMatches`: if `packaging/homebrew/zode.rb` exists, its `version` equals the version and its `sha256` equals the SHA-256 of the downloaded DMG (stream the download through `crypto.createHash`; skip with `ok: true, detail: 'skipped'` when `--no-hash` is passed since the DMG is 100+ MB).
  5. `privacyUrls`: every distinct `privacyPolicyUrl` in `app/store.config.json` returns 200 and its body contains the word "privacy" (case-insensitive).
  6. `notesMention`: `docs/RELEASE_NOTES.md` contains a line mentioning the version.
- Output: one line per check (`ok` / `FAIL name: detail`), final line `release v<version> verified` or `release v<version> NOT verified`; exit code 0 or 1. Retry network errors twice with 2 s backoff; a check never throws, it returns `ok: false`.
- `mac/scripts/publish.sh`: after a successful `--publish`, run `node scripts/verify-release.mjs --no-hash` (full hash check only when `ZODE_VERIFY_HASH=1`) and propagate its exit code. Draft creation does not verify.

## Tests (node:test)
- `mac/test/verify-release.test.mjs`: each check passes on good fake responses and fails on: draft release, missing asset, wrong feed version, wrong content-length, wrong homebrew sha, privacy URL 404, privacy body without the word, notes missing the version; retry on a thrown fetch; exit code logic of the summary helper.

## Rules
- Do not change `release.sh`, the app, the relay or the phone app. Do not embed tokens: the GitHub API call is unauthenticated, plus `Authorization: Bearer $GITHUB_TOKEN` only if that env var is set.
- Keep the script under 200 lines; short comments only where not obvious.

## Quality bar
Claude runs `npm test --prefix mac` and the script against the real v1.5.7 release (it must print verified), and against a bogus version (must fail with a clear line).

Reply with the single line: `verify release done`.
