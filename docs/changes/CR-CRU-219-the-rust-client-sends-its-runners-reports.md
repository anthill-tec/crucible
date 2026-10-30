# CR-CRU-219 — the rust client sends its runner's reports and parses nothing

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-204, CR-CRU-208, CR-CRU-218 · **Status**
DONE — merged 2026-10-30 (plan 222, cycles 809–811, gate 9726/0: bun 4226/0, python 5500/0); filed 2026-10-30 (split from CR-CRU-206 at its gap analysis, user ruling: the shared reporting
first, CR-CRU-218, then one CR per client); spec pre-review 2026-10-30 (CR-CRU-219-SPEC-REVIEW, F1–F11 folded;
user ruling on F7: rust's run envelope takes the fleet's shape, `files` on every run)

## Problem

After CR-CRU-204 the bun and python clients send their runners' reports to `POST /api/v2/runs` through one
shared ingest (`ingest_reports`), and the board decodes them (CR-CRU-152) within its bounds (CR-CRU-207);
CR-CRU-206 moved the maven client the same way. The rust client still parses nextest's JUnit itself
(`_parse_junit`) and sums llvm-cov's lcov (`_parse_lcov`), posting them to `/api/v2/runs/parsed`
(`_workspace_regression_run`, `_regression_ingest_run`), or sends a `dataPath` the board must read off its own
disk (`_ingest_junit_axi`, and `_smoke_run`'s own body).

## Design (user rulings, 2026-10-27 and 2026-10-30)

- As CR-CRU-204: the client parses nothing but the runner's exit code and the testcase count that decides
  "ran nothing"; every figure and warning comes from the board's response; reports travel inline; an oversized
  body is refused before sending; with no board there are no figures.
- Rust's run envelope takes the fleet's shape: every run envelope carries the answer's `files`, as bun's,
  python's and maven's do (today only the two regression verbs carry it, from the client's own count).
- The run emitter is written in the client, shaped as maven's `_emit_run_axi` (with a coverage option), because
  the shared module has no room for it until CR-CRU-221, which lifts the bun, python, maven and rust emitters
  into one.

## Steps

### §S1 — every report-ingesting verb uses the shared ingest

Five bodies file a rust report, and each files it through a client `_file_reports` — one call of the shared
`ingest_reports` (CR-CRU-218) — with `codec: "junit"` and the text of the `junit.xml` the body reads today:

| Verb(s) | Body | Reads |
|---|---|---|
| `test`, `unit`, `integration`, `e2e`, `module`, `bdd` (declared profiles through `_run_declared_nextest_profile`), and the declared suites a composed `pre-merge-gate` runs | `_test_run` (from `cmd_test`) | `_resolve_junit_path(profile)`, claimed into the run's own directory |
| `auto-ingest` | `cmd_auto_ingest` | `target/nextest/ci/junit.xml`, else the `default` one |
| `smoke-test`, `docker-e2e-gate` | `_smoke_run` | `target/nextest/<profile>/junit.xml`, else the `default` one |
| `workspace-regression`, `regression`, and `pre-merge-gate`'s whole suite | `_workspace_regression_run` | `target/nextest/<profile>/junit.xml` written this run; the `--lcov-output` when coverage is on |
| `regression-ingest` | `_regression_ingest_run` | `target/nextest/ci/junit.xml` and `target/lcov.info` |

A run that measured coverage (`regression-ingest`, and `workspace-regression`, `regression` and `pre-merge-gate`
when coverage is on, CR-CRU-212) sends `coverage: {codec: "lcov", data}` with the lcov report it reads today; a
coverage run whose lcov is missing sends no `coverage` block and carries `coverage-not-measured`
(`coverage_not_measured_warning`, CR-CRU-218).

`_ingest_junit_axi`, `_smoke_run`'s inline `dataPath` payload and the two `/runs/parsed` payloads are deleted;
the rustc compile ingests (`_ingest_rustc_stderr`, `cmd_auto_ingest`'s compile post) are unchanged.

Each body keeps its other exits unchanged — a run with no `--agent` where the verb allows one (the runner's exit),
a run abandoned (`emit_run_abandoned`), no report (the compile ingest, or exit 1), a run that ran nothing
(`emit_ran_nothing`), and the refusals before the run (an unattributed run, the gate lock, the disk guard, a
docker-up failure, the gate's clippy abort) — and gains the shared ingest's: a refusal before sending, a 413, and
a board unreachable at the POST. `_regression_ingest_run` gains the "ran nothing" check the other four bodies make
(`ran_nothing` over the runner's exit and `junit_testcase_count`); today it files a zero-case report.

Every verb but `auto-ingest` sends its captured runner output as `raw` (an agent's run is captured by
`run_streamed`) and the runner's exit as `runnerExit` (CR-CRU-208). `auto-ingest` keeps its exit: 0 only when the
answer is `ok` and its run records no failure. No verb sends `dataPath`.

### §S2 — the client parsers go

- `_parse_junit`, `_parse_lcov` and `_run_block` are deleted. "Ran nothing" reads `junit_testcase_count`.
- The text that names the parsed route, `dataPath`, or coverage published on a failing run says the reports route
  and the board's discard: the module docstring (the `regression-ingest` row and the endpoint list), the
  docstrings of `_request`, `cmd_smoke_test`, `cmd_workspace_regression` and `_regression_ingest_run`, the
  `regression-ingest` subparser help, `workspace-regression`'s `--ignore-run-fail` help, and the shared
  `REGRESSION_COVERAGE_LLVM_COV_HELP` (reworded in its own lines). The printed-help tests
  (`test_every_clients_help_says_regression_coverage_is_opt_in.py`) follow.
- Rust's own stderr result lines (`ingest junit:`, `regression: ok=`, `workspace regression: ok=`,
  `smoke-test: ok=`) go; the shared `ingest:` line (CR-CRU-218) is the run's one ingest line.
- Every by-symbol citation of a deleted or renamed rust symbol is re-pointed or removed, in its own commit:
  `docs/research/DN-crucible-api-reconstruction.md` (its two `_ingest_junit_axi` citations, and its §4 rust row,
  which names `dataPath` and the parsed route), `tests/clients-rust-mvn-crucible.test.ts`, and — if the emitter or
  a body is renamed — `tests/client/test_client_tier_run_envelope.py` and `tests/client/test_cr051_rust_files_count.py`.
  Text-only mentions follow: `tests/fixtures/coverage-percent-oracle.gen.py` and the docstrings of
  `test_rust_crucible_agent_report_isolation.py` and `test_cr051_files_count_parity.py`.
- `tests/fixtures/reports/freeze-client-parse.py`'s `freeze_rust` retires, and the fixtures' `README.md` follows.
- The client tests that pinned the parser, the parsed route, `dataPath`, rust's own result lines or "files only
  on the regression verbs" are retired, re-pointed at the board, or given a health answer carrying `codecs` and
  `limits` and a `run` block in the ingest answer they stub, each such change in its own commit: the rust-only
  test files, rust's cases in the shared files and in `tests/clients-rust-mvn-crucible.test.ts` (a census at RED
  lists them).
- `clients/_crucible_axi.py` does not grow.
- The provenance floor `PROSE_CITATIONS.clients.head` (`tests/project-namespace-tripwire.test.ts`) moves with the CR
  literals the deleted and rewritten bodies carry: one re-record, in its own commit at the close-out.

### §S3 — the envelope's figures and warnings come from the board

As CR-CRU-204 §S4: every rust run envelope's `run:` block (`passed`, `failed`, `pending`, `total`, `files`) is the
ingest answer's (`filed_run`), through one emitter shaped as maven's `_emit_run_axi`; `regression-ingest`'s and the
workspace regression's `coverage:` field is the answer's `run.coverage` lines and functions percents, absent when
the board kept none (a red run's coverage is discarded); the answer's `warnings[]` join the envelope's. A run
whose ingest fails, is refused or cannot reach the board carries no figures (each null, never indexed) and says
why, and its help and exit are derived without a failure count. `_workspace_regression_run`, when run as
`pre-merge-gate`, adds `whole_suite_unreported_warnings` for a suite it did not file, as maven's and python's
regression bodies do. The `files` count is the board's (a case's `file`, else its `classname` — nextest's test
binary — else its suite's name: the rule the client applied).

## Acceptance criteria

- [x] **AC1 — every verb.** The route census (`test_every_verb_that_runs_a_test_runner_is_classified.py`) rust
      table names, for each verb §S1 lists, the shared ingest as its only report call site (the rustc compile sites
      as today; `pre-merge-gate` reaching `_test_run`'s through declared profiles as well as the workspace
      regression's), and it passes; no rust source position posts to `/api/v2/runs/parsed` or names `dataPath`.
- [x] **AC2 — coverage as its report.** `regression-ingest`, and `workspace-regression`, `regression --coverage` and
      `pre-merge-gate` with coverage on, send `coverage: {codec: "lcov", data}` with the lcov text, on a passing run
      and on a failing one; with the lcov missing they send no `coverage` block and carry `coverage-not-measured`;
      a run with coverage off sends none and carries no such warning; a health answer lacking `lcov` in
      `codecs.coverage` refuses the coverage run.
- [x] **AC3 — the same figures.** CR-CRU-152's rust fixture, filed by `test --crate c` through this client (a fake
      `cargo` writing the fixture's `junit.xml` to `target/nextest/ci/junit.xml` and exiting 100) against a board
      the test spawns, stores `expected.json`'s summary and each case's status, compared by `(suite, case)`, and
      prints an envelope whose `run.files` is the answer's and equals `expected.json`'s 3. The fixture is a failing
      run, whose coverage the board discards, so the stored coverage object is proven by `regression-ingest` on a
      passing one-case report beside the fixture's `lcov.info`, and equals `expected.json`'s coverage.
- [x] **AC4 — no parser left.** CR-CRU-204's source scan (`test_a_client_parses_no_report.py`) covers
      `rust-crucible.py` with an empty exemption set, finds a synthetic rust source that defines its own
      `junit_testcase_count`, and passes.
- [x] **AC5 — local decisions.** "Ran nothing" comes from the runner's exit code and `junit_testcase_count`, and the
      verb's exit from `verb_exit` over the runner's exit and the board's answer, asserted for `test`, `smoke-test`,
      `workspace-regression` and `regression-ingest` on a run that ran nothing and a run with a failure;
      `auto-ingest` exits 0 only on an `ok` answer whose run records no failure.
- [x] **AC6 — envelope, warnings, no board, older board, too large.** CR-CRU-204's AC6–AC9 hold for the rust client:
      every run envelope's `run:` block is the answer's five counts and a board warning joins `warnings[]`; with the
      board unreachable at the health read or the ingest, `regression-ingest` and `workspace-regression` each print
      one envelope with null figures, exit 1 and print no traceback, and `pre-merge-gate` names its suite
      `gate-suite-unreported` and is not green; an older board is refused naming its version and the 0.4.0 floor; a
      body over the advertised limit is refused before sending, and a 413 reported, both naming `ingest_body_bytes`.
- [x] **AC7 — raw and the runner's exit.** Each verb of §S1 but `auto-ingest` sends its captured runner output as
      `raw` and the runner's exit as `runnerExit`.
- [x] **AC8 — files on every run.** `test`, `smoke-test`, `auto-ingest`, `workspace-regression` and
      `regression-ingest` envelopes each carry the answer's `files`; the coverage field rides only the two regression
      verbs, and only when the answer carries coverage.
- [x] **AC9 — help, lines and citations.** No printed rust help names `/api/v2/runs/parsed` or says coverage is
      published on a failing run, and the module docstring names `/api/v2/runs` and not `/api/v2/runs/parsed` (the
      rust cases of `test_every_clients_help_says_regression_coverage_is_opt_in.py`); `rust-crucible.py` holds no
      string literal beginning `ingest junit:`, `regression: ok=`, `workspace regression: ok=` or `smoke-test: ok=`;
      `DN-crucible-api-reconstruction.md` names no rust `dataPath` or parsed route;
      `tests/citations-cite-by-symbol.test.ts` passes; `clients/_crucible_axi.py` is no longer than at
      `develop@850e8a0` (9,997 lines).
- [x] **AC10 — the citation floor (close-out).** `PROSE_CITATIONS.clients.head` is re-measured at the close-out and
      re-recorded once, in its own commit, by exactly the measured delta.
- *Recorded at merge:* VERIFY approved with no blocking finding. GREEN named an unfiled suite unreported on the
  gate's whole-suite path (`whole_suite_alone=… name_unfiled=True`, bun's shape) rather than on every
  `pre-merge-gate` run, so a gate with declared suites names it once; VERIFY confirmed it once in both shapes.
  `regression-ingest` over a runner that failed with a zero-case report now ends `run-aborted` with the runner's
  exit, as §S1 adds. VERIFY's F1 (the dated path matrix in `test_client_tier_run_envelope.py` named rust's
  `_emit_ingest_axi`) and F2 (the API reconstruction's v1 `/api/ingest` row read oddly against `ingest_reports`)
  were fixed in their own cycle (811, user ruling). Its F3 — a connection the board drops mid-request escapes the
  shared transport — is CR-CRU-206's F1, already in CR-CRU-221. AC10: `PROSE_CITATIONS.clients.head` 835 → 821,
  the 14 CR literals of rust's deleted and rewritten bodies. `rust-crucible.py` closed at 3,502 lines;
  `_crucible_axi.py` held at 9,997. Model B's `crucible-report-rust` skill goes to the 0.4.0 notice.

## Non-goals

- The arduino client (CR-CRU-220), and lifting the run emitter into the shared code (CR-CRU-221).
- The board's side (CR-CRU-152, CR-CRU-207), the shared ingest (CR-CRU-204, CR-CRU-218), and retiring
  `/api/v2/runs/parsed`.
- Model B's `crucible-report-rust` skill, which goes to the 0.4.0 notice.
- A run's live test stream: CR-CRU-202.
