# CR-CRU-240 — a Go run ticks its progress like every other stack

**Type** feature · **Points** 2 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-195, CR-CRU-196 ·
**Status** PENDING — filed 2026-11-09 (user ruling at the CR-CRU-195 sign-off: progress ticks were
out of that CR's scope and come in their own CR, after CR-CRU-196) · Pre-review: none

## Problem

Every client but the Go one shows a running run's progress twice: the relay lands the stream's
batches on the board, and the shared narrator prints and posts `running N[/M]` ticks between
them. The narrator reads a stream through the shared module's one stream reading, which knows the
`crucible-events` and `nextest` codecs only. It counts no `go-test` event, so the Go client hands
the relay a no-op tick sender: an agent watching its console sees no count while `go test -json`
runs, and a long build or a slow package that lands no batch posts nothing that keeps the run's
agent alive.

## Design

- **The shared stream reading learns `go-test`.** The pure reading of one decoded stream line gains
  the `go-test` codec: a test's `pass` or `fail` action is a result that ran, a `skip` a result that
  did not, a `run` a test that began. Package-level actions (no `Test` field) and `output` lines
  count nothing. `go test -json` states no total; the run's total is the one the client already
  takes from `go test -list` and states on the run-start.
- **The Go client posts its ticks.** The Go client passes its real tick sender to the stream relay,
  as the other clients do, so the narrator's `running N/M` ticks print and post whenever the relay
  lands no batch.
- **The shared module's size budget is re-recorded.** The change grows the shared run module; its
  pinned size budget is raised by exactly what the change adds, and the three tests that pin it
  are re-seeded in the same CR.

## Scope

- The shared run module's stream reading: the `go-test` codec.
- The Go client's relay start: its tick sender.
- The shared module's size budget and its three pins.
- CHANGELOG `[Unreleased]`: a Go run ticks its progress.

## Acceptance criteria

- [ ] **AC1 — the reading counts Go results.** On a captured `go test -json` stream with passing,
  failing, skipped and nested subtests, the shared stream reading counts each test's result once,
  counts skips as not run, and counts no package-level or `output` line.
- [ ] **AC2 — a Go run ticks.** A Go run whose relay lands no batch for longer than the tick interval
  prints and posts `running N/M`, with M the listed total; a run that lands batches posts no in-run
  tick, as on every other stack.
- [ ] **AC3 — the budget is re-recorded.** The shared module's size budget equals its new size, and
  the three tests pinning it pass at that value.

## Non-goals

- Tier verbs (CR-CRU-196) and compile errors or coverage (CR-CRU-239).
- Any change to how the board decodes `go test -json`.
