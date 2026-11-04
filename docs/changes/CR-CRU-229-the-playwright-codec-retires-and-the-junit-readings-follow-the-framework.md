# CR-CRU-229 — the playwright codec retires, its runs migrate, and the junit readings follow the framework

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-226, CR-CRU-228 · **Status** PENDING ·
Pre-review: ran — 13 points, and the gap analysis needed user rulings; FINDINGS(9), all folded
- **Filed 2026-11-04.** Split from CR-CRU-226 at its gap analysis (user ruling 2026-11-04: two CRs, the client's break
  first, then the board's half in this one).
- **Gap analysis 2026-11-04** on develop `2676d3b5` (baseline: the CR-CRU-226 pre-merge gate, 10681 passed / 0 failed,
  on the code-identical `f67505ab`). User rulings that day: a migrated run is recounted by scenario; the python
  `auto-ingest` states the runner the project declares.
- **Spec pre-review 2026-11-04** (`CR-CRU-229-SPEC-REVIEW`, on `e38da554`): FINDINGS(9), folded here: the heat-cell
  reveal in the scenario shape (§S4), the codec used as a test oracle (§S7), a failing scenario with no failing step
  (§S3), rollups (§S3), the `feature` of other runs (§S3), the PRD and DN rows (§S8), the pytest report condition
  (§S5), and AC2's and AC5's checks.

## Problem

- **Playwright's JSON report and the board's `playwright` codec are redundant.** Since CR-CRU-228 the shipped reporter
  streams each scenario as a test with its Gherkin steps, as `crucible-events` with framework `playwright-bdd`. After
  CR-CRU-226 refuses `crucible.rawReport`, nothing a project declares reaches the codec. The bun client still points
  Playwright's JSON report into a stream run's reports dir (`STREAM_KEPT_REPORTS`), and this repo's
  `playwright.config.ts` and the `tests/fixtures/playwright-bdd-project` config still write it. Only this repo's own
  tests post Playwright JSON: 24 files under `tests/` name the codec in a post, a fixture or a direct call (the e2e
  harness's `ingestPlaywright` among them), and 10 more pin a codec list that holds `playwright`.
- **Stored runs keep a second shape.** Measured on the DEV board's store (schema v24): 225 runs were filed through the
  codec, none with a framework; 224 of them also have a `runs` row. 223 hold a suite per scenario named
  `<feature> › <scenario>`, its steps as cases (no `run_case_steps` row, no `events.tree`), and 2 hold no suite.
  Their stored counts count steps: run `evt-1793378657927-74` says 150 tests, which are 150 steps of 10 scenarios over
  2 (feature, browser) pairs. The UI tells the shapes apart by codec (`public/app.js` `isSpecRun`, `isScenarioShape`,
  `BDD_SEP`; `public/app-logic.mjs`'s BDD filter), and the store splits a feature off a suite's name for every run
  not of framework `playwright-bdd` (`src/store.ts` `featureOf`, `FEATURE_SEPARATOR`), which only the codec's runs
  need.
- **Two `junit` readings switch on the client's stack**, not the framework that wrote the report:
  - `parseJunit` groups cases by classname when `stack === "python"` and the report's only suite is named `pytest`;
  - `readJunitRawOutput` reads the console as bun's only when `stack === "bun"`, so a bun project's vitest `junit`
    run gets bun's console reading too.
  The codec is told the run's effective stack (`DecodeOptions.stack`, from `effectiveStack` in `src/v2.ts`). The
  python client sends no framework on any path.

## Design (user rulings 2026-10-31 and 2026-11-04; `DN-crucible-live-test-progress.md`)

- **Retirement** (ruling 2026-11-04). The board stops accepting Playwright JSON: the `playwright` codec leaves the
  registry and the health codec list, and a post naming it is refused as an unknown codec. Playwright's JSON report
  leaves both Playwright configs and the client's kept reports; the `junit` reporter and its kept-report entry stay.
- **The stored runs migrate to framework `playwright-bdd`** (ruling 2026-11-04), in the scenario shape the stream
  stores, and **are recounted by scenario** (ruling 2026-11-04): a migrated run's counts say what the stream would
  have said. The stored `codec` stays as the record of how the run was filed. The UI's codec checks and the store's
  name split then go: the specification view is decided by framework alone.
- **The test fixtures re-seed through the stream** (ruling 2026-11-04); `tests/playwright-codec.test.ts` is deleted.
- **Readings keyed by the declared framework** (ruling 2026-10-31). pytest's classname grouping applies to a run of
  framework `pytest`, and the bun console reading to a run of framework `bun-test`, whatever the stack. The `stack`
  field stays only as the run's label. A run that states no framework gets neither reading.
- **The python client sends its framework**: its runner, `pytest` or `unittest`, on every run it files. `auto-ingest`,
  which runs no runner, states the runner the project declares (ruling 2026-11-04).

## Steps

### §S1 — the codec retires
- `src/codecs/playwright.ts` is deleted and the `playwright` entry leaves `codecs` (`src/codecs/index.ts`).
- `GET /api/health` lists `codecs.test` as `crucible-events`, `junit`.
- `POST /api/v2/runs` naming `codec: "playwright"` is refused by the existing unknown-codec check
  (400 `unknown codec: playwright`), and nothing is stored.

### §S2 — Playwright's JSON report retires
- `STREAM_KEPT_REPORTS` (`clients/bun-crucible.py`) keeps only `PLAYWRIGHT_JUNIT_OUTPUT_NAME`.
- `playwright.config.ts` and `tests/fixtures/playwright-bdd-project/playwright.config.ts` configure no `json`
  reporter; their comments stop describing the JSON report and the codec.

### §S3 — the stored runs migrate (schema v25)
One transacted step in the migration chain. For each `events` row of codec `playwright`:
- its `framework` is set to `playwright-bdd`, on the event and on its `runs` row when it has one; `codec` stays;
- its detail rows are rewritten to the scenario shape `writeRunDetailRows` stores for a `playwright-bdd` run:
  - each old suite is a scenario: its feature is its name up to the first ` › `, its scenario name the rest (PROPOSED:
    a name with no ` › ` is its own feature and its own scenario name);
  - one suite per distinct (feature, browser), in first-seen order of the old suites, named by the feature, `feature`
    = that name, `browser` kept;
  - one case per scenario, in the old order, with the old suite's status. PROPOSED: its duration is the sum of its
    steps' durations; its failure is its first failing step's failure (message, type, trace). A failing scenario with
    no failing step (a hook failed, or it holds no step) gets an empty failure, every part NULL, as the stream's
    `failureOf({})` gives one; a passing or pending scenario gets none;
  - the old cases become that case's `run_case_steps` rows, in order, with their status, duration and failure;
  - each new suite's status and counts follow from its cases, as at ingest;
- its `total`, `passed`, `failed` and `pending` are recounted over the scenarios; `duration_ms` is unchanged. A run
  can turn red: on the DEV store three runs hold a failing scenario with no step (`evt-1790192324097-11`,
  `evt-1790195306029-19`, `evt-1790196439852-26`, the last stored as 634 passed, 0 failed), and each is recounted
  with that scenario failed;
- a run with no suites gets the framework and nothing else.
The same step sets `feature` to NULL on every suite of a run whose framework is not `playwright-bdd` (no route reads
it). Nothing else of any other run changes. The `rollups` (`foldIntoRollup`) are left as they were folded: their
source rows are gone, so a day folded from codec runs keeps its step counts. A store with no codec run rewrites
nothing.

### §S4 — the specification view by framework alone
- `isSpecRun` (`public/app.js`) is a test run of framework `playwright-bdd`; the BDD index filter
  (`public/app-logic.mjs`) the same. Neither reads `codec`.
- `isScenarioShape`, its branches (`specFeaturesOf`, `openProgressively`, `openFeature`, `FeatureGroup`) and `BDD_SEP`
  are deleted; the scenario-shape path is the only one.
- `featureOf` and `FEATURE_SEPARATOR` (`src/store.ts`) are deleted: a suite's `feature` is its name for a run of
  framework `playwright-bdd`, and NULL for any other.
- The heat strip in the scenario shape (a feature's suite, a scenario its leaf): a scenario's cell reveals that
  scenario's row, as it does today. PROPOSED: a synthetic cell of a suite not yet loaded loads it and reveals its
  first failing scenario's row when red, else its first scenario's row. Today it reveals a `suite:` row, which the
  scenario shape never draws, so nothing is located.

### §S5 — the readings keyed by framework
- `DecodeOptions` carries the run's effective framework in place of its stack: the one the ingest states, else the one
  the run it closes was started with (the rule `effectiveStack` applies today, which it replaces).
- `parseJunit` groups cases by classname when the framework is `pytest` and the report holds exactly one suite,
  named `pytest` (today's report condition, which the python client meets); only the stack test is replaced.
- `readJunitRawOutput` reads the console as bun's when the framework is `bun-test`.
- With no framework, or any other, neither applies. Nothing under `src/codecs/` reads the run's stack for a test run.

### §S6 — the python client files its framework
- Every run the python client opens or files states `framework` = its runner: `test` (the `unittest` stream and the
  `pytest` junit run), `regression`, and each tier `pre-merge-gate` runs.
- `auto-ingest` states the runner `[python] runner` declares in the project's own `crucible.toml`, else `unittest`
  (the running verbs' resolution, without `--runner`, which `auto-ingest` does not take, and without the pytest import
  check, since it runs nothing). A declared value that is neither runner is refused as the running verbs refuse it:
  an envelope, and nothing posted.

### §S7 — the test fixtures re-seed through the stream
- The e2e harness's `ingestPlaywright` is replaced by a seed that opens a run, posts its `crucible-events` stream (each
  scenario a `test-end` with its `browser` and `steps`) and closes it with codec `crucible-events`, framework
  `playwright-bdd`; the step files that called it use it.
- Each test that posts codec `playwright` or calls the codec seeds the same way, or is deleted where it pins only the
  codec's own behaviour; `tests/playwright-codec.test.ts` is deleted. Codec-list pins lose `playwright`, in
  `tests/` and `tests/client/` alike (health stubs, `codec="playwright"` ingests).
- A test that uses the codec as its expected value (`tests/playwright-bdd-fixture-streams-through-the-bun-client.test.ts`,
  `tests/e2e-suite-reaches-the-board.test.ts`) takes it from a codec-free source instead. PROPOSED: the steps read
  from the `.feature` files, as the fixture test already reads its Background.
- The three spec-run scenarios of `tests/e2e/features/heat-cell-reveal.feature` and
  `tests/heat-cell-reveal-spec-unfold.test.ts` are rewritten to the scenario shape's cells and rows (§S4).

### §S8 — the record
- `CHANGELOG.md` `[Unreleased]`:
  - **Removed (⚠ breaking):** the `playwright` codec; a post naming it is refused.
  - **Changed:** the `junit` readings follow the framework; a run that states none (any client older than 0.4.0)
    gets neither. The python client states its runner as the framework. A migration (schema v25) moves the runs
    filed through the codec to framework `playwright-bdd` and recounts them by scenario.
    Days already folded into the rollups keep their step counts.
  - **Stack declaration changes:** a Playwright config needs no `json` reporter; the client no longer points one.
- `DN-crucible-live-test-progress.md` and `PRD-crucible-v2.md` §4.4 state the codec retired and the readings keyed
  by framework; PRD §4.12 and §8 stop naming the codec.
- PRD's run-fields table: the `framework` row says python states `pytest` or `unittest`, the migrated codec runs
  carry `playwright-bdd`, and the framework decides the readings and the specification view; the `codec` row stops
  listing `playwright` as a codec a run is filed with (kept on stored runs as a record) and stops saying the codec
  drives rendering. PRD §4.4's vocabulary and gate lines, and the DN's "their suites name no framework", say the
  python gate's tiers state their runner.

## Acceptance criteria

- [ ] **AC1 — the codec is gone.** `codecs` holds `crucible-events` and `junit` only, `src/codecs/playwright.ts` does
      not exist, `GET /api/health` lists `codecs.test` as `["crucible-events", "junit"]`, and `POST /api/v2/runs` with
      `codec: "playwright"` answers 400 `unknown codec: playwright` with nothing stored. (§S1)
- [ ] **AC2 — no Playwright JSON report is written.** `STREAM_KEPT_REPORTS` names only `PLAYWRIGHT_JUNIT_OUTPUT_NAME`;
      neither `playwright.config.ts` nor the fixture project's config configures a `json` reporter; the runner of a
      stream-target run through the bun client gets `PLAYWRIGHT_JUNIT_OUTPUT_NAME` naming a file in the run's reports
      dir and no `PLAYWRIGHT_JSON_OUTPUT_NAME`. (§S2)
- [ ] **AC3 — the stored runs migrate.** On a v24 store holding a codec run of two scenarios of one feature in one
      browser (one passing with two steps; one failing at its second of three steps), a codec run whose one
      scenario failed with no step, a codec run with no suite, a junit run with a suite named `A › B`, and a
      `crucible-events` run, opening it at v25 leaves:
      - both codec runs, and the first one's `runs` row, at framework `playwright-bdd` with codec `playwright`;
      - the first run as one suite named by the feature (`feature` = that name, its browser kept), two cases with
        the statuses, summed durations and first-failing-step failure of §S3, and their 2 and 3 steps in
        `run_case_steps`, in order, none left as a case;
      - its counts at total 2, passed 1, failed 1, pending 0, its `duration_ms` unchanged;
      - the no-step run with one failing case carrying an empty failure, counted total 1, failed 1;
      - the run with no suite otherwise unchanged, the junit run's suite at `feature` NULL and otherwise unchanged,
        and the `crucible-events` run unchanged;
      - the `rollups` rows unchanged;
      - `GET /api/v2/events/<id>` and the suite and case reads answering for the migrated run the shape they answer
        for a `crucible-events` run of the same scenarios.
      A v24 store with no codec run opens at v25 unchanged. (§S3)
- [ ] **AC4 — the specification view reads the framework alone.** A migrated run opens in the specification view
      (feature → scenario → step); a test run of codec `playwright` with no framework does not. `app.js` and
      `app-logic.mjs` read no `codec` to decide it; `isScenarioShape`, `BDD_SEP`, `featureOf` and `FEATURE_SEPARATOR`
      do not exist; a stored suite's `feature` is its name for a `playwright-bdd` run and NULL for any other, a junit
      suite named `A › B` included. In a scenario-shape run, a scenario's heat cell, and a synthetic cell (red and
      green), each locate a scenario row as §S4 states; the heat-cell-reveal e2e scenarios pass. (§S4)
- [ ] **AC5 — no test posts Playwright JSON.** `git grep -nE "ingestPlaywright|parsePlaywright" -- tests` finds
      nothing, and every match of `git grep -nE "[\"']playwright[\"']" -- tests` names the framework `playwright`, the
      Playwright package or binary, or the value of a refused key, never a codec posted or listed;
      `tests/playwright-codec.test.ts` does not exist; the tests that took their expected steps from the codec take
      them from a codec-free source; and the e2e scenarios that seeded a BDD run through the codec seed it through the
      stream and pass in the e2e target. (§S7)
- [ ] **AC6 — the readings follow the framework.** Through `POST /api/v2/runs`, codec `junit`:
      - a one-suite report named `pytest` whose cases carry classnames is grouped by classname for framework `pytest`
        under stack `bun`, and not for framework `unittest`, or none, under stack `python`; under framework `pytest`,
        a report of two suites, or of one suite named otherwise, is not grouped;
      - a failing case with no message takes bun's console message for framework `bun-test` under stack `python`,
        and not for framework `vitest`, or none, under stack `bun`;
      - a close stating no framework reads under the framework its run was started with;
      - nothing under `src/codecs/` reads the run's stack for a test run. (§S5)
- [ ] **AC7 — the python client states its runner.** Each run filed by `test` (under `unittest` and under `pytest`),
      `regression`, every `pre-merge-gate` tier and the run each opens states framework = its runner; `auto-ingest`
      states `pytest` when the project's `crucible.toml` declares `[python] runner = "pytest"`, `unittest` when it
      declares nothing, and with `runner = "nose"` emits a refusal envelope and posts nothing. (§S6)
- [ ] **AC8 — the record.** `CHANGELOG.md` `[Unreleased]` holds the §S8 entries; the DN and PRD §4.4 state the codec
      retired and the readings keyed by framework; PRD §4.12 and §8 do not name the `playwright` codec; the PRD's
      `framework` and `codec` rows, §4.4's vocabulary and gate lines and the DN's gate line say what §S8 lists. (§S8)
- [ ] **AC9 — the gate.** `pre-merge-gate` runs every declared stack's suite through its own client, green; this
      repo's `test:e2e` still files through the stream. (all)

## Non-goals

- **The bun declaration's clean break and the gate** (CR-CRU-226, merged).
- **What `regression` runs** (CR-CRU-222).
- **`run_suites.feature` has no reader** (gap analysis lead, Dimension 5). This CR keeps writing it as ingest does.
- **The bun `auto-ingest` framework.** It sends no raw output, so no reading applies to its runs either way.
