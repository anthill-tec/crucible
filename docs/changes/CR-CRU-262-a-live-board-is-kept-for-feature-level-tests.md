# CR-CRU-262 — a live board is kept for feature-level tests

**Status:** PENDING · filed 2026-11-15 (release fix; user rulings 2026-11-15: the test pyramid applies, all five
proposed changes go into the 0.4.0 release fix, and unit = no process, no socket)
**Type:** fix
**Points:** 13
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-261
**Labels:** tests, release
**Design reference:** `test-reports/work/rel040-test-gap-analysis.md` (§3, D1); the test pyramid (knowledge
`the-gate-and-regression-scope`); `handleV2` in `src/v2.ts`; `RecordingBoard` in `tests/client/live_run_harness.py`

## Problem

The pyramid: unit tests use mocks or in-process fakes; a live test-only board is for feature-level integration tests,
used sparingly, beside the UI-driven e2e suite. The census measured the opposite shape at the heavy end.

- **Python:** 53 modules (478 tests) spawn a real Crucible server. Many check one verb's envelope, a refusal, or a
  field the client sends, which a `RecordingBoard` (or an in-process fake transport) proves as well. The 53:
  `test_a_cycle_gate_files_every_suite_it_runs_under_the_cycle`,
  `test_a_declared_maven_run_shows_its_real_surefire_console_live_end_to_end`,
  `test_a_gate_milestone_carries_each_suite_result`, `test_a_gate_scoped_to_named_suites_runs_only_them`,
  `test_a_go_coverage_regression_stores_statement_coverage_on_a_real_board`,
  `test_a_go_regression_coverage_stores_the_union_of_its_tiers_on_a_real_board`,
  `test_a_go_run_streams_real_go_test_to_a_real_board`,
  `test_a_python_coverage_run_names_its_files_on_a_real_board`,
  `test_a_relayed_bun_run_shows_on_the_board_while_it_works`, `test_a_rust_run_streams_real_nextest_end_to_end`,
  `test_a_scoped_gate_refuses_what_it_cannot_run`, `test_a_streamed_python_run_reaches_the_board_while_it_works`,
  `test_an_arduino_declared_target_streams_a_real_native_run_end_to_end`,
  `test_an_arduino_run_narrowed_by_tests_and_name_reaches_make`,
  `test_an_unattributed_run_is_refused_while_a_cycle_is_active`, `test_arduino_exits_and_files_on_its_runners_exit`,
  `test_bun_crucible_two_agents_concurrent_report_isolation_end_to_end`,
  `test_bun_declared_target_exit_without_report_aborts_its_run_end_to_end`,
  `test_bun_exits_and_files_on_its_runners_exit`, `test_bun_regression_declares_its_release_end_to_end`,
  `test_cr092_next_decision_resolver`, `test_cr_close_reports_its_own_cr_merged_post`,
  `test_cycle_add_targets_the_plan_it_means`, `test_every_run_names_the_board_events_it_filed`,
  `test_every_verb_that_files_a_run_is_refused_while_a_cycle_is_active`,
  `test_gate_names_an_unfiled_suite_unreported_end_to_end`, `test_gate_names_the_release_it_gates`,
  `test_landings_verb_shows_closed_plans_end_to_end`, `test_mvn_exits_and_files_on_its_runners_exit`,
  `test_next_lane_carries_release_and_wave`, `test_no_composed_gate_is_green_on_a_failed_runner`,
  `test_plan_file_names_the_release_it_plans`, `test_project_create_against_a_real_board`,
  `test_project_meta_verb_wires_write_read_and_refusal_end_to_end`, `test_python_exits_and_files_on_its_runners_exit`,
  `test_queue_rows_carry_title_and_lifecycle`, `test_real_stack_reports_filed_through_their_client_end_to_end`,
  `test_release_notes_dates_orders_and_titles_the_section`, `test_release_notes_draft_passes_the_notes_guard`,
  `test_release_notes_drafts_the_section_in_every_client`, `test_release_notes_lands_a_cr_by_its_merged_plan`,
  `test_release_notes_markdown_keeps_warnings_off_stdout`, `test_release_notes_reads_only_what_it_names`,
  `test_release_notes_refuses_and_says_what_to_do`, `test_release_notes_titles_an_untitled_plan_from_the_queue`,
  `test_release_notes_writes_each_title_on_one_line`, `test_runs_and_run_read_a_filed_run_back_end_to_end`,
  `test_rust_exits_and_files_on_its_runners_exit`, `test_status_verb_shows_open_plans_end_to_end`,
  `test_the_board_refuses_a_settled_runs_abort_as_the_clients_expect_end_to_end`,
  `test_the_close_judges_each_suite_by_its_latest_gate_result`,
  `test_the_fixture_stream_is_stored_as_its_junit_record`,
  `test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close`.
- **Bun:** about 150 files boot the real server in-process (`startServer`, scratch DB) and reach it over a loopback
  socket, most to check one route's response. The route handler is callable in-process (`handleV2`), with no socket.

## Design

- **What keeps a live board.** A test keeps a live test-only board only when what it proves is a feature across the
  client–server boundary that no fake can stand in for: the server's own storage, ordering or refusal logic observed
  through a client, or the run lifecycle end to end. One module per such feature, not one per verb or stack. Each kept
  module's docstring (or file header) states the feature and why a fake cannot prove it.
- **What replaces it otherwise.**
  - Python: a `RecordingBoard` scripted with the responses the test needs, or, for a test that loads the client
    in-process, a fake transport with no socket (unit, by D1). What the server would answer is taken from the
    server's own contract (the response shapes `src/v2.ts` returns), not invented.
  - Bun: the route test calls `handleV2` (or the smallest exported handler that serves the route) with a scratch
    store, no `startServer`, no socket; it moves to `tests/unit/`. A test of the listener, the SSE stream over a real
    connection, or the boot path keeps `startServer` and stays in `tests/integration/`.
- **Coverage is not lost.** A demoted test asserts what it asserted before; a server behaviour that only the removed
  live round-trip covered moves to (or is already in) a server-side test.
- **Tier follows.** A demoted test moves tier when its heaviest dependency changes (CR-CRU-261's rule).

## Acceptance criteria

- [ ] **AC1 — the kept list.** This spec's close-out records the python modules and bun files that still start a live
  board, each with the feature it proves; the dependency census shows no other test starting one (python: no spawn
  of the server; bun: no `startServer` call).
- [ ] **AC2 — sparing.** At most 15 python modules spawn a server, and the bun files calling `startServer` are at most a
  quarter of today's (≤ 38); a larger kept set needs the user's ruling, recorded here.
- [ ] **AC3 — nothing lost.** Every demoted test still runs (same test names), passes, and asserts at least what it did;
  the server suite still covers each route the demoted tests used to reach (a route without a server-side test gets
  one).
- [ ] **AC4 — the pyramid is measured.** The census re-run after the change reports the class counts for both suites
  (unit, socket-fake, process, toolchain, live board) and they are recorded in the close-out; the live-board share of
  python tests is below 3%.
- [ ] **AC5 — suites green.** Both suites and the e2e suite pass; the pre-merge gate passes.

## Non-goals

- Turning process-level client tests into unit tests generally (only live-board ones are in scope).
- Changing server behaviour or the client contract.
