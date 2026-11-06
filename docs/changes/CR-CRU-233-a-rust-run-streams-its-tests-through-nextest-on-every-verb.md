# CR-CRU-233 — a rust run streams its tests through nextest on every verb

**Type** feature · **Points** 13 (PROPOSED; scored at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on**
CR-CRU-202 · **Status** PENDING · Pre-review: due — 13 points; another project's surface (the `crucible.toml`
targets table Model B's scaffold writes)
- **Filed 2026-11-06**, split from CR-CRU-202 at its gap analysis (user ruling): CR-CRU-202 keeps the board's `nextest`
  codec; this CR takes the rust client's half. It gets its gap analysis when it comes up in the queue.

## Problem

- **The rust client files a report written at exit.** Each of its four test-running bodies runs nextest and files the
  JUnit report nextest writes when the run ends; the live view is a count read from nextest's human lines.
- **The board will decode nextest's stream** (CR-CRU-202), and the DN rules a structured stream the run's record
  (user ruling 2026-10-20, re-affirmed 2026-11-06), so the JUnit path goes.

## What CR-CRU-202's gap analysis measured for this CR

- **The stream:** `cargo nextest run --message-format libtest-json-plus --message-format-version 0.1` with
  `NEXTEST_EXPERIMENTAL_LIBTEST_JSON=1` writes it to stdout, the human output to stderr; the same under
  `cargo llvm-cov nextest`. The client's shared run path (`run_streamed`) merges stdout and stderr today.
- **The total:** the stream states none up front. `cargo nextest list --message-format json` under the run's own
  profile, filter and selection answers it: on `nai` (3 crates, profile `ci`, with its `default-filter`) its
  `matches` count was 1434, the run's exact total, in 0.77 s once built; ignored tests are listed as a `mismatch`
  with reason `ignored`.
- **Coverage:** `cargo llvm-cov show-env` lets `nextest list`, `nextest run` and `cargo llvm-cov report --lcov` share one
  instrumented build (measured on a scratch crate, the lcov written though a test failed); `cargo llvm-cov nextest`
  runs list-less in one command today.
- **The bodies and their verbs:**
  - `cmd_test`: `test`, `unit`, `integration`, `e2e` and a declared nextest profile's tier;
  - `cmd_regression_ingest`: `regression-ingest`;
  - `_smoke_test`: `smoke-test`, `docker-e2e-gate`;
  - `cmd_workspace_regression`: `workspace-regression`, `regression` (with and without `--coverage`),
    `pre-merge-gate`.
  - `auto-ingest` runs no tests: it files the JUnit report a nextest run outside the client left.
- **The tests:** about twenty files under `tests/client` pin the rust JUnit path (the most: agent-report isolation,
  a client parses no report, the tier run envelope, tier stamping).

## Scope (user rulings 2026-11-06; made exact at this CR's gap analysis)

- **§S1 — every test-running verb streams.** Each of the four bodies runs nextest with the stream on stdout, relays
  it to the open run with codec `nextest`, and closes the run from the stream; llvm-cov's lcov stays a final report.
- **§S2 — the total and the binary ids from `nextest list`.** Once cargo has built and before the run, the client lists
  the tests the run will run (its profile, filter, features and selection; under `show-env` for a coverage run) and
  posts the list, as nextest wrote it, to the open run (`POST /api/v2/runs/<runId>/tests`, CR-CRU-202 §S7). The board
  takes the run's total and each test's binary id from it; the client counts nothing.
- **§S3 — the declaration.** A rust project declares its targets in `crucible.toml`, in the bun table's vocabulary:
  `framework = "nextest"` and `stream = { codec = "nextest", path = "stdout" }` (a new `path` value: the runner's
  stdout). Rust projects are upgraded to declare it through Model B's scaffold, and Crucible's installer helps create
  the declaration in a project, for every stack Crucible supports, through one definition shared with Model B (user
  ruling 2026-11-06; queued to Model B as a contract request). That installer work is every stack's, not this CR's:
  this CR reads the rust table and settles the undeclared case at its gap analysis.
- **§S4 — an unsupported nextest is refused.** A nextest without `libtest-json-plus` or message-format version 0.1 is
  refused before cargo builds, naming the minimum version.
- **§S5 — the JUnit path goes.** Once the stored result is shown equal to the JUnit report's through the real client
  and real nextest on every verb, the client's JUnit filing for its streamed verbs is removed and the tests that pin
  it are re-pinned.

## Acceptance criteria

To be made exact at the gap analysis. These hold under any design:
- [ ] A rust run's tests reach the open run one by one while it runs, through the real client and real nextest, from
  each of the four bodies.
- [ ] The open run's total is the listed total, posted before the run's first result.
- [ ] The stored result equals the JUnit report's for the same run, on every verb, asserted before the JUnit path is
  removed.
- [ ] An unsupported nextest is refused before cargo builds, naming the minimum version.

## Non-goals

- The board's codec: CR-CRU-202.
- `cargo test` without nextest.
