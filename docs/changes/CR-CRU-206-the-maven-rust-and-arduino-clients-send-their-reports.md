# CR-CRU-206 — the maven, rust and arduino clients send their runners' reports and parse nothing

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-204, CR-CRU-208 · **Status** PENDING — filed
2026-10-27 (split from CR-CRU-152 at its gap analysis, user ruling; bun and python are CR-CRU-204)

## Problem

After CR-CRU-204 the bun and python clients send their runners' reports to `POST /api/v2/runs`
through one shared ingest, and the board decodes them (CR-CRU-152) within its bounds (CR-CRU-207).
The maven, rust and arduino clients still parse their own JUnit and coverage and post to
`/api/v2/runs/parsed`, or send a `dataPath` the board must read off its own disk.

## Design (user rulings, 2026-10-27)

As CR-CRU-204: the clients parse nothing but the runner's exit code and the two testcase counts;
every figure and warning comes from the board's response; reports travel inline; an oversized body
is refused before sending; with no board there are no figures. Maven collects JaCoCo coverage on
every coverage run; the board discards it on a red one.

## Steps

### §S1 — every report-ingesting verb uses the shared ingest

- **maven** (`mvn-crucible.py`): `test`, `unit`, `module`, `integration`, `e2e`, `regression`,
  `bdd`, `auto-ingest`, and the suites `pre-merge-gate` runs. `codec: "junit"` with the text of
  every `TEST-*.xml` in the surefire and failsafe report directories the verb reads today, across
  modules, in path order; coverage `jacoco` with the one JaCoCo CSV the client selects today
  (`target/jacoco-report/jacoco.csv`, else `target/site/jacoco/jacoco.csv`).
- **rust** (`rust-crucible.py`): `test`, `unit`, `module`, `integration`, `e2e`, `regression`,
  `bdd`, `auto-ingest`, `regression-ingest`, `workspace-regression`, `smoke-test`,
  `docker-e2e-gate`, and the suites `pre-merge-gate` runs. `codec: "junit"` (nextest); coverage
  `lcov` (llvm-cov).
- **arduino** (`arduino-crucible.py`): `test`, `unit`, `module`, `integration`, `e2e`, `regression`,
  `bdd`, `auto-ingest`, and the suites `pre-merge-gate` runs. `codec: "junit"` with every
  `TEST-*.xml` the native harness wrote; coverage `lcov`.

Every verb but `auto-ingest` sends its captured runner output as `raw` and the runner's exit as
`runnerExit` (CR-CRU-208). No verb sends `dataPath`.

### §S2 — the client parsers go

Each client's JUnit parse and coverage summation (maven's JaCoCo CSV, rust's and arduino's lcov) are
deleted. arduino's no-`--agent` run, which files nothing, prints `ran <n> testcases (<m> not
skipped); runner exit <rc>` from the two counts and exits with the runner's exit code (it printed
passed/total, failed, pending and files and exited 1 on a failure). The maven and rust callers of
`junit_testcase_count` read `junit_non_skipped_count` where CR-CRU-204's rules need it. The client
tests that pinned the parsers are retired or re-pointed at the board, each such change in its own
commit: the maven-, rust- and arduino-only test files, and these three clients' cases in the shared
files CR-CRU-204 left on `/api/v2/runs/parsed`.

### §S3 — the envelope's figures and warnings come from the board

As CR-CRU-204 §S4.

## Acceptance criteria

- [ ] **AC1 — every verb, three clients.** For each verb §S1 names, in each client, the run's ingest
      is one `POST /api/v2/runs` through the shared function, with the report texts inline; none
      posts to `/api/v2/runs/parsed` or sends `dataPath`. CR-CRU-204's census test covers all five
      clients.
- [ ] **AC2 — coverage as its report.** A coverage run sends `jacoco` (maven, the one CSV it selects,
      whether or not the run passed) or `lcov` (rust, arduino) with the report text.
- [ ] **AC3 — the same figures.** Each of CR-CRU-152's mvn, rust and arduino fixtures, ingested by
      this CR's client, stores the counts, statuses and coverage of its `expected.json`.
- [ ] **AC4 — no parser left.** No client module defines a JUnit, lcov or JaCoCo parse; CR-CRU-204's
      source scan covers all five clients.
- [ ] **AC5 — local decisions.** "Ran nothing" comes from the runner's exit code and the two counts
      only, and the verb's exit from CR-CRU-208's `verb_exit` over the runner's exit and the board's
      response, asserted per client; arduino's no-`--agent` run prints §S2's line and
      exits with the runner's exit code.
- [ ] **AC6 — envelope, warnings, no board, older board, too large.** CR-CRU-204's AC6–AC9 hold for
      each of the three clients.
- [ ] **AC7 — raw.** Each verb of §S1 but `auto-ingest` sends its captured runner output as `raw`.

## Non-goals

- The board's side (CR-CRU-152, CR-CRU-207) and the shared ingest (CR-CRU-204).
- Retiring `/api/v2/runs/parsed`.
- A run's live test stream: CR-CRU-200 to CR-CRU-203.
