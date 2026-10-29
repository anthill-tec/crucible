# CR-CRU-219 — the rust client sends its runner's reports and parses nothing

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-204, CR-CRU-208, CR-CRU-218 · **Status**
PENDING — filed 2026-10-30 (split from CR-CRU-206 at its gap analysis, user ruling: the shared reporting
first, CR-CRU-218, then one CR per client)

## Problem

After CR-CRU-204 the bun and python clients send their runners' reports to `POST /api/v2/runs` through one
shared ingest (`ingest_reports`), and the board decodes them (CR-CRU-152) within its bounds (CR-CRU-207).
The rust client still parses nextest's JUnit itself (`_parse_junit`) and sums llvm-cov's lcov
(`_parse_lcov`), posting them to `/api/v2/runs/parsed` (`_workspace_regression_run`,
`_regression_ingest_run`), or sends a `dataPath` the board must read off its own disk (`_ingest_junit_axi`,
and `_smoke_run`'s own body).

## Design (user rulings, 2026-10-27)

As CR-CRU-204: the client parses nothing but the runner's exit code and the testcase count that decides
"ran nothing"; every figure and warning comes from the board's response; reports travel inline; an
oversized body is refused before sending; with no board there are no figures.

## Steps

### §S1 — every report-ingesting verb uses the shared ingest

`test`, `unit`, `module`, `integration`, `e2e`, `bdd`, `auto-ingest` (today `_ingest_junit_axi`),
`smoke-test` and `docker-e2e-gate` (today `_smoke_run`), `workspace-regression`, `regression` and the
suites `pre-merge-gate` runs (today `_workspace_regression_run`), and `regression-ingest` (today
`_regression_ingest_run`) each file their report through a client `_file_reports` — one call of the shared
`ingest_reports` (CR-CRU-218) — with `codec: "junit"` and the text of the `junit.xml` the verb reads today.
A run that measured coverage (`regression-ingest`, and `workspace-regression`, `regression` and
`pre-merge-gate` when coverage is on, CR-CRU-212) sends `coverage: {codec: "lcov", data}` with the lcov
report it reads today; a coverage run whose lcov is missing sends no `coverage` block and carries
`coverage-not-measured` (`coverage_not_measured_warning`, CR-CRU-218). `_ingest_junit_axi`'s and
`_smoke_run`'s `dataPath` bodies and the two parsed bodies are deleted; the rustc compile ingests
(`_ingest_rustc_stderr`, `cmd_auto_ingest`'s compile post) are unchanged.

Every verb but `auto-ingest` sends its captured runner output as `raw` (an agent's run is captured by
`run_streamed`) and the runner's exit as `runnerExit` (CR-CRU-208). No verb sends `dataPath`.

### §S2 — the client parsers go

`_parse_junit` and `_parse_lcov` are deleted. "Ran nothing" keeps reading `junit_testcase_count`, unchanged.
The module docstring, the verb help and the shared `REGRESSION_COVERAGE_LLVM_COV_HELP` that name
`/api/v2/runs/parsed` say the reports route; the printed-help tests
(`test_every_clients_help_says_regression_coverage_is_opt_in.py`) follow. The client tests that pinned the parser, the parsed route or `dataPath` for rust are retired,
re-pointed at the board or given a `run` block in the ingest answer they stub, each such change in its own
commit: the rust-only test files (`test_cr051_rust_files_count.py` among them), and rust's cases in the
shared files (a census at RED lists them). The provenance floor `PROSE_CITATIONS` pins for `clients`
(`tests/project-namespace-tripwire.test.ts`) moves with the deleted docstrings: one re-record, in its own
commit at the close-out.

### §S3 — the envelope's figures and warnings come from the board

As CR-CRU-204 §S4: the envelope's `run:` block (`passed`, `failed`, `pending`, `total`, and `files` where it
is named today — the two regression verbs) and the coverage — on stderr and in `regression-ingest`'s and the
workspace regression's `coverage:` field — are the ingest answer's; the answer's `warnings[]` join the
envelope's; a run whose ingest fails, is refused or cannot reach the board carries no figures and says why.
The `files` count is the board's (a case's `file`, else its `classname` — nextest's test binary — else its
suite's name: the rule the client applied).

## Acceptance criteria

- [ ] **AC1 — every verb.** The route census (`test_every_verb_that_runs_a_test_runner_is_classified.py`)
      rust table names, for each verb §S1 lists, the shared ingest as its only report call site (the rustc
      compile sites as today), and it passes; no rust source position posts to `/api/v2/runs/parsed` or names
      `dataPath`.
- [ ] **AC2 — coverage as its report.** A `regression-ingest` run, and a `workspace-regression` run with
      coverage on, send `coverage: {codec: "lcov", data}` with the lcov text, on a passing run and on a
      failing one; with the lcov missing they send no `coverage` block and carry `coverage-not-measured`; a
      run with coverage off sends none and carries no such warning.
- [ ] **AC3 — the same figures.** CR-CRU-152's rust fixture, ingested through this client against a board
      it spawns, stores the counts and statuses of its `expected.json` (`files` included); the fixture is a
      failing run, whose coverage the board discards, so the stored coverage object is proven on a passing
      report beside the fixture's lcov.
- [ ] **AC4 — no parser left.** CR-CRU-204's source scan (`test_a_client_parses_no_report.py`) covers
      `rust-crucible.py`, exempting only `junit_testcase_count`, and passes.
- [ ] **AC5 — local decisions.** "Ran nothing" comes from the runner's exit code and `junit_testcase_count`,
      and the verb's exit from `verb_exit` over the runner's exit and the board's answer, asserted for
      `test`, `smoke-test`, `workspace-regression` and `regression-ingest` on a run that ran nothing and a
      run with a failure.
- [ ] **AC6 — envelope, warnings, no board, older board, too large.** CR-CRU-204's AC6–AC9 hold for the rust
      client: the `run:` block is the answer's counts and a board warning joins `warnings[]`; with the board
      unreachable at the health read or the ingest the envelope carries no figures and `pre-merge-gate`
      reports the suite unreported; an older board is refused naming its version and the 0.4.0 floor; a body
      over the advertised limit is refused before sending, and a 413 reported, both naming `ingest_body_bytes`.
- [ ] **AC7 — raw and the runner's exit.** Each verb of §S1 but `auto-ingest` sends its captured runner output
      as `raw` and the runner's exit as `runnerExit`.

## Non-goals

- The maven and arduino clients (CR-CRU-206, CR-CRU-220).
- The board's side (CR-CRU-152, CR-CRU-207), the shared ingest (CR-CRU-204, CR-CRU-218), and retiring
  `/api/v2/runs/parsed`.
- A run's live test stream: CR-CRU-202.
