# CR-CRU-206 — the maven client sends its runner's reports and parses nothing

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-204, CR-CRU-208, CR-CRU-218 · **Status**
DONE — merged 2026-10-30 (plan 221, cycles 806–808, gate 9631/0: bun 4226/0, python 5405/0); filed 2026-10-27 (split from CR-CRU-152 at its gap analysis, user ruling; bun and python are
CR-CRU-204); re-scoped 2026-10-30 at its gap analysis (user ruling: the shared reporting first, CR-CRU-218,
then one CR per client — maven here, rust CR-CRU-219, arduino CR-CRU-220; re-scored 13 → 8); spec
pre-review 2026-10-30 (CR-CRU-206-SPEC-REVIEW, F1–F8 folded; F9, the shared module's line budget, ruled by
the user: the module is split in its own CR ahead of CR-CRU-220). The file keeps its first slug.

## Problem

After CR-CRU-204 the bun and python clients send their runners' reports to `POST /api/v2/runs` through one
shared ingest (`ingest_reports`), and the board decodes them (CR-CRU-152) within its bounds (CR-CRU-207).
The maven client still parses its own JUnit (`_parse_junit`) and sums its own JaCoCo (`_collect_jacoco`)
and posts them to `/api/v2/runs/parsed` (`_ingest_parsed`), or sends a `dataPath` the board must read off
its own disk (`_ingest_junit_dir`, chosen by `_smart_ingest` when one directory holds the reports).

## Design (user rulings, 2026-10-27)

As CR-CRU-204: the client parses nothing but the runner's exit code and the testcase count that decides
"ran nothing"; every figure and warning comes from the board's response; reports travel inline; an
oversized body is refused before sending; with no board there are no figures. Maven collects JaCoCo
coverage on every coverage run, passing or failing; the board discards it on a red one.

## Steps

### §S1 — every report-ingesting verb uses the shared ingest

Five bodies file a maven report, and each files it through the client's `_file_reports` — one call of the
shared `ingest_reports` (CR-CRU-218) — with `codec: "junit"` and the text of every `TEST-*.xml` in the
directories the body reads today, in the order of those directories, each directory's `TEST-*.xml` sorted:

| Verb(s) | Body | Reads |
|---|---|---|
| `unit`, `module`, `bdd` | `_surefire_tier_run` | the run's own reports directory, else surefire's `target` dirs |
| `integration`, `e2e` | `_failsafe_tier_run` | the run's own reports directory, else failsafe's |
| `test` | `_test_run` | the run's own reports directory, else surefire's |
| `regression`, and `pre-merge-gate`'s one suite | `_regression_run` | the run's own reports directory, else surefire's then failsafe's |
| `auto-ingest` | `cmd_auto_ingest` | every module's surefire then failsafe `target` dirs |

`_ingest_junit_dir`, `_ingest_parsed` and `_smart_ingest` are deleted. Each body keeps its other exits
unchanged — a run with no `--agent` (the runner's exit), a run abandoned (`emit_run_abandoned`), no report
(`_compile_fallback`, the compile ingest), a run that ran nothing (`emit_ran_nothing`) — and gains the
shared ingest's: a refusal before sending, a 413, and a board unreachable at the POST.

A coverage run (`regression --coverage`, `pre-merge-gate`'s regression suite, `auto-ingest --coverage`)
sends `coverage: {codec: "jacoco", data}` with the text of every CSV the client selects today: the first of
`jacoco-report/jacoco.csv` and `site/jacoco/jacoco.csv` that exists under any `target/` at or below the
maven directory (hidden directories excepted), then every CSV of that name, deduplicated and sorted — the
board sums several texts as one (`decodeCoverage`). It is sent whether or not the run passed. A coverage
run that finds no CSV sends no `coverage` block and carries `coverage-not-measured`
(`coverage_not_measured_warning`, CR-CRU-218).

Every verb but `auto-ingest` sends its captured runner output as `raw` and the runner's exit as
`runnerExit` (CR-CRU-208). `auto-ingest` runs no runner and keeps its exit, 0 when the answer is `ok`,
else 1. No verb sends `dataPath`.

### §S2 — the client parsers go

- `_parse_junit` and `_collect_jacoco` are deleted. "Ran nothing" keeps reading `junit_testcase_count`,
  unchanged. `_read_declared_profile`'s POM read is not a report parse and stays.
- The text that names the parsed route or a green-only coverage rule says the reports route and the
  board's discard: the module docstring (its `/api/v2/runs/parsed` mentions and its endpoint list),
  `_request`'s docstring, the `--agent` help of `integration` and `e2e` ("parsed, no coverage"),
  `regression`'s subparser help, `auto-ingest`'s `--coverage` help ("ONLY valid after a known-green full
  regression") and the shared `REGRESSION_COVERAGE_JACOCO_HELP`. The printed-help tests
  (`test_every_clients_help_says_regression_coverage_is_opt_in.py`) follow.
- The maven ingest lines (`ingest junit:`, `ingest parsed:`, `[crucible] jacoco: N csv file(s)`,
  `no jacoco.csv found`, `NOT publishing coverage`) go; the shared `ingest:` line (CR-CRU-218) is the run's
  one ingest line.
- Every by-symbol citation of a deleted maven symbol is re-pointed or removed, in its own commit:
  `tests/clients-rust-mvn-crucible.test.ts`, `tests/clients-bun-crucible.test.ts`,
  `docs/research/DN-client-fleet-inventory.md` and `docs/research/DN-crucible-api-reconstruction.md`.
- `tests/fixtures/reports/freeze-client-parse.py`'s `freeze_mvn` (which imports the deleted parsers) retires,
  as CR-CRU-204 retired bun's and python's, and the fixtures' `README.md` follows.
- The client tests that pinned the parser, the parsed route, `dataPath` or the old ingest lines for maven
  are retired, re-pointed at the board, or given a health answer carrying `codecs` and `limits` and a `run`
  block in the ingest answer they stub, each such change in its own commit: the maven-only test files, and
  maven's cases in the shared files and in `tests/clients-rust-mvn-crucible.test.ts` (a census at RED lists
  them).
- `clients/_crucible_axi.py` does not grow: the shared module sits one line under the 10,000-line self-test
  of `tests/citations-cite-by-symbol.test.ts` until its split (ruled ahead of CR-CRU-220).
- The provenance floor `PROSE_CITATIONS.clients.head` (`tests/project-namespace-tripwire.test.ts`) moves
  with the CR literals the deleted and rewritten bodies carry: one re-record, in its own commit at the
  close-out.

### §S3 — the envelope's figures and warnings come from the board

As CR-CRU-204 §S4: the envelope's `run:` block (`passed`, `failed`, `pending`, `total`, `files`) is the
ingest answer's (`filed_run`), on every emitter (`_emit_tier_run_axi`, `_emit_ingest_summary_axi`,
`_emit_ingest_axi_resp`, or one emitter that replaces them); the answer's `warnings[]` join the
envelope's; a run whose ingest fails, is refused or cannot reach the board carries no figures, says why,
and its help and exit are derived without a failure count. The `files` count is the board's (distinct
sources: a case's `file`, else its `classname`, else its suite's name — the rule the client applied). The
coverage on stderr is the `ingest:` line's `lines=`/`funcs=`.

## Acceptance criteria

- [x] **AC1 — every verb.** The route census (`test_every_verb_that_runs_a_test_runner_is_classified.py`)
      maven table names, for each of `test`, `unit`, `module`, `integration`, `e2e`, `regression`, `bdd`,
      `auto-ingest` and `pre-merge-gate`, the shared ingest as its only report call site (compile sites as
      today), and it passes; no maven source position posts to `/api/v2/runs/parsed` or names `dataPath`.
- [x] **AC2 — the reports inline, in order.** A `module` run over a two-module reactor sends one
      `POST /api/v2/runs` whose `data` holds every `TEST-*.xml` text of its reports directory, sorted; a
      `regression` run sends both surefire and failsafe texts; an `auto-ingest` over a two-module tree sends
      each module's surefire then failsafe texts, in that order.
- [x] **AC3 — coverage as its report.** A `regression --coverage` run over a two-module reactor sends
      `coverage: {codec: "jacoco", data}` holding both modules' CSV texts, on a passing run and on a failing
      one, and its stderr `ingest:` line carries the answer's `lines=`/`funcs=`; with no CSV it sends no
      `coverage` block and carries `coverage-not-measured`; `auto-ingest --coverage` does the same.
- [x] **AC4 — the same figures.** CR-CRU-152's mvn fixture, filed by a `regression` run through this client
      (a fake `mvnw` writing the fixture's five reports) against a board it spawns, stores the counts of its
      `expected.json` and each case's status, compared by `(suite, case)`; the envelope's `run.files` is the
      answer's and equals `expected.json`'s 5. The fixture is a failing run, whose coverage the board
      discards, so the stored coverage object is proven on a passing report beside the fixture's two CSVs.
- [x] **AC5 — no parser left.** CR-CRU-204's source scan (`test_a_client_parses_no_report.py`) gains a JaCoCo
      summation kind — a call of `csv.reader` or `csv.DictReader`, or a string literal `LINE_COVERED`,
      `LINE_MISSED`, `METHOD_COVERED`, `METHOD_MISSED`, `BRANCH_COVERED` or `BRANCH_MISSED` — proved on a
      synthetic violating source, and covers `mvn-crucible.py` with `_read_declared_profile` its only
      exemption, and passes.
- [x] **AC6 — local decisions.** "Ran nothing" comes from the runner's exit code and `junit_testcase_count`,
      and the verb's exit from `verb_exit` over the runner's exit and the board's answer, asserted on a run
      that ran nothing and a run with a failure for `unit`, `integration`, `test` and `regression`;
      `auto-ingest` exits 0 on an `ok` answer and 1 otherwise.
- [x] **AC7 — envelope, warnings, no board, older board, too large.** CR-CRU-204's AC6–AC9 hold for the maven
      client: the `run:` block is the answer's five counts and a board warning joins `warnings[]`; with the
      board unreachable at the health read or the ingest the envelope carries no figures and `pre-merge-gate`
      reports the suite unreported and is not green; an older board is refused naming its version and the
      0.4.0 floor; a body over the advertised limit is refused before sending, and a 413 reported, both
      naming `ingest_body_bytes`.
- [x] **AC8 — raw and the runner's exit.** Each verb of §S1 but `auto-ingest` sends its captured runner output
      as `raw` and the runner's exit as `runnerExit`.
- [x] **AC9 — help, lines and citations.** No printed maven help names `/api/v2/runs/parsed` or a green-only
      coverage rule, and the module docstring names `/api/v2/runs` (the maven cases of
      `test_every_clients_help_says_regression_coverage_is_opt_in.py`); `mvn-crucible.py` holds no string
      literal beginning `ingest junit:` or `ingest parsed:`; `tests/citations-cite-by-symbol.test.ts` passes;
      `clients/_crucible_axi.py` is no longer than it was at `develop@de4ae4a`.
- [x] **AC10 — the citation floor (close-out).** `PROSE_CITATIONS.clients.head` is re-measured at the close-out
      and re-recorded once, in its own commit, by exactly the measured delta.
- *Recorded at merge:* VERIFY approved with no blocking finding. Its F3 (the maven and python rows of
  `DN-crucible-api-reconstruction.md` §4 still named the parsed route) and F4 (two test headers named maven's old
  route without the "deleted since" note python's carried) were fixed in their own cycle (808, user ruling). F1
  (a connection reset at the ingest escapes the shared transport, in every client) and F2 (the run emitter written
  three times, maven's `_emit_run_axi` beside python's and bun's) move into CR-CRU-221 (user ruling). AC10:
  `PROSE_CITATIONS.clients.head` 856 → 835, the 21 CR literals of maven's deleted and rewritten bodies.
  `mvn-crucible.py` closed at 2,702 lines (2,914 before); `_crucible_axi.py` held at 9,997. `test` now sends
  every surefire directory it reads, as §S1's table says (a filing run reads its own directory). VERIFY's F5
  (Model B's `crucible-report-java` skill still describes the parsed route and green-only coverage) and F6 (the
  plain verbs' canned help after a failed ingest, python's alike) go to the 0.4.0 notice and stand.

## Non-goals

- The rust and arduino clients (CR-CRU-219, CR-CRU-220).
- The board's side (CR-CRU-152, CR-CRU-207), the shared ingest (CR-CRU-204, CR-CRU-218), and retiring
  `/api/v2/runs/parsed`.
- The comment citations of maven's `_parse_junit` in the rust and arduino clients: CR-CRU-219 and CR-CRU-220
  delete those comments with their own parsers.
- A run's live test stream: CR-CRU-200 to CR-CRU-203.
