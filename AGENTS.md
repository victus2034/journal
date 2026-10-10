# Rules for AI editors

Any AI that edits this repo (Claude, Codex, Copilot, Cursor) follows these rules.

## Test twice before "done"

Never call a change done after one check. Every change gets two:

1. **Run the tests twice**: `npm run test:twice` (the smoke test, two full runs back to back). Both must pass. A pass then a fail is a flaky test to fix, not to ignore.
2. **Check it a second, different way**: open the changed tab and use the feature with real-looking data, or recompute a number by hand, or break the code on purpose and confirm the test fails.

Say in the summary what both checks were.

## Every update

- Bump `<meta name="app-version">` in `index.html`.
- Keep the README in step with what changed.

## Summaries

Short bullets: what changed, what was checked, what's next. No paragraphs.
