# CR-CRU-211 — an arduino agent runs only its own native tests

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** DONE — merged 2026-10-28 (plan 214, cycles 775–779, gate 9042/0: bun 4176/0, python 4866/0); filed 2026-10-28
(requested by Model B, Sandesh #1489; user rulings 2026-10-28: delivered in 0.4.0, straight after
CR-CRU-210; files and names, like bun; re-scored 3 → 5 at gap analysis and 5 → 8 at the spec pre-review)

## Problem

Model B narrows the test runs its RED, GREEN and FIX agents make (CR-MDB-083, its release 1.0.0): a
phase agent runs its own tests by name, VERIFY the wider net, and only the orchestrator's pre-merge gate
runs the whole suite. Every other client can already narrow a run — python `--tests` down to one method,
rust `--crate` with `--test`/`--filter`, maven `--test Class#method` and `--module`, bun `test --tests
<files>` and `--name <pattern>`.

`arduino-crucible.py`'s `test` and `unit` take no narrowing flag: they run the native host suite as
`make junit` under `--dir` (`_run_native_tests_body`), so an arduino agent can only run a whole tier.

The client hands the project's Makefile two declared variables — `REPORTS_DIR`, and `COVERAGE_DIR` on a
coverage run (`_make_reports_env`) — and warns when a Makefile ignores one (`_move_ignored_outputs`,
`makefile-ignored-reports-dir`). That `make` contract is written down nowhere a project would read it:
only in CR-CRU-155's spec and the client's own code; the client's printed help does not mention it.

Unity's own rules, read at the source (`src/unity.c`, `auto/stylize_as_junit.py`): built with
`UNITY_USE_COMMAND_LINE_ARGS` and a runner whose `main` calls `UnityParseOptions` (the runner
generator's `cmdline_args` option), a test binary's `-f NAME` runs the tests whose **name or source
file path** contains NAME (comma-separated alternatives; `*` ends a match); Unity's JUnit stylizer
writes one combined report whose cases carry the test function as `name` and the file stem as
`classname`.

## Design (user rulings, 2026-10-28; settled at gap analysis and the spec pre-review)

- **Two narrowing flags, like bun, on arduino's `test` and `unit` only:**
  - `--tests <stem> [<stem> …]` (`nargs="+"`, as bun's; a bare `--tests` is argparse's usage error) — the
    test files to run, by stem (`test_motor`), passed to `make` as `TESTS="test_motor test_pid"`; the
    Makefile builds and runs only those test binaries. A stem matches `[A-Za-z0-9_-]+` — no path, no
    extension.
  - `--name <names>` — comma-separated elements, each `[A-Za-z0-9_]+` optionally ending in `*`, passed to
    `make` as `TEST_NAME`; the Makefile hands it to each test binary as Unity's `-f`, which runs the tests
    whose name or file contains one of the elements.
  - Either may be given alone. `--dir` still chooses the native directory; stems resolve against that
    directory's Makefile. The tier verbs, `regression`, `auto-ingest` and the pre-merge gate take neither
    and never narrow (bun's tier verbs take neither either).
- **Ill-formed input is refused before anything reaches the board**: a stem or `--name` element outside
  its pattern, or an empty `--name`, raises a typed hard stop with the code `narrowing-refused` — checked
  before the run's registration heartbeat and run start, ahead of the unattributed-run refusal — giving
  one `ok:false` envelope with `error` and `help[]` ("give a stem, not a path or file name";
  "`--name` takes comma-separated test-name fragments"), exit non-zero, no POST.
- **The client owns `TESTS` and `TEST_NAME`.** On every native `make` run it removes both from `make`'s
  environment unless its own flag set them — `test`/`unit` without the flags, `regression`, the
  pre-merge gate and the declared tier verbs — so a variable exported in the shell never narrows a run,
  the gate least of all. With or without an own reports directory, the flags set them.
- **A narrowed run that ran nothing fails.** A run given either flag whose reports hold zero cases is the
  ran-nothing failure whatever `make`'s exit (Unity with a `-f` that matches nothing exits 0): the open
  run is aborted, nothing is filed, the exit is non-zero. An unnarrowed zero-case run that exits 0 is
  filed as today.
- **A Makefile that ignored a variable is named**, as an ignored `REPORTS_DIR` is; the run is filed as
  today. The judgment reads each case's file stem — its `classname` (Unity's stylizer) or `file` — which
  `_parse_junit` already reads:
  - `makefile-ignored-tests` — a case whose file stem is not among `--tests`;
  - `makefile-ignored-test-name` — a case where no `--name` element (its part before `*`) appears in the
    case's name or its file stem.
  A case whose file stem cannot be read raises no `makefile-ignored-tests`. The warnings are gathered
  before the ran-nothing check, ride every envelope the run emits, and are printed to stderr too (as
  `_ignored_contract_warning` does), so a run without `--agent` sees them.
- **The contract is documented in the client's printed help**: a `make` contract section in the root
  help, kept as written (`RawDescriptionHelpFormatter`, as bun, python and maven use), naming
  `REPORTS_DIR`, `COVERAGE_DIR`, `TESTS` and `TEST_NAME`; showing `TESTS ?=` (an environment variable
  loses to a plain assignment in the Makefile) and a quoted `-f "$(TEST_NAME)"`; stating the Unity runner
  requirement; and recommending one `TEST-<stem>.xml` per test file. `--tests` and `--name`'s own help
  point to it.
- **Model B's arduino skill and agents** describe whole-tier runs; per user ruling, the change is
  announced in the release notes and the Model B notice.

## Steps

### §S1 — `--tests` and `--name` reach `make`, and only theirs do

The two flags on `test` and `unit`, the `narrowing-refused` hard stop, `TESTS`/`TEST_NAME` set by the
flags and removed otherwise, and the narrowed ran-nothing failure (AC1, AC2, AC5, AC7, AC8).

### §S2 — an ignored variable is named

The two warnings, judged on each case's name and file stem, on every exit path (AC3, AC4).

### §S3 — the `make` contract is written down

The printed help's contract section (AC6).

## Acceptance criteria

- [x] **AC1** On `test` and on `unit`, `--tests test_a test_b` runs `make` with `TESTS="test_a test_b"` in
  its environment, with or without an own reports directory; a Makefile honouring it produces only those
  files' cases, and the run filed holds only them.
- [x] **AC2** On `test` and on `unit`, `--name stall,limit` runs `make` with `TEST_NAME="stall,limit"`; a
  Makefile honouring it produces only the cases whose name or file contains `stall` or `limit`, and the
  run filed holds only them.
- [x] **AC3** On `test` and on `unit`, a Makefile that ignores `TESTS` produces a case whose file stem was
  not asked for; the run is filed and its envelope warns `makefile-ignored-tests`, naming `TESTS` and the
  stems not asked for. A Makefile that honours `TESTS` and writes one combined report raises no warning.
- [x] **AC4** On `test` and on `unit`, a Makefile that ignores `TEST_NAME` produces a case whose name and
  file stem contain none of the elements; the run is filed and its envelope warns
  `makefile-ignored-test-name`, naming `TEST_NAME`, the elements and the first unmatched case. A Makefile
  that honours it and runs a whole file because its path matched raises no warning.
- [x] **AC5** On `test` and on `unit`, a stem with a path or an extension (`src/test_a`, `test_a.c`), a
  stem outside `[A-Za-z0-9_-]+`, an empty `--name`, or a `--name` element outside `[A-Za-z0-9_]+\*?`
  (`stall,,limit`, `a:b`, `a b`) is refused with `narrowing-refused`: one `ok:false` envelope, exit
  non-zero, no request to the board, `make` not run.
- [x] **AC6** `arduino-crucible.py --help` carries the `make` contract section, kept as written, naming
  `REPORTS_DIR`, `COVERAGE_DIR`, `TESTS` and `TEST_NAME`, with `TESTS ?=`, the quoted `-f "$(TEST_NAME)"`
  and the Unity runner requirement; by their parsed options, `test` and `unit` take `--tests` and
  `--name`, and `regression`, `pre-merge-gate`, `auto-ingest` and the declared tier verbs (`module`,
  `integration`, `e2e`, `bdd`) take neither.
- [x] **AC7** On `test` and on `unit`, a narrowed run whose Makefile exits 0 and writes a report with zero
  cases (`--name nomatch`) fails: `ok:false`, a ran-nothing warning, no ingest, exit non-zero; an
  unnarrowed zero-case run that exits 0 is filed as today (that half a GREEN-GUARD).
- [x] **AC8** With `TESTS` and `TEST_NAME` set in the client's own environment, `test` and `unit` without
  the flags, `regression`, `pre-merge-gate` and a declared tier verb run `make` with neither.

- *Recorded at merge.* Rulings in the cycles: a narrowed zero-case run reuses the ran-nothing code
  `no-test-reports`; a refusal's `help[]` carries the hint for the refused flag; `--tests` and `--name`
  together set both variables; the ran-nothing path carries neither ignored-variable warning (nothing to
  judge); a warning names the elements as given and the first unmatched case in report order. VERIFY's
  findings, fixed in cycle 779: the help states that `REPORTS_DIR`/`COVERAGE_DIR` are set only for a run
  with its own reports directory and shows their `?=` defaults; a case's file stem is judged against
  `--tests` only when a test source `<stem>.c`/`.cpp`/`.ino` exists under `--dir`, so a constant
  `classname` is never judged; a flag never lets the other shell variable through (mutant-proven). The
  first gate was cut off by a power failure and re-run in full.

## Non-goals

- Narrowing the pre-merge gate, `regression`, `auto-ingest` or the tier verbs.
- Changing how a narrowed run is ingested.
- Stale reports: a run with no own reports directory reads `<dir>/reports/TEST-*.xml`, which is never
  cleared, so an earlier run's reports can still be read (the known limitation CR-CRU-206 addresses).
- Building a project's Makefile: the project adopts `TESTS`/`TEST_NAME` (Model B's arduino scaffold can
  carry it).

## Release notes

- `arduino-crucible.py test`/`unit` take `--tests <stems>` and `--name <names>`, passed to the project's
  Makefile as `TESTS` and `TEST_NAME` (Unity's `-f`); a narrowed run that ran nothing fails; a Makefile
  that ignores either variable is named in a warning; a `TESTS`/`TEST_NAME` exported in the shell never
  reaches `make`. The client's `--help` now documents its `make` contract.
