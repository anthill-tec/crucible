# CR-CRU-228 — a BDD run streams its scenarios with their steps

**Type** feature · **Points** 13 (measures above 13; kept as one CR by user ruling, the board's scale stops at 13) ·
**Wave** 8 (0.4.0) · **Depends on** CR-CRU-225 · **Status** PENDING

- **Filed 2026-11-01.** Split from CR-CRU-225 at its gap analysis (user ruling: the board's points scale stops at 13).
  The id CR-CRU-227 is skipped because a reverted filing used it.
- **User rulings 2026-11-01** (CR-CRU-225's gap analysis):
  1. **A BDD run's test is the scenario.** Each scenario is one test, carrying its Gherkin steps inside it, so a run's
     counts match its JUnit report. This folds in the over-count the user ruled into this work on 2026-10-30: the
     `playwright` codec stores each step as a test (75 for 5 scenarios).
  2. **The specification view keys on the run's framework** (stored by CR-CRU-225).
  3. **The live view shows no steps.** An open BDD run's live view is its scenario counts, current file and failures,
     as for any stream. The steps are in the stored run.
- **User rulings 2026-11-01** (this CR's pre-review):
  4. **This repo's `test:e2e` moves to the table in this CR, in ONE commit** with every test that pins its old
     declaration, and its kept JUnit and JSON reports go into the run's own reports dir.
  5. **The specification view's loading design stays in this CR** (not split out), though it takes the CR above 13.
  6. **Background steps are kept:** a hook's `test.step` children are the scenario's first steps.
  7. **Live failures carry their browser,** so a scenario failing in two projects shows two distinct rows.
  8. **A scenario's status follows Playwright's `test.outcome()`,** so it agrees with JUnit for an expected failure.

**Gap analysis 2026-11-01** (after CR-CRU-225 merged as `62a9abfc`):

- **Baseline:** CR-CRU-225's pre-merge gate on the identical tree: 10481/0 (bun 4539/0, python 5942/0; events
  `evt-1793492541466-75` and `evt-1793493838630-76`). No re-run is needed: `git diff 148507b1 62a9abfc` is empty.
- **What changed:** `framework` exists on every run and its event brief (CR-CRU-225), and the shared
  `start_stream_relay` and `close_streamed_run` exist. The reporters directory and its install exist.
- **Reach:** two more places key a BDD run on the `playwright` codec: `isSpecRun` (`public/app.js`) and the BDD tab's
  index, `bddIndexRows` (`public/app-logic.mjs`).
- **Pre-review** (`CR-CRU-228-SPEC-REVIEW`): its 13 findings are folded in below, named F1–F13 where a choice was made.

**PROPOSED, awaiting the user's ruling** (Rule 19):

- **P1:** migration v24 adds a `run_case_steps` table holding a test's steps, listed in `RUN_DETAIL_TABLES` ahead of
  `run_cases`.
- **P3:** AC4 has two proofs, both in `test:integration`. A small playwright-bdd fixture run through the bun client
  against a stub board covers:
  - a failing step and a failing Before hook;
  - a retried scenario and a `@fail` scenario;
  - a Background;
  - a dependency project that fails, and two projects.

  The existing `tests/e2e-suite-reaches-the-board.test.ts`, which already drives this repo's real e2e suite in the gate,
  is re-pointed at the stream shape (F1) and is the real-suite proof, at no extra gate cost.
- **P4:** the reporter's steps are the attempt's `test.step` steps: the top-level ones, plus the `test.step` children of a
  hook step (Background, ruling 6). Fixtures are not steps.
- **P5 — the suite** (F11): a test's `suite` is the describe titles after its file in `titlePath()`, without the
  scenario's own title, joined by ` › `. Two features with the same title in different files stay apart because the
  file is part of the match: the store keys a suite by (`suite`, `browser`) and the view by (`file`, `suite`, `browser`).
- **P6 — the spec view's new shape** (F8, ruling 5):
  - the first read, `?depth=suites`, lists features (suites) with their counts;
  - opening a feature reads `?suite=<feature>&browser=<b>`, which answers its scenarios with their steps;
  - a feature run in several projects shows once, as one feature, with each scenario row naming its browser;
  - failing features open first, then the first `SPEC_FIRST_OPEN`, as today.

## Problem

- **Nothing uses Playwright's reporter API,** so a Playwright run reaches the board only at exit, through its JSON
  report and the `playwright` codec.
- **That codec counts steps as tests.** It builds one suite per scenario, with each Gherkin step as a test under it.
  A run of 5 scenarios files 75 tests, while its JUnit report says 5.

## Design

- **The Playwright reporter's tests are scenarios.** The reporter ships in `clients/reporters/` beside CR-CRU-225's
  Vitest one and emits `crucible-events`. Each `test-end` is one scenario per Playwright project, from its last
  attempt. It names:
  - the feature as its `suite` *(P5)*;
  - the project as its `browser`;
  - its Gherkin steps in `steps`, each with a name, status, duration and failure *(P4)*.
- **The board stores it the same way:** a suite per feature and browser, a test per scenario, and the scenario's steps
  under it. Counts are the tests'.
- **The run detail's specification view** reads feature → scenario → step from that shape for a `playwright-bdd` run
  *(P6)*, and still reads runs the `playwright` codec stored.

## Steps

### §S1 — steps under a test (board)

- **`crucible-events` `test-end` takes two optional keys:**
  - `browser`: a non-empty string;
  - `steps`: an array of `{name, status, duration_ms?, failure?}`.
- **How a step is read** (F13). Each step follows the rules a `test-end` does, and its `failure` is kept only when its
  status is `fail`, as `toLeaf` does. Steps that never ran after a failure are absent, not pending. An ill-formed
  `steps` or `browser` makes the line undecodable, as an ill-formed key does today.
- **The tree.** The decoder groups test-ends into suites by (`suite`, `browser`); `SuiteNode.browser` is set from it.
  A test's steps become `TestLeaf.steps`.
- **The counts are the tests', never the steps'.** A run's summary and a suite's counts count its tests.
- **The live fill.** `fillRunLive` ignores `steps` (ruling 3). A live failure stores its `browser`: `run_live_failures`
  gains a nullable `browser` column (ruling 7), and `RunLiveFailure` answers it.
- **The store, every site named** (F9, P1):
  - `run_case_steps` (event, suite position, case position, position, name, status, duration, failure parts) is created
    in `createRunDetailTables` for a new store and by migration v24 for an existing one;
  - `RUN_DETAIL_TABLES` lists it ahead of `run_cases`, so `deleteRunDetail`, `deleteProjectRunDetail` and the
    milestone and gate move's `dropDetail` delete it, and the native-rows migration's `satisfiedBy` check reads it;
  - `writeRunDetailRows` writes it;
  - the full read and `getEventSuite` (`?suite=&browser=`) answer a test's `steps`, but `getEventSuites`
    (`?depth=suites`) reads no step row;
  - `invalidLeaf` accepts a leaf's `steps` by the same rules, so `/runs/parsed` takes them;
  - **`feature`:** a suite of a `playwright-bdd` run stores its own name as its `feature`. An old run's suite keeps
    `featureOf`'s split.
- **Migration v24** adds `run_case_steps` and `run_live_failures.browser`. Runs stored before it read unchanged.

### §S2 — the Playwright reporter

- **`clients/reporters/playwright-crucible.ts`** writes to the file `CRUCIBLE_STREAM` names, flushing each line as it is
  written. It emits:
  - `run-start` with the total (`onBegin`: every test in every project);
  - one `test-end` per test per project, at its last attempt (F5): an attempt is the last when its status is `skipped`,
    or equals `test.expectedStatus`, or `result.retry >= test.retries`.
- **Each `test-end` carries:**
  - `id`: `test.id`, unique per project (F10);
  - `name`: the scenario's title;
  - `suite`: per P5;
  - `browser`: the project name;
  - `file`;
  - `status` by `test.outcome()` (ruling 8): `expected` or `flaky` → `pass`; `unexpected` → `fail`; `skipped` →
    `pending`;
  - `duration_ms`;
  - `steps` *(P4)*;
  - `failure` (F6): from `result.error`, else `result.errors[0]`, with message, type and stack. A scenario whose Before
    hook fails has a failure and no failing step; one whose After hook fails has passing steps and a failure.
- **Tests that never run** (F4). At `onEnd`, the reporter emits a `pending` `test-end` for every test with no result: a
  dependency project that failed, `--max-failures`, an interrupt. It also emits the last result of any test not yet
  emitted. `run-end`'s totals are those of the `test-end`s emitted, so the count equals JUnit's.
- **Errors outside a test** (F6). An `onError` (a webServer that will not start, a step file that will not load), or a
  `bddgen` failure before Playwright starts, is filed by the shared close's existing paths: "only a `run-start`" or
  "nothing held".
- **It stands alone, and is installed** (F7):
  - it imports only Playwright types and `node:` built-ins, and loads with no `node_modules` above it;
  - `check` typechecks it;
  - `crucible_axi/install.py`'s `FLEET_FILES` gains `reporters/playwright-crucible.ts`, and the pinned fleets in
    `test_cr090_fleet_stage.py` and `test_cr090_cli_install_integration.py` follow in the same commit.
- **A config with no client.** With `CRUCIBLE_REPORTERS` unset, a config that adds the reporter from it adds nothing.

### §S3 — this repo's e2e streams, in one commit (ruling 4)

One commit holds all of the following, so no state between commits breaks the gate:

- **`package.json`:** `test:e2e` moves to `crucible.targets` as
  `{framework: "playwright-bdd", stream: {codec: "crucible-events", path: "env:CRUCIBLE_STREAM"}}`. Its `reportPath`
  and `rawReport` entries go.
- **`playwright.config.ts`:**
  - adds the reporter from `CRUCIBLE_REPORTERS` when it is set;
  - keeps the `junit` and `json` reporters, which CR-CRU-226 retires with the codec.
- **The kept reports' destination** (F3). The client sets `PLAYWRIGHT_JUNIT_OUTPUT_NAME` and
  `PLAYWRIGHT_JSON_OUTPUT_NAME` into the run's reports dir for a `stream` target, so the run writes nothing to
  `<repo>/test-reports`.
- **The tests that pin the old declaration, moved with it:**
  - `tests/e2e-suite-reaches-the-board.test.ts` (F1, P3) is re-pointed at the stream shape: framework
    `playwright-bdd`, the scenario count equal to JUnit's, and steps under each scenario;
  - `tests/client/test_declared_target_report_mechanism.py`'s
    `test_this_project_declares_the_report_mechanism_its_e2e_runner_uses` (F2) reads the table entry.

### §S4 — the specification view and the BDD index *(P6)*

- **Which runs are BDD runs.** `isSpecRun` (`public/app.js`) and `bddIndexRows` (`public/app-logic.mjs`) hold for a run
  whose framework is `playwright-bdd`, and still for a run stored by the `playwright` codec. `CrucibleEventBrief`
  gains `framework` in `public/app-logic.d.mts` and its mirror `tests/app-logic.d.ts` (F10).
- **A new run** reads features from `?depth=suites`, and a feature's scenarios with their steps from
  `?suite=<feature>&browser=<b>`. A feature run in several projects shows once, with each scenario row naming its
  browser. The failures-first and first-open rules apply to features.
- **A scenario that failed with no failing step** (a Before hook) shows its failure on the scenario row.
- **An old run** reads its scenario suites and their step leaves, as today. The tests that pin the old shape keep it:
  - `playwright-run-progressive-expansion`;
  - `heat-cell-reveal-spec-unfold`;
  - `run-detail-suite-load-dom-identity`;
  - `run-detail-feature-fold-and-raw-dom-identity`;
  - `bdd-section`;
  - `playwright-run-browser-scoping`.

### §S5 — the record of the design, and the close-out

- **The PRD:** §4.4 names the Playwright reporter, `test-end`'s `steps` and `browser`, and scenario-as-test.
- **The DN** (F12):
  - line 48's live state drops "Playwright's steps" (ruling 3);
  - line 66 says the steps ride inside each scenario's `test-end`;
  - the Declaration example's `test:e2e` names `playwright-bdd`;
  - the "Playwright's steps in the live state are CR-CRU-201's" sentence becomes ruling 3.

  The pin in `tests/docs-live-test-stream-design-record.test.ts` asserts the ruling-3 statement and that the
  CR-CRU-201 assignment is gone.
- **Schema:** `docs/RUNBOOK.md` reads v24.
- **The existing tests that follow** (Rule 16):
  - the zero-row read tests (`event-brief-reads-…`, `projects-last-event-…`, `?depth=suites reads no run_cases row`);
  - the v15-store fixtures that drop the detail tables;
  - the migration tests pinned to v23;
  - the fleet tests.

  A change to what a test asserts is the orchestrator's ruling, in its own commit.
- **The fixture's guard** (F13). The P3 fixture project stays out of this repo's own suites, with a guard like the
  Vitest fixture's.
- **The local API doc:** `.lavish/crucible-server-api.html` (not in git) is updated for `steps`, `browser` and the live
  failure's `browser`.
- **The close-out:** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-recorded once each, in their own
  commits.

### Dog-food (Rule 21)

`test:e2e` is excluded from the gate fleet-wide. The gate's `test:integration` drives it through
`e2e-suite-reaches-the-board`, and `test:client` reads its declaration. Both move in §S3's single commit, so every commit
leaves the gate green. The DEV board ignores `steps` and `browser` until it runs the merged code.

## Acceptance criteria

- [ ] **AC1 — steps under a test.**
  - A `crucible-events` stream with `browser` and `steps` decodes to suites keyed by (`suite`, `browser`), and tests
    carrying their steps.
  - A step's failure is kept only on a failing step.
  - An ill-formed `steps` or `browser` makes its line undecodable.
  - The summary counts tests, not steps.
  - `run_case_steps` stores the steps; the full and `?suite=&browser=` reads answer them, and `?depth=suites` reads no
    step row.
  - Every delete path removes them.
  - `/runs/parsed` takes them.
  - A `playwright-bdd` suite stores its own name as its `feature`.
  - Live failures carry their browser.
  - Runs stored before v24 read unchanged, and RUNBOOK reads v24.
- [ ] **AC2 — the reporter.** On the P3 fixture it emits the events §S2 states:
  - Background steps first;
  - a retried scenario once, from its last attempt;
  - a `@fail` scenario as `pass`;
  - a Before-hook failure as a failing scenario with no failing step;
  - the failed dependency project's tests as `pending`;
  - `run-end` equal to what was emitted.

  It writes nothing with `CRUCIBLE_REPORTERS` unset, loads with no `node_modules` above it, is typechecked, and is
  installed.
- [ ] **AC3 — the specification view and the BDD index.**
  - A `playwright-bdd` run opens as feature → scenario → step from its tests and steps, loading as P6 states, with a
    multi-project feature shown once and a hook-failed scenario showing its failure.
  - A run stored by the `playwright` codec opens as today, and its six tests stay green.
  - The BDD tab's index lists both.
- [ ] **AC4 — a BDD run streams** *(P3)*. The P3 fixture through the bun client against a stub board, and this repo's
  `test:e2e` through `e2e-suite-reaches-the-board` against a scratch board built from this branch:
  - each is closed by its stream, with framework `playwright-bdd`;
  - its scenario count equals the same run's JUnit `tests`;
  - each scenario's steps equal, by name, status and order, what the `playwright` codec decodes from the same run's JSON
    report, matched by (`suite`, `name`, `browser`);
  - each scenario sits under its feature and browser;
  - the run writes nothing to `<repo>/test-reports`.
- [ ] **AC5 — the design record and the guards.**
  - PRD §4.4 and the DN read as §S5 states, and the DN pin moves.
  - The fixture stays out of this repo's suites.
  - The citations guard passes, and no in-scope file reaches 10,000 lines (`public/app.js` is at 8894).
- [ ] **AC6 — the close-out.** The pins are re-recorded once each, in their own commits.

## Non-goals

- **Live steps** (ruling 3).
- **Retiring the `playwright` codec and the JSON report** (CR-CRU-226).
- **Re-shaping runs already stored by the `playwright` codec.**
