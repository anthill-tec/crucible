# CR-CRU-204 — the bun and python clients send their runners' reports and parse nothing

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-152, CR-CRU-207, CR-CRU-208 · **Status**
PENDING — filed 2026-10-27 (split from CR-CRU-152 at its gap analysis, user ruling; maven, rust and
arduino are CR-CRU-206); gap analysis 2026-10-29

## Problem

CR-CRU-152 gives the board everything a client needs to hand over its runner's own reports: `POST
/api/v2/runs` takes a run's report texts, its coverage report and its captured output inline; the
`junit` codec reads each stack's report, bun's console included; the `lcov` and `jacoco` codecs
decode coverage; the response carries every figure a client's envelope reports, and `warnings[]`;
health names the codecs the board decodes. CR-CRU-207 bounds the body and advertises the limit. The
bun and python clients still parse their own reports and post to `/api/v2/runs/parsed`, so the same
semantics live twice and the stored run says `codec: "parsed"`.

## Design (user rulings, 2026-10-27)

- **The clients parse nothing** but the runner's exit code and two counts over the JUnit reports —
  the `<testcase>` elements, and those carrying no `<skipped>` — which decide "ran nothing" and bun's
  filter check before any ingest; the verb's exit is CR-CRU-208's `verb_exit`. A bun `rawReport` target keeps its Playwright
  result count (`_raw_report_result_count`) until CR-CRU-201 retires that report. Every figure the
  client reports or stores comes from the board's response. With no board there are no figures: the
  run reports it could not file, and a gate counting it is not green.
- **Reports travel inline** in the request body, `raw` included.
- **The client refuses an oversized body before sending**, from the limit health advertises.

## Steps

### §S1 — one shared ingest

`_crucible_axi.py` gains the one function that posts a run's reports. It reads the board's health
first (through the client's `_get`, as `refuse_unrunnable_scoped_gate` does) and:

- refuses, naming the health error, when health cannot be read (the board unreachable, or an
  answer that is not `ok`), and sends nothing;
- refuses, naming the board's `version` from health and the version floor that decodes the
  clients' reports (0.4.0), when health carries no `codecs` or lacks a codec the run needs, and
  sends nothing (no CR id in the string: `tests/project-namespace-tripwire.test.ts` forbids a CR
  literal at a live-code position in any client);
- refuses, naming `ingest_body_bytes` and its value, when the body it would send — the bytes
  `http_request` encodes, `len(json.dumps(payload).encode())` of the payload as `post_ingest` stamps
  it (`stack` and `release` included) — is larger than health's
  `limits.ingest_body_bytes`, and sends nothing;
- otherwise sends `POST /api/v2/runs`, through `post_ingest` (so the body's `stack` and `release`
  stamps, the abort of a run whose ingest the board refused, and the filed-run record hold as
  today), with `codec`, `data` (each report file's text, in path order),
  `coverage: {codec, data}` when the run measured coverage, `raw` (the captured runner output), and
  `stack`, `tier`, `context`, `runId`, `release` and `runnerExit` (CR-CRU-208) as today.

A refusal before sending settles the run the verb opened exactly as the no-report exit does: the
open `runId` is aborted through `abort_run` with the refusal as its reason, and the envelope carries
`run-aborted` (or `run-left-open` when the abort is refused). It returns the response; a 413 is
reported naming `ingest_body_bytes`. Health that carries `codecs`
but no `limits` is read as no limit advertised: the client sends, and a 413 is still reported. The
second count of the Design is a new shared function, `junit_non_skipped_count`;
`junit_testcase_count` keeps its return type, so the maven and rust clients that call it are
untouched until CR-CRU-206. CR-CRU-206 moves the other three clients onto the same ingest.

### §S2 — every report-ingesting verb of the bun and python clients uses it

- **bun** (`bun-crucible.py`): `test`, `unit`, `module`, `integration`, `e2e`, `regression`, `bdd`,
  `auto-ingest`, and the suites `pre-merge-gate` runs. `codec: "junit"`; coverage `lcov`. A target
  declaring `crucible.rawReport` sends its declared codec's report as `data`, inline (not
  `dataPath`), and its coverage when measured. The `raw-report-carries-no-coverage` warning retires
  in favour of one route-neutral warning, `coverage-not-measured`, carried in the envelope's
  `warnings[]` by either client whenever `--coverage` was asked and the run left no coverage report
  to send (a `rawReport` target under the `env:<VAR>` mechanism measures none; a parsed-route run
  whose lcov is missing today only prints a stderr WARN) — user ruling 2026-10-29.
- **python** (`python-crucible.py`): the same verbs. `codec: "junit"`; coverage `lcov` after
  `coverage lcov`. A pytest run is invoked with its JUnit suite name pinned to `pytest`, so the
  board's grouping rule (CR-CRU-152 §S2) holds.

Every verb but `auto-ingest`, which runs nothing, sends its captured runner output as `raw`.

The exits that file no report are unchanged: bun `test` with no `junit.xml` (a synthetic compile
ingest), bun `regression` with no report (aborted, nothing ingested), python's no-XML and
pytest-failed-as-runner exits (a compile ingest; a JUnit left behind is discarded) and its
zero-discovery exit, `ran_nothing`, and the filter aborts. None is a report ingest, so none reaches
the shared function, AC1's census classifies them as such, AC4's scan does not flag
`_ingest_compile`, and AC10 reads on the report path only.

### §S3 — the client parsers go

The bun client's JUnit parse, lcov summation, console-to-leaf matching and load-error reading
(CR-CRU-208 §S3 — it moves into the board's `src/codecs/bun-console.ts`, so a file bun names under
`# Unhandled error between tests` still becomes a failing case; after that reading the run's
summary is recomputed from the amended tree and its `files` count includes each such file, before
the board's runner rule), and the python client's
JUnit parse, classname grouping and lcov summation are deleted; their cases live in CR-CRU-152's
server tests. The two clients' module docstrings and their `--coverage` help say the reports route:
the python sentence (`REGRESSION_COVERAGE_PY_HELP`) names it, and the lcov sentence
(`REGRESSION_COVERAGE_LCOV_HELP`, shared with the arduino client until CR-CRU-206) is reworded to
hold on either route — the coverage "is filed with its results"; the printed-help tests follow.
`DN-testing-tiers-in-crucible-projects.md`'s endpoint table names `/api/v2/runs` beside the parsed route.

The shared test harness answers the health this CR reads: `tests/client/live_run_harness.py`'s
`RecordingBoard` (and each in-process `_get` stub a bun or python test installs) answers health with
`codecs: {test: ["junit", "playwright"], coverage: ["jacoco", "lcov"]}` and
`limits: {ingest_body_bytes: <n>}`, and its `/api/v2/runs` answer carries a scripted `run` block
(`passed`, `failed`, `pending`, `total`, `files`) a test sets per drive — the harness decodes
nothing — so the drives that assert envelope counts (`test_bun_test_name_filter.py`,
`test_bun_declared_test_script_runs_the_projects_runner.py`,
`test_bun_declared_script_passthrough_reaches_the_script.py`) read what they scripted; in its own
commit ahead of the client change; the maven, rust
and arduino drives through it are unaffected. A test that needs a real board spawns its own
(the `*_end_to_end.py` pattern), never the live one (CR-CRU-214).

The two source-scan censuses are extended, never exempted: `test_every_verb_that_runs_a_test_runner_is_classified.py`
(CR-CRU-208 AC4) and `test_every_ingest_states_its_stack.py` recognise the shared function as the
ingest call — handed `stack=_STACK` and `runnerExit` — so each bun and python verb still
classifies as applying; the first of them is AC1's census, extended with the route and call site
per verb, shaped per client with the maven, rust and arduino entries at their current route (so
CR-CRU-206 extends the same table).

The provenance floors `PROSE_CITATIONS` pins in `tests/project-namespace-tripwire.test.ts`
(`clients`, `src`) move with the deleted docstrings and the codec text: one re-record, in its own
commit at the close-out, as that test's own comment prescribes.

The client tests that pinned the parsers, or that stub an ingest response with no `run`
block, are retired, re-pointed at the board or given a `run` block, each such test change in its own
commit:

- bun- or python-only: `tests/clients-bun-crucible.test.ts`'s console cases,
  `tests/client/test_cr087_*`, `test_cr088_*`, `test_cr040_*`,
  `test_bun_load_error_reading_skips_a_tests_own_console_lines.py` (its case — a test's own
  flush-left `results:` line is not a file header — moves into AC13's board test, in both wire forms);
- shared by all five clients: this CR changes their bun and python cases, and their maven, rust and
  arduino cases keep passing on `/api/v2/runs/parsed` until CR-CRU-206 changes them:
  `test_client_tier_stamping.py`, `test_cr017_client_lifecycle.py`, `test_cr051_files_count_parity.py`,
  `test_a_runner_that_ran_nothing_is_a_failure.py`, `test_a_run_without_agent_files_nothing.py`,
  `test_suite_run_verbs_gain_a_cycle_flag.py`, `test_verification_runs_declare_their_release.py`,
  and the other files that post to or assert `/api/v2/runs/parsed` (a census at RED lists them).

### §S4 — the envelope's figures and warnings come from the board

A run's envelope `run:` block (`passed`, `failed`, `pending`, `total`, `files`) and the coverage line
on stderr are read from the ingest response, and the response's `warnings[]` entries join the
envelope's `warnings[]`. A run whose ingest fails, is refused (413, an older board, a body over the
advertised limit, a health read that failed) or cannot reach the board carries no figures and says why.

## Acceptance criteria

- [ ] **AC1 — every verb, both clients.** For each verb §S2 names, in each of `bun-crucible.py` and
      `python-crucible.py`, the run's ingest is one `POST /api/v2/runs` through the shared function,
      with `codec` and the report texts inline; neither client posts to `/api/v2/runs/parsed` or
      sends `dataPath`. The extended CR-CRU-208 census (§S3) enumerates the verbs per client and
      asserts the route and the call site; the no-report exits classify as filing no report.
- [ ] **AC2 — coverage as its report.** A coverage run of each client sends `coverage: {codec:
      "lcov", data}`, and the coverage line on stderr reads the response's coverage. A `--coverage`
      run that left no coverage report (a bun `rawReport` target; a missing lcov) sends no
      `coverage` block and carries the `coverage-not-measured` warning; no
      `raw-report-carries-no-coverage` warning remains.
- [ ] **AC3 — the same figures.** Each of CR-CRU-152's bun and python fixtures, ingested by this
      CR's client, stores the counts and statuses of its `expected.json`; the fixtures are failing
      runs, whose coverage the board discards, so the stored coverage object is proven on a
      passing report beside each fixture's own lcov.
- [ ] **AC4 — no parser left.** Neither client module defines a JUnit, lcov or console parse or a
      classname grouping; a source scan asserts it, exempting only `junit_testcase_count`,
      `junit_non_skipped_count` and `_raw_report_result_count`.
- [ ] **AC5 — local decisions.** "Ran nothing" and bun's filter check come from the runner's exit
      code and the two counts only, and the verb's exit from CR-CRU-208's `verb_exit` over the runner's
      exit and the board's response, asserted per client on a run that ran nothing, a
      bun filter that matched nothing (`bun test -t <no match>` writes skipped testcases), and a run
      with a failure.
- [ ] **AC6 — the envelope reads the response.** Each client's envelope `run:` block carries the
      response's `run` block's five counts (`passed`, `failed`, `pending`, `total`, `files`) on a
      fixture run, and a `report-skipped` or
      `coverage-dropped` warning from the board appears in the envelope's `warnings[]`.
- [ ] **AC7 — no board, no figures.** With the board unreachable at the ingest, or at the health
      read before it, each client's
      envelope carries no figures and says the run was not filed, and `pre-merge-gate` reports that
      suite unreported and is not green.
- [ ] **AC8 — an older board.** Against a board whose health carries no `codecs`, or whose `codecs`
      lack one the run needs, each client refuses to ingest, naming the board's `version` and the
      0.4.0 floor, and sends nothing; against health with `codecs` but no `limits`, it sends.
      `junit_testcase_count` keeps its contract (an `int`, or `None` for a report it cannot read),
      and the maven and rust clients' "ran nothing" holds unchanged.
- [ ] **AC9 — too large.** A body over the advertised `ingest_body_bytes` is refused by the client
      before sending, naming the limit; a 413 from the board is reported naming it; in both the run
      is not filed. A refusal before sending (this one, AC8's, a failed health read) aborts the
      run the verb opened and the envelope carries `run-aborted`.
- [ ] **AC10 — raw and the runner's exit.** Each verb of §S2 but `auto-ingest` sends its captured runner
      output as `raw` and the runner's exit as `runnerExit`.
- [ ] **AC13 — bun's load errors, read on the board.** A bun run with files that failed to load (CR-CRU-208
      §S3's shapes), ingested through `/runs` with its JUnit and console, is stored with one failing case
      per such file, read by `src/codecs/bun-console.ts` before the board's runner rule; its stored
      `summary` counts those cases, the response's `files` counts their files, and no
      `runner / exit` case is stored beside them.
- [ ] **AC11 — pytest's suite name.** A pytest run through the python client invokes pytest with its
      JUnit suite name pinned to `pytest`.
- [ ] **AC12 — this repo's own runs (close-out evidence, not a test).** The CR's pre-merge gate
      runs of this repo's bun suite and of its python suite, through their clients, store
      `codec: "junit"` with the counts the runners printed, read from the board at the merge
      sign-off.

## Non-goals

- The board's side: CR-CRU-152 and CR-CRU-207 — except moving bun's load-error reading onto the board
  (AC13), which this CR carries with the client's deletion of it.
- The maven, rust and arduino clients: CR-CRU-206.
- Retiring `/api/v2/runs/parsed`: installed clients elsewhere still post to it.
- A run's live test stream: CR-CRU-200 to CR-CRU-203.
