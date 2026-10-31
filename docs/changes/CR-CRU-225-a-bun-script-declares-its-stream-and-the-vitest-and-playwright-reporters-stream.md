# CR-CRU-225 — a bun script declares its stream, and the Vitest and Playwright reporters stream the Crucible shape

**Type** feature · **Points** 26 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200, CR-CRU-224, CR-CRU-201 ·
**Status** PENDING

- **Filed 2026-10-31.** Split from CR-CRU-201 at its gap analysis. User ruling: three dog-food-safe units —
  CR-CRU-201 (bun's console live view), this CR (the table and the reporters), then CR-CRU-226 (the clean break).
- **Gap analysis 2026-11-01.** Re-scored to 26 points, kept as one CR (user ruling). User rulings:
  1. **A BDD run's test is the scenario.** Each scenario is one test, carrying its Gherkin steps inside it, so a
     run's counts match its JUnit report. This folds in the over-count the user ruled into this work on 2026-10-30:
     the `playwright` codec stores each step as a test (75 for 5 scenarios).
  2. **Each run carries the framework its target declares,** from this CR. The board stores it, the run detail's
     specification view keys on it, and CR-CRU-226 re-keys the `junit` codec's two stack readings off it.
  3. **This CR defines the vocabulary for every stack and implements it for bun.** The other stacks adopt it in
     their own CRs: rust in CR-CRU-202, arduino and maven in CR-CRU-203, go in CR-CRU-195, python in a CR to be filed.
  4. **The live view shows no steps.** An open BDD run's live view is its scenario counts, current file and
     failures, as for any stream. The steps are in the stored run.
- Folds in CR-CRU-201's split: Playwright's steps, and the DN statement that they were CR-CRU-201's.

The file keeps its first slug.

**Pre-review: due** — 26 points, new shipped artifacts (two reporters), a migration, and a contract another
project (Model B) implements.

**PROPOSED, awaiting the user's ruling** (Rule 19):

- **P1:** the framework names are `bun-test`, `vitest`, `playwright` and `playwright-bdd` for bun, and `pytest`,
  `unittest`, `nextest`, `surefire`, `go-test` and `arduino-native` reserved for the other stacks.
- **P2:** the reporters live in `clients/reporters/` as `vitest-crucible.ts` and `playwright-crucible.ts`. They are
  installed with the clients, and handed to the runner as the directory `CRUCIBLE_REPORTERS`.
- **P3:** a script declared in both `crucible.targets` and an older key (`reportPath`, `rawReport`) is refused before
  anything is posted, naming both. No precedence is guessed.
- **P4:** the migration is v23, which adds a nullable `framework` beside each stored run's `stack`, and a
  `run_case_steps` table holding a test's steps.
- **P5:** this repo's `test:e2e` moves to the table in this CR, which proves the Playwright stream on the real
  suite. CR-CRU-226 then migrates the Vitest fixture and `testScript`.

## Problem

Vitest and Playwright have reporter APIs nothing uses. A bun project's script cannot declare a structured stream, and a
Vitest or Playwright run reaches the board only at exit.

**A BDD run counts its steps as its tests.** The `playwright` codec builds one suite per scenario, with each Gherkin step
as a test under it. So a run of 5 scenarios files 75 tests, while its JUnit report says 5.

**Nothing records which framework a run used.** The run detail opens a BDD run as a specification only when its codec is
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
      "test:e2e":  { "framework": "playwright-bdd", "stream": { "codec": "crucible-events", "path": "env:CRUCIBLE_STREAM" } }
    }
  }
  ```
- **An undeclared script keeps today's default:** `bun test`, the `flag` JUnit report, the `bun-console` view and
  `lcov` coverage, with framework `bun-test`.
- **The older keys are still read in this CR** (`crucible.reportPath`, `crucible.rawReport`, `crucible.testScript`), so
  nothing breaks mid-way. CR-CRU-226 makes the clean break.
- **Model B writes the table.** modelb-axi's project verbs implement this contract: `init` offers the tools per modality
  for the selected stacks and writes the table; `migrate` detects a legacy project's tools and older keys, proposes a
  table and confirms it with the user; `update` / `agents` bring an older table to the current shape. The request goes
  to Model B at this gap analysis.

### The run carries its framework

The run start and every ingest carry `framework`, and the board stores it beside `stack`. The run detail's specification
view keys on a BDD framework (`playwright-bdd`), and still on the `playwright` codec for runs stored before this CR.

### Shipped reporters

- Reporters for Vitest and Playwright ship inside the client install *(P2)* and emit the `crucible-events` shape.
- The client hands the runner the reporter directory (`CRUCIBLE_REPORTERS`) and the stream path (the declared variable).
  A project's config adds the reporter from `CRUCIBLE_REPORTERS` when it is set, so it names no machine path and runs
  unchanged with no client.
- A streamed run's record is its stream (CR-CRU-200), relayed by the shared `StreamRelay` (CR-CRU-224).

### A BDD run's test is its scenario (user ruling 1)

- **The Playwright reporter's tests are scenarios.** It emits one `test-end` per scenario per Playwright project, from
  its last attempt. The event names the feature as its `suite`, the project as its `browser`, and its Gherkin steps in
  `steps`, each with a name, status, duration and failure.
- **The board stores it the same way:** a suite per feature and browser, a test per scenario, and the scenario's steps
  under it.
- **The run detail's specification view** reads feature → scenario → step from that shape.

## Steps

### §S1 — the run's framework, and steps under a test (board)

- **`framework`:**
  - `POST /api/v2/runs/start`, `/runs`, `/runs/parsed` and `/runs/compile` take an optional `framework`, a non-empty
    string; an empty or non-string value is a 400 that stores nothing.
  - An ingest that closes a run states the same framework as its start, or none; a different one is a 400, as `stack`
    is.
  - It is stored beside `stack` *(P4)*, and answered on the event and in the run brief wherever `stack` is.
- **`crucible-events` `test-end` takes two optional keys:**
  - `browser`: a non-empty string;
  - `steps`: an array of `{name, status, duration_ms?, failure?}`, each read by the rules a `test-end` is.

  An ill-formed one makes the line undecodable, as an ill-formed key does today.
- **The tree.** The decoder groups test-ends into suites by (`suite`, `browser`); `SuiteNode.browser` is set from it.
  A test's steps become `TestLeaf.steps`.
- **The store.** `run_case_steps` *(P4)* holds each test's steps in order. The progressive reads answer a suite's tests
  with their steps (`getEventSuite`, `?suite=<name>&browser=<b>`), and the full read answers them on every leaf.
- **The counts are the tests', never the steps'.** A run's summary and a suite's counts count its tests.
- **Migration v23** adds the `framework` column and `run_case_steps`. Runs stored before it are read unchanged.

### §S2 — the `crucible.targets` table (bun client)

- **Reading the table.** The client reads `crucible.targets.<script>` for the script a run goes through, and refuses
  these before anything is posted, naming the key and `crucible.targets`:
  - an entry that is not an object, or has no `framework`;
  - an entry with both `stream` and `junit`, or with neither;
  - a `stream` without `codec` or `path`, or with a `path` that is not `env:<VAR>`;
  - a `junit` that is neither `flag` nor `env:<VAR>`;
  - a `console` on a `stream` entry;
  - a script declared in the table and in an older key *(P3)*.

  A `console` or `coverage` codec the board's health does not list is refused before the run opens.
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
  - A board whose health lists no record stream codec of that name refuses before the run opens.
- **`framework`** rides the run start and the close, for every bun-client run: the declared one, or `bun-test` for an
  undeclared script and the client's own `bun test`.
- **`coverage`** names the coverage codec the client sends; undeclared, it is `lcov`, as today.
- **Liveness.** A stream target's narration follows CR-CRU-201 §S4 step 6: no in-run `running N/M` while the relay
  lands batches, and ticks whenever it does not.

### §S3 — the shipped reporters

- **`clients/reporters/vitest-crucible.ts`** *(P2)*, a Vitest reporter that writes to the file the stream variable names
  (`CRUCIBLE_STREAM` by default; the client passes the declared one through):
  - `run-start` with the collected total (`onTestRunStart`);
  - one `test-end` per test case, as it finishes (`onTestCaseResult`): `id`, `name`, `suite` (the describe chain
    joined by ` > `), `file`, `status`, `duration_ms`, and `failure` (message, type, trace);
  - `run-end` with its totals (`onTestRunEnd`);
  - each line is flushed as written.
- **`clients/reporters/playwright-crucible.ts`**, a Playwright reporter:
  - `run-start` with the total (`onBegin`);
  - one `test-end` per test per project from its last attempt (`onTestEnd`, when no retry follows): `name` (the
    scenario), `suite` (the feature: the test's title path above it), `browser` (the project name), `file`,
    `status`, `duration_ms`, `failure`, and `steps`. The steps are the attempt's `test.step` steps, in order, with each
    step's error as its failure;
  - `run-end` with its totals (`onEnd`).
- **Status mapping, both reporters:** passed → `pass`; failed or timed out → `fail`; skipped, todo and interrupted →
  `pending`.
- **Installed with the clients.** `crucible_axi/install.py`'s `FLEET_FILES` lays down `reporters/`, and the manifest
  and its tests follow.
- **A config with no client.** With `CRUCIBLE_REPORTERS` unset, a project config that adds the reporter from it adds
  nothing and runs as before.

### §S4 — this repo's e2e streams, and the specification view *(P5)*

- **This repo's `package.json`:** `test:e2e` moves to the table as
  `{framework: "playwright-bdd", stream: {codec: "crucible-events", path: "env:CRUCIBLE_STREAM"}}`. Its `reportPath`
  and `rawReport` entries go.
- **`playwright.config.ts`** adds the reporter from `CRUCIBLE_REPORTERS` when it is set. It keeps the `junit` and
  `json` reporters, which CR-CRU-226 retires with the codec.
- **The specification view (`public/app.js`).** `isSpecRun` holds for a run whose framework is `playwright-bdd`, and
  still for a run stored by the `playwright` codec.
  - A new run reads feature → scenario → step from suites, tests and their steps.
  - An old run reads its scenario suites and their step leaves, as today.
  - The scenario's identity (name, browser) is unchanged.

### §S5 — the record of the design, and the close-out

- **The PRD:**
  - §4.4 names the table and its framework vocabulary, the run's `framework`, the reporters, `test-end`'s `steps` and
    `browser`, and scenario-as-test;
  - the event table (§3.x) gains `framework`.
- **The DN:**
  - the Declaration section's table gains `framework` and `coverage`, and names the modality-by-script rule and the
    Model B contract;
  - the "Playwright's steps in the live state are CR-CRU-201's" sentence becomes this CR's ruling 4: steps are in the
    record, not the live state. Its pin in `tests/docs-live-test-stream-design-record.test.ts` moves with it.
- **Schema:** `docs/RUNBOOK.md`'s figures read v23.
- **The local API doc:** `.lavish/crucible-server-api.html` (not in git) is updated for `framework`, `steps` and
  `browser`. This is the orchestrator's manual close-out check.
- **Model B:** the contract above is sent to Model B as a Sandesh request, at this gap analysis.
- **The close-out:** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-measured and re-recorded once
  each, in their own commits.

### Dog-food (Rule 21)

- **The bun gate's suites stay undeclared.** `test:unit` and `test:integration` keep today's default, which §S2 reads as
  framework `bun-test`, `junit: flag`, `console: bun-console`, so every cycle leaves them filing as now.
- **`test:e2e` is excluded from the gate** fleet-wide, and moves only in §S4.
- **The DEV board** runs develop's code while this CR is open. It takes no `framework` (`handleRunStart` ignores an
  unknown key) and no `steps`, so the client's runs file against it unchanged. AC6 proves the stream on a scratch board.

## Acceptance criteria

- [ ] **AC1 — the run's framework.**
  - The four run routes store an optional `framework` (400 on an empty or non-string value, nothing stored).
  - A close stating a different framework from its start is a 400.
  - It is answered on the event and the run brief.
  - Migration v23 adds it, and RUNBOOK reads v23.
- [ ] **AC2 — steps under a test.**
  - A `crucible-events` stream with `browser` and `steps` decodes to suites keyed by (`suite`, `browser`) and tests
    carrying their steps; an ill-formed `steps` or `browser` makes its line undecodable.
  - The summary counts tests, not steps.
  - `run_case_steps` stores the steps, and the full and `?suite=&browser=` reads answer them.
  - Runs stored before v23 read unchanged.
- [ ] **AC3 — the table.**
  - Each refusal in §S2 happens before anything is posted, names the key, and names `crucible.targets`.
  - An undeclared script runs exactly as today, now with framework `bun-test`.
  - A `junit` target with `env:<VAR>` and a `console` relays or not by its `console`.
  - `framework` and `coverage` ride the start and the close.
  - A codec the board's health does not list is refused before the run opens.
- [ ] **AC4 — the Vitest stream.** The Vitest fixture, declared as a `vitest` stream target, run through the bun client
  against a stub board:
  - streams its tests and is closed by its stream;
  - its stored result equals the same tests' JUnit report on summary, statuses, names and failure messages;
  - a runner that exits non-zero with no `test-end` files `no-test-reports`.
- [ ] **AC5 — the reporters stand alone.**
  - The Vitest fixture's config and this repo's `playwright.config.ts` run unchanged with `CRUCIBLE_REPORTERS` unset,
    writing no stream.
  - The installer lays down `reporters/`, and its manifest test follows.
- [ ] **AC6 — the Playwright stream.** This repo's `test:e2e`, run through the bun client against a scratch board built
  from this branch:
  - is closed by its stream, with framework `playwright-bdd`;
  - its scenario count equals the same run's JUnit `tests`;
  - each scenario's steps equal, by name, status and order, what the `playwright` codec decodes from the same run's
    JSON report;
  - each scenario is under its feature and browser.
- [ ] **AC7 — the specification view.** In the run detail, a `playwright-bdd` run opens as feature → scenario → step from
  its tests and steps, and a run stored by the `playwright` codec opens as today. Both are shown on stored fixtures.
- [ ] **AC8 — the design record and the guards.**
  - PRD §4.4 and the event table, and the DN, read as §S5 states; the DN pin moves.
  - `tests/citations-cite-by-symbol.test.ts` passes, and no in-scope file reaches 10,000 lines.
- [ ] **AC9 — the close-out.** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-recorded once each, in
  their own commits.

## Non-goals

- **The clean break,** the `playwright` codec's retirement, and the Vitest fixture's and `testScript`'s migration
  (CR-CRU-226).
- **Re-keying the `junit` codec's stack readings** by the framework (CR-CRU-226). This CR stores the framework they will
  read.
- **Live steps** (user ruling 4).
- **The other stacks' declarations** (user ruling 3): CR-CRU-202, CR-CRU-203, CR-CRU-195, and a python CR to be filed.
- **Coverage from Vitest or Playwright:** the `coverage` key is read and validated; a stream target sends none.
- **Back-filling** old runs' framework, or re-shaping old playwright runs.
