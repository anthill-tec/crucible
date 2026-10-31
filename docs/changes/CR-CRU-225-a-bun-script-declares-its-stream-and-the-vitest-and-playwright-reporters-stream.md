# CR-CRU-225 — a bun script declares its stream and its framework, and the Vitest reporter streams the Crucible shape

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200, CR-CRU-224, CR-CRU-201 ·
**Status** PENDING

- **Filed 2026-10-31.** Split from CR-CRU-201 at its gap analysis. User ruling: three dog-food-safe units —
  CR-CRU-201 (bun's console live view), this CR (the table and the reporters), then CR-CRU-226 (the clean break).
- **Gap analysis 2026-11-01.** User rulings:
  1. **A BDD run's test is the scenario,** carrying its Gherkin steps inside it. That lands in CR-CRU-228.
  2. **Each run carries the framework its target declares,** from this CR. The board stores it; CR-CRU-228's
     specification view keys on it, and CR-CRU-226 re-keys the `junit` codec's two stack readings off it.
  3. **This CR defines the vocabulary for every stack and implements it for bun.** The other stacks adopt it in their
     own CRs: rust in CR-CRU-202, arduino and maven in CR-CRU-203, go in CR-CRU-195, python in a CR to be filed.
  4. **The live view shows no steps** (CR-CRU-228's scope).
  5. **Split in two** (the board's points scale stops at 13): this CR is the table, the run's framework and the Vitest
     reporter; **CR-CRU-228** is the Playwright reporter, scenario-as-test with its steps, and the specification view.
     The id CR-CRU-227 is skipped because a reverted filing used it.
- **Pre-review 2026-11-01** (`CR-CRU-225-SPEC-REVIEW`): its 20 findings are folded in, named F1–F20 below where a
  choice was made. The CR sits at the top of 13 points; F4's extraction is its largest cost.

The file keeps its first slug.

**Approved by the user 2026-11-01**, with P1–P10 as proposed (no longer open):

- **P1 — the framework vocabulary.** `bun-test`, `vitest`, `playwright` and `playwright-bdd` for bun. `pytest`,
  `unittest`, `nextest`, `surefire`, `go-test` and `arduino-native` are reserved for the other stacks.
  - **Enforced by the client (F17):** the bun client refuses any framework outside the bun four.
  - **The board stays string-only,** so another stack's CR needs no board change.
- **P2 — the reporters.** They live in `clients/reporters/` (this CR adds `vitest-crucible.ts`), are installed with the
  clients, and are handed to the runner as the directory `CRUCIBLE_REPORTERS`, which the client computes as its own
  install directory's `reporters/`.
- **P3 — no double declaration.** A script declared in both `crucible.targets` and `crucible.reportPath` or
  `crucible.rawReport` is refused before anything is posted, naming both. `crucible.testScript` may name a
  table-declared script (F19).
- **P4 — migration v23** adds a nullable `framework` beside `stack` on both `events` and `runs`.
- **P5 — health lists `codecs.stream`** (F15): the record stream codecs (`crucible-events`), so a client can check a
  declared `stream` codec before the run opens. `codecs.test` is unchanged.
- **P6 — one stream variable for the shipped reporters** (F3). A bun `stream` target's `path` must be
  `env:CRUCIBLE_STREAM`; any other variable is refused, because the shipped reporters read only that one. The `path` key
  stays in the table for native streams in other stacks (nextest, go).
- **P7 — `coverage` is refused unless the target can produce it** (F16). For bun that means `lcov`, on a `junit: flag`
  target with framework `bun-test`.
- **P8 — the streamed-run close is shared** (F4). Python-crucible's streamed-run body is extracted into `_crucible_run.py`,
  and the bun client calls it: the count from the stream, zero discovery, ran-nothing, the `held == 0` compile ingest
  versus the stream close with its warning, and the unfiled answer.
- **P9 — a Vitest run states no total up front** (F2). Vitest's `onTestRunStart` receives only the files, before
  anything is collected, so its `run-start` carries no `total`. The live view shows a count with no total, and the DN's
  Totals section is amended.
- **P10 — the reporter's failures outside a test** (F6):
  - **a module that fails to load:** one failing `test-end` named `?`, with its file and the error's message;
  - **unhandled errors:** these reach the board through the runner's non-zero exit (`runnerExit`, `fileRunnerExit`),
    as for any runner.

## Problem

Vitest has a reporter API nothing uses. A bun project's script cannot declare a structured stream, and a Vitest run
reaches the board only at exit.

Nothing records which framework a run used. The run detail opens a BDD run as a specification only when its codec is
`playwright`, and the `junit` codec reads pytest's shape and bun's console by the client's stack.

## Design (user rulings 2026-10-20, 2026-10-31 and 2026-11-01; `DN-crucible-live-test-progress.md`)

### The declaration: tools per modality (the Model B contract)

- **Codecs are named by the framework or format whose output they parse, never by stack.** A project selects its codecs
  by the testing tools of each test modality it runs: unit, regression, and BDD where needed (mostly front-end and UI).
  Coverage follows the coverage tool.
- **The modality is the script's name,** by the template the client already reads (`test:<tier>`, `declared_target_name`).
  The table does not restate it.
- **One table per script:** `crucible.targets.<script>`. Each entry names:
  - `framework` *(P1)*: required;
  - the record, either `stream: {codec, path}` or `junit` (`flag` or `env:<VAR>`);
  - optionally, `console`: a view codec for a `junit` target's live view;
  - optionally, `coverage`: the coverage codec *(P7)*.

  ```json
  "crucible": {
    "targets": {
      "test:unit": { "framework": "bun-test", "junit": "flag", "console": "bun-console", "coverage": "lcov" },
      "test:vitest": { "framework": "vitest", "stream": { "codec": "crucible-events", "path": "env:CRUCIBLE_STREAM" } }
    }
  }
  ```
- **A script with no table entry keeps today's behaviour,** read as framework `bun-test`:
  - **the client's own `bun test`:** the `flag` JUnit report, the `bun-console` view where the board has it, and `lcov`
    coverage;
  - **a declared script** (`bun run <script>`, as `test:unit` is here): the report path its older keys declare, or the
    `flag` default.
- **The older keys are still read in this CR** (`crucible.reportPath`, `crucible.rawReport`, `crucible.testScript`), so
  nothing breaks mid-way. CR-CRU-226 makes the clean break.
- **Model B writes the table.** modelb-axi's project verbs implement this contract:
  - `init` offers the tools per modality for the selected stacks, and writes the table;
  - `migrate` detects a legacy project's tools and older keys, proposes a table, and confirms it with the user;
  - `update` / `agents` bring an older table to the current shape.

  The request is drafted. It waits until Model B is listening on Sandesh.

### The run carries its framework

The run start and every ingest carry `framework`, and the board stores it beside `stack`. A close that states none
inherits the start's.

### The shipped Vitest reporter

- The Vitest reporter ships inside the client install *(P2)* and emits the `crucible-events` shape to the file
  `CRUCIBLE_STREAM` names *(P6)*.
- A project's config adds the reporter from `CRUCIBLE_REPORTERS` when it is set, so it names no machine path and runs
  unchanged with no client.
- A streamed run's record is its stream (CR-CRU-200), relayed by the shared `StreamRelay` (CR-CRU-224) and closed by
  the shared streamed-run close *(P8)*.

## Steps

### §S1 — the run's framework, and health's stream codecs (board)

- **The routes.** `POST /api/v2/runs/start`, `/runs`, `/runs/parsed` and `/runs/compile` take an optional `framework`, a
  non-empty string. An empty or non-string value is a 400 that stores nothing.
- **The close** (`resolveRunClose`):
  - an ingest that closes a run states the same framework as its start, or none; a different one is a 400, as `stack`
    is;
  - a close that states none inherits the start's framework.
- **Storage** *(P4, F11)* — every site where `stack` is held gains `framework`:
  - the `events` and `runs` tables, in the base DDL and in migration v23, so a new store and a migrated one agree;
  - the timeline read (`listEvents`), which merges test runs, milestones and gates in code: only a test run carries a
    framework (RED 836: there is no SQL UNION);
  - `abortRun`, so an aborted run's event keeps its start's framework (RED 836 ruling);
  - the inserts in `startRun` and `recordTestEvent`, and the mappers (`toEvent` and the run row);
  - `runMeta`, the event brief and `openRunBrief`, which answer it wherever they answer `stack`.
- **Health** *(P5)*: `codecs.stream` lists the record stream codecs (`isRecordStreamCodec`).
- **Migration v23** adds the columns. Runs stored before it read unchanged, with no framework.

### §S2 — the `crucible.targets` table (bun client)

- **What is refused,** before anything is posted, each naming the key and `crucible.targets`:
  - an entry that is not an object, or has no `framework`;
  - a framework outside the bun four *(P1)*;
  - an entry with both `stream` and `junit`, or with neither;
  - a `stream` without `codec` or `path`, or with a `path` other than `env:CRUCIBLE_STREAM` *(P6)*;
  - a `junit` that is neither `flag` nor `env:<VAR>`;
  - a `console` on a `stream` entry, or a `console: bun-console` on a framework other than `bun-test` (F18);
  - a `coverage` the target cannot produce *(P7)*;
  - a script declared in the table and in `reportPath` or `rawReport` *(P3)*.
- **The board check.** When a run is to be opened, a codec the TABLE declares (`stream`, `console`, `coverage`) that the
  board's health does not list is refused before the run opens. A script with no table entry keeps CR-CRU-201's quiet
  fallback: no relay on a board without `bun-console` (F1). Under `--no-lifecycle` no health is read and nothing is
  checked (F20).
- **`crucible.testScript`** may name a table-declared script. A `test` run then goes through `cmd_regression(script=…)`
  and reads that script's entry (F19).
- **A `junit` target** runs as a declared script runs today, with the report path carried the declared way
  (`_declared_report_mechanism`'s rule, now also read from the table). Its `console` decides whether it relays
  (CR-CRU-201's `console_is_buns`, now read from the table).
- **A `stream` target:**
  - the client sets `CRUCIBLE_STREAM` to `<reports dir>/crucible-events.ndjson`, and `CRUCIBLE_REPORTERS` to its install's
    `reporters/` *(P2)*;
  - the reports dir's wipe removes the old stream file;
  - a `StreamRelay` follows the file with the declared codec;
  - at the runner's exit, the relay is finished (bounded) and the shared streamed-run close *(P8)* files the run. It
    closes by the stream when a test was held. When nothing was held, it files the compile ingest (`no-test-reports`).
    When a `run-start` but no `test-end` was held, it closes by the stream with the warning;
  - **the narration's count** comes from the stream's `test-end`s, as python's streamed narration does, with the total
    the stream's `run-start` states, if any (F13);
  - **a `--name` filter** counts what ran from the stream, not from a JUnit report (F14);
  - **no open run** (`--no-lifecycle`, a board with no `/runs/start`, a board that cannot be reached): the suite runs,
    nothing is filed, and the answer is `ok: false` naming the cause, as python's unfiled answer is (F5).
- **The wire** (F12). The shared helpers `open_run`, `ingest_reports`, `close_stream` and `post_ingest` take an optional
  `framework`; the other clients pass none and are unchanged. Every bun-client test run sends its framework: the
  declared one, or `bun-test`. `check` (tsc) sends none.
- **`coverage`** names the coverage codec the client sends; undeclared, it is `lcov`, as today.
- **Liveness.** A stream target's narration follows CR-CRU-201 §S4 step 6: no in-run `running N/M` while the relay lands
  batches, and ticks whenever it does not. The in-run count comes from the STREAM's `test-end`s, never from the runner's
  console, so a runner whose console the client does not read (Vitest) still ticks. This holds in the shared narration,
  for python's streamed run too (VERIFY 839 finding 2, orchestrator ruling).
- **The closing count** (VERIFY 839 finding 3, orchestrator ruling): a streamed run with no `run-end` closes on
  `ran N/M`, with `M` the `run-start`'s total when there is one, never less than `N`. So a crashed python run now says
  `ran 3/10`, where it said `ran 3/3`; a run that stopped short never claims the whole suite ran. This is AC5's one
  intended change to python's streamed runs.
- **The gate and a non-`bun-test` target** (VERIFY 839 finding 5, user ruling): `pre-merge-gate`'s bun suite is the
  client's own `bun test`, which counts every declared bun target as covered. How the gate runs a table target whose
  framework is not `bun-test` is CR-CRU-226's. This repo declares none in this CR.

### §S3 — the shipped Vitest reporter

- **`clients/reporters/vitest-crucible.ts`** *(P2)* writes to the file `CRUCIBLE_STREAM` names, flushing each line as it is
  written. It emits:
  - `run-start` with no total *(P9)*;
  - one `test-end` per test case as it finishes (`onTestCaseResult`):
    - `id`, `name`, `file`, `status`, `duration_ms`, and `failure` (message, type, trace);
    - `suite`: the describe chain joined by ` > `, or the file when there is none (F6);
  - one failing `test-end` named `?` for a module that fails to load, with its file and message *(P10)*;
  - `run-end` with its totals (`onTestRunEnd`).
- **Status mapping:** passed → `pass`; failed → `fail`; skipped and todo → `pending`, including tests skipped statically.
- **It loads anywhere** (F8). It imports only `vitest` types and `node:` built-ins, so it loads from an install with no
  `node_modules` above it. `tsconfig.json`'s `include` gains `clients/reporters`, so `check` typechecks it.
- **The install** (F9). `crucible_axi/install.py` lays down `reporters/`:
  - `FLEET_FILES` gains the reporter;
  - `run_fleet_stage` creates the subdirectory;
  - the symlink-confinement rule covers the directory as it covers a file: a symlinked `reporters/` is replaced by a
    real directory, and nothing is ever written through the link (RED 837 ruling);
  - the pinned fleets follow: `EXPECTED_FLEET_FILES` in `tests/client/test_cr090_fleet_stage.py`, and
    `tests/client/test_cr090_cli_install_integration.py` and `tests/client/test_cr090_one_source_resolver.py`.
- **The fixture** (F10). `tests/fixtures/vitest-project/vitest.config.ts` adds the reporter from `CRUCIBLE_REPORTERS` when
  it is set. Its `package.json` keeps its older keys; CR-CRU-226 migrates it. The fixture must still stay out of this
  repo's own suite (`tests/client/test_bun_vitest_fixture_stays_out_of_this_repos_suite.py`).

### §S4 — the record of the design, and the close-out

- **The PRD:**
  - §4.4 names the table and its framework vocabulary, the run's `framework`, `codecs.stream` and the Vitest reporter;
  - the event table gains `framework`.
- **The DN:**
  - the Declaration section's table gains `framework` and `coverage`, and names the modality-by-script rule and the
    Model B contract;
  - the Totals section says Vitest's `run-start` states no total *(P9)*.
- **Schema:** `docs/RUNBOOK.md`'s figures read v23.
- **The existing tests that follow** (Rule 16): the health and gate-milestone codec lists (`codecs.stream`), the
  migration tests pinned to v22, and the three fleet tests in §S3. A change to what a test asserts is the
  orchestrator's ruling, in its own commit.
- **The local API doc:** `.lavish/crucible-server-api.html` (not in git) is updated for `framework` and `codecs.stream`.
  This is the orchestrator's manual close-out check.
- **The close-out:** `SHARED_MODULE_LINE_BUDGETS` (*P8* moves `_crucible_run.py`) and the `PROSE_CITATIONS` heads are
  re-measured and re-recorded once each, in their own commits.

### Dog-food (Rule 21)

- **This repo declares no `crucible.targets`** in this CR, so no table rule fires here. `test:unit` and `test:integration`
  keep today's behaviour, now stamped `bun-test`.
- **The DEV board** runs develop's code while this CR is open. It drops an unknown `framework` (`runMeta`), and lists
  `bun-console` and `crucible-events`, so the client's runs file against it unchanged.
- **P8's extraction moves python-crucible's streamed run,** the gate's `test:client` path, so the commit that moves it
  must leave the python suite filing. GREEN proves this with a python regression after that commit.
- **CR-CRU-228 must replace `test:e2e`'s `reportPath` and `rawReport` with its table entry in one commit,** or P3 refuses
  it.

## Acceptance criteria

- [ ] **AC1 — the run's framework.**
  - The four run routes store an optional `framework`; an empty or non-string value is a 400 and nothing is stored.
  - A close stating a different framework from its start is a 400; a close stating none inherits the start's.
  - It is answered on the event, in the run brief and in the open-run brief.
  - A timeline read across a test run, a milestone and a gate answers the test run's framework and none on the others.
  - Migration v23 adds both columns, a new store matches a migrated one, and RUNBOOK reads v23.
  - Health lists `codecs.stream: ["crucible-events"]`.
- [ ] **AC2 — the table.**
  - Each refusal in §S2 happens before anything is posted, names the key, and names `crucible.targets`.
  - A script with no table entry runs exactly as today, now with framework `bun-test`, including against a health
    response with no `codecs.view` (no relay, no refusal).
  - A table codec the board's health does not list is refused before the run opens; under `--no-lifecycle` nothing is
    checked.
  - A `junit` target with `env:<VAR>` and a `console` relays or not by its `console`.
  - `crucible.testScript` naming a table-declared script runs through that entry.
  - `framework` and `coverage` ride the start and the close; `check` sends no framework.
- [ ] **AC3 — the Vitest stream.** A scratch copy of the Vitest fixture, with a skipped and a todo test added and its
  `reportPath` replaced by a `vitest` stream entry in `crucible.targets`, run through the bun client against a stub
  board:
  - streams its tests and is closed by its stream, with framework `vitest`;
  - the narration counts from the stream;
  - its stored result equals the same tests' JUnit report on summary counts and statuses, and on each test's failure
    message, matched by file and the describe chain plus name;
  - a top-level test sits under its file as its suite;
  - a module that fails to load is one failing `?` test with its file;
  - a `--name` run counts what ran from the stream;
  - **nothing held:** a runner that exits non-zero having written nothing files the compile ingest
    (`no-test-reports`);
  - **only a `run-start` held:** closes by the stream, with the warning;
  - **no open run:** the suite runs and nothing is filed, with `ok: false` naming the cause.
- [ ] **AC4 — the reporter stands alone, and is installed.**
  - The fixture's config runs unchanged with `CRUCIBLE_REPORTERS` unset, writing no stream.
  - The reporter loads from a directory with no `node_modules` above it.
  - `check` typechecks it.
  - The installer lays down `reporters/`, replaces a symlinked `reporters/` with a real directory without writing through
    the link, and the three fleet tests follow.
- [ ] **AC5 — the shared close.**
  - Python-crucible's streamed runs behave exactly as before through the extracted close, apart from the closing count
    §S2 rules on: its existing streamed-run
    tests pass unchanged.
  - The bun client calls the same close; a source check shows neither client copies it.
- [ ] **AC6 — the design record and the guards.**
  - PRD §4.4 and the event table, and the DN, read as §S4 states.
  - The existing tests §S4 names follow.
  - `tests/citations-cite-by-symbol.test.ts` passes, and no in-scope file reaches 10,000 lines.
- [ ] **AC7 — the close-out.** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-recorded once each, in
  their own commits.

## Non-goals

- **The Playwright reporter, scenario-as-test with its steps, and the specification view** (CR-CRU-228).
- **The clean break,** the `playwright` codec's retirement, and the Vitest fixture's and `testScript`'s migration
  (CR-CRU-226).
- **Re-keying the `junit` codec's stack readings** by the framework (CR-CRU-226). This CR stores the framework they will
  read.
- **The other stacks' declarations** (user ruling 3): CR-CRU-202, CR-CRU-203, CR-CRU-195, and a python CR to be filed.
- **Coverage from Vitest.**
- **Back-filling** old runs' framework.
