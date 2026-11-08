# CR-CRU-203 — the arduino runner streams its tests, and maven shows its console live

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200, CR-CRU-201, CR-CRU-225 ·
**Status** PENDING — filed 2026-10-20; made exact at gap analysis 2026-11-08 (user rulings 2026-11-08;
design in `DN-crucible-live-test-progress.md`) · Pre-review: due — user rulings; 13 points; the make
contract another project consumes

## Problem

An arduino run and a maven run show nothing on their open run until the runner exits.

- **arduino.** The client runs `make <target>` in the project's native test dir and files the
  `TEST-*.xml` the project's harness writes into `REPORTS_DIR`.
  - The harness is the project's own: Crucible ships none. Its make contract asks only for
    Unity-style verdict lines on stdout, and for JUnit.
  - The verdict lines feed a heartbeat narration and nothing else.
  - Measured: a C++ harness writing to a pipe delivers every line at exit, because stdio buffers in
    blocks.
- **maven.** Surefire's console states, while maven runs:
  - each class as it starts;
  - each class's counts as it ends;
  - each failed or errored test, by name, with its message.

  The client reads only the `Running <class>` lines, for a heartbeat narration (`running N/M
  classes`). Measured on real surefire 3.2.5 and 3.5.4 (`mvn -B`), the two print identical lines:

  ```text
  [INFO] Running demo.BetaTest
  [INFO] Running demo.BetaTest$Inner
  [INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.004 s -- in demo.BetaTest$Inner
  [INFO] Tests run: 0, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.535 s -- in demo.BetaTest
  [INFO] Running demo.AlphaTest
  [ERROR] Tests run: 4, Failures: 1, Errors: 1, Skipped: 1, Time elapsed: 1.514 s <<< FAILURE! -- in demo.AlphaTest
  [ERROR] demo.AlphaTest.bad -- Time elapsed: 0.006 s <<< FAILURE!
  org.opentest4j.AssertionFailedError: two is not three ==> expected: <2> but was: <3>
  [ERROR] demo.AlphaTest.boom -- Time elapsed: 0.001 s <<< ERROR!
  [ERROR] Tests run: 6, Failures: 1, Errors: 1, Skipped: 1
  ```

  - A nested class reports on its own line, and its outer class then reports 0.
  - The last line is a module summary with no `-- in`.
  - Maven states no total in advance.

## Scope

- **§S1 — an arduino target's stream is its record.**
  - A project declares an arduino run's stream in the one `[targets.<name>]` vocabulary (CR-CRU-225,
    CR-CRU-233), keyed by the make target.
  - The make contract hands the stream file to `make` in `CRUCIBLE_STREAM`, bun's stream variable.
  - The project's harness appends `crucible-events` lines to that file as each test ends.
  - The client relays the file to the open run, and the run is recorded from it.
  - The JUnit reports stay on disk.
  - How a project's harness comes to write the stream is the project's concern: Model B manages
    project templates.
- **§S2 — a maven target's console reaches its open run.**
  - A project declares a maven run's console view in the same vocabulary, keyed by the verb's tier.
  - The client relays maven's console to the open run under a new `surefire-console` view codec,
    which reads it on the board.
  - The record stays maven's JUnit reports (DN: console-only runners).
- **§S3 — maven's heartbeat narration retires.** A maven run no longer heartbeats `running N/M
  classes`. Its open run carries the live view, and the agent's card follows its streaming run
  (CR-CRU-236), as rust's retired in CR-CRU-233.

## Design (user rulings 2026-11-08)

### The arduino declaration

The declaration lives in the project's own `crucible.toml`, one table per make target:

```toml
[targets.junit]
framework = "arduino-native"
stream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }
```

- **Undeclared:**
  - a make target with no entry, or a project with no `crucible.toml`, runs exactly as today: JUnit
    filed at exit, no stream;
  - only a declared target streams.
- **Refused before anything runs:**
  - a `framework` other than `arduino-native`;
  - a `codec` other than `crucible-events`;
  - a `path` other than `env:CRUCIBLE_STREAM`;
  - `junit`, `console` or `coverage` keys on the entry. Coverage follows the verb (`--coverage`), as
    today.
  - The refusal names the table and the field. A file that does not parse is refused as well.
- **The stream file:**
  - It is `<REPORTS_DIR>/crucible-events.ndjson`, emptied before `make` spawns.
  - Every binary the target runs appends to it.
  - A `run-end` line is optional. A run with several binaries cannot state one in advance, so the
    run's counts are the sum of its `test-end` lines.

### The maven declaration

The declaration lives in the project's own `crucible.toml`, one table per tier verb (`unit`,
`module`, `integration`, `e2e`, `regression`), and `test` reads the `unit` entry:

```toml
[targets.regression]
framework = "surefire"
junit = "flag"
console = "surefire-console"
```

- **Undeclared:** a verb with no entry runs exactly as today, with no relay.
- **Refused before anything runs:**
  - a `framework` other than `surefire`;
  - a `console` other than `surefire-console`;
  - a `stream` key: maven has no structured stream, which is a non-goal.
  - The refusal names the table and the field.
- **Relay only on a board that reads it:** a declared run whose board's health lists no
  `surefire-console` view codec runs unrelayed and carries one warning, as bun's console relay does.

## Acceptance criteria

### arduino

- [ ] **AC1 — a declared target's tests reach the open run one by one.**
  - On `test`, every tier verb and `pre-merge-gate`, a run whose make target is declared gets these
    steps:
    1. The client empties the stream file.
    2. It runs `make <target>` with `CRUCIBLE_STREAM` set to that file's absolute path, alongside
       `REPORTS_DIR` (and `COVERAGE_DIR` on a coverage run).
    3. It relays the file to the open run under `crucible-events` while `make` runs.
  - A harness that appends a `test-end` line per test, with a delay between tests, shows each test on
    the open run before the next one ends. This is proved with a real `g++` harness in the client
    suite.
- [ ] **AC2 — the stream is the record, and it matches the JUnit.**
  - The run is closed from its stream, and no JUnit is sent for it.
  - Its stored counts and its failures (by suite, name and message) equal what the target's JUnit
    reports for the same run would store. This is proved on one real run with passes, a failure, and
    an ignored test across two binaries.
- [ ] **AC3 — a declared target whose harness writes no stream is refused, not hidden.**
  - Suppose `make` exits and the stream file is empty, while `REPORTS_DIR` holds `TEST-*.xml`. Then
    the run is filed from the JUnit, and one warning names the declared target and the empty stream.
    The exit follows the runner's.
  - With neither a stream nor JUnit, the run is "ran nothing", as today.
- [ ] **AC4 — the declaration is read and refused as specified.** This covers every refusal listed in
  "The arduino declaration", each before the board, the lock or `make`. An undeclared target behaves
  exactly as before this CR, with the same posts and the same envelope.
- [ ] **AC5 — the make contract is written down.**
  - The client's `--help` make contract names `CRUCIBLE_STREAM`, the `crucible-events` line shape
    (`test-end` with `name`, `suite`, `status` and `failure`; an optional `run-end`), and the append
    rule.
  - `clients/crucible.toml`'s commented reference names the arduino entry.

### maven

- [ ] **AC6 — a declared verb's console reaches the open run.**
  - On `test`, every tier verb and `pre-merge-gate`'s regression, a run whose verb is declared relays
    maven's combined console to the open run under `surefire-console` while maven runs.
  - The open run's live view shows each class's counts as the class ends, and each failed or errored
    test as its line arrives.
  - With no `surefire-console` in the board's health, the run is unrelayed and carries one warning.
  - An undeclared verb relays nothing, with the same posts as before this CR.
- [ ] **AC7 — the `surefire-console` view codec reads surefire's lines.** Registered in `viewCodecs`
  only, never as a report codec, it reads:
  - **a line ending `-- in <class>`:** completed += run; failed += failures + errors; pending +=
    skipped; passed += run − failures − errors − skipped;
  - **a summary line with no `-- in`:** read as nothing;
  - **`<class>.<method> -- Time elapsed: … <<< FAILURE!` or `<<< ERROR!`:** one failure, its suite
    the class, its name the method, and its message the first non-blank line after it;
  - **`Running <class>`:** the current file.

  It also:
  - resumes across batch boundaries;
  - never re-reads a decoded byte;
  - is proved on real captures from surefire 3.2.5 and 3.5.4, kept as fixtures, that cover a nested
    class, a failure, an error, a skip and a two-module reactor.
- [ ] **AC8 — maven's record is unchanged.** A relayed maven run stores exactly what the same run's
  JUnit reports stored before this CR: its counts, its failures and its coverage.
- [ ] **AC9 — the declaration is read and refused as specified.** This covers every refusal listed in
  "The maven declaration", each before the board, docker or maven.
- [ ] **AC10 — maven's heartbeat narration is gone.**
  - No maven run posts a narration heartbeat.
  - The narrator and its `Running` line reader are removed, along with any code only they used.

### both

- [ ] **AC11 — every caller is kept green.** Every test in both suites (bun `tests/*.ts` and
  `tests/client/*.py`) that drives `arduino-crucible.py` or `mvn-crucible.py` passes, its call
  sequence re-pinned only where this CR changes what a run posts. At gap analysis there were 76 files
  for arduino and 71 for mvn.
- [ ] **AC12 — the docs name the declarations.** The CHANGELOG's `[Unreleased]` names:
  - the two declarations;
  - the `CRUCIBLE_STREAM` make contract;
  - the `surefire-console` codec;
  - the retired maven narration.

  These go under "Stack declaration changes" in the release notes to Model B.

## Non-goals

- A JUnit Platform listener for maven, which would be a structured maven stream.
- Shipping a native harness, and how any project's harness adopts the stream. Model B manages project
  templates.
- A total in advance for either stack: neither runner states one.
