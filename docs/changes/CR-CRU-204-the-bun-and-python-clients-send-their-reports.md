# CR-CRU-204 — the bun and python clients send their runners' reports and parse nothing

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-152, CR-CRU-207, CR-CRU-208 · **Status**
PENDING — filed 2026-10-27 (split from CR-CRU-152 at its gap analysis, user ruling; maven, rust and
arduino are CR-CRU-206)

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
  the `<testcase>` elements, and those carrying no `<skipped>` — which decide "ran nothing", bun's
  filter check and the exit code before any ingest. A bun `rawReport` target keeps its Playwright
  result count (`_raw_report_result_count`) until CR-CRU-201 retires that report. Every figure the
  client reports or stores comes from the board's response. With no board there are no figures: the
  run reports it could not file, and a gate counting it is not green.
- **Reports travel inline** in the request body, `raw` included.
- **The client refuses an oversized body before sending**, from the limit health advertises.

## Steps

### §S1 — one shared ingest

`_crucible_axi.py` gains the one function that posts a run's reports. It reads the board's health
first and:

- refuses, naming the board's version and CR-CRU-152, when health carries no `codecs` or lacks a
  codec the run needs, and sends nothing;
- refuses, naming `ingest_body_bytes` and its value, when the body it would send is larger than
  health's `limits.ingest_body_bytes`, and sends nothing;
- otherwise sends `POST /api/v2/runs` with `codec`, `data` (each report file's text, in path order),
  `coverage: {codec, data}` when the run measured coverage, `raw` (the captured runner output), and
  `stack`, `tier`, `context`, `runId`, `release` and `runnerExit` (CR-CRU-208) as today.

It returns the response; a 413 is reported naming `ingest_body_bytes`. Health that carries `codecs`
but no `limits` is read as no limit advertised: the client sends, and a 413 is still reported. The
second count of the Design is a new shared function, `junit_non_skipped_count`;
`junit_testcase_count` keeps its return type, so the maven and rust clients that call it are
untouched until CR-CRU-206. CR-CRU-206 moves the other three clients onto the same ingest.

### §S2 — every report-ingesting verb of the bun and python clients uses it

- **bun** (`bun-crucible.py`): `test`, `unit`, `module`, `integration`, `e2e`, `regression`, `bdd`,
  `auto-ingest`, and the suites `pre-merge-gate` runs. `codec: "junit"`; coverage `lcov`. A target
  declaring `crucible.rawReport` sends its declared codec's report as `data`, inline (not
  `dataPath`), and its coverage when measured; the `raw-report-carries-no-coverage` warning
  retires.
- **python** (`python-crucible.py`): the same verbs. `codec: "junit"`; coverage `lcov` after
  `coverage lcov`. A pytest run is invoked with its JUnit suite name pinned to `pytest`, so the
  board's grouping rule (CR-CRU-152 §S2) holds.

Every verb but `auto-ingest`, which runs nothing, sends its captured runner output as `raw`.

### §S3 — the client parsers go

The bun client's JUnit parse, lcov summation, console-to-leaf matching and load-error reading
(CR-CRU-208 §S3 — it moves into the board's `src/codecs/bun-console.ts`, so a file bun names under
`# Unhandled error between tests` still becomes a failing case), and the python client's
JUnit parse, classname grouping and lcov summation are deleted; their cases live in CR-CRU-152's
server tests. The client tests that pinned them, or that stub an ingest response with no `run`
block, are retired, re-pointed at the board or given a `run` block, each such test change in its own
commit:

- bun- or python-only: `tests/clients-bun-crucible.test.ts`'s console cases,
  `tests/client/test_cr087_*`, `test_cr088_*`, `test_cr040_*`;
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
advertised limit) or cannot reach the board carries no figures and says why.

## Acceptance criteria

- [ ] **AC1 — every verb, both clients.** For each verb §S2 names, in each of `bun-crucible.py` and
      `python-crucible.py`, the run's ingest is one `POST /api/v2/runs` through the shared function,
      with `codec` and the report texts inline; neither client posts to `/api/v2/runs/parsed` or
      sends `dataPath`. A census test enumerates the verbs per client and asserts the route and the
      call site.
- [ ] **AC2 — coverage as its report.** A coverage run of each client sends `coverage: {codec:
      "lcov", data}`, a bun `rawReport` target's included, and no `raw-report-carries-no-coverage`
      warning remains; the coverage line on stderr reads the response's coverage.
- [ ] **AC3 — the same figures.** Each of CR-CRU-152's bun and python fixtures, ingested by this
      CR's client, stores the counts, statuses and coverage of its `expected.json`.
- [ ] **AC4 — no parser left.** Neither client module defines a JUnit, lcov or console parse or a
      classname grouping; a source scan asserts it, exempting only `junit_testcase_count`,
      `junit_non_skipped_count` and `_raw_report_result_count`.
- [ ] **AC5 — local decisions.** "Ran nothing" and bun's filter check come from the runner's exit
      code and the two counts only, and the verb's exit from CR-CRU-208's `verb_exit` over the runner's
      exit and the board's response, asserted per client on a run that ran nothing, a
      bun filter that matched nothing (`bun test -t <no match>` writes skipped testcases), and a run
      with a failure.
- [ ] **AC6 — the envelope reads the response.** Each client's envelope `run:` block equals the
      response's `run` block on a fixture run, `files` included, and a `report-skipped` or
      `coverage-dropped` warning from the board appears in the envelope's `warnings[]`.
- [ ] **AC7 — no board, no figures.** With the board unreachable at the ingest, each client's
      envelope carries no figures and says the run was not filed, and `pre-merge-gate` reports that
      suite unreported and is not green.
- [ ] **AC8 — an older board.** Against a board whose health carries no `codecs`, or whose `codecs`
      lack one the run needs, each client refuses to ingest, naming the board's version and
      CR-CRU-152, and sends nothing; against health with `codecs` but no `limits`, it sends.
      `junit_testcase_count` still returns an `int`, and the maven and rust clients' "ran nothing"
      holds unchanged.
- [ ] **AC9 — too large.** A body over the advertised `ingest_body_bytes` is refused by the client
      before sending, naming the limit; a 413 from the board is reported naming it; in both the run
      is not filed.
- [ ] **AC10 — raw.** Each verb of §S2 but `auto-ingest` sends its captured runner output as `raw`.
- [ ] **AC11 — pytest's suite name.** A pytest run through the python client invokes pytest with its
      JUnit suite name pinned to `pytest`.
- [ ] **AC12 — this repo's own runs.** A run of this repo's bun suite and of its python suite
      through their clients stores `codec: "junit"` with the counts the runner printed.

## Non-goals

- The board's side: CR-CRU-152 and CR-CRU-207.
- The maven, rust and arduino clients: CR-CRU-206.
- Retiring `/api/v2/runs/parsed`: installed clients elsewhere still post to it.
- A run's live test stream: CR-CRU-200 to CR-CRU-203.
