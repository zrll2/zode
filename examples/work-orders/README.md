# Example work orders

Real orders that built this project's phone app, with ZCode writing the code and Claude Code verifying it.

| File | What it shows |
|---|---|
| `00-template.md` | The template the skill uses. |
| `01-client.md` | A first big order: scaffold a whole app from a protocol document and recorded sample data. |
| `04-sim-fixes.md` | A fix order after running the app: the exact API shapes ZCode had to guess wrongly, now stated as facts. |
| `07-redesign.md` | A design order that points at a spec and a visual reference. |

Notice what they have in common: a read-first list, verified facts, a file list, rules, a quality bar, and one line to reply with.

The orders use the names from when the project was a set of separate folders (for example `RELAY_PROTOCOL.md`, now `relay/README.md`, and `zcode-relay`, now `relay/`). The method matters more than the names.
