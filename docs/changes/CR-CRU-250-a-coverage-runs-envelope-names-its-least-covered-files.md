# CR-CRU-250 — a coverage run's envelope names its least covered files

**Status:** PENDING · Pre-review: ran — another project's surface (the run envelope its agents read)
**Type:** feature
**Priority:** medium
**Depends on:** CR-CRU-193, CR-CRU-216, CR-CRU-218
**Labels:** clients, shared-modules, coverage, gate
**Phase:** design
**Design reference:** CR-CRU-193 (the board keeps a run's coverage file by file, and answers the
least covered files with the ingest); CR-CRU-218 (the one run emitter)

## Context

CR-CRU-193 makes the board keep each file's coverage with the run. Its ingest answer carries the
run's file count and its 10 least covered files, and `GET /api/v2/events/<id>?depth=coverage`
reads them all. An agent reaches none of that through its client:

- **A run's envelope.** Every client emits a run's envelope through `emit_run_axi`
  (`clients/_crucible_run.py`), which states the coverage the board kept only when its caller
  asks. Only the rust client asks. A bun, python, maven, arduino or go `regression --coverage`
  measures coverage, files it, and prints no coverage figure at all.
- **A gate's envelope.** A gate composed of several runs (`run_gate_suites`,
  `clients/_crucible_axi.py`) reads each run's envelope for its counts and its warnings, and
  drops the rest. It states no coverage.
- **The read-back verb.** `run <event-id>` (`cmd_run`, `clients/_crucible_axi.py`) reads the run
  with `?depth=suites` and states its lines percent in the brief. It reads no files.

The gate is where an orchestrator measures coverage. Today it must leave the envelope and open
the coverage tool's own report to learn which files fell.

## Scope

### §S1 — every stack's run envelope states its coverage

Each client's run wrapper passes `coverage=True` to `emit_run_axi`, as rust's does for its
coverage runs:

- `_emit_ingest_axi` in `clients/bun-crucible.py` and `clients/python-crucible.py`;
- `_emit_run_axi` in `clients/mvn-crucible.py` and `clients/arduino-crucible.py`;
- the `emit_run_axi` call of `_go_test_run` in `clients/go-crucible.py`.

`emit_run_axi` still states no `coverage` block for a run whose answer kept none, so a run that
measured no coverage, and a failing run, print as they do today.

### §S2 — the coverage block names the files

One function in `clients/_crucible_run.py` builds an envelope's `coverage` block; `emit_run_axi`
and `cmd_run` both use it.

The block keeps today's two keys: `lines` and `functions`, each the axis's percent, `functions`
absent when the run has no functions axis. When the board's answer carries the run's files, the
block gains the keys below. The files are read where CR-CRU-193 answers them:

- the ingest answer: `run.coverageFileCount` and `run.coverageFiles`, with the run's id at the
  answer's top-level `event`;
- the `?depth=coverage` read: `event.coverageFileCount` and `event.coverageFiles`.

The block's keys:

- `event`: the id of the run that kept this coverage: the ingest answer's top-level `event`, or
  the id `run` was asked for;
- `fileCount`: the run's file count;
- `moreFiles`: the files the block does not list, 0 when it lists them all;
- `files`: one row per listed file, in the board's order, least covered first. A row's keys are
  `file`, `linesPercent`, `linesCovered`, `linesTotal`, `functionsPercent`, `functionsCovered`
  and `functionsTotal`. `file` is the name as the board holds it, whole. The three function keys
  are null for a file with no functions axis.

A run's envelope lists the files the ingest answer carries: the 10 least covered. The verbs that
run tests gain no flag.

An answer that carries no files (a board older than CR-CRU-193, or a run filed with totals only)
gives the block its two percent keys alone, as today. Nothing is refused.

### §S3 — `run <event-id>` lists the run's files

- **The flag.** `add_run_read_verbs` adds `--files <n>|all` to `run`, default `10`. It is a plain
  string. It is accepted only as `all`, or as ASCII digits alone whose value is at least 1; any
  other value (`0`, `-1`, `x`, `+3`, `1_0`, ` 3 `) is refused by the verb's own envelope, exit 2,
  before any request.
- **The read.** When the `?depth=suites` answer carries `event.coverageFileCount`, `cmd_run`
  reads `?depth=coverage&files=<n>`, `<n>` the parsed integer, or `?depth=coverage` alone for
  `all`.
- **The envelope.** It carries the §S2 block as `coverage`, beside the brief: the percents from
  the event's stored coverage, and the files that read answered.
- **A read that fails** refuses the verb, exit 1, as a failed read of the failing tests does: a
  run is never printed with a file list it could not read.
- **A run without files** prints as today. `--files` then changes nothing.

### §S4 — a composed gate states each run's coverage

`run_gate_suites` keeps the `coverage` block of each run's envelope it reads: the whole-suite run
and every suite run, dispatched or run in the gate's own process.

The gate's envelope gains `coverageRuns`: one row per run whose envelope carried a `coverage`
block, in the order the runs ran. A row is `suite` (the whole-suite label, or the suite's
target), `stack`, then the block's own keys. The key is absent when no run carried a block.

A gate that is one run alone emits that run's envelope, so it carries `coverage` as any run does.

### §S5 — the shared modules' size budgets

`_crucible_axi.py` stays within its hard limit, `CORE_LINE_LIMIT` (9200) in
`tests/client/test_the_run_pipeline_lives_in_its_own_shared_module.py`, which leaves it about 40
lines. So the new logic lives in `_crucible_run.py`: the block builder, the `--files` value check,
the `?depth=coverage` read and the `coverageRuns` rows. `_crucible_axi.py` gains only the
`--files` argument and the calls into `_crucible_run.py`.

Each shared module's pinned line budget is re-recorded at its measured line count after the
branch's last content edit. `SHARED_MODULE_LINE_BUDGETS` is re-seeded at those values in the three
modules that pin it:

- `tests/client/test_arduino_client_sends_its_runners_reports.py`;
- `tests/client/test_rust_client_sends_its_runners_reports.py`;
- `tests/client/test_mvn_client_sends_its_runners_reports.py`.

### §S6 — docs

- `CHANGELOG.md` `[Unreleased]`: every stack's coverage run states its coverage and its 10 least
  covered files; `run --files`; the gate's `coverageRuns`. It names the block's keys and a file
  row's keys exactly.
- `README.md` and `docs/RUNBOOK.md`: the `coverage` block, `run --files <n>|all`, and
  `coverageRuns`.
- `docs/research/PRD-crucible-v2.md`: the bullet on the gate running every declared framework,
  which names the composed envelope's keys, gains `coverageRuns`.
- The `run` verb's help names `--files`.

## Acceptance criteria

- [ ] **AC1 — the block names the files.** Given an ingest answer with a kept coverage, a
  `coverageFileCount` of 12 and 10 `coverageFiles`, `emit_run_axi` with `coverage=True` emits a
  `coverage` block with `lines`, `functions`, `event`, `fileCount: 12`, `moreFiles: 2` and 10
  `files` rows in the answer's order, each with the seven §S2 keys.
- [ ] **AC2 — a file without functions.** A file with no functions axis has null for its three
  function keys, and a run with no functions axis has no `functions` key in the block.
- [ ] **AC3 — an answer without files.** An answer with a kept coverage and no file keys emits
  the block with its percent keys alone. An answer that kept no coverage emits no block.
- [ ] **AC4 — every stack asks.** Each client file holds exactly one `emit_run_axi` call, and
  all six ask for coverage:
  - `_emit_ingest_axi` in `bun-crucible.py` and in `python-crucible.py`, `_emit_run_axi` in
    `mvn-crucible.py` and in `arduino-crucible.py`, and `_go_test_run` in `go-crucible.py` pass
    `coverage=True`;
  - `_emit_run_axi` in `rust-crucible.py` passes its caller's `coverage`, as today.

  Each of bun, python, maven, arduino and go is proven through its client's own test harness: a
  stubbed green `regression --coverage` (and a Go `test --coverage`) against a recorded board
  answer that carries `run.coverageFileCount` and `run.coverageFiles` prints the block with its
  files. A client added after this CR that measures no coverage is not one of the six.
- [ ] **AC5 — a run that measured none is unchanged.** A run without `--coverage`, and a failing
  coverage run, print no `coverage` block on any stack.
- [ ] **AC6 — `run` lists the files.** For a stored run of 12 files:
  - `run <event-id>` carries the block with 10 rows, `fileCount: 12` and `moreFiles: 2`;
  - `--files 3` carries 3 rows and `moreFiles: 9`;
  - `--files all` carries 12 rows and `moreFiles: 0`, and its request names no `files=`.
- [ ] **AC7 — `run` refusals.** `--files 0`, `--files -1`, `--files x`, `--files +3` and
  `--files 1_0` are refused, exit 2, with no request sent. `--files 03` requests `files=3`. A `?depth=coverage` read that fails refuses the verb, exit 1, and prints
  no run.
- [ ] **AC8 — a run without files reads as before.** For a run whose `?depth=suites` answer
  carries no `event.coverageFileCount`, `run` sends no `?depth=coverage` request and its envelope is
  today's, with or without `--files`.
- [ ] **AC9 — a composed gate.** A gate of three runs, two of whose envelopes carry a `coverage`
  block, emits `coverageRuns` with two rows in run order, each with its `suite`, its `stack` and
  that run's block whole. A gate none of whose runs carried one emits no `coverageRuns`.
- [ ] **AC10 — on a real board.** A python `regression --coverage` of a fixture project that
  declares its coverage source as 12 source files, with its tests outside that source, against a
  real board:
  - prints the block with `fileCount: 12`, 10 rows and `moreFiles: 2`;
  - its rows are the first 10 files `?depth=coverage` answers for that event, in that order;
  - `run <that event> --files all` lists the 12.
- [ ] **AC11 — the budgets are re-recorded.** Each shared module's line count equals its
  re-seeded `SHARED_MODULE_LINE_BUDGETS` value in all three pinning modules, and those pass.
  `test_the_core_is_no_longer_than_its_line_limit` passes with `CORE_LINE_LIMIT` unchanged.
- [ ] **AC12 — docs and hygiene.** The §S6 texts are present, and the CHANGELOG and the PRD
  name every key of §S2 and §S4. The code and tests add no CR id literal. A CR citation on a
  touched line is kept, or `PROSE_CITATIONS` in `tests/project-namespace-tripwire.test.ts` is
  re-recorded once, as its own commit.

## Estimated size

5 points:

- the block builder and the five wrappers (2);
- `run --files` and its read (1);
- the gate's `coverageRuns` (1);
- the budgets, the real-board proof and the docs (1).

## Risk

- **Five stacks' envelopes gain a key.** A consumer that reads a bun, python, maven, arduino or
  go run's envelope by exact key set sees `coverage` appear on a coverage run. The fleet's own
  envelope tests are swept at RED.
- **Envelope size.** A coverage run's envelope grows by at most 10 rows, and a composed gate's by
  10 rows per coverage run.
- **Shared budgets in flight.** CR-CRU-241 (0.5.0) also edits `_crucible_run.py` and re-records
  the same three `SHARED_MODULE_LINE_BUDGETS`. This CR merges first, in 0.4.0; CR-CRU-241's
  budgets are then taken from the measured counts on its own branch.
- **The core's headroom.** `_crucible_axi.py` has about 40 lines under `CORE_LINE_LIMIT`. A
  change that needs more there is a finding, not a raised limit.

## Non-goals

- Any change to the board: CR-CRU-193.
- A flag on `regression` or `pre-merge-gate` to list more files: `run <event-id> --files` reads
  them.
- Uncovered line numbers, per-file thresholds, and files grouped by source root.
- A coverage total across a gate's runs.
