# CR-CRU-215 — a rust regression test writes its report during the run it files

**Type** fix · **Points** 2 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** DONE — merged 2026-10-29 (plan 217, cycles 795–796,
gate 9277/0: bun 4226/0, python 5051/0); filed 2026-10-29 (found by CR-CRU-204's scoped re-gate; user ruling: a
patch CR into 0.4.0, sequenced after CR-CRU-204)

## Problem

CR-CRU-212 made the rust client's plain regression file only a report its own run wrote:
`_written_since` in `clients/rust-crucible.py` accepts the nextest `junit.xml` when its mtime is at or after
the run's start, floored to the whole second (`os.path.getmtime(path) >= int(started)`), and otherwise
reports that no report was written by this run.

Some tests write that report **before** the run, then drive the regression with a fake `cargo` that writes
nothing. They pass only while the fixture write and the run's start fall in the same wall-clock second.
Between them the test registers its agent and spawns the client, so under load the gap crosses a second
boundary and the report is refused: the client aborts the run it opened, and the test reads that aborted run,
which has no `summary`.

Measured 2026-10-29:

- `tests/clients-rust-mvn-crucible.test.ts`, the CR-CRU-050 site 2 `workspace-regression` case
  (`expect(event.summary?.total).toBe(3)`, received `undefined`), failed CR-CRU-204's scoped re-gate on
  cycle 793 and passed in its full gate an hour earlier on the same code;
- `tests/client/test_client_tier_stamping.py`'s `RustEarnedTierTest`
  (`test_rust_regression_ingests_the_workspace_run_as_regression`) failed twice that day with "no junit.xml
  written by this run" and passed on re-run.

The client is right; the tests set the report up outside the run they file.

## Design

The fake runner writes the report. A test that drives a rust run expected to file a nextest report writes
that report from its fake `cargo`, during the run, instead of before it — the report the client reads is then
one its own run wrote, as CR-CRU-212's rule requires. The client is unchanged.

## Steps

### §S1 — the fake cargo writes the report

Every test that drives a rust run through a fake `cargo` into `_workspace_regression_run` — the one body
`workspace-regression`, `regression` and `pre-merge-gate` reach, and the one that applies `_written_since` —
and expects it to file the nextest report writes that `junit.xml` from the fake `cargo` when it runs, not
ahead of the run. Measured at gap analysis, there are exactly two:

- `tests/clients-rust-mvn-crucible.test.ts`, the CR-CRU-050 site 2 (`workspace-regression`) case;
- `tests/client/test_client_tier_stamping.py`, `RustEarnedTierTest.test_rust_regression_ingests_the_workspace_run_as_regression`.

Each reuses a writer the passing tests already have, never a third bespoke one: the python test gives its
file's shared `_FAKE_CARGO` an opt-in write of `target/nextest/<-P profile>/junit.xml` on a `nextest` call, the
shape `_RECORDING_CARGO` in `tests/client/test_rust_regression_coverage_is_opt_in.py` already has, through an
environment key restored per test with the file's others; the TS test's fake copies a fixture staged outside
`target/` into `target/nextest/ci/junit.xml`, so the skipped and failing cases it builds are kept, and the
comment on its no-op fake stops saying pre-placed reports survive untouched.

The rule itself is already pinned: `RustRegressionFilesOnlyItsOwnReportTest` in
`tests/client/test_rust_regression_coverage_is_opt_in.py` (CR-CRU-212's RED, `62b4969`) backdates a planted
report with `os.utime` and asserts it is never filed.

## Acceptance criteria

- [x] **AC1 — the report is the run's own.** In both tests §S1 names, the nextest report the client files
      is written by the fake `cargo` during the run; neither writes it before the client starts.
- [x] **AC2 — the run files what its runner wrote.** In each such test, nothing exists at
      `target/nextest/<profile>/junit.xml` when the client is started, and the run the board files carries the
      counts of the report the fake `cargo` wrote.
- [x] **AC3 — the client is unchanged.** `clients/rust-crucible.py` is untouched, and
      `RustRegressionFilesOnlyItsOwnReportTest` still passes unchanged.

- *Recorded at merge:* VERIFY approved with no blocking finding. With a 1.1 s pause forced before the run's
  start in a `/tmp` copy of the client, both tests pass and their versions at this CR's base fail as measured;
  four mutations (no write, a write ahead, in each test) each turn a test red. F1, left at the user's ruling:
  the TS case's fake writes `target/nextest/ci/junit.xml` whatever `-P` says — correct while the case relies on
  the default profile `ci`. The shared `/tmp/nai-gate.lock` the probe showed is CR-CRU-217.

## Non-goals

- Changing `_written_since` or its whole-second floor.
- Tests of the maven, bun, python or arduino clients.
- The rust client's gate lock for a project directory that is not a git repository: `_gate_lock_path` then
  resolves to the parent directory (for a scratch project under `/tmp`, the shared `/tmp/nai-gate.lock`), so
  concurrent drives can refuse each other with exit 75. A client defect of its own, not this CR's.
