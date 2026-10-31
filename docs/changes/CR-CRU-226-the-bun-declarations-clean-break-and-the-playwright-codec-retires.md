# CR-CRU-226 — the bun declaration's clean break, and the playwright codec retires

**Type** feature · **Points** 8 (to be re-scored at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-225 ·
**Status** PENDING
- **Filed 2026-10-31.** Split from CR-CRU-201 at its gap analysis. User ruling: three dog-food-safe units —
  CR-CRU-201, CR-CRU-225, then this CR.
- CR-CRU-222's open declaration question (what a bun project's `regression` runs) is taken up at this CR's gap analysis,
  since `crucible.testScript` is one of the keys this CR replaces.

## Problem

Once a script declares its stream in `crucible.targets` (CR-CRU-225), three older keys say the same things in other words:
- `crucible.reportPath`;
- `crucible.rawReport`, which misnames Playwright's step-keeping JSON;
- `crucible.testScript`.

Playwright's JSON report, and the board's `playwright` codec that decodes it, are no longer needed once its steps ride the
stream.

## Design (user rulings 2026-10-20 and 2026-10-31; `DN-crucible-live-test-progress.md`)

- **The clean break.** `crucible.reportPath`, `crucible.rawReport` and `crucible.testScript` are refused, before anything is
  posted, with a message naming `crucible.targets`, as `--phase` was when it became `--role`.
- **Retirement.** Playwright's JSON report and the board's `playwright` codec retire.
- **Migration.** This repo's `package.json` and the Vitest fixture move to the table, in the same unit as the break: this
  repo dog-foods its own client.
- **Readings keyed by the declared framework, not the stack** (user ruling 2026-10-31, after CR-CRU-201). Codecs are
  named by framework or format, and a project selects them by the tools of each modality it runs (CR-CRU-225). Two
  readings inside the `junit` codec still switch on the client's stack:
  - `parseJunit` groups cases by classname when `stack === "python"` and the suite is named `pytest`. That is pytest's
    shape.
  - `readJunitRawOutput` reads the console as bun's only when `stack === "bun"`. That is the `bun test` console's
    failure detail.

  Both are re-keyed by the framework the project declares in `crucible.targets`, so they apply to any stack running
  that framework. The `stack` field stays only as the run's label.
- **BDD as well as unit.** The declarations this CR enforces cover BDD frameworks (mostly front-end and UI) as well as
  unit runners.

## Steps

Written at this CR's gap analysis.

## Acceptance criteria

Made exact at the gap analysis. At least:

- [ ] A `package.json` declaring `crucible.reportPath`, `crucible.rawReport` or `crucible.testScript` is refused before
      anything is posted, naming `crucible.targets`.
- [ ] No `playwright` codec is registered, and nothing declares one.
- [ ] This repo's own runs file through the table at every commit of the CR.
- [ ] Neither `junit` reading switches on `stack`. Each applies to a run whose declared framework is pytest or
      `bun test`, whatever its stack.

## Non-goals

- **The table and the reporters** (CR-CRU-225).
- **bun's console live view** (CR-CRU-201).
