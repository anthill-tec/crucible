# CR-CRU-228 — a BDD run streams its scenarios with their steps

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-225 · **Status** PENDING

- **Filed 2026-11-01.** Split from CR-CRU-225 at its gap analysis (user ruling: the board's points scale stops at 13).
  The id CR-CRU-227 is skipped because a reverted filing used it.
- **User rulings 2026-11-01** (CR-CRU-225's gap analysis):
  1. **A BDD run's test is the scenario.** Each scenario is one test, carrying its Gherkin steps inside it, so a run's
     counts match its JUnit report. This folds in the over-count the user ruled into this work on 2026-10-30: the
     `playwright` codec stores each step as a test (75 for 5 scenarios).
  2. **The specification view keys on the run's framework** (stored by CR-CRU-225).
  3. **The live view shows no steps.** An open BDD run's live view is its scenario counts, current file and failures,
     as for any stream. The steps are in the stored run.

Its gap analysis is short: CR-CRU-225's analysis covered this scope before the split.

**Gap analysis 2026-11-01** (after CR-CRU-225 merged as `62a9abfc`):
- **Baseline:** CR-CRU-225's pre-merge gate on the identical tree: 10481/0 (bun 4539/0, python 5942/0; events
  `evt-1793492541466-75` and `evt-1793493838630-76`). No re-run is needed: `git diff 148507b1 62a9abfc` is empty.
- **What changed:** `framework` exists on every run and its event brief (CR-CRU-225), and the shared
  `start_stream_relay` and `close_streamed_run` exist. The reporters directory and its install exist.
- **Reach:** two more places key a BDD run on the `playwright` codec: `isSpecRun` (`public/app.js`) and the BDD tab's
  index, `bddIndexRows` (`public/app-logic.mjs`). Both are named in §S3.
- **The spec view's shape today:** `specFeaturesOf` splits each suite's name at `BDD_SEP` (` › `) into feature and
  scenario, and the steps are the suite's leaves. The new shape has the feature as the suite and the scenario as the
  test, so the view reads two shapes.
- **Cost (Dimension 7):** a full run of this repo's e2e suite inside the client test suite would add about 10 minutes to
  every gate. That is P3.

**Pre-review: due** — a new shipped artifact (a reporter), a migration, and a re-modelled view.

**PROPOSED, awaiting the user's ruling** (Rule 19):

- **P1:** the migration is v24, adding a `run_case_steps` table that holds a test's steps.
- **P2:** this repo's `test:e2e` moves to the table in this CR, which proves the Playwright stream on the real suite.
- **P3:** AC4 has two proofs. A small playwright-bdd fixture project, run through the bun client against a stub board,
  is the automated test: one feature, scenarios with steps, a failing step, a retried scenario, and two projects. The
  real `test:e2e` run against a scratch board is VERIFY's recorded proof, run once and not part of the gate.
- **P4:** the reporter's steps are the attempt's top-level `test.step` steps, which are the steps Playwright's own JSON
  reporter keeps, so the comparison with the `playwright` codec is like for like. Hooks and fixtures are not steps.

## Problem

- **Nothing uses Playwright's reporter API,** so a Playwright run reaches the board only at exit, through its JSON
  report and the `playwright` codec.
- **That codec counts steps as tests.** It builds one suite per scenario, with each Gherkin step as a test under it.
  A run of 5 scenarios files 75 tests, while its JUnit report says 5.

## Design

- **The Playwright reporter's tests are scenarios.** The reporter ships in `clients/reporters/` beside CR-CRU-225's
  Vitest one and emits `crucible-events`. Each `test-end` is one scenario per Playwright project, from its last
  attempt. It names:
  - the feature as its `suite`;
  - the project as its `browser`;
  - its Gherkin steps in `steps`, each with a name, status, duration and failure.
- **The board stores it the same way:** a suite per feature and browser, a test per scenario, and the scenario's steps
  under it. Counts are the tests'.
- **The run detail's specification view** reads feature → scenario → step from that shape for a `playwright-bdd` run, and
  still reads runs the `playwright` codec stored.

## Steps

### §S1 — steps under a test (board)

- **`crucible-events` `test-end` takes two optional keys:**
  - `browser`: a non-empty string;
  - `steps`: an array of `{name, status, duration_ms?, failure?}`, each read by the rules a `test-end` is.

  An ill-formed one makes the line undecodable, as an ill-formed key does today.
- **The tree.** The decoder groups test-ends into suites by (`suite`, `browser`); `SuiteNode.browser` is set from it.
  A test's steps become `TestLeaf.steps`.
- **The store.** `run_case_steps` *(P1)* holds each test's steps in order. The progressive reads answer a suite's tests
  with their steps (`getEventSuite`, `?suite=<name>&browser=<b>`), and the full read answers them on every leaf.
- **The counts are the tests', never the steps'.** A run's summary and a suite's counts count its tests.
- **Migration v24** adds `run_case_steps`. Runs stored before it read unchanged.

### §S2 — the Playwright reporter

- **`clients/reporters/playwright-crucible.ts`**, a Playwright reporter writing to the file the stream variable names. It
  emits:
  - `run-start` with the total (`onBegin`);
  - one `test-end` per test per project from its last attempt (`onTestEnd`, when no retry follows): `name` (the
    scenario), `suite` (the feature: the test's title path above it), `browser` (the project name), `file`,
    `status`, `duration_ms`, `failure`, and `steps`. The steps are the attempt's `test.step` steps, in order, with each
    step's error as its failure;
  - `run-end` with its totals (`onEnd`).
- **Status mapping:** passed → `pass`; failed or timed out → `fail`; skipped and interrupted → `pending`.
- **Installed** with CR-CRU-225's `reporters/`.
- **A config with no client.** With `CRUCIBLE_REPORTERS` unset, a config that adds the reporter from it adds nothing.

### §S3 — this repo's e2e streams *(P2)*, and the specification view

- **`package.json`:** `test:e2e` moves to `crucible.targets` as
  `{framework: "playwright-bdd", stream: {codec: "crucible-events", path: "env:CRUCIBLE_STREAM"}}`. Its `reportPath`
  and `rawReport` entries go.
- **`playwright.config.ts`** adds the reporter from `CRUCIBLE_REPORTERS` when it is set. It keeps the `junit` and `json`
  reporters, which CR-CRU-226 retires with the codec.
- **The specification view (`public/app.js`).** `isSpecRun` holds for a run whose framework is `playwright-bdd`, and still
  for a run stored by the `playwright` codec.
  - A new run reads feature → scenario → step from suites, tests and their steps.
  - An old run reads its scenario suites and their step leaves, as today.
  - The scenario's identity (name, browser) is unchanged.
- **The BDD tab's index** (`bddIndexRows`, `public/app-logic.mjs`) lists a run whose framework is `playwright-bdd` as
  well as a run stored by the `playwright` codec.

### §S4 — the record of the design, and the close-out

- **The PRD:** §4.4 names the Playwright reporter, `test-end`'s `steps` and `browser`, and scenario-as-test.
- **The DN:** the "Playwright's steps in the live state are CR-CRU-201's" sentence becomes ruling 3 (steps are in the
  record, not the live state), and its pin in `tests/docs-live-test-stream-design-record.test.ts` moves with it.
- **Schema:** `docs/RUNBOOK.md` reads v24.
- **The local API doc:** `.lavish/crucible-server-api.html` (not in git) is updated for `steps` and `browser`.
- **The close-out:** `SHARED_MODULE_LINE_BUDGETS` and the `PROSE_CITATIONS` heads are re-recorded once each, in their own
  commits.

### Dog-food (Rule 21)

`test:e2e` is excluded from the gate fleet-wide, and the gate's bun suites are untouched. The DEV board ignores `steps`
and `browser` until it runs the merged code. AC4 proves the stream on a scratch board.

## Acceptance criteria

- [ ] **AC1 — steps under a test.**
  - A `crucible-events` stream with `browser` and `steps` decodes to suites keyed by (`suite`, `browser`), and tests
    carrying their steps.
  - An ill-formed `steps` or `browser` makes its line undecodable.
  - The summary counts tests, not steps.
  - `run_case_steps` stores the steps, and the full and `?suite=&browser=` reads answer them.
  - Runs stored before v24 read unchanged, and RUNBOOK reads v24.
- [ ] **AC2 — the reporter.**
  - On a Playwright fixture run, it emits the events §S2 states, steps and retries included.
  - It writes nothing with `CRUCIBLE_REPORTERS` unset.
  - It is installed.
- [ ] **AC3 — the specification view.** In the run detail, a `playwright-bdd` run opens as feature → scenario → step from
  its tests and steps, and a run stored by the `playwright` codec opens as today. Both are shown on stored fixtures. The
  BDD tab's index lists both.
- [ ] **AC4 — a BDD run streams** *(P3)*. A playwright-bdd fixture project (one feature, scenarios with steps, a
  failing step, a retried scenario, two projects), run through the bun client against a stub board, and — as VERIFY's
  recorded proof, outside the gate — this repo's `test:e2e` against a scratch board built from this branch:
  - it is closed by its stream, with framework `playwright-bdd`;
  - its scenario count equals the same run's JUnit `tests`;
  - each scenario's steps equal, by name, status and order, what the `playwright` codec decodes from the same run's
    JSON report;
  - each scenario sits under its feature and browser.
- [ ] **AC5 — the design record and the guards.**
  - PRD §4.4 and the DN read as §S4 states, and the DN pin moves.
  - The citations guard passes, and no in-scope file reaches 10,000 lines.
- [ ] **AC6 — the close-out.** The pins are re-recorded once each, in their own commits.

## Non-goals

- **Live steps** (ruling 3).
- **Retiring the `playwright` codec and the JSON report** (CR-CRU-226).
- **Re-shaping runs already stored by the `playwright` codec.**
