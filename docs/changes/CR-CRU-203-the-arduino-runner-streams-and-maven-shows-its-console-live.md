# CR-CRU-203 — the arduino runner streams its tests

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200, CR-CRU-225 ·
**Status** PENDING — filed 2026-10-20; made exact at gap analysis 2026-11-08; pre-review folded
2026-11-08 (user rulings 2026-11-08). Maven's live console split out to CR-CRU-237 · Pre-review:
ran — 13 points and user rulings (17 findings; the arduino ones folded, maven's to CR-CRU-237)

## Problem

An arduino run shows nothing on its open run until `make` exits.

- The client runs `make <target>` in the project's native test dir (`--dir`), and files the
  `TEST-*.xml` that the project's harness writes into `REPORTS_DIR`.
- The harness is the project's own; Crucible ships none. The make contract asks only for Unity-style
  verdict lines on stdout and for JUnit.
- The verdict lines feed a heartbeat narration, and nothing else. A harness that prints other lines,
  such as `  ok   <name>`, is not narrated at all.
- Measured: a C++ harness writing to a pipe delivers every line at exit, because stdio buffers in
  blocks.

## Scope

- **§S1 — a declared target's stream is its record.**
  - A project declares an arduino run's stream in the one `[targets.<key>]` vocabulary (CR-CRU-225,
    CR-CRU-233), keyed by native dir and make target.
  - The make contract hands the stream file to `make` in `CRUCIBLE_STREAM`, bun's stream variable.
  - The project's harness appends one `crucible-events` `test-end` line per test, as each test ends.
  - The client relays the file to the open run, and the run is recorded from it.
  - When `make` exits, the client appends the `run-end`, stating the totals of the run's own
    `TEST-*.xml`. The board's completeness check then compares the stream with the JUnit (DN:
    Completeness, "the runner's own totals").
- **§S2 — the contract is Crucible's; adoption is not.** How a project's harness comes to write the
  stream is the project's concern: Model B manages project templates.
- **§S3 — the DN is amended.** Arduino's runner is the project's own harness, writing
  `crucible-events` under the `CRUCIBLE_STREAM` make contract. Crucible does not own it.

## Design (user rulings 2026-11-08)

### The declaration

The declaration lives in the project's own `crucible.toml`. Its key is the native dir (`--dir`),
relative to the project dir (`--project-dir`, the dir holding the project's `.env` and
`crucible.toml`), joined by `/` to the make target. Sheetal's project dir is `sheetal-firmware/`:

```toml
[targets."tests/native/junit"]
framework = "arduino-native"
stream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }
```

**Fields:**

| Field | Allowed | Default |
| --- | --- | --- |
| `framework` | `arduino-native` | required |
| `stream.codec` | `crucible-events` | required |
| `stream.path` | `env:CRUCIBLE_STREAM` | required |
| `junit`, `console`, `coverage` | refused | — |

- **Coverage** follows the verb (`--coverage`), as today.
- **Undeclared:** a native dir and target with no entry, or a project with no `crucible.toml`, runs
  exactly as today: the JUnit is filed at exit, there is no stream, and the Unity narrator runs.
- **Other stacks' entries:** an entry whose `framework` is another stack's (`nextest`, `surefire`, a
  bun framework) is skipped, not refused. The same file holds every stack's `[targets.*]`.
- **Refused before anything runs:**
  - when an entry under the run's own key names a wrong `framework`, `codec` or `path`, or declares a
    refused key;
  - when the project's file does not parse.

  The refusal names the table and the field.
- **Refused on a board that cannot read it:**
  - a declared target on a board whose health lists no `crucible-events` under `codecs.stream`;
  - a declared `--coverage` run on a board that lists no `lcov`.

  Both are refused before `make`, as rust's are. An unreadable health refuses nothing.
- **Every refusal comes before any board call, the `arduino-cli` compile, and `make`.** This includes
  `pre-merge-gate`, which checks the declaration before its compile step.

### The make contract (stream)

- `CRUCIBLE_STREAM` is the absolute path of `<REPORTS_DIR>/crucible-events.ndjson`.
  - The client empties the file before `make` spawns.
  - The variable is set only on a run with an agent, where `REPORTS_DIR` is the client's. When it is
    unset, the harness writes nothing.
- The harness opens the file in append mode. It writes each line in one write and flushes after each
  line, because several binaries, possibly under `make -j`, append to the same file.
- **One line per test:**

  ```json
  {"event":"test-end","suite":"…","name":"…","status":"pass|fail|pending","duration_ms":…,"failure":{"message":"…"}}
  ```

  `status` is one of `pass`, `fail` or `pending`, and Unity's `IGNORE` is `pending`.
- The harness writes no `run-start` and no `run-end`. The client writes the `run-end`.
- The harness still writes its `TEST-*.xml` into `REPORTS_DIR`, as today.

### What a declared run does

1. It sends the declared `framework` (`arduino-native`) with its run.
2. It narrates through the shared stream-counted heartbeat, counting the stream's `test-end` lines.
   It never uses the Unity narrator.
3. After `make` exits, it appends the `run-end` if the run's `TEST-*.xml` exist, stating their totals.
   This happens before the relay's last flush.
4. It is closed from its stream. On `regression --coverage` and `pre-merge-gate`, the close carries
   the `lcov` from `COVERAGE_DIR`.

## Acceptance criteria

- [ ] **AC1 — a declared target's tests reach the open run one by one.**
  - On `test`, every tier verb and `pre-merge-gate`, a declared run gets these steps:
    1. The client empties the stream file.
    2. It runs `make <target>` with `CRUCIBLE_STREAM` set beside `REPORTS_DIR` (and `COVERAGE_DIR`
       on a coverage run).
    3. It relays the file under `crucible-events` while `make` runs.
  - A real `g++` harness that writes the file through `fopen`/`fflush`, with a delay between tests,
    shows each test on the open run before the next ends.
  - The heartbeat counts the stream's `test-end` lines.
  - With no `--agent`, `CRUCIBLE_STREAM` is unset.
- [ ] **AC2 — the stream is the record, and the JUnit checks it.**
  - A green declared run with two binaries exits 0 and is stored without `incomplete`.
  - Its counts and failures (by suite, name and message) equal what its JUnit would store.
  - Its stored framework is `arduino-native`.
  - A stream whose test count differs from its JUnit's is stored flagged incomplete.
  - Proved on one real run with passes, a failure and an ignored test across two binaries.
- [ ] **AC3 — coverage rides the close.**
  - A declared `regression --coverage` or `pre-merge-gate` closes its stream with `COVERAGE_DIR`'s
    `lcov`. The stored coverage equals the same run's coverage from the JUnit path.
  - With no lcov, the run carries the existing `coverage-not-measured` warning.
- [ ] **AC4 — a crash is filed red and incomplete.**
  - A binary killed by SIGSEGV after k tests is filed red from its stream. The record holds:
    - the k tests;
    - the `exit <n>` leaf;
    - the incomplete flag: no `run-end` is written, because the crashed binary left no complete JUnit
      set. A cut last line counts as undecodable.
  - Later binaries that never ran are absent.
  - Proved with a real `g++` harness.
- [ ] **AC5 — a declared run with no stream is not hidden.**
  - **Nothing held:** when the board holds no `test-end` (the file is empty, or the relay stopped),
    the run is filed from its `TEST-*.xml` if there are any. It carries one warning naming the
    declared key and the missing stream, and the exit follows the runner's.
  - **Build failure:** a failure to build the test binary gives the no-report envelope, as today, with
    no compile ingest.
  - **Narrowed run:** a narrowed run (`--tests`/`--name`) whose stream holds no `test-end` is aborted
    as having run nothing. The narrowing warnings still read the JUnit when it is present.
  - **No open run:** when the board opens no run, the run is filed single-shot from its JUnit, as
    today, with one warning.
- [ ] **AC6 — the declaration is read and refused as specified.**
  - Every refusal in "The declaration" is covered, each before any board call, the `arduino-cli`
    compile and `make`.
  - This includes the board-health refusals and two native dirs that each have a `junit` target,
    only one of them declared.
  - Another stack's entry is skipped.
  - An undeclared target behaves exactly as before this CR, with the same posts, the same envelope
    and the Unity narration.
- [ ] **AC7 — the make contract is written down.**
  - The client's `--help` make contract states:
    - `CRUCIBLE_STREAM`;
    - the `test-end` line shape and its statuses;
    - the append, one-write and flush rule;
    - that there is no `run-start` or `run-end`;
    - that an unset variable means write nothing.
  - `clients/crucible.toml`'s commented reference names the arduino entry and its key.
- [ ] **AC8 — every caller is kept green.**
  - Every test in both suites (bun `tests/*.ts` and `tests/client/*.py`) that drives
    `arduino-crucible.py` passes. At gap analysis there were 76 files. A test's call sequence is
    re-pinned only where this CR changes what a run posts.
  - Every test of the shared module passes.
  - Any growth of `_crucible_run.py` or `_crucible_axi.py` re-records `SHARED_MODULE_LINE_BUDGETS`
    in all three files that pin it, in the same change.
- [ ] **AC9 — the docs follow.**
  - The DN's lines that call arduino a runner Crucible owns are amended (§S3).
  - The CHANGELOG `[Unreleased]` names the declaration and the `CRUCIBLE_STREAM` make contract, under
    "Stack declaration changes" for the release notes to Model B.

## Non-goals

- Shipping a native harness, and how any project's harness adopts the stream. Model B manages
  project templates.
- Maven's live console. That is CR-CRU-237.
- A total stated in advance. Several binaries cannot state one.
