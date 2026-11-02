# Work order 26: fix three failing tests

Same rules as order 24 (you cannot run commands; Claude ran them). `npm test --prefix mac` fails with exactly these three:

1. `test/eventInbox.test.mjs:45` "inbox: a valid file is delivered once and deleted; junk and stale are only deleted": at line 55 `deepEqual(delivered, [event])` got `[]` (nothing delivered).
2. `test/eventInbox.test.mjs:61` "the folder is created with mode 0700 and scans are capped at 50 files": line 68 `0 !== 50`.
3. `test/settings.test.mjs:38` "saveSettings drops unknown keys and out-of-range ports": the expected object is missing the new `eventRules` key (actual has everything else equal).

Compare these two inbox tests with the banner inbox tests they mirror (`mac/test/bannerInbox.test.mjs`): the fake fs and clock seams must behave the same way here. Two real-fs inbox tests pass, so the fake-fs path (reads, `mtimeMs` age, `readdirSync` shape, deletion) is the likely difference between `eventInbox.mjs` and `bannerInbox.mjs`. Fix whichever side is wrong; do not weaken what the tests assert. Fix 3 by updating the expected object (default `eventRules: false`).

Reply with the single line: `fix done`.
