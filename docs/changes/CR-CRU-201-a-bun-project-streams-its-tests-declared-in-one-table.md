# CR-CRU-201 — a bun project streams its tests, declared in one table per script

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200 · **Status**
PENDING — filed 2026-10-20 (user rulings 2026-10-20; design in `DN-crucible-live-test-progress.md`)

## Problem

A bun project's runs reach the board only at exit. `bun test` has no structured live stream; Vitest
and Playwright have reporter APIs nothing uses. A script's reports are declared in two keyed tables,
`crucible.reportPath` and `crucible.rawReport`, and "raw report" misnames the runner's full report the
board decodes (Playwright's JSON, kept for the Gherkin steps JUnit drops).

## Scope

- **§S1 — one declaration per script, clean break.** `crucible.targets.<script>` declares either a
  `stream` (its codec, and how the runner is told where to write it) or a `junit` report (`flag` or
  `env:<VAR>`) with an optional `console` codec for its live view. `crucible.reportPath` and
  `crucible.rawReport` are refused, naming the table that replaces them. An undeclared script keeps
  today's default: `bun test`, the `flag` JUnit report, the bun console view.
- **§S2 — `bun test` shows its console live.** A `bun-console` board codec decodes bun's console
  result lines, reusing CR-CRU-152's `src/codecs/bun-console.ts`; the client relays them to the open run; the JUnit report stays the record.
- **§S3 — Vitest and Playwright stream the Crucible shape.** Reporters for both ship in the client
  install and emit the Crucible event shape; the client hands their location to the runner through a
  variable Crucible fixes, so a project's config names no machine path and runs unchanged without a
  client. A streamed Vitest or Playwright run is recorded from its stream.
- **§S4 — Playwright's steps ride the stream.** The Playwright reporter emits each Gherkin step;
  this repo's own e2e target moves to the stream, and Playwright's JSON report and the `playwright`
  codec retire.
- **§S5 — the fixture and this repo move to the table.** The Vitest fixture and this repo's
  `package.json` declare their targets in the new table.

## Acceptance criteria

To be made exact at gap analysis. These hold under any design:

- [ ] A `bun test` run's completed tests and failures show on the open run while it runs; its stored
      result is unchanged from today's for the same tests.
- [ ] A Vitest run through the fixture streams its tests to the board and is recorded from the
      stream; its result equals the JUnit report's for the same tests.
- [ ] This repo's e2e run streams its scenarios with their steps; the stored scenarios and steps
      equal what the `playwright` codec stored for the same run, before that codec is removed.
- [ ] A `package.json` declaring `crucible.reportPath` or `crucible.rawReport` is refused before
      anything is posted, naming `crucible.targets`.
- [ ] A project config that adds the shipped reporter runs unchanged when no client sets the
      variable.

## Non-goals

- A structured stream from `bun test` itself (it has no reporter API).
