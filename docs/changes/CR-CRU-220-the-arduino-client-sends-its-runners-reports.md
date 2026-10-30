# CR-CRU-220 — the arduino client sends its runner's reports and parses nothing

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-204, CR-CRU-208, CR-CRU-218, CR-CRU-221 · **Status**
DONE — merged 2026-10-30 (plan 224, cycles 815–817, gate 9904/0: bun 4227/0, python 5677/0); filed 2026-10-30 (split from CR-CRU-206 at its gap analysis, user ruling: the shared reporting
first, CR-CRU-218, then one CR per client; user ruling the same day: the Makefile-narrowing check reads its
cases through a shared reader; user ruling at CR-CRU-206's pre-review: the shared module is split first,
CR-CRU-221); spec pre-review 2026-10-30 (CR-CRU-220-SPEC-REVIEW, F1–F17 folded; user rulings: the no-`--agent`
run exits with the runner's exit and the make contract requires `make` to fail on a failing binary; the run
envelope carries `ingest-failed` as maven's and rust's do; `filed_summary` is deleted; arduino's send-reports test
pins the run module's line budget too; re-scored 5 → 8)

## Problem

After CR-CRU-204, CR-CRU-206 and CR-CRU-219, the bun, python, maven and rust clients send their runners' reports
to `POST /api/v2/runs` through one shared ingest (`ingest_reports`, now in `clients/_crucible_run.py`), and the board
decodes them (CR-CRU-152) within its bounds (CR-CRU-207); their envelopes come from one shared emitter
(`emit_run_axi`, CR-CRU-221). The arduino client still parses the native harness's JUnit itself (`_parse_junit`) and
sums its lcov (`_collect_lcov`), posting them to `/api/v2/runs/parsed` (`_run_native_tests_body`,
`cmd_auto_ingest`), and its envelope falls back to its own counts (`filed_summary`), so a run the board never filed
still shows figures. The same parse feeds the check that names a Makefile which ignored `TESTS` or `TEST_NAME`
(`_ignored_narrowing_warnings`, reading each case's name and file stem).

## Design (user rulings, 2026-10-27 and 2026-10-30)

- As CR-CRU-204: the client parses nothing but the runner's exit code and the two testcase counts; every figure and
  warning comes from the board's response; reports travel inline; an oversized body is refused before sending; with
  no board there are no figures.
- The narrowing check is a local decision made before the ingest, as bun's filter check is: it reads each case's
  name and file stem through one shared reader in the run module (`_crucible_run.py`), beside the two counts. The
  no-parse scan reads client modules, not the run module, so arduino's exemption set is empty.
- The no-`--agent` run, which files nothing, exits with the runner's exit, not a failure count it would have to parse
  (the change CR-CRU-208 AC5's arduino clause anticipated); so the make contract the client documents requires `make`
  to exit non-zero when a test binary fails.
- The run envelope is emitted through `emit_run_axi`, and a run whose ingest was not `ok` also carries `ingest-failed`,
  as maven's and rust's do.

## Steps

### §S1 — every report-ingesting verb uses the shared ingest

Two bodies file an arduino report, each through a client `_file_reports` — one call of the shared `ingest_reports` —
with `codec: "junit"` and the text of every `TEST-*.xml` the body reads, sorted:

| Verb(s) | Body | Reads |
|---|---|---|
| `test`, `unit`, `regression`, the declared `module`, `integration`, `e2e` and `bdd` (through `_run_declared_make_target`), and `pre-merge-gate`'s whole suite (through `gate_regression`) | `_run_native_tests_body`, through `_run_native_tests` | the run's own reports directory, else `<native_dir>/reports`; on a coverage run `<coverage dir>/lcov.info` |
| `auto-ingest` | `cmd_auto_ingest` | `--reports`, else `<native_dir>/reports` |

A `--coverage` run sends `coverage: {codec: "lcov", data}` with the `lcov.info` it reads today; one whose lcov is
missing sends no `coverage` block and carries `coverage-not-measured`; a run with coverage off sends none. The
compile gate (`_compile_run`, `_ingest_compile`: `check`, `compile`, the gate's step 0) is unchanged.

Each body keeps its other exits unchanged — the narrowing refusal, the unattributed and scoped-gate refusals, the
gate's compile abort, a run abandoned (`emit_run_abandoned`), no report (exit 1), a run that ran nothing
(`ran_nothing`, and a narrowed run with zero cases), `auto-ingest`'s missing `--agent` — and gains the shared
ingest's: a refusal before sending (an unreadable health, no `junit` or `lcov` codec, an unreadable report, a body
over the limit), a 413, a board unreachable at the POST, a dropped connection (`run-aborted`, `run-left-open`), and a
run the board may hold (`run-may-be-filed`).

Every verb but `auto-ingest` sends its captured `make` output as `raw` and the runner's exit as `runnerExit`
(CR-CRU-208). `auto-ingest` exits 0 only on an `ok` answer whose run records no failure.

### §S2 — the client parsers go; the narrowing check reads through the shared reader

- `_parse_junit`, `_collect_lcov` and `_file_stem` are deleted from the arduino client, and with them its
  `xml.etree.ElementTree` import.
- `_crucible_run.py` gains `junit_case_sources(paths)`: each `<testcase>` across the reports at `paths`, in report
  order, walked as `junit_testcase_count` walks them (every `testcase` element in the tree), as `(name, stem)` — the
  name the case's `name`, `"?"` when it has none; the stem from the case's `classname`, else its `file` (an empty
  `classname` falls through), with `\` read as `/`, its basename without extension, `None` when that is empty or the
  case carries neither — and `None` when a report cannot be read or parsed, printing one warning, as
  `junit_testcase_count` answers. `_ignored_narrowing_warnings` reads its cases from it; when it answers `None`, no
  narrowing warning is judged.
- `filed_summary` is deleted from `_crucible_run.py`: arduino was its last caller.
- `_crucible_run.py`'s line budget (`SHARED_MODULE_LINE_BUDGETS`, in the maven and rust send-reports tests and in
  arduino's) is re-recorded at its new size in the commit that grows it; `_crucible_axi.py` does not grow.
- "Ran nothing", and a narrowed run that ran nothing, read `junit_testcase_count`.
- The no-`--agent` run prints `ran <n> testcases (<m> not skipped); runner exit <rc>` from `junit_testcase_count` and
  `junit_non_skipped_count`, and exits with the runner's exit code. The make contract the client prints
  (`test_the_arduino_client_help_writes_down_its_make_contract.py`) states that `make <target>` exits non-zero when a
  test binary fails, and its example loop does.
- The text that names the parsed route says the reports route: the module docstring's `test` row, the docstrings of
  `_request` and `_run_native_tests`, the `test` subparser help, the `unit` and `regression` tier-verb help, and the
  shared `http_request` docstring (reworded in its own lines). Arduino's own stderr result lines (`[crucible] <verb> ->
  '<key>': <p>/<t> passed, …` on both the filing and the no-`--agent` paths, and `auto-ingest`'s) go; the shared
  `ingest:` line is the run's one ingest line. `DN-crucible-api-reconstruction.md`'s §4 arduino row and its §3.5 claim
  about `_run_native_tests_body` follow.
- Every by-symbol citation of a deleted arduino symbol is re-pointed, annotated or removed, in its own commit:
  `tests/clients-python-arduino-crucible.test.ts` (the comment above its CR-CRU-050 describe and the
  `junitXmlString` JSDoc), `tests/client/test_cr051_files_count_parity.py` (its docstring; its arduino `_parse_junit`
  section retires), and the dated matrix row of `tests/client/test_client_tier_run_envelope.py` (annotated "replaced
  since", as rust's was). `tests/fixtures/reports/freeze-client-parse.py` retires whole (its last freezer is
  arduino's), and its `README.md` and the header comment of `real-stack-reports-decode-on-the-board.test.ts` follow.
- The client tests that pinned the parser, the parsed route, arduino's own result lines, its own figures, or the
  no-`--agent` exit on a failing report are retired, re-pointed at the board, or given a health answer carrying
  `codecs` and `limits` and a `run` block in the ingest answer they stub, each such change in its own commit: the
  arduino-only test files, arduino's cases in the shared files and in `tests/clients-python-arduino-crucible.test.ts`
  (a census at RED lists them).
- The provenance floor `PROSE_CITATIONS.clients.head` (`tests/project-namespace-tripwire.test.ts`) moves with the CR
  literals the deleted and rewritten bodies carry: one re-record, in its own commit at the close-out.

### §S3 — the envelope's figures and warnings come from the board

`_emit_ingest_summary_axi` is deleted, and arduino's run envelope is emitted by a one-statement `_emit_run_axi` that
returns `_axi().emit_run_axi(...)`, passing the context built with `cycle_id=_axi().echoed_cycle_id(resp)`: the
`run:` block (`passed`, `failed`, `pending`, `total`, `files`) is the answer's (`filed_run`), each figure null when
the run was not filed; the answer's `warnings[]` join the envelope's; a run whose ingest was not `ok` carries the
answer's `error` and `ingest-failed`; its help and exit are derived without a failure count it would have to read
from its own parse. The envelope gains no `coverage` field. `pre-merge-gate`, when the project's whole suite runs
alone, names a suite it did not file `gate-suite-unreported` (`whole_suite_alone` with `whole_suite_unreported_warnings`,
as the bun and rust clients do); a composed gate reads the null figures as unreported. The `files` count is the
board's: distinct sources across all of the run's reports (the client summed each report's distinct sources, which
differs when a source repeats across reports).

## Acceptance criteria

- [x] **AC1 — every verb.** The route census (`test_every_verb_that_runs_a_test_runner_is_classified.py`) arduino
      table names, for each verb §S1 lists, the shared ingest as its only report call site (the compile site as today),
      and it passes; no arduino source position posts to `/api/v2/runs/parsed`; arduino's `_file_reports` is one call
      of `_axi().ingest_reports` (`test_a_runs_ingest_helpers_live_once_in_the_shared_module.py`).
- [x] **AC2 — coverage as its report.** A `regression --coverage` run sends `coverage: {codec: "lcov", data}` with the
      lcov text, on a passing run and on a failing one; with the lcov missing it sends no `coverage` block and carries
      `coverage-not-measured`; with coverage off it sends none and carries no such warning; a health answer lacking
      `lcov` in `codecs.coverage` refuses the coverage run.
- [x] **AC3 — the same figures.** CR-CRU-152's arduino fixture, filed by `unit --agent <id> --reports <dir>` through
      this client (a fake `make` copying the fixture's three `TEST-*.xml` into `$REPORTS_DIR` and exiting 0) against a
      board the test spawns, stores 13 cases — 8 passed, 2 failed, 3 pending — each case's status equal to
      `expected.json`'s by `(suite, case)`; the envelope's `run.files` is the answer's 2, not `expected.json`'s
      per-report 3 (the esp32 and uno reports share a source); the verb exits 1 from the board's failure count. The
      fixture is a failing run, whose coverage the board discards, so the stored coverage object is proven by
      `regression --coverage` on a passing one-case report beside the fixture's `lcov.info`, and equals
      `expected.json`'s coverage.
- [x] **AC4 — no parser left.** CR-CRU-204's source scan (`test_a_client_parses_no_report.py`) covers
      `arduino-crucible.py` with an empty exemption set, finds a synthetic arduino source that defines its own
      `junit_case_sources`, and passes.
- [x] **AC5 — the narrowing check holds.** `junit_case_sources` answers each case's `(name, stem)` as §S2 states —
      `classname`, else `file`, an empty `classname` falling through, `\` as `/`, a nameless case `"?"`, no stem
      `None` — and `None`, with one warning, for an unreadable report, beside `junit_non_skipped_count`'s tests in
      `test_one_shared_ingest_reads_health_before_it_sends.py`; through the client, a Makefile that ignored `TESTS` and
      one that ignored `TEST_NAME` are each named (`makefile-ignored-tests`, `makefile-ignored-test-name`) in the filed
      run's envelope, and a narrowed run with zero cases is a run that ran nothing:
      `test_an_arduino_makefile_that_ignored_tests_or_test_name_is_named.py` and
      `test_an_arduino_run_narrowed_by_tests_and_name_reaches_make.py` pass, re-pointed only where they read the parsed
      payload's `summary.total` or the old no-`--agent` line.
- [x] **AC6 — local decisions.** The verb's exit is `verb_exit` over the runner's exit and the board's answer, asserted
      on a run that ran nothing and a run with a failure; `auto-ingest` exits 0 only on an `ok` answer whose run records
      no failure; the no-`--agent` run prints §S2's line and exits with the runner's exit code, 0 on a report with a
      failure after a clean `make`; the printed make contract states that `make` exits non-zero when a test binary
      fails.
- [x] **AC7 — envelope, warnings, no board, older board, too large, dropped.** CR-CRU-204's AC6–AC9 hold for the
      arduino client: the `run:` block is the answer's five counts, each null when the run was not filed, and a board
      warning joins `warnings[]`; a not-`ok` answer carries `error` and `ingest-failed`; with the board unreachable at
      the health read or the ingest the envelope carries no figures, and `pre-merge-gate` names its suite
      `gate-suite-unreported` and is not green; an older board is refused naming its version and the 0.4.0 floor; a
      body over the advertised limit is refused before sending, and a 413 reported, both naming `ingest_body_bytes`;
      arduino joins `test_a_dropped_connection_is_answered.py`'s shared-ingest classes (one `ingest:` line, null figures,
      `run-may-be-filed` for a run the board may hold), retiring its arduino-only class there.
- [x] **AC8 — one emitter, raw and the runner's exit.** Arduino's `_emit_run_axi` is one statement besides an optional
      docstring, a `return` of `_axi().emit_run_axi(...)` (it joins `RUN_EMITTERS` in
      `test_the_run_pipeline_lives_in_its_own_shared_module.py`); `_emit_ingest_summary_axi` and `filed_summary` are
      defined nowhere; each verb of §S1 but `auto-ingest` sends its captured `make` output as `raw` and the runner's exit
      as `runnerExit`.
- [x] **AC9 — help, lines and citations.** No printed arduino help names `/api/v2/runs/parsed`, and the module docstring
      names `/api/v2/runs` (the arduino cases of `test_every_clients_help_says_regression_coverage_is_opt_in.py`);
      `arduino-crucible.py` holds no string literal carrying its old result line (` passed, ` beside
      `files (ingest ok=`); `DN-crucible-api-reconstruction.md` names no arduino parsed route; `ruff check --select F` is
      clean on `arduino-crucible.py` and `_crucible_run.py`; `tests/citations-cite-by-symbol.test.ts` passes;
      `_crucible_axi.py` is no longer than 9,088 newlines, and `_crucible_run.py` no longer than its re-recorded budget
      (pinned in arduino's send-reports test as in maven's and rust's).
- [x] **AC10 — the citation floor (close-out).** `PROSE_CITATIONS.clients.head` is re-measured at the close-out and
      re-recorded once, in its own commit, by exactly the measured delta.
- *Recorded at merge:* VERIFY approved with no blocking finding. Its F1 (process): §S2 has the run module's budget
  re-recorded in the commit that grows it, but GREEN may not edit tests, so the re-record (1,123 → 1,134, in the maven,
  rust and arduino send-reports tests) came at the close-out, and GREEN's two commits fail that budget pin at their own
  heads — the orchestrator's brief, for the retro. The close-out also made the API reconstruction's §4 arduino row true
  (`projects/add` gone, the compile ingest's `gcc`). VERIFY's F2 (the DN's §3.6 still listed arduino as sending no compile
  format), F3 (a no-`--agent` run over an unreadable report printed `ran None testcases` and warned twice) and F4 (a
  no-`--agent` `--coverage` run with no lcov said nothing) were fixed in their own cycle (817, user ruling). On nested
  `<testsuite>` reports the reader's whole-tree walk sees cases the old parse missed (the native harness writes flat
  reports); a malformed report, which crashed the old client with its run left open, is now warned of and sent for the
  board to judge. AC10: `PROSE_CITATIONS.clients.head` 814 → 799. `_crucible_run.py` closed at 1,134 newlines,
  `_crucible_axi.py` at 9,088. With this CR all five clients send their runners' reports and parse none. VERIFY's F5 —
  Model B's `crucible-report-arduino` skill — goes to the 0.4.0 notice.

## Non-goals

- The board's side (CR-CRU-152, CR-CRU-207), the shared ingest and emitter (CR-CRU-204, CR-CRU-218, CR-CRU-221), and
  retiring `/api/v2/runs/parsed` (`RUN_INGEST_PATHS` keeps it).
- A `coverage` field on arduino's envelope.
- Model B's `crucible-report-arduino` skill, which goes to the 0.4.0 notice.
- A run's live test stream: CR-CRU-203.
