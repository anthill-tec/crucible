# CR-CRU-225 — a bun script declares its stream, and the Vitest and Playwright reporters stream the Crucible shape

**Type** feature · **Points** 13 (to be re-scored at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200,
CR-CRU-224 · **Status** PENDING
- **Filed 2026-10-31.** Split from CR-CRU-201 at its gap analysis. User ruling: three dog-food-safe units —
  CR-CRU-201 (bun's console live view), this CR (the table and the reporters), then CR-CRU-226 (the clean break).

## Problem

Vitest and Playwright have reporter APIs nothing uses. A bun project's script cannot declare a structured stream, and a
Vitest or Playwright run reaches the board only at exit.

## Design (user rulings 2026-10-20 and 2026-10-31; `DN-crucible-live-test-progress.md`)

- **One table per script.** `crucible.targets.<script>` declares either:
  - a `stream` (its codec, and how the runner is told where to write it); or
  - a `junit` report (`flag` or `env:<VAR>`), with an optional `console` codec for its live view.

  The old keys (`crucible.reportPath`, `crucible.rawReport`, `crucible.testScript`) are still read in this CR, so nothing
  breaks mid-way. CR-CRU-226 makes the clean break.
- **Shipped reporters.** Reporters for Vitest and Playwright ship inside the client install and emit the Crucible event
  shape.
  - The client hands their location to the runner through a variable Crucible fixes.
  - A project's config adds the reporter from that variable when it is set, so it names no machine path and runs
    unchanged without a client.
- **The record.** A streamed Vitest or Playwright run is recorded from its stream.
- **Playwright's steps.** They ride the stream: each Gherkin step is an event, and the board keeps the steps the
  `playwright` codec keeps today.

## Steps

Written at this CR's gap analysis. One known reach item: `tests/docs-live-test-stream-design-record.test.ts` pins the
DN's statement that Playwright's steps are CR-CRU-201's, which the 2026-10-31 split made this CR's. This CR moves that DN
statement and its pin together.

## Acceptance criteria

Made exact at the gap analysis. At least:

- [ ] A Vitest run through the fixture streams its tests to the board and is recorded from the stream. Its result equals
      the JUnit report's for the same tests.
- [ ] This repo's e2e run streams its scenarios with their steps. The stored scenarios and steps equal what the
      `playwright` codec stores for the same run.
- [ ] A project config that adds the shipped reporter runs unchanged when no client sets the variable.

## Non-goals

- **The clean break**, and the `playwright` codec's retirement (CR-CRU-226).
- **bun's console live view** (CR-CRU-201).
