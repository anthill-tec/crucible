# CR-CRU-220 — the arduino client sends its runner's reports and parses nothing

**Type** feature · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-204, CR-CRU-208, CR-CRU-218, CR-CRU-221 · **Status**
PENDING — filed 2026-10-30 (split from CR-CRU-206 at its gap analysis, user ruling: the shared reporting
first, CR-CRU-218, then one CR per client; user ruling the same day: the Makefile-narrowing check reads its
cases through a shared reader the no-parse scan exempts; user ruling at CR-CRU-206's pre-review: the shared
module, one line under its 10,000-line guard, is split first, CR-CRU-221)

## Problem

After CR-CRU-204 the bun and python clients send their runners' reports to `POST /api/v2/runs` through one
shared ingest (`ingest_reports`), and the board decodes them (CR-CRU-152) within its bounds (CR-CRU-207).
The arduino client still parses the native harness's JUnit itself (`_parse_junit`) and sums its lcov
(`_collect_lcov`), posting them to `/api/v2/runs/parsed` (`_run_native_tests_body`, `cmd_auto_ingest`).
The same parse feeds the check that names a Makefile which ignored `TESTS` or `TEST_NAME`
(`_ignored_narrowing_warnings`, reading each case's name and file stem).

## Design (user rulings, 2026-10-27 and 2026-10-30)

- As CR-CRU-204: the client parses nothing but the runner's exit code and the two testcase counts; every
  figure and warning comes from the board's response; reports travel inline; an oversized body is refused
  before sending; with no board there are no figures.
- The narrowing check is a local decision made before the ingest, as bun's filter check is: it reads each
  case's name and file stem through one shared reader in the shared run module (`_crucible_run.py`, CR-CRU-221),
  beside the two counts, and the
  no-parse scan exempts it as it exempts them.

## Steps

### §S1 — every report-ingesting verb uses the shared ingest

`test`, `unit`, `module`, `integration`, `e2e`, `regression`, `bdd` and the suites `pre-merge-gate` runs
(today `_run_native_tests_body`), and `auto-ingest` (today `cmd_auto_ingest`), each file their report
through a client `_file_reports` — one call of the shared `ingest_reports` (CR-CRU-218) — with
`codec: "junit"` and the text of every `TEST-*.xml` the native harness wrote (or `auto-ingest` found), in
path order. A `--coverage` run sends `coverage: {codec: "lcov", data}` with the `lcov.info` it reads today;
one whose lcov is missing sends no `coverage` block and carries `coverage-not-measured`
(`coverage_not_measured_warning`, CR-CRU-218). The arduino-cli compile ingest is unchanged.

Every verb but `auto-ingest` sends its captured `make` output as `raw` and the runner's exit as
`runnerExit` (CR-CRU-208). `auto-ingest` exits by `verb_exit` over no runner exit and the board's answer.

### §S2 — the client parsers go; the narrowing check reads through the shared reader

- `_parse_junit`, `_collect_lcov` and `_file_stem` are deleted.
- The shared run module (`clients/_crucible_run.py`, CR-CRU-221) gains `junit_case_sources(paths)`: each `<testcase>`'s `(name, file stem)` across the
  reports at `paths`, in report order — the stem the basename without extension of the case's `classname`,
  else its `file`, `None` when it carries neither — and `None` when a report cannot be read or parsed, as
  `junit_testcase_count` answers. `_ignored_narrowing_warnings` reads its cases from it; when it answers
  `None`, no narrowing warning is judged.
- "Ran nothing", and a narrowed run that ran nothing, read `junit_testcase_count`.
- The no-`--agent` run, which files nothing, prints
  `ran <n> testcases (<m> not skipped); runner exit <rc>` from `junit_testcase_count` and
  `junit_non_skipped_count` and exits with the runner's exit code (today it prints passed/total, failed,
  pending and files, and exits 1 on a failure in the report).
- The module docstring and the verb help that name `/api/v2/runs/parsed` say the reports route (the shared
  `REGRESSION_COVERAGE_LCOV_HELP` its `--coverage` reads already names no route).
- The client tests that pinned the parser or the parsed route for arduino are retired, re-pointed at the
  board or given a `run` block in the ingest answer they stub, each such change in its own commit: the
  arduino-only test files, and arduino's cases in the shared files (a census at RED lists them).
- The provenance floor `PROSE_CITATIONS` pins for `clients` (`tests/project-namespace-tripwire.test.ts`)
  moves with the deleted docstrings: one re-record, in its own commit at the close-out.

### §S3 — the envelope's figures and warnings come from the board

As CR-CRU-204 §S4, through the shared run emitter (`_axi().emit_run_axi`, CR-CRU-221), never a fifth copy: the
envelope's `run:` block (`passed`, `failed`, `pending`, `total`, `files`) is the ingest answer's; the answer's
`warnings[]` join the envelope's; a run whose ingest fails, is refused or cannot
reach the board carries no figures and says why. The `files` count is the board's: distinct sources
across all of the run's reports (the client summed each report's distinct sources, which differs only when
a source repeats across reports).

## Acceptance criteria

- [ ] **AC1 — every verb.** The route census (`test_every_verb_that_runs_a_test_runner_is_classified.py`)
      arduino table names, for each verb §S1 lists, the shared ingest as its only report call site (the
      compile site as today), and it passes; no arduino source position posts to `/api/v2/runs/parsed`.
- [ ] **AC2 — coverage as its report.** A `regression --coverage` run sends `coverage: {codec: "lcov",
      data}` with the lcov text, on a passing run and on a failing one; with the lcov missing it sends no
      `coverage` block and carries `coverage-not-measured`.
- [ ] **AC3 — the same figures.** CR-CRU-152's arduino fixture, ingested through this client against a board
      it spawns, stores the counts and statuses of its `expected.json` (`files` included); the fixture is a
      failing run, whose coverage the board discards, so the stored coverage object is proven on a passing
      report beside the fixture's lcov.
- [ ] **AC4 — no parser left.** CR-CRU-204's source scan (`test_a_client_parses_no_report.py`) covers
      `arduino-crucible.py`, exempting only `junit_testcase_count`, `junit_non_skipped_count` and
      `junit_case_sources`, and passes.
- [ ] **AC5 — the narrowing check holds.** `junit_case_sources` answers each case's `(name, stem)` from
      `classname`, else `file`, else `None`, and `None` for an unreadable report; through the client, a
      Makefile that ignored `TESTS` and one that ignored `TEST_NAME` are each named
      (`makefile-ignored-tests`, `makefile-ignored-test-name`) in the filed run's envelope, and a narrowed
      run with zero cases is a run that ran nothing — `test_an_arduino_makefile_that_ignored_tests_or_test_name_is_named.py`
      and `test_an_arduino_run_narrowed_by_tests_and_name_reaches_make.py` pass, re-pointed only where they
      read a figure the board now gives.
- [ ] **AC6 — local decisions.** The verb's exit is `verb_exit` over the runner's exit and the board's answer,
      asserted on a run that ran nothing and a run with a failure; the no-`--agent` run prints §S2's line and
      exits with the runner's exit code, 0 on a report with a failure after a clean `make`.
- [ ] **AC7 — envelope, warnings, no board, older board, too large.** CR-CRU-204's AC6–AC9 hold for the arduino
      client: the `run:` block is the answer's five counts and a board warning joins `warnings[]`; with the
      board unreachable at the health read or the ingest the envelope carries no figures and `pre-merge-gate`
      reports the suite unreported; an older board is refused naming its version and the 0.4.0 floor; a body
      over the advertised limit is refused before sending, and a 413 reported, both naming `ingest_body_bytes`.
- [ ] **AC8 — raw and the runner's exit.** Each verb of §S1 but `auto-ingest` sends its captured `make` output
      as `raw` and the runner's exit as `runnerExit`.

## Non-goals

- The maven and rust clients (CR-CRU-206, CR-CRU-219).
- The board's side (CR-CRU-152, CR-CRU-207), the shared ingest (CR-CRU-204, CR-CRU-218), and retiring
  `/api/v2/runs/parsed`.
- A run's live test stream: CR-CRU-203.
