# CR-CRU-229 — the playwright codec retires, its runs migrate, and the junit readings follow the framework

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-226, CR-CRU-228 · **Status** PENDING ·
Pre-review: due — 13 points; split from CR-CRU-226 by user ruling
- **Filed 2026-11-04.** Split from CR-CRU-226 at its gap analysis (user ruling 2026-11-04: two CRs, the client's break
  first, then the board's half in this one). It gets its own gap analysis when it comes up in the queue (Rule 20).

## Problem

- **Playwright's JSON report and the board's `playwright` codec are redundant.** Since CR-CRU-228 the shipped reporter
  streams each scenario as a test with its Gherkin steps, as `crucible-events` with framework `playwright-bdd`. After
  CR-CRU-226 refuses `crucible.rawReport`, nothing a project declares reaches the codec; only this repo's own test
  fixtures post Playwright JSON (the e2e harness's `ingestPlaywright` and 29 test files).
- **Stored runs keep a second shape.** The dev board holds 225 runs filed through the codec: a suite per scenario, its
  steps as cases. The UI tells them apart by codec (`public/app.js` `isSpecRun` / `isScenarioShape`,
  `public/app-logic.mjs`).
- **Two `junit` readings switch on the client's stack**, not the framework that wrote the report:
  - `parseJunit` groups cases by classname when `stack === "python"` and the suite is named `pytest`;
  - `readJunitRawOutput` reads the console as bun's only when `stack === "bun"`.
  The python client sends no framework at all (`framework=None` on every path).

## Design (user rulings 2026-10-31 and 2026-11-04; `DN-crucible-live-test-progress.md`)

- **Retirement** (user ruling 2026-11-04). The board stops accepting Playwright JSON: the `playwright` codec leaves the
  registry and the health codec list, and a post naming it is refused as an unknown codec. Playwright's JSON report
  leaves `playwright.config.ts` and the client's kept reports (`STREAM_KEPT_REPORTS`).
- **The stored runs migrate to framework `playwright-bdd`** (user ruling 2026-11-04). PROPOSED: a migration sets the
  framework and reshapes each run into the scenario shape the stream stores (one suite per feature and browser, a case
  per scenario, its steps in `run_case_steps`), in `run_suites` / `run_cases` / `run_case_steps` and the event's `tree`;
  the stored `codec` stays as the record of how the run was filed. The UI's codec checks then collapse to the
  framework.
- **The test fixtures re-seed through the stream** (user ruling 2026-11-04). The e2e harness and the tests that post
  Playwright JSON post `crucible-events` streams with steps instead; `tests/playwright-codec.test.ts` is deleted.
- **Readings keyed by the declared framework** (user ruling 2026-10-31). pytest's classname grouping applies to a run of
  framework `pytest`, and the bun console reading to a run of framework `bun-test`, whatever the stack. The `stack`
  field stays only as the run's label.
- **The python client sends its framework.** PROPOSED: its runner name, `pytest` or `unittest`, on every run it files.

## Steps

Written at this CR's gap analysis.

## Acceptance criteria

Made exact at the gap analysis. At least:

- [ ] No `playwright` codec is registered or listed in health, and a post naming it is refused.
- [ ] No config or client writes Playwright's JSON report.
- [ ] Every stored run filed through the codec reads as framework `playwright-bdd` in the scenario shape, and the UI
      decides the specification view by framework alone.
- [ ] No test posts Playwright JSON.
- [ ] Neither `junit` reading switches on `stack`; each applies to a run whose framework is `pytest` or `bun-test`,
      whatever its stack, and the python client files its runner as its framework.

## Non-goals

- **The bun declaration's clean break and the gate** (CR-CRU-226).
- **What `regression` runs** (CR-CRU-222).
