# CR-CRU-145 — one Gherkin renderer, and the BDD tab is its index

**Type** fix · **Points** 8 · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-015 · **Status** COMPLETED (0.3.0)

> **Close-out 2026-09-25.** Delivered as plan 158 in three RED+GREEN cycles (codec → run detail →
> index and cutover) plus VERIFY, which approved with findings that were fixed in-cycle. **Named gap
> (§S3):** Playwright's `trace.zip` (`trace: "retain-on-failure"`) is still not ingested, stored or
> linked. A failing step offers its stored stack behind `stack ▸`, and nothing in the UI offers
> `trace ↗`. Storing artifacts would be its own CR.
>
> **Gap analysis 2026-09-24** (baseline bun 2741/0, python 1930/0 at `1056f8f`). **Storyboard F11 is
> redrawn to this CR's design and approved**: it is the visual contract. Folded in by user rulings:
> progressive expansion (§S1), a verdict per browser (§S3, a codec defect measured here), and
> `trace ↗` as the stored stack only, with `trace.zip` a named gap (§S3). Line citations are replaced
> by symbol names; the old ones had drifted by hundreds of lines.
>
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
| BDD pane (CR-CRU-015 §S3) | the **latest** run only (`latestBddEventId()`, `public/app.js`), no selection, no history — but with every step EXPANDED, which is what the user endorses |

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
opens as a specification rather than as a test tree, **expanded progressively** (user ruling
2026-09-24, storyboard F11 redrawn and approved): on open, the **failing scenarios** and the **first
scenarios of the first feature** show their Gherkin steps, green features fold, and the remaining
scenarios load their steps **as they scroll into view**. A long run is never loaded or rendered in
one go. Every other codec's default is untouched.

**Why progressive, not all-expanded:** the drill-in reads a run as `?depth=suites` then
`?suite=<name>` per suite (the suites reply carries no steps). "Every step expanded on open" would
have meant fetching every suite at open, contradicting the §S1 AC that a 524-row run is not
rendered eagerly. The ruling resolved that conflict in favour of progressive loading.

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

Nothing new is needed to find the runs: `visibleEvents()` (`public/app.js`) already holds the
history client-side. The existing chain — `linkedRunsFor(cycleId)`, the `cycleId`-anchored
evidence read (CR-CRU-140 §S1), the first-class `cycleId` on the event (CR-CRU-094 §S1)
— is the primary path and is left alone; this index is the direct-entry complement to it, not a fork.

### §S3 — what the drill-in genuinely lacks for a specification

Measured in `src/codecs/playwright.ts`, these are the only F11 elements no surface can express today:

- **The browser, and a verdict per browser.** `collectScenarios` passes `suite.title` and the spec;
  the report's per-test `projectName` is dropped, so `· chromium ·` cannot be drawn anywhere. Worse,
  measured at gap analysis 2026-09-24: `specToNode` flattens the results of **all** of a spec's
  `tests` and keeps the **last** as the verdict ("earlier attempts are retries"). A spec's `tests`
  are one per **Playwright project**, not per retry, and `chromium-mobile` and `webkit-iphone` both
  run `mobile-viewport-responsive.feature` (`playwright.config.ts` `testMatch`). Whenever WebKit
  runs, one browser's verdict silently replaces the other's, so a WebKit pass can hide a Chromium
  failure. **Fix (user ruling 2026-09-24, folded here):** one scenario node per (spec, project),
  named with its `projectName`; retries stay within a project (the last attempt **of that project**
  is its verdict). This is additive to the node shape, not the parser rewrite CR-CRU-015's non-goal
  forbids.
- **`trace ↗` means the stored stack only (user ruling 2026-09-24).** The codec's `failure.trace` is
  `step.error.stack`, already stored; the failing step shows it behind a `stack ▸` disclosure under
  its message. `playwright.config.ts`'s `trace: "retain-on-failure"` `trace.zip` is **not** ingested,
  stored or linked, there is **no `trace ↗` link**, and close-out names that gap. Artifact storage
  would be its own CR.

Per-scenario **duration** already reaches the event (`duration_ms` per step leaf, `stepLeaf`) and
per-feature **counts** already render in the drill-in (`✓4`), so neither needs building — only
verifying.

### §S4 — what CR-CRU-015 §S3 shipped, and what becomes of it

- **The bespoke BDD renderer is RETIRED.** `BddFeed`/`BddFeature`/`BddScenario`/`BddStep`
  (`public/app.js`) duplicate the drill-in once §S1 lands. They go; no shim, no second code
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
- [ ] A `codec: "playwright"` run's detail opens **progressively expanded**, per F11 B. Features are
      ordered failures first. The **first feature in that order** is expanded: its failing scenarios
      and its first scenarios show their ordered `Given`/`When`/`Then` with per-step status without
      clicking, and its later scenarios have rows that load their steps when they scroll into view,
      without a click. Every other feature containing a failure is expanded with its failing
      scenarios' steps shown. Every other all-green feature is **folded** (no scenario rows until
      clicked). In an all-green run, the report-first feature is the one expanded. Asserted on a
      real ingested run. (Rule settled at C2 GREEN 2026-09-24, when two RED readings contradicted.)
- [ ] A long run is neither fetched nor rendered in one go: opening a run with more scenarios than
      the initial expansion issues **no** per-suite read for a scenario that has not scrolled into
      view. Asserted on the requests made, not on timing.
- [ ] A failing step still shows its message AT that step.
- [ ] **A scenario that ran under two browsers opens that browser's own steps.** The suites read
      (`?depth=suites`) carries each scenario node's `browser`; the per-suite read is narrowed by
      browser as well as name; and the run detail keys every per-scenario state (loaded leaves,
      loading flag, window, leaf keys) by (name, browser). Asserted on a two-browser run in which
      the FIRST-listed browser passes and the second fails: expanding the failing browser's row
      shows its failing step, never the passing browser's steps. (Found at C1 GREEN 2026-09-24: the
      per-suite read returned the first same-named node, and the run detail keyed by name alone.)
- [ ] Non-playwright runs' details are UNCHANGED — same default expansion as today, asserted, so this
      does not become a global behaviour change.
- [ ] The drill-in's existing frame still applies to a playwright run: collapse works, per-scenario
      counts render, failures float and green folds through `L.foldSuites`/`L.digestFailures`, and a
      524-row run is not rendered eagerly. Asserted as REUSE — the same functions, no second
      implementation.

**§S2 — the index**
- [ ] The BDD tab lists the project's BDD-bearing runs, newest first. Each row names when (the
      board's relative-time idiom), who filed it, its cycle where it has one, and its verdict with
      scenario counts (F11 A); an unbound run is listed as unbound.
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
      `tests/playwright-codec.test.ts` GAINS cases for that field rather than having existing cases
      rewritten.
- [ ] **A verdict per browser.** A report in which one spec ran under two projects, one failing and
      one passing, decodes to **two** scenario nodes, each named with its project and each with its
      own verdict, in either project order: the failing browser is never hidden by the other.
      Retries within ONE project still resolve to that project's last attempt. The run summary
      counts both.
- [ ] A failing step's stack is reachable in the UI behind a `stack ▸` disclosure at that step. No
      `trace ↗` link to a `trace.zip` exists anywhere in the UI, and close-out names the unstored
      artifact as a gap.

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
