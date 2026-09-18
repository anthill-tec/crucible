# CR-CRU-145 — one Gherkin renderer, and the BDD tab is its index

**Type** fix · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-015 · **Status** PENDING

> **RE-SPECIFIED 2026-09-18 after the user read the shipped UI: *"I just noticed that the run detail
> view from an e2e run actually renders the Gherkin results. So is the BDD only view an overkill?"***
> The first draft of this CR said "give the BDD pane a run list, F11's collapsible tree with counts,
> failures-float, and virtualization". Measured, most of that already exists in the generic run
> drill-in. Building it again in the BDD pane would have been a SECOND renderer for one tree. This
> re-spec deletes that duplication before it is written.

## Problem

**User-reported 2026-09-18:** *"There is a disconnect between it and the other runs views, i.e. each
run of the e2e is not being shown. There is no tree view rather than the last e2e run's output."*

Measured on the live board at `8f8312d`:

| Surface | What it does today |
|---|---|
| Runs pane | **21 e2e run cards** (agent · tier · codec · relative time · duration · counts), each opening `/p/<key>/run/<id>` |
| **run detail** for an e2e run | **already renders the Gherkin tree** — `▸ <Feature> › <Scenario>` rows with per-scenario counts (`✓4`, `✓5`, `✓13`), collapsed; steps one expand away. Header: `RUN DETAIL · EVT-…-38`, `✗ failures 0 · ⏭ pending 0 · ✓ passed 524` |
| BDD pane (CR-CRU-015 §S3) | the **latest** run only (`latestBddEventId()`, `public/app.js:2682`), no selection, no history — but with every step EXPANDED, which is what the user endorses |

So there are two renderers of one tree. The drill-in has the frame (collapse, per-scenario counts,
failures-float via `L.foldSuites`/`L.digestFailures`, `drillinDefaultMode("e2e") === "Density"`,
§S4.4 virtualization) and reaches every run through the hierarchy. The BDD pane has the leaf the user
wants (steps, expanded, verbatim) and reaches exactly one run.

**Neither is wrong; the split is.** The fix is one renderer that does both, and a BDD tab that stops
pretending to be a run view.

**Design lineage — and a spec error of mine.** Storyboard frame **F11 ("Frontend project — the BDD
harness", `badge: approved`)** draws collapsible features with per-feature `11 ✓ 1 ✗`, per-scenario
browser and duration, and `trace ↗`. CR-CRU-015 §S3 refused "a run list" and "counts", and hardened
that into an AC — authored without reading F11. The storyboard is the design authority; the refusal
was wrong, and §S4 below retires it.

## Scope

### §S1 — ONE renderer: the run detail, opened as a specification for BDD runs

The run detail stays the single place a run's tree is drawn. For a **`codec: "playwright"`** run it
opens as a specification rather than as a test tree: **steps expanded by default**, so the Gherkin
reads top-to-bottom — the behaviour the user endorses, moved to where every entry point already
lands. Every other codec's default is untouched.

Nothing else about the drill-in changes: its collapse, per-scenario counts, failure-float, digest and
virtualization are the frame this CR wanted, and they are reused by not being touched. The tier
default (`drillinDefaultMode("e2e") → "Density"`) already means failures float and green folds.

### §S2 — the BDD tab is an INDEX, honouring the hierarchy it sits in

**User ruling 2026-09-18:** *"today there is a seamless link between a workflow run (cycle →
agent-run → detail)"* and *"when an e2e test run takes place as part of the cycle that hierarchy
should be honoured."*

So the tab answers *"which BDD runs exist, and whose evidence is each"* and then hands off — it never
renders a tree of its own:

- it lists the project's BDD-bearing runs (`kind === "test" && codec === "playwright"` — the
  predicate `latestBddEventId()` already uses), newest first;
- each row names the run's **cycle** where it has one, so the index and the Workflow view agree.
  Unbound runs (a fleet gate or ad-hoc probe — legitimate per CR-CRU-094 §S3) are listed AS unbound,
  never hidden and never attributed to a cycle they do not carry;
- a row opens that run's detail — the same `/p/<key>/run/<id>` route (CR-CRU-016 §S3) the Runs pane
  and the Workflow chain use. No second route, no embedded copy.

Nothing new is needed to find the runs: `visibleEvents()` (`public/app.js:461`) already holds the
history client-side. The existing chain — `linkedRunsFor(cycleId)` (`:4082`), the `cycleId`-anchored
evidence read (`:4305-4316`, CR-CRU-140 §S1), the first-class `cycleId` on the event (CR-CRU-094 §S1)
— is the primary path and is left alone; this index is the direct-entry complement to it, not a fork.

### §S3 — what the drill-in genuinely lacks for a specification

Measured in `src/codecs/playwright.ts`, these are the only F11 elements no surface can express today:

- **The browser.** `collectScenarios` (:81-86) passes `suite.title` and the spec; the report's
  per-test `projectName` is dropped, so `· chromium ·` cannot be drawn anywhere. Adding that one
  field is additive, not the parser rewrite CR-CRU-015's non-goal forbids — but it IS a codec change,
  so it is stated here.
- **`trace ↗` means two different things.** The codec's `failure.trace` is `step.error.stack` (:58) —
  a string, already stored. `playwright.config.ts` separately declares `trace: "retain-on-failure"`,
  writing a **trace.zip** artifact that nothing ingests or serves. Rendering the stack is free;
  linking the artifact needs artifact storage. Decide explicitly, and never ship a link that
  silently shows a stack.

Per-scenario **duration** already reaches the event (`duration_ms` per step leaf, :53) and
per-feature **counts** already render in the drill-in (`✓4`), so neither needs building — only
verifying.

### §S4 — what CR-CRU-015 §S3 shipped, and what becomes of it

- **The bespoke BDD renderer is RETIRED.** `BddFeed`/`BddFeature`/`BddScenario`/`BddStep`
  (`public/app.js:2649-2800`) duplicate the drill-in once §S1 lands. They go; no shim, no second code
  path kept "just in case". The Gherkin view the user likes is preserved by §S1 — it moves, it is not
  removed. An AC proves the step-level output still exists where a reader now finds it.
- **`tests/bdd-section.test.ts` MIGRATES rather than being deleted.** Its 13 assertions are the
  behavioural contract for the Gherkin output (step order, verbatim text, per-step status, failure at
  the failing step, empty state, frontend-only gate, the two-dimming discrimination). They re-point
  at the surface that now renders it. A test that only asserted the retired component's internals is
  deleted; a test that asserts observable Gherkin behaviour is kept and re-pointed.
- **The no-tally bound is superseded.** The `NAMED, never TALLIED` case is amended, not dropped: what
  survives is that the BDD tab does not reproduce the Runs timeline's card grammar. Per-feature and
  per-scenario counts are the specification's own content — F11 draws them, and the drill-in already
  renders them.
- **The C3 identity byline.** Measured: the run detail identifies a run by **event id and counts**
  (`RUN DETAIL · EVT-…-38`), NOT by agent or recorded time — those sit on the timeline card a reader
  arrived from, and a reader arriving from the BDD index or a deep link never saw one. So C3's
  requirement keeps its force and moves with the renderer: whoever renders a playwright run's
  specification names WHO filed it and WHEN, in the board's own relative-time idiom.
- **F11's `▶ Run BDD suite` button stays retired** — the user retired server-side execution when
  re-specifying CR-CRU-015. This CR takes F11's content design, not its execution model.

## Acceptance criteria

**§S1 — one renderer**
- [ ] A `codec: "playwright"` run's detail opens with its Gherkin steps EXPANDED: feature, scenarios,
      and each scenario's ordered `Given`/`When`/`Then` with per-step status, read top-to-bottom
      without clicking. Asserted on a real ingested run.
- [ ] A failing step still shows its message AT that step.
- [ ] Non-playwright runs' details are UNCHANGED — same default expansion as today, asserted, so this
      does not become a global behaviour change.
- [ ] The drill-in's existing frame still applies to a playwright run: collapse works, per-scenario
      counts render, failures float and green folds through `L.foldSuites`/`L.digestFailures`, and a
      524-row run is not rendered eagerly. Asserted as REUSE — the same functions, no second
      implementation.

**§S2 — the index**
- [ ] The BDD tab lists the project's BDD-bearing runs, newest first, each naming its cycle where it
      has one; an unbound run is listed as unbound.
- [ ] A row opens that run's detail via the SAME `/p/<key>/run/<id>` route the Runs pane and the
      Workflow chain use — asserted on the route, so a second renderer cannot creep back in.
- [ ] Reaching a run through cycle → linked runs → detail lands the same rendering as the index does.
- [ ] A project with no BDD-bearing run shows the CR-CRU-078 empty state with no index chrome
      implying runs exist, still naming NO CR id and NO release version
      (`tests/project-independence-strings.test.ts:172` keeps passing untouched).
- [ ] The tab stays frontend-only: `workspaceTabs(project)` still disables BDD for
      `type !== "frontend"`, and the project-type-independent tabs stay enabled for a backend project.

**§S3 — the missing frame elements**
- [ ] Each scenario names the browser it ran in, from the report's `projectName` through the codec;
      `tests/playwright-codec.test.ts` GAINS a case for that field rather than having existing cases
      rewritten.
- [ ] A failing step's stack is reachable in the UI, and whatever is not shipped (the trace.zip
      artifact link) is named at close-out rather than left as an implied gap.

**§S4 — the cutover**
- [ ] `BddFeed` and its sibling components are GONE from `public/app.js` — no shim, no dead branch,
      no second path. Asserted by absence, not by inspection.
- [ ] The Gherkin step-level output still exists and is asserted where it now renders; the migrated
      assertions from `tests/bdd-section.test.ts` pass against the single renderer.
- [ ] Whoever renders a playwright run's specification names WHO filed it and WHEN, in the board's
      own relative-time idiom, and follows the subject (a different run named when a different run is
      opened).

## Risk

- **The step-level view being lost in the move.** It is the thing the user explicitly endorsed. §S4's
  second AC exists to fail the CR if it disappears, and §S1's first AC asserts it at the new home.
- **Turning a global default into a BDD-only one by accident.** §S1's third AC pins every other
  codec's behaviour.
- **The index drifting into a second Runs timeline.** It routes to the shared detail and carries no
  tree of its own, which is the structural guard rather than a rule to remember.

## Non-goals

- Server-side execution of Playwright (F11's button) — retired at CR-CRU-015.
- Rewriting the playwright codec. §S3 adds one dropped field; existing behaviour and unit coverage
  stand.
- Artifact storage for trace.zip, unless §S3's decision takes it explicitly.
- Changing the Runs pane, the Workflow chain, or the drill-in's behaviour for any other tier.
