# Contributing

Thanks for helping. Zode is small on purpose: keep changes small and tested.

## Set up

```bash
git clone https://github.com/zrll2/zode.git && cd zode
(cd bridge && npm install) && (cd relay && npm install) && (cd app && npm install)
```

## Run the tests

```bash
(cd bridge && npm test)     # the tee wrapper
(cd app && npx tsc --noEmit && npx jest)   # the phone app
```

Try the app without a Mac connection: `cd app && npx expo start`, then tap **Try the demo**.

## Rules

- **No personal data, no ZCode files.** Run `./zode scan` before you commit. Never add ZCode's `zcode.cjs`, `.asar` files or event logs.
- **Presentation changes follow [`app/docs/DESIGN.md`](app/docs/DESIGN.md).** Colors come from `src/theme.ts` tokens only.
- **Protocol changes** update [`docs/PROTOCOL.md`](docs/PROTOCOL.md) in the same pull request. ZCode's protocol is undocumented and can change; say which ZCode version you tested.
- **Keep the relay's allow list short.** A new phone-callable method needs a reason and a test.
- Write short, plain comments only where the code is not obvious.
- Release versions: the Mac app reads `mac/package.json`; the phone reads `app/app.json` (`version` plus the build numbers). The other `package.json` files are internal.
- Known structure and refactor plan: [`docs/CODE_HEALTH.md`](docs/CODE_HEALTH.md).

## Working the way Zode does

You can build features with the same loop: write a work order, let ZCode write the code in a worktree, verify with real commands, review the diff. [`docs/WORKFLOW.md`](docs/WORKFLOW.md) explains it. Good work orders are welcome as examples in `examples/work-orders/`.

## Pull requests

One topic per pull request. Say what you ran (tests, simulator) and on which versions of macOS, Node and ZCode.
