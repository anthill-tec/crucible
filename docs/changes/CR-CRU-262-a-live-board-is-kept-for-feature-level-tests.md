# CR-CRU-262 — a live board is kept for feature-level tests

**Status:** COMPLETED — 2026-11-19 (on release/0.4.0; its CI run waits for the user's push) · filed 2026-11-15 (release fix; user rulings 2026-11-15: the test pyramid applies, all five
proposed changes go into the 0.4.0 release fix, and unit = no process, no socket) · gap analysis 2026-11-18 (user
rulings: split — this CR is the python client suite, the bun suite is CR-CRU-264; kept modules are consolidated, one
per feature) · spec pre-review 2026-11-18 (CHANGES, F1–F10 folded)
**Type:** fix
**Points:** 13
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-261
**Labels:** tests, release
**Design reference:** `test-reports/work/cr262-gap-analysis.md` (measured baseline, the survey's verdicts);
`test-reports/work/cr262-survey-report.md`; `test-reports/work/rel040-test-gap-analysis.md` (§3, D1); the test pyramid
(knowledge `the-gate-and-regression-scope`); `RealBoard` in `tests/client/real_board.py`; `RecordingBoard` in
`tests/client/live_run_harness.py`; `test-reports/work/prereview262-report.md`; CR-CRU-260 VERIFY Sug5 (one shared server spawner)

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
  release retirement at insert, plan-file's queue registration, coverage file ranking; the client's `next` agreeing
  with the server's write side — `test_next_lane_carries_release_and_wave` and the server-normalisation agreement in
  `test_cr092_next_decision_resolver`, which the pre-review found the survey had misjudged); go coverage merging. RED
  confirms each verdict by reading the module's tests, not its docstring.
- **A kept module stays lean.** It holds only the tests that use its board; tests in a kept or merged module that use
  no board (help, source scans, resolver tests, mocked tests) move to a sibling module at their own tier, keeping their
  names (pre-review F2).
- **What replaces it otherwise.** A demoted test runs against a scripted fake board, or, for a test that loads the
  client in-process, a fake transport with no socket (unit, by D1). Today's `RecordingBoard` cannot be told what to
  answer for a read (it answers health, a fixed `/plans` refusal, and `{"ok": true, "agents": []}` for everything
  else), so it is extended ONCE, in `tests/client/live_run_harness.py`, rather than each module writing its own stub
  (pre-review F4): a test sets the answer for a method and path (refusals included), and the defaults are the response
  shapes `src/v2.ts` returns — never invented. What the fake mints follows the server's rules: event ids
  `evt-<ms>-<seq>` and millisecond timestamps as `src/store.ts` makes them, so a client that orders by them is tested
  against the real shape, including a same-millisecond tie and a sequence number that sorts numerically (`-100` after
  `-59`) (pre-review F5). A test that asserts the ORDER or SET of requests uses the fake's request log.
- **Shared helpers move out of test modules.** Helpers that test modules import from each other — `_await_server`,
  `_free_port`, `_call`, `_seed`, `_filing_verbs`, the fake toolchains and `_FAKE_*`, the recording proxies — move to
  helper modules under `tests/client/` that are not test modules, before any module is merged, demoted or stripped of
  its boot code (pre-review F8). `release_notes_board.py`, all of whose users are demoted, becomes the seeder of the
  release-notes fake (or is deleted if nothing needs it); it is not a `RealBoard` user.
- **Coverage is not lost.** First, a route pass: for every route a demoted test reached, name the server-side bun test
  that asserts the behaviour the demoted test relied on; a route behaviour with none gets a server-side test (in the
  bun suite, at its measured tier, built on one of the helpers CR-CRU-264 converts first — `run-stream-harness.ts`,
  `server-limits-fixture.ts` or `served-app.ts` — so CR-CRU-264's conversion of the helper carries it (pre-review F9)).
  The pass names explicitly the server rules demoted tests used to observe: `cycle-add`'s stored kind,
  `appendCycle`'s fix-needs-its-verify-done guard and `parseCycleInput`'s invalid-kind refusal; how milestones are
  listed (order, timestamps); the per-agent stored run totals; every refusal wording a demoted test matches, beside a
  bun test that pins the same literal (pre-review F6). A demoted test asserts what it asserted before.
- **One spawner.** Every kept module boots its board through `RealBoard` (`tests/client/real_board.py`), extended with
  an optional recording-proxy mode for the modules that time or capture the client's requests; the copied boot and
  readiness code in the self-spawning modules is removed (CR-CRU-260 Sug5), and so are the per-module recording-proxy
  copies (three identical `_RecordingProxy`, `BoardProxy`, `CapturingProxy`).
- **Tier follows.** A demoted module moves tier when its heaviest dependency changes (CR-CRU-261's rule: measured,
  heavier of itself and what it imports).

## Acceptance criteria

- [x] **AC1 — the kept list.** This spec's close-out records the python modules that still start a live board, each
  with the feature it proves; the dependency census (orchestrator check) shows no other python test spawning the
  server. The census charges a fixture's events to its module by the module's own name (the last dotted part before
  the class — the tier package is not the module), and the kept modules must show up as live-board (a known positive)
  before a zero elsewhere counts (pre-review F1).
- [x] **AC2 — sparing.** At most 15 python modules spawn a server, one per feature; a larger kept set needs the user's
  ruling, recorded here.
- [x] **AC3 — nothing lost.** Every demoted or merged test still runs under its name, passes, and asserts at least what
  it did; the route pass is recorded in the close-out, and each route behaviour a demoted test relied on has a
  server-side bun test. The close-out holds one row per demoted assertion: the old assertion, and either its new
  client-side assertion against the fake (sent body, request log, envelope) or the bun test (file and test name) that
  now asserts the server half (pre-review F3).
- [x] **AC4 — the pyramid is measured (orchestrator check).** The census re-run after the change reports the python
  class counts (unit, socket fake, process, toolchain, live board), recorded in the close-out; the live-board share of
  python tests is below 3%, measured per test with a module's fixture events charged to its tests.
- [x] **AC5 — one spawner (orchestrator check).** No python test module spawns `src/server.ts` itself — a search for
  the server's argv under `tests/client/` outside `real_board.py` finds none — and no test module defines its own
  recording proxy; every live board comes from `RealBoard`.
- [x] **AC6 — suites green.** Both suites and the e2e suite pass; the pre-merge gate passes.

## Non-goals

- The bun suite's in-process server use (CR-CRU-264).
- Turning process-level client tests into unit tests generally (only live-board ones are in scope).
- Changing server behaviour or the client contract.
- New tests that test the tests (user ruling 2026-11-18). The sparing rule is checked once, at this CR's close-out;
  no standing guard enforces it.

## Close-out (2026-11-19)

- **AC1/AC2 — the kept list (census at `51a428d0`, clone, isolated network, tripwire 0 hits).** Exactly 15 python
  modules start a live board, one per feature, each through `RealBoard`:
  arduino native run (`test_an_arduino_declared_target_streams_a_real_native_run_end_to_end`), rust/nextest run
  (`test_a_rust_run_streams_real_nextest_end_to_end`), maven surefire-console run
  (`test_a_declared_maven_run_shows_its_real_surefire_console_live_end_to_end`), go test-json run
  (`test_a_go_run_streams_real_go_test_to_a_real_board`), bun relayed run
  (`test_a_relayed_bun_run_shows_on_the_board_while_it_works`), python crucible-events run
  (`test_a_streamed_python_run_reaches_the_board_while_it_works`), gate composition
  (`test_a_gate_milestone_carries_each_suite_result`), settled-run abort refusal
  (`test_the_board_refuses_a_settled_runs_abort_as_the_clients_expect_end_to_end`), project metadata
  (`test_project_meta_verb_wires_write_read_and_refusal_end_to_end`), project-create by token
  (`test_project_create_against_a_real_board`), release retirement at insert (`test_gate_names_the_release_it_gates`),
  plan-file's queue registration (`test_plan_file_names_the_release_it_plans`), coverage file ranking
  (`test_a_python_coverage_run_names_its_files_on_a_real_board`), `next` agrees with the write side
  (`test_next_lane_carries_release_and_wave`), go coverage merging
  (`test_a_go_coverage_regression_stores_statement_coverage_on_a_real_board`).
- **AC3 — nothing lost.** The route pass and its rows are in `test-reports/work/red970-report.md`,
  `red972-report.md`, `red973-report.md` and the per-pass AC3 tables (`green972-a/-b/-c`, `green973-d`); new server
  tests: `cycle-append-route-stores-and-refuses-kinds`, `milestone-routes-order-and-refuse-as-clients-read-them`,
  `closed-plans-read-carries-merge-and-title-verbatim`, `events-list-keeps-each-agents-own-run-totals`,
  `a-close-over-an-accepted-failing-gate-keeps-its-reason`, `plan-file-route-stores-and-refuses-kinds`. One python test
  was deleted by user ruling (`test_a_kindless_cycle_posted_straight_to_the_route_still_stores_red_green`: its whole
  assertion is the bun test "a cycle filed with no kind is stored as red-green, read back from the store").
- **AC4 — the pyramid (python, per test).** unit 52.0%, process 25.9%, toolchain 18.2%, live board 1.8% (102 of 5793;
  was 470, 8.1%), socket fake 1.8%, clock 0.3%.
- **AC5 — one spawner.** No python test module starts `src/server.ts` outside `real_board.py`; `RecordingProxy` is the
  one proxy.
- **AC6 — green.** Pre-merge gate, cycle 975: 14750 passed, 0 failed.
- **The fake board** answers only what a test scripts (an unscripted read is a 404), logs each method as sent, and
  mints store-shaped event ids.
