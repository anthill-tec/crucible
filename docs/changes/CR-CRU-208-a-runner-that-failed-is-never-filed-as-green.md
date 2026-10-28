# CR-CRU-208 — a runner that failed is never filed as green

**Type** fix · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** DONE — merged 2026-10-28 (plan 210, cycles 752–759, gate bun 4111/0 + python 4523/0 on the fix cycle); filed 2026-10-28
(user ruling: an urgent fix CR, sequenced straight after CR-CRU-207; re-scoped at its two pre-reviews)

## Problem

**Measured 2026-10-27/28.** A bun test file that fails to load, or throws while it is imported, is
counted by bun itself — a scratch run of three files (one passing, one importing a missing module, one
throwing at import) prints `1 pass · 2 fail · 2 errors · Ran 3 tests across 3 files` under
`# Unhandled error between tests`, and exits 1 — but bun's JUnit report holds only the passing case
(`failures="0"`). When every file fails to load, bun writes no report at all. The bun client builds its
run from the report, and with `--agent` its `test` verb exits 0 whenever the report shows no failure
and the ingest succeeded — ignoring the runner's exit — and, with no report, returns the compile
ingest's code (0 when that ingest succeeds). A pre-merge gate composes those exits and counts, so **a
gate passes while test files never ran**. CR-CRU-207's C2 did exactly this to 13 test files on its
branch (bun `13 fail · 13 errors`; ingested `87 passed, 0 failed`); VERIFY caught it in bun's log. No
merged gate was affected (CR-CRU-153, 205, 152 and 207's gate logs match bun's own summary).

The pre-review found the same hole across the fleet: every client decides its exit from the report
alone; maven falls back to a compile ingest's code when no report was written (an enforcer at
`validate`, a forked-VM crash, `-Dtest=` matching nothing); maven's `unit`/`module` exit 0 once
ingested even with failures; rust's `workspace-regression`/`regression`/`pre-merge-gate` and
`regression-ingest` exit 0 whenever the ingest succeeded — so **the rust gate passes on failing tests**;
arduino without `--agent` exits from a report directory it does not wipe. On the board-decoded routes
(rust `test`, its tier verbs, `smoke-test`, `docker-e2e-gate`, `auto-ingest`; maven `test` and
single-directory `unit`/`module`/`auto-ingest`; bun's Playwright raw report) the client holds no tree
at all before it ingests.

## Design (user rulings, 2026-10-28)

- **The board adds the case.** Every client sends the runner's exit code with each test ingest
  (`runnerExit`, on `/api/v2/runs` and `/api/v2/runs/parsed`); when it is non-zero and the run as
  decoded or posted records no failure, the board adds one failing case — suite `runner`, case
  `exit <n>`, message `the runner exited <n> but its report records no failure` — before it stores
  the run, so its counts, its verdict and its coverage discard follow. One rule, every route.
- **A verb never exits green on a failed runner.** Each verb that runs a test runner exits non-zero
  whenever the runner exited non-zero or the run it filed has a failure — with a report or without
  one; a compile ingest's code never decides it.
- **No exceptions:** a runner that fails after its tests passed — a maven build whose coverage check or
  enforcer fails, a `--cov-fail-under`, a `cargo llvm-cov` that fails after the run — is a failed run.
- **Bun's load errors are failures, one case per file.** Every file bun names under
  `# Unhandled error between tests` gets a failing case in the run the bun client files (it already
  reads bun's console); CR-CRU-204 moves this reading onto the board with the rest of bun's console.

## Steps

### §S1 — the board adds the case

`POST /api/v2/runs` and `/api/v2/runs/parsed` accept an optional `runnerExit`. When present it must be
an integer ≥ 0, else the ingest is refused with 400 `runnerExit must be a non-negative integer — run NOT
stored`, before anything is written (beside the stack check). When it is non-zero and the run records
no failure (`summary.failed` is 0 — on `/runs` after the codec, bun's console reading included, has
run), the board appends a failing suite `runner` holding the Design's case and adds 1 to the run's
`summary.total` and `summary.failed`, before the run is stored and before its hints are computed — so
its verdict, its stored counts, its coverage discard (with the `coverageDropped` hint) and the
`afterRed` hint all follow, and the response's `run` counts include it. A missing `runnerExit` changes
nothing (older clients). A run killed by a signal is sent as `128 + <signal>` (so `exit 137` for
SIGKILL), as a shell reports it.

### §S2 — every client sends `runnerExit` and exits on it

`_crucible_axi.py` gains `runner_exit_code(returncode)` (a negative `subprocess` return code — a
signal — becomes `128 + <signal>`) and `verb_exit(runner_exit, response)` — non-zero when the runner
exited non-zero, or the ingest response is not `ok` (refused, unreachable, 413), or the response's
`run.failed` is above 0. "The runner" is the process whose report the verb files, the one the client
prints as `exit=`. In each of the five clients, every verb that runs a test runner sends `runnerExit`
on its ingest, builds its envelope's `run:` counts from the ingest response's `run` (on every route,
so the board's added case shows in the envelope and in the gate's totals), and returns `verb_exit(…)`.
The bodies, each reached through the verbs named:

- **bun:** `cmd_test` and `cmd_regression` (with them `test`, `regression`, the declared tier verbs,
  `test` with a script, the Playwright raw-report route, and the suites `pre-merge-gate` runs);
- **python:** `_test_run` (through `cmd_test`: `test` and the declared tier verbs) and
  `_regression_run` (through `cmd_regression`: `regression`, `pre-merge-gate`);
- **mvn:** `_surefire_tier_run` (`unit`, `module`, declared profiles), `_failsafe_tier_run`
  (`integration`, `e2e`), `cmd_regression` (`regression`, `pre-merge-gate`) and `_test_run` (`test`),
  on both the parsed and the junit-directory routes;
- **rust:** `_test_run` (through `cmd_test`: `test`, `unit`, `integration`, `e2e`, and the declared
  nextest profiles `module`/`bdd`), `_smoke_run` (`smoke-test`,
  `docker-e2e-gate`), `_workspace_regression_run` (`workspace-regression`, `regression`,
  `pre-merge-gate`) and `_regression_ingest_run` (`regression-ingest`);
- **arduino:** `_run_native_tests` (`test`, `unit`, `regression`, declared make targets,
  `pre-merge-gate`); its no-`--agent` run, which files nothing, exits `verb_exit` over the runner's exit
  and its local summary (non-zero when the runner did or the report records a failure) until
  CR-CRU-206 removes its parse.

A run with no report keeps filing what it files today, and exits non-zero when the runner did.
`auto-ingest` runs no runner: it sends no `runnerExit` and is exempt. `ran_nothing` and bun's filter
check keep their paths and run first.

### §S3 — bun's files that failed to load

The bun client reads its captured console, in both wire forms, for each `<path>:` header followed by
one or more `# Unhandled error between tests` blocks, and adds one failing case per such file to the
tree it files: in the suite for that file (a new suite named by the path when the report has none),
case `?`, message = the first block's `error:` line, trace = every block for that file. This covers a
file that fails to load, one that throws at import, and one that rejects at import (bun counts the
last as an error, not a `fail`). This reading runs before the board's runner rule, so a load-error
case makes the run failed and no `runner / exit` case is added beside it.

## Acceptance criteria

- [x] **AC1 — bun's load errors are filed.** Real bun runs through `bun-crucible.py test --agent`
      (scratch projects: a passing file, a file importing a missing module, a file throwing at
      import, a file rejecting at import; in both console forms, `NO_COLOR=1` and `FORCE_COLOR=1`)
      file one failing case per failing file as §S3 states, beside the passing case, and the verb
      exits non-zero; a file with two error blocks gets one case (the first `error:` line, every block
      in its trace); a file whose tests ran and then rejected at import gets its case in its existing
      suite; a run where every file fails to load (bun writes no report) exits non-zero.
- [x] **AC2 — the board adds the case.** On `/runs` and `/runs/parsed`: `runnerExit` non-zero with no
      failure → the run is stored and answered with the `runner / exit <n>` case, `summary.total` and
      `summary.failed` each one higher, verdict `RED — 1 failing of <total>`, the `afterRed` hint, and
      any coverage discarded with the `coverageDropped` hint; `runnerExit` non-zero with a failure,
      `runnerExit: 0` and no `runnerExit` → unchanged; `runnerExit` of `"1"`, `1.5`, `true`, `null` or
      `-1` → 400 naming `runnerExit`, nothing stored.
- [x] **AC3 — the shared functions.** `runner_exit_code` maps 0, 1, 100 unchanged and `-9` → 137;
      `verb_exit` is non-zero exactly when the runner exit is non-zero, the response is not `ok`, or
      its `run.failed` is above 0 (a runner exiting 0 with a refused ingest exits non-zero).
- [x] **AC4 — every verb, every client.** A census built from each client's subcommand parser
      classifies every subcommand as applying the rule (naming its body function), exempt with a
      reason (`auto-ingest`, non-test verbs), or not ingesting; each applying body sends `runnerExit`
      and returns `verb_exit`. For one verb per client and per ingest route (parsed, junit-directory
      or `dataPath`, raw report), a fake runner exiting 1 with a passing-only report files a run with
      the `exit 1` case, the envelope's `run.failed`/`total` include it, and the verb exits non-zero.
- [x] **AC5 — failures exit non-zero everywhere.** For maven `unit`/`module` and rust
      `workspace-regression` and `regression-ingest`, a report recording a failure makes the verb exit
      non-zero (today: 0); a runner exiting non-zero with no report makes every client's test verb
      exit non-zero (today: maven and bun return the compile ingest's 0); arduino without `--agent`
      exits non-zero when the runner did or its report records a failure (a `make` exiting 0 over a
      failing report exits non-zero).
- [x] **AC6 — the gate.** `pre-merge-gate` over a suite whose runner exits non-zero with a
      passing-only report, and the rust gate over a failing test, are not green.
- [x] **AC7 — nothing else changes.** A run whose runner exits 0 and whose filed run has no failure is
      filed and exits exactly as before; a run that ran nothing (`ran_nothing`, bun's filter check)
      sends no ingest and exits as today. Existing tests that pinned an exit this CR changes (a fake
      runner exiting non-zero with a clean report, a failing report exiting 0) are amended, each in its
      own commit, and listed in the close-out.

- *Recorded at merge:* the rust smoke body is `_smoke_run` (both `smoke-test` and `docker-e2e-gate` reach
  it; `_smoke_test` wraps it for the latter). A board-decoded route with no counts in the response shows a
  `run` block with null figures. Rulings: a load-error case's message is bun's error text without
  `error:`, its suite `fail`; a bun file header is a `<path>:` line ending in a JS/TS module extension (a
  test that logs such a line would still read as one); `verb_exit` returns 1; `filed_summary` is shared.
  Approved test amendments: `19665c6`, `eabe85e`, `33df75c`, `cd240b3`, `ca7b96f` (two files: the maven
  tier-envelope tests and the rust smoke no-board test), `9865601`. Nits: envelope `ok` means the ingest
  was accepted, fleet-wide (rust `_smoke_run` excepted); the new test code adds 19 ruff findings of kinds
  the clients already carry; arduino without `--agent` still reads a report directory it never wipes
  (until CR-CRU-206). The gate's python half went red on a test-setup defect (a fixture passing retired
  variables) and was re-run alone on the fix cycle (user ruling).

## Non-goals

- The clients decoding nothing (CR-CRU-204, CR-CRU-206): they carry this CR's rules — the clients keep
  sending `runnerExit`, and the bun load-error reading moves onto the board's console module.
- Load-error shapes of runners other than bun beyond the exit rule.
- A new client against a board that predates this CR: the board ignores `runnerExit`, so the stored run
  reads green while the client exits red (CR-CRU-204's health check refuses such a board later).
