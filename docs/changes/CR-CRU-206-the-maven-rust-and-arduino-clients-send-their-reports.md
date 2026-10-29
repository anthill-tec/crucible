# CR-CRU-206 — the maven client sends its runner's reports and parses nothing

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-204, CR-CRU-208, CR-CRU-218 · **Status**
PENDING — filed 2026-10-27 (split from CR-CRU-152 at its gap analysis, user ruling; bun and python are
CR-CRU-204); re-scoped 2026-10-30 at its gap analysis (user ruling: the shared reporting first, CR-CRU-218,
then one CR per client — maven here, rust CR-CRU-219, arduino CR-CRU-220; re-scored 13 → 8). The file keeps
its first slug.

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

`test`, `unit`, `module`, `integration`, `e2e`, `regression`, `bdd`, `auto-ingest`, and the suites
`pre-merge-gate` runs, each file their report through the client's `_file_reports` — one call of the shared
`ingest_reports` (CR-CRU-218) — with `codec: "junit"` and the text of every `TEST-*.xml` in the directories
the verb reads today (`_run_read_dirs`, or the run's own `--reports` directory), across modules, in path
order. `_ingest_junit_dir`, `_ingest_parsed` and `_smart_ingest`'s choice between them are deleted; the
compile ingests (`_ingest_compile`, `_compile_fallback`) are unchanged.

A coverage run (`regression --coverage`, `pre-merge-gate`'s regression suite, `auto-ingest --coverage`)
sends `coverage: {codec: "jacoco", data}` with the text of every CSV the client selects today: each
`jacoco.csv` under the first of `target/jacoco-report/` and `target/site/jacoco/` that holds one, at the
maven root and in every module, in path order — the board sums several texts as one (`decodeCoverage`). It
is sent whether or not the run passed. A coverage run that finds no CSV sends no `coverage` block and
carries `coverage-not-measured` (`coverage_not_measured_warning`, CR-CRU-218).

Every verb but `auto-ingest` sends its captured runner output as `raw` and the runner's exit as
`runnerExit` (CR-CRU-208). No verb sends `dataPath`.

### §S2 — the client parsers go

`_parse_junit` and `_collect_jacoco` are deleted. "Ran nothing" keeps reading `junit_testcase_count`,
unchanged. `_read_declared_profile`'s POM read is not a report parse and stays. The module docstring, the
verb help and the shared `REGRESSION_COVERAGE_JACOCO_HELP` that name `/api/v2/runs/parsed` or the
green-only coverage rule say the reports route and the board's discard; the printed-help tests
(`test_every_clients_help_says_regression_coverage_is_opt_in.py`) follow. The client tests that pinned the parser, the parsed route or
`dataPath` for maven are retired, re-pointed at the board or given a `run` block in the ingest answer they
stub, each such change in its own commit: the maven-only test files, and maven's cases in the shared files
(a census at RED lists them). The provenance floor `PROSE_CITATIONS` pins for `clients`
(`tests/project-namespace-tripwire.test.ts`) moves with the deleted docstrings: one re-record, in its own
commit at the close-out.

### §S3 — the envelope's figures and warnings come from the board

As CR-CRU-204 §S4: the envelope's `run:` block (`passed`, `failed`, `pending`, `total`, `files`) and the
coverage on stderr are the ingest answer's; the answer's `warnings[]` join the envelope's; a run whose
ingest fails, is refused or cannot reach the board carries no figures and says why. The `files` count is
the board's (distinct sources: a case's `file`, else its `classname`, else its suite's name — the rule the
client applied).

## Acceptance criteria

- [ ] **AC1 — every verb.** The route census (`test_every_verb_that_runs_a_test_runner_is_classified.py`)
      maven table names, for each of `test`, `unit`, `module`, `integration`, `e2e`, `regression`, `bdd`,
      `auto-ingest` and `pre-merge-gate`, the shared ingest as its only report call site (compile sites as
      today), and it passes; no maven source position posts to `/api/v2/runs/parsed` or names `dataPath`.
- [ ] **AC2 — the reports inline.** A `module` run over a two-module reactor sends one `POST /api/v2/runs`
      whose `data` holds every `TEST-*.xml` text of both modules' surefire reports in path order; a
      `regression` run sends both surefire and failsafe texts.
- [ ] **AC3 — coverage as its report.** A `regression --coverage` run over a two-module reactor sends
      `coverage: {codec: "jacoco", data}` holding both modules' CSV texts, on a passing run and on a failing
      one; with no CSV it sends no `coverage` block and carries `coverage-not-measured`; `auto-ingest
      --coverage` does the same.
- [ ] **AC4 — the same figures.** CR-CRU-152's mvn fixture, ingested through this client against a board it
      spawns, stores the counts and statuses of its `expected.json` (`files` included); the fixture is a
      failing run, whose coverage the board discards, so the stored coverage object is proven on a passing
      report beside the fixture's two CSVs.
- [ ] **AC5 — no parser left.** CR-CRU-204's source scan (`test_a_client_parses_no_report.py`) covers
      `mvn-crucible.py`, exempting only `junit_testcase_count` and `_read_declared_profile`, and passes.
- [ ] **AC6 — local decisions.** "Ran nothing" comes from the runner's exit code and `junit_testcase_count`,
      and the verb's exit from `verb_exit` over the runner's exit and the board's answer, asserted on a run
      that ran nothing and a run with a failure.
- [ ] **AC7 — envelope, warnings, no board, older board, too large.** CR-CRU-204's AC6–AC9 hold for the maven
      client: the `run:` block is the answer's five counts and a board warning joins `warnings[]`; with the
      board unreachable at the health read or the ingest the envelope carries no figures and `pre-merge-gate`
      reports the suite unreported; an older board is refused naming its version and the 0.4.0 floor; a body
      over the advertised limit is refused before sending, and a 413 reported, both naming `ingest_body_bytes`.
- [ ] **AC8 — raw and the runner's exit.** Each verb of §S1 but `auto-ingest` sends its captured runner output
      as `raw` and the runner's exit as `runnerExit`.

## Non-goals

- The rust and arduino clients (CR-CRU-219, CR-CRU-220).
- The board's side (CR-CRU-152, CR-CRU-207), the shared ingest (CR-CRU-204, CR-CRU-218), and retiring
  `/api/v2/runs/parsed`.
- A run's live test stream: CR-CRU-200 to CR-CRU-203.
