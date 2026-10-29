# CR-CRU-215 — a rust regression test writes its report during the run it files

**Type** fix · **Points** 2 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-29
(found by CR-CRU-204's scoped re-gate; user ruling: a patch CR into 0.4.0, sequenced after CR-CRU-204)

## Problem

CR-CRU-212 made the rust client's plain regression file only a report its own run wrote:
`_written_since` in `clients/rust-crucible.py` accepts the nextest `junit.xml` when its mtime is at or after
the run's start, floored to the whole second (`os.path.getmtime(path) >= int(started)`), and otherwise
reports that no report was written by this run.

Some tests write that report **before** the run, then drive the regression with a fake `cargo` that writes
nothing. They pass only while the fixture write and the run's start fall in the same wall-clock second.
Between them the test registers its agent and spawns the client, so under load the gap crosses a second
boundary and the run is refused: the client files no run, and the test reads an event with no `summary`.

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

Every test that drives a rust regression or workspace-regression run through a fake `cargo` and expects it to
file the nextest report writes that `junit.xml` from the fake `cargo` when it runs, not ahead of the run. A
census at RED lists them (at least the two above).

## Acceptance criteria

- [ ] **AC1 — the report is the run's own.** In each test the census lists, the nextest report the client
      files is written by the fake `cargo` during the run; no such test writes it before the client starts.
- [ ] **AC2 — the race is gone.** Each such test passes when the fixture would otherwise straddle a second
      boundary: a fake `cargo` that sleeps past the next whole second before writing still files the run.
- [ ] **AC3 — the client is unchanged.** `clients/rust-crucible.py` is untouched; a report written before the
      run started is still refused, as CR-CRU-212 pinned.

## Non-goals

- Changing `_written_since` or its whole-second floor.
- Tests of the maven, bun, python or arduino clients.
