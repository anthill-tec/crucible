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

The file keeps its first slug.

**Pre-review: due** — new shipped artifact (a reporter), a migration, and a contract another project (Model B)
implements.

**PROPOSED, awaiting the user's ruling** (Rule 19):

- **P1:** the framework names are `bun-test`, `vitest`, `playwright` and `playwright-bdd` for bun, and `pytest`,
  `unittest`, `nextest`, `surefire`, `go-test` and `arduino-native` reserved for the other stacks.
- **P2:** the reporters live in `clients/reporters/` (this CR adds `vitest-crucible.ts`). They are installed with the
  clients, and handed to the runner as the directory `CRUCIBLE_REPORTERS`.
- **P3:** a script declared in both `crucible.targets` and an older key (`reportPath`, `rawReport`) is refused before
  anything is posted, naming both. No precedence is guessed.
- **P4:** migration v23 adds a nullable `framework` beside each stored run's `stack`.

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
  - the record, either `stream: {codec, path}` (`path` is `env:<VAR>`) or `junit` (`flag` or `env:<VAR>`);
  - optionally, `console`: a view codec for a `junit` target's live view;
  - optionally, `coverage`: the coverage codec (`lcov`, `jacoco`), which must be one the board lists.

  ```json
  "crucible": {
    "targets": {
      "test:unit": { "framework": "bun-test", "junit": "flag", "console": "bun-console", "coverage": "lcov" },
      "test:vitest": { "framework": "vitest", "stream": { "codec": "crucible-events", "path": "env:CRUCIBLE_STREAM" } }
    }
  }
  ```
- **An undeclared script keeps today's default:** `bun test`, the `flag` JUnit report, the `bun-console` view and `lcov`
  coverage, with framework `bun-test`.
- **The older keys are still read in this CR** (`crucible.reportPath`, `crucible.rawReport`, `crucible.testScript`), so
  nothing breaks mid-way. CR-CRU-226 makes the clean break.
- **Model B writes the table.** modelb-axi's project verbs implement this contract:
  - `init` offers the tools per modality for the selected stacks, and writes the table;
  - `migrate` detects a legacy project's tools and older keys, proposes a table, and confirms it with the user;
  - `update` / `agents` bring an older table to the current shape.

  The request goes to Model B at this gap analysis.

### The run carries its framework

The run start and every ingest carry `framework`, and the board stores it beside `stack`.

### The shipped Vitest reporter

- The Vitest reporter ships inside the client install *(P2)* and emits the `crucible-events` shape.
- The client hands the runner the reporter directory (`CRUCIBLE_REPORTERS`) and the stream path (the declared variable).
  A project's config adds the reporter from `CRUCIBLE_REPORTERS` when it is set, so it names no machine path and runs
  unchanged with no client.
- A streamed run's record is its stream (CR-CRU-200), relayed by the shared `StreamRelay` (CR-CRU-224).

## Steps

### §S1 — the run's framework (board)

- **The routes.** `POST /api/v2/runs/start`, `/runs`, `/runs/parsed` and `/runs/compile` take an optional `framework`, a
  non-empty string. An empty or non-string value is a 400 that stores nothing.
- **The close.** An ingest that closes a run states the same framework as its start, or none; a different one is a 400,
  as `stack` is.
- **Storage.** It is stored beside `stack` *(P4)*, and answered on the event and in the run brief wherever `stack` is.
- **Migration v23** adds the column. Runs stored before it read unchanged, with no framework.

### §S2 — the `crucible.targets` table (bun client)

- **Reading the table.** The client reads `crucible.targets.<script>` for the script a run goes through, and refuses
  these before anything is posted, naming the key and `crucible.targets`:
  - an entry that is not an object, or has no `framework`;
  - an entry with both `stream` and `junit`, or with neither;
  - a `stream` without `codec` or `path`, or with a `path` that is not `env:<VAR>`;
  - a `junit` that is neither `flag` nor `env:<VAR>`;
  - a `console` on a `stream` entry;
  - a script declared in the table and in an older key *(P3)*.

  A `stream`, `console` or `coverage` codec the board's health does not list is refused before the run opens.
- **A `junit` target** runs as a declared script runs today, with the report path carried the declared way (the
  mechanism `_declared_report_mechanism` reads today). Its `console` codec decides whether it relays (CR-CRU-201's
  rule, now read from the table).
- **A `stream` target:**
  - the client sets the declared variable to `<reports dir>/crucible-events.ndjson`, and `CRUCIBLE_REPORTERS` to the
    install's reporter directory;
  - the reports dir's wipe removes the old stream file;
  - a `StreamRelay` follows the file with the declared codec;
  - at the runner's exit the relay is finished (bounded), and the run is closed by its stream: `/runs` with `runId`,
    the codec and no data, on the shared close path CR-CRU-224 built (`no-test-reports` when the runner exits non-zero
    with no `test-end`).
- **`framework`** rides the run start and the close, for every bun-client run: the declared one, or `bun-test` for an
  undeclared script and the client's own `bun test`.
- **`coverage`** names the coverage codec the client sends; undeclared, it is `lcov`, as today.
- **Liveness.** A stream target's narration follows CR-CRU-201 §S4 step 6: no in-run `running N/M` while the relay lands
  batches, and ticks whenever it does not.

### §S3 — the shipped Vitest reporter

- **`clients/reporters/vitest-crucible.ts`** *(P2)* is a Vitest reporter that writes to the file the stream variable
  names (`CRUCIBLE_STREAM` by default; the client passes the declared one through). Each line is flushed as it is
  written. It emits:
  - `run-start` with the collected total (`onTestRunStart`);
  - one `test-end` per test case, as it finishes (`onTestCaseResult`): `id`, `name`, `suite` (the describe chain
    joined by ` > `), `file`, `status`, `duration_ms`, and `failure` (message, type, trace);
  - `run-end` with its totals (`onTestRunEnd`).
- **Status mapping:** passed → `pass`; failed → `fail`; skipped and todo → `pending`.
- **Installed with the clients.** `crucible_axi/install.py`'s `FLEET_FILES` lays down `reporters/`, and the manifest and
  its tests follow.
- **A config with no client.** With `CRUCIBLE_REPORTERS` unset, a project config that adds the reporter from it adds
  nothing and runs as before.

### §S4 — the record of the design, and the close-out

- **The PRD:** §4.4 names the table and its framework vocabulary, the run's `framework` and the Vitest reporter; the
  event table gains `framework`.
- **The DN:** the Declaration section's table gains `framework` and `coverage`, and names the modality-by-script rule and
  the Model B contract.
- **Schema:** `docs/RUNBOOK.md`'s figures read v23.
- **The local API doc:** `.lavish/crucible-server-api.html` (not in git) is updated for `framework`. This is the
  orchestrator's manual close-out check.
- **Model B:** the contract above is sent to Model B as a Sandesh request, at this gap analysis.
- **The close-out:** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-measured and re-recorded once
  each, in their own commits.

### Dog-food (Rule 21)

- **The bun gate's suites stay undeclared.** `test:unit` and `test:integration` keep today's default, which §S2 reads as
  framework `bun-test`, `junit: flag`, `console: bun-console`, so every cycle leaves them filing as now.
- **This repo's `package.json` is not changed** by this CR. CR-CRU-228 moves `test:e2e`, and CR-CRU-226 the rest.
- **The DEV board** runs develop's code while this CR is open. It ignores an unknown `framework` key
  (`handleRunStart`), so the client's runs file against it unchanged. AC4 proves the stream on a stub board, and
  `framework` storage on the branch's board.

## Acceptance criteria

- [ ] **AC1 — the run's framework.**
  - The four run routes store an optional `framework` (400 on an empty or non-string value, nothing stored).
  - A close stating a different framework from its start is a 400.
  - It is answered on the event and the run brief.
  - Migration v23 adds it, and RUNBOOK reads v23.
- [ ] **AC2 — the table.**
  - Each refusal in §S2 happens before anything is posted, names the key, and names `crucible.targets`.
  - An undeclared script runs exactly as today, now with framework `bun-test`.
  - A `junit` target with `env:<VAR>` and a `console` relays or not by its `console`.
  - `framework` and `coverage` ride the start and the close.
  - A codec the board's health does not list is refused before the run opens.
- [ ] **AC3 — the Vitest stream.** A scratch copy of the Vitest fixture, declared as a `vitest` stream target, run through
  the bun client against a stub board:
  - streams its tests and is closed by its stream, with framework `vitest`;
  - its stored result equals the same tests' JUnit report on summary, statuses, names and failure messages;
  - a runner that exits non-zero with no `test-end` files `no-test-reports`.
- [ ] **AC4 — the reporter stands alone, and is installed.**
  - The Vitest fixture's config runs unchanged with `CRUCIBLE_REPORTERS` unset, writing no stream.
  - The installer lays down `reporters/`, and its manifest test follows.
- [ ] **AC5 — the design record and the guards.**
  - PRD §4.4 and the event table, and the DN, read as §S4 states.
  - `tests/citations-cite-by-symbol.test.ts` passes, and no in-scope file reaches 10,000 lines.
- [ ] **AC6 — the close-out.** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-recorded once each, in
  their own commits.

## Non-goals

- **The Playwright reporter, scenario-as-test with its steps, and the specification view** (CR-CRU-228).
- **The clean break,** the `playwright` codec's retirement, and the Vitest fixture's and `testScript`'s migration
  (CR-CRU-226).
- **Re-keying the `junit` codec's stack readings** by the framework (CR-CRU-226). This CR stores the framework they will
  read.
- **The other stacks' declarations** (user ruling 3): CR-CRU-202, CR-CRU-203, CR-CRU-195, and a python CR to be filed.
- **Coverage from Vitest:** the `coverage` key is read and validated; a stream target sends none.
- **Back-filling** old runs' framework.
