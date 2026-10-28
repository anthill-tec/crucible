# CR-CRU-211 — an arduino agent runs only its own native tests

**Type** feature · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(requested by Model B, Sandesh #1489; user rulings 2026-10-28: delivered in 0.4.0, straight after
CR-CRU-210; files and names, like bun; re-scored 3 → 5 at gap analysis)

## Problem

Model B narrows the test runs its RED, GREEN and FIX agents make (CR-MDB-083, its release 1.0.0): a
phase agent runs its own tests by name, VERIFY the wider net, and only the orchestrator's pre-merge gate
runs the whole suite. Every other client can already narrow a run — python `--tests` down to one method,
rust `--crate` with `--test`/`--filter`, maven `--test Class#method` and `--module`, bun `test --tests
<files>` and `--name <pattern>`.

`arduino-crucible.py` cannot. Its `test` and `unit` verbs take only `--dir`, and run the native host
suite as `make junit` in that directory (`_run_native_tests_body`), so an arduino agent can only run a
whole tier.

The client hands the project's Makefile two declared variables — `REPORTS_DIR`, and `COVERAGE_DIR` on a
coverage run (`_make_reports_env`) — and warns when a Makefile ignores one (`_move_ignored_outputs`,
`makefile-ignored-reports-dir`). That `make` contract is written down nowhere a project would read it:
only in CR-CRU-155's spec and the client's own code; the client's printed help does not mention it.

## Design (user rulings, 2026-10-28)

- **Two narrowing flags, like bun, on arduino's `test` and `unit`:**
  - `--tests <stem> [<stem> …]` — the test files to run, by stem (`test_motor`), passed to `make` as
    `TESTS="test_motor test_pid"`; the Makefile builds and runs only those test binaries.
  - `--name <names>` — passed to `make` as `TEST_NAME`; the Makefile hands it to each test binary as
    Unity's `-f`, which runs only the tests whose name **contains** one of the comma-separated names (`*`
    ends a match). It needs the binaries built with `UNITY_USE_COMMAND_LINE_ARGS`.
  - Either may be given alone. A stem must match `[A-Za-z0-9_.-]+`; an empty flag or a malformed stem is
    refused before `make` runs. The tier verbs, `regression` and the pre-merge gate take neither and
    never narrow (bun's tier verbs take neither either).
- **The report names its test file.** The contract fixes one JUnit report per test file, named
  `TEST-<stem>.xml`, in `REPORTS_DIR`.
- **A Makefile that ignored a variable is named**, as an ignored `REPORTS_DIR` is, and the run is filed as
  today:
  - `makefile-ignored-tests` — a narrowed run produced a `TEST-<stem>.xml` for a stem not asked for;
  - `makefile-ignored-test-name` — a reported case's name contains none of `--name`'s names.
  A report not named `TEST-<stem>.xml` cannot be judged against `--tests`, and raises no warning.
- **A narrowed run that matches nothing** is today's ran-nothing failure.
- **The contract is documented in the client's printed help**: a `make` contract section naming
  `REPORTS_DIR`, `COVERAGE_DIR`, `TESTS`, `TEST_NAME` and the report-name rule; `--tests` and `--name`'s
  own help point to it.
- **Model B's arduino skill and agents** describe whole-tier runs; per user ruling, the change is
  announced in the release notes and the Model B notice.

## Steps

### §S1 — `--tests` and `--name` reach `make`

The two flags on `test` and `unit`, their validation, and `TESTS`/`TEST_NAME` in `make`'s environment
beside `REPORTS_DIR` (AC1, AC2, AC5).

### §S2 — an ignored variable is named

The two warnings, read from the reports the run produced (AC3, AC4).

### §S3 — the `make` contract is written down

The printed help's contract section (AC6).

## Acceptance criteria

- [ ] **AC1** `arduino-crucible.py test --tests test_a test_b` and `unit --tests test_a test_b` run
  `make` with `TESTS="test_a test_b"` in its environment beside `REPORTS_DIR`; a Makefile honouring it
  produces only those reports, and the run filed holds only their cases.
- [ ] **AC2** `--name stall,limit` on `test` and `unit` runs `make` with `TEST_NAME="stall,limit"`; a
  Makefile honouring it (passing `-f` to each binary) produces only the cases whose names contain `stall`
  or `limit`, and the run filed holds only those.
- [ ] **AC3** A Makefile that ignores `TESTS` produces a `TEST-<stem>.xml` for a stem not asked for; the
  run is filed and its envelope warns `makefile-ignored-tests`, naming `TESTS` and the stems not asked
  for.
- [ ] **AC4** A Makefile that ignores `TEST_NAME` produces a case whose name contains none of the names;
  the run is filed and its envelope warns `makefile-ignored-test-name`, naming `TEST_NAME`.
- [ ] **AC5** An empty `--tests` or `--name`, or a stem outside `[A-Za-z0-9_.-]+`, is refused before
  `make` runs (non-zero exit, `ok:false` envelope, nothing filed); without either flag, `test` and `unit`
  run exactly as today (no `TESTS` or `TEST_NAME` in `make`'s environment) — that half a GREEN-GUARD.
- [ ] **AC6** `arduino-crucible.py --help` carries a `make` contract section naming `REPORTS_DIR`,
  `COVERAGE_DIR`, `TESTS`, `TEST_NAME` and the `TEST-<stem>.xml` rule; `test --help` and `unit --help`
  list `--tests` and `--name`, and the tier verbs, `regression` and `pre-merge-gate` list neither.

## Non-goals

- Narrowing the pre-merge gate, `regression` or the tier verbs.
- Changing how a narrowed run is ingested.
- Building a project's Makefile: the project adopts `TESTS`/`TEST_NAME` (Model B's arduino scaffold can
  carry it).

## Release notes

- `arduino-crucible.py test`/`unit` take `--tests <stems>` and `--name <names>`, passed to the project's
  Makefile as `TESTS` and `TEST_NAME` (Unity's `-f`); a Makefile that ignores either is named in a
  warning. The client's `--help` now documents its `make` contract: `REPORTS_DIR`, `COVERAGE_DIR`, `TESTS`,
  `TEST_NAME`, one `TEST-<stem>.xml` per test file.
