# CR-CRU-201 — a bun test run shows its console live on the board

**Type** feature · **Points** 8 (to be re-scored at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200,
CR-CRU-224 · **Status** PENDING
- **Filed 2026-10-20.** User rulings 2026-10-20; the design is in `DN-crucible-live-test-progress.md`.
- **Split at its gap analysis, 2026-10-31.** User ruling: three dog-food-safe units.
  - **This CR:** bun's console live view, with the board's view-only stream mode it needs.
  - **CR-CRU-225:** the `crucible.targets` table declares a stream, and the shipped Vitest and Playwright reporters stream
    the Crucible shape.
  - **CR-CRU-226:** the clean break. `crucible.reportPath`, `crucible.rawReport` and `crucible.testScript` are refused, the
    `playwright` codec retires, and this repo's `package.json` and the Vitest fixture move to the table.

The file keeps its first slug.

## Problem

A `bun test` run reaches the board only at exit. While it runs, the client counts its console result lines and sends
`running N/M · <file>` as a heartbeat. The board sees no test name, status or failure until the JUnit report arrives.

`bun test` has no structured stream: its console result lines are its only live source. Its record stays its JUnit report
(the DN's console-only row), so its live view must come from a stream that is NOT the run's record.

CR-CRU-200's board takes only record-bearing streams: a run holding a stream closed by a JUnit report is refused.

## Design (user rulings 2026-10-20 and 2026-10-31)

- **A view-only stream.** The board learns a second kind of stream codec, one that fills the live state and is never the
  run's record. A run holding a view-only stream closes through its JUnit ingest as today.
- **`bun-console`.** A board codec that reads bun's console result lines into the live state. It reuses the reading
  CR-CRU-152 put in `src/codecs/bun-console.ts`.
- **The relay.** The bun client relays the runner's console lines to the open run through CR-CRU-224's shared relay.
- **The record is unchanged:** the JUnit report.

## Steps

Written at this CR's gap analysis.

## Acceptance criteria

Made exact at the gap analysis. At least:

- [ ] A `bun test` run's completed tests and failures show on the open run while it runs.
- [ ] Its stored result is unchanged from today's for the same tests.

## Non-goals

- **A structured stream from `bun test` itself:** it has no reporter API.
- **The declaration table and the shipped reporters** (CR-CRU-225).
- **The clean break and the `playwright` codec's retirement** (CR-CRU-226).
- **Maven's console live view** (CR-CRU-203), which reuses this CR's view-only mode.
