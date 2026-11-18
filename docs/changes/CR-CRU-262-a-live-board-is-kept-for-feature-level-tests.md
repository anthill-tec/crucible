# CR-CRU-262 — a live board is kept for feature-level tests

**Status:** PENDING · filed 2026-11-15 (release fix; user rulings 2026-11-15: the test pyramid applies, all five
proposed changes go into the 0.4.0 release fix, and unit = no process, no socket) · gap analysis 2026-11-18 (user
rulings: split — this CR is the python client suite, the bun suite is CR-CRU-264; kept modules are consolidated, one
per feature)
**Type:** fix
**Points:** 13
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-261
**Labels:** tests, release
**Design reference:** `test-reports/work/cr262-gap-analysis.md` (measured baseline, the survey's verdicts);
`test-reports/work/cr262-survey-report.md`; `test-reports/work/rel040-test-gap-analysis.md` (§3, D1); the test pyramid
(knowledge `the-gate-and-regression-scope`); `RealBoard` in `tests/client/real_board.py`; `RecordingBoard` in
`tests/client/live_run_harness.py`; CR-CRU-260 VERIFY Sug5 (one shared server spawner)

## Problem

The pyramid: unit tests use mocks or in-process fakes; a live test-only board is for feature-level integration tests,
used sparingly, beside the UI-driven e2e suite. The census at `d199371b` measured the opposite shape at the heavy end of
the python client suite: **53 modules (478 tests, 8.3%) spawn a real Crucible server**
(`test-reports/work/cr262-live-board-modules.txt`). Many check one verb's envelope, a pre-flight refusal, or a server
answer the client prints verbatim, which a scripted fake board proves as well. Of the 53, 21 spawn
`bun run src/server.ts` themselves rather than through `RealBoard`, each with its own copy of the boot and readiness
logic.

## Design

- **What keeps a live board.** A module keeps a live test-only board only when what it proves is a feature across the
  client–server boundary that no fake can stand in for: the server's own storage, ordering or refusal logic observed
  through a client, or the run lifecycle end to end. **One module per feature** (user ruling 2026-11-18): tests of the
  same feature spread over two or three modules are merged into one module, keeping their test names. Each kept
  module's docstring states the feature and why a fake cannot prove it. The gap analysis's survey groups the starting
  set (about 15): the run lifecycle once per wire codec (arduino native, rust/nextest, maven surefire console, go
  test-json, bun relay, python crucible-events); gate composition across dispatched clients; the server's storage and
  refusal invariants seen through a client (settled-run abort refusal, project metadata, project-create by token,
  release retirement at insert, plan-file's queue registration, coverage file ranking); go coverage merging. RED
  confirms each verdict by reading the module's tests, not its docstring.
- **What replaces it otherwise.** A demoted test runs against a scripted fake board — `RecordingBoard`, a module's
  `_StubBoard`, or, for a test that loads the client in-process, a fake transport with no socket (unit, by D1). What
  the fake answers is taken from the server's own contract (the response shapes `src/v2.ts` returns, refusal bodies
  included), never invented. A test that asserts the ORDER or SET of requests uses the fake's request log.
- **Coverage is not lost.** First, a route pass: for every route a demoted test reached, name the server-side bun test
  that asserts the behaviour the demoted test relied on; a route behaviour with none gets a server-side test (in the
  bun suite, at its measured tier). A demoted test asserts what it asserted before.
- **One spawner.** Every kept module boots its board through `RealBoard` (`tests/client/real_board.py`), extended with
  an optional recording-proxy mode for the modules that time or capture the client's requests; the copied boot and
  readiness code in the self-spawning modules is removed (CR-CRU-260 Sug5). `release_notes_board.py` builds on it.
- **Tier follows.** A demoted module moves tier when its heaviest dependency changes (CR-CRU-261's rule: measured,
  heavier of itself and what it imports).

## Acceptance criteria

- [ ] **AC1 — the kept list.** This spec's close-out records the python modules that still start a live board, each
  with the feature it proves; the dependency census (orchestrator check) shows no other python test spawning the
  server.
- [ ] **AC2 — sparing.** At most 15 python modules spawn a server, one per feature; a larger kept set needs the user's
  ruling, recorded here.
- [ ] **AC3 — nothing lost.** Every demoted or merged test still runs under its name, passes, and asserts at least what
  it did; the route pass is recorded in the close-out, and each route behaviour a demoted test relied on has a
  server-side bun test.
- [ ] **AC4 — the pyramid is measured (orchestrator check).** The census re-run after the change reports the python
  class counts (unit, socket fake, process, toolchain, live board), recorded in the close-out; the live-board share of
  python tests is below 3%.
- [ ] **AC5 — one spawner.** No python test module spawns `src/server.ts` itself; every live board comes from
  `RealBoard`.
- [ ] **AC6 — suites green.** Both suites and the e2e suite pass; the pre-merge gate passes.

## Non-goals

- The bun suite's in-process server use (CR-CRU-264).
- Turning process-level client tests into unit tests generally (only live-board ones are in scope).
- Changing server behaviour or the client contract.
- New tests that test the tests (user ruling 2026-11-18).
