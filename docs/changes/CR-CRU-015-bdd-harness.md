# CR-CRU-015 — the BDD-driven e2e suite reaches the board, with its scenarios intact

**Type** feature · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-004, CR-CRU-007 · **Status** PENDING

> **RE-SPECIFIED 2026-09-17 (user ruling, option 2).** The original CR — filed at kickoff, when
> Crucible was "not just a sink" — had the SERVER execute Playwright against a project's `sutRoot`
> on demand, driven by a dashboard button. That premise is retired: since CR-CRU-030 every tier in
> this system is run BY the client and ingested, which is why `bdd` is already a declared tier in
> the fleet's own vocabulary. A server that spawns test runs would be a SECOND execution mechanism
> for something the fleet owns, inside an unauthenticated HTTP service whose own configuration
> comments warn it "stays LOOPBACK unless an operator deliberately widens it". The stale header
> (`Status: PENDING (0.2.0)`, `Phase: Wave 5`, "runs as track-2 in parallel with CR-CRU-014") is
> corrected with it; CR-CRU-014 shipped in 0.2.0.

## Problem

Every piece of the BDD path exists, and nothing connects them. Measured on `develop` at `fe7794c`:

| Piece | State |
|---|---|
| Gherkin features | **16** under `tests/e2e/features/` |
| The harness that runs them | `package.json`'s `test:e2e` — `bunx bddgen && bunx playwright test` (playwright-bdd) |
| The `bdd` tier | declared server-side (`src/v2.ts:687`) and in the fleet vocabulary (`clients/_crucible_axi.py:4904` — *"executable specifications, in the project's own BDD form"*) |
| The playwright codec | `src/codecs/playwright.ts`, 125 lines, registered in the codec map as `"playwright"` (`src/codecs/index.ts:20-27`), unit-tested by `tests/playwright-codec.test.ts` |
| A `test:bdd` declared target | **absent** |
| Any client that selects the codec | **none** — `grep playwright clients/*.py` returns zero hits |
| A BDD surface | absent, and the UI says so at `public/app.js:2644`: *"BDD run results already stream into the Runs timeline — a dedicated BDD surface does not exist yet"* |

So sixteen executable specifications run on every CI push and **not one of their results reaches
Crucible as `bdd`**. They are collected under `test:e2e`, which the pre-merge gate excludes
fleet-wide (DN open question 5), so the BDD suite is the least-reported tier in the project while
being the one written in the project's own domain language.

And the `playwright` codec is **dead in the real workflow**: reachable only through the raw API, never
selected by the fleet. A codec no caller selects is not a feature, it is an unexercised parser — the
same shape CR-CRU-140 found in the cycle-evidence read, where the capability existed and nothing
pointed at it.

## Scope

### §S1 — the e2e suite is BDD-driven, files as `e2e`, and reaches the board at all

**USER RULING 2026-09-17, overriding this CR's first two drafts: for a UI-driven project, `e2e` MAY
use Playwright and BDD.** BDD and Playwright are the MEANS; `e2e` is the tier. So there is no
rename, no `test:bdd`, and no tier change — an earlier draft of this section proposed migrating
`test:e2e` to `test:bdd` on the strength of the DN's marker row ("feature files, generated specs"),
which read the means as the dependency. The dependency this suite takes is the assembled product
driven through a browser, which is `e2e`.

What is measurably wrong is narrower and worse: **the suite's results never reach the board.**
Measured on `develop` at `fe7794c`:

- `playwright.config.ts:76-77` is `defineBddConfig({ features: "tests/e2e/features/*.feature" })`
  with `testDir` on the generated output; `bunx playwright test --list` reports
  **`Total: 46 tests in 16 files`**, every one generated from a `.feature`.
- `test:e2e` is excluded from the pre-merge gate fleet-wide, and nothing else files it, so those 46
  scenarios run on every CI push and produce no board record whatsoever.
- The `playwright` codec that would carry their scenario-level detail has no caller
  (`grep playwright clients/*.py` → zero hits), so even an ingest today would flatten them through
  JUnit into counts.

So §S1 makes the existing suite's existing runs land, as `e2e`, carrying the per-scenario detail a
specification language exists to produce. It does NOT decide who SHOULD run and gate the browser
tiers — that is DN open question 5, still unanswered, and a non-goal below.

### §S2 — the codec that already parses the Gherkin gets a caller

`src/codecs/playwright.ts` does not need writing. Read on the merged tree, it already produces
exactly the tree the BDD UI needs, and its own header records why: *"CR-CRU-007 C5b (pulled forward
from CR-CRU-015 §S2)"* — this CR's codec work was delivered early and then left unreachable.

What it yields, per its own code:

- one `SuiteNode` **per scenario**, named `<Feature title> › <Scenario title>` — playwright-bdd
  surfaces Gherkin feature and scenario names as ordinary suite/spec titles;
- one `TestLeaf` **per Gherkin step**, in step order, `name` being the step text
  (`Given …` / `When …` / `Then …`);
- per-step `status`, and on a failing step `failure.message` plus `trace`;
- the LAST attempt's steps, so a retried scenario reports its verdict rather than its history.

The gap is the caller: `grep playwright clients/*.py` returns zero hits, so every run is either not
ingested at all or flattened through JUnit into counts, which discards the steps.

**The decode happens ON THE SERVER, and that is a decision, not a preference (user ruling).** The
harness provides the output; the server renders it into the BDD UI. Measured, the path already
exists and the two routes are not interchangeable:

| Route | What it does | What the event records |
|---|---|---|
| `POST /api/v2/runs` (`src/v2.ts:974-1021`) | reads `body.codec` (default `"junit"`), resolves it in the registry, and `parseRunBody(codec, body, …)` decodes the report from `data` or `dataPath` | `codec: <name>` — the server's own parse, with provenance |
| `POST /api/v2/runs/parsed` (`:1024-1084`) | takes a `summary` + `tree` the CLIENT already parsed | `codec: "parsed"` |

So the harness posts the raw playwright JSON report with **`codec: "playwright"`** to
`POST /api/v2/runs`, and the server's own registry codec — registry-only by CR-CRU-010 §S1 — turns it
into the feature → scenario → step tree the UI reads. The `runs/parsed` path is REFUSED for this
suite: a client-side parse would flatten the Gherkin before the server ever saw it, store
`codec: "parsed"`, and leave the BDD section rendering something no codec vouches for.

### §S3 — the BDD section that already exists gets populated with the Gherkin execution output

**USER RULING: there IS a BDD section in the UI, and showing the Gherkin execution output is what it
is for.** This is a POPULATION of an existing, already-routed surface — not a new tab, not a second
Runs timeline, not a pass/fail tally. Measured, the section is present and wired:

| Site | State today |
|---|---|
| `public/app.js:2638` `BddFeed` | renders ONE string and nothing else |
| `public/app.js:2644-2645` | that string: *"BDD run results already stream into the Runs timeline — a dedicated BDD surface does not exist yet"* |
| `public/app.js:2650` `BddPlaceholder` | wraps `BddFeed` in `greyed(...)` — the tab is deliberately dimmed |
| `public/app.js:4841` | `state.workspaceTab === "BDD"` — the route already dispatches here |

So the tab row has promised this since CR-CRU-007 and the dispatch has been in place all along; only
the content is absent. `BddFeed` renders the feature, its scenarios, and each scenario's
`Given`/`When`/`Then` steps in order with the outcome of each, straight off the codec's tree
(scenario nodes named `<Feature> › <Scenario>`, step leaves in step order). A failing step shows its
`failure.message` AT that step — which step of the specification broke is the thing a Gherkin report
is read for, not merely that the scenario did. The `greyed(...)` wrapper and the
"does not exist yet" copy both go, because neither is true once the section renders.

**The section is frontend-only, and that gate already exists (user ruling: not backend projects).**
`public/app-logic.mjs:300-314`'s `workspaceTabs(project)` already returns
`disabled: name === "BDD" && project.type !== "frontend"`, with the docstring saying so outright —
so backend projects (this board carries two: Model B, Sandesh) cannot reach the tab today. This CR
does NOT build that gate; it must not break it. Populating a section is precisely the change that
un-gates one by accident — the content arrives, someone tests it on the one frontend project, and
nobody notices the tab came alive everywhere. So the gate gets a rail, not a rewrite.

### §S4 — the downstream CRs this feature set already has

Checked against every CR spec, not assumed (`grep -ril 'bdd|gherkin|playwright' docs/changes/`):
29 specs mention them; of those only these are still open, and two of them matter here.

**CR-CRU-018 (responsive mobile, PENDING) CONSUMES this suite.** Two of its own ACs are written on
it verbatim: *"BDD E2E with mobile viewport projects (Playwright devices `Pixel 7` or equivalent + a
tablet profile)"* and *"Desktop is pixel-unchanged at ≥1280px (the existing desktop BDD scenarios
re-run green with zero modification)"*. So CR-018 will ADD scenarios to the 16 features and re-run
the existing ones as its evidence. It does not need the BDD section to exist — the suite already
runs — but its evidence is exactly what this section renders, so **CR-015 lands first** and CR-018's
viewport scenarios then report where a reader can see them. `docs/changes/README.md`'s row for
CR-018 gains `015` in its `Depends on` column for that reason: an ordering fact, stated where the
queue derives ordering from.

**CR-CRU-097 §S1/§S4 OWNS the copy §S3 deletes, and a shipped guard pins its rule.**
`tests/project-independence-strings.test.ts` asserts CR-097's AC1 — *"The BDD empty state names no
CR and no release version; it states the capability"* — because the string this CR removes is itself
a CR-097 correction: the pane previously read *"the dedicated BDD surface lands in CR-CRU-015
(0.2.0)"*, and CR-097 struck that on the rule that an empty state may say a surface is not built,
but may not cite the builder's backlog, because *"a plan moves, and a string does not move with
it"*. §S3 must therefore (a) keep an empty state for the no-run case, (b) keep it free of CR ids
and version numbers, and (c) leave that guard passing rather than re-pinning it to new text. A CR
that deleted the string and the guard together would re-open a defect CR-097 closed.

**Not related, checked and dismissed:** CR-CRU-022 (roadmap analytics) and CR-CRU-098 (the plan
pointer has no publisher) mention none of these; CR-CRU-082 is VOID; CR-CRU-141 names Playwright
only as the cost of the e2e tier and already defers browser-tier ownership to DN open question 5.

## Acceptance criteria

**§S1**
- [ ] `test:e2e` KEEPS its name and the suite keeps `tier: e2e` — no rename, no second target, no
      tier change. Asserted by a test pinning that the declared target for this suite is `test:e2e`
      and that its runs file as `e2e`, so a later author cannot "tidy" it into `test:bdd`.
- [ ] The suite's results are INGESTED at all: today 46 scenarios across 16 features run on every
      CI push and nothing reaches the board. A real `bun-crucible.py e2e` invocation files a run,
      asserted on the stored event.
- [ ] That ingest carries SCENARIO-LEVEL detail — the thing a specification language exists to
      produce — not just a pass/fail total. Asserted against the stored event's own shape.
- [ ] The declared-target guard (`tests/ci-toolchain-provisioning.test.ts` plus the declared-target
      tests CR-CRU-133 established) covers `test:e2e`, so its declaration cannot silently change.

**§S2**
- [ ] A REAL client invocation of this project's e2e suite causes the `"playwright"` codec to parse
      the report — asserted by driving the client and reading the STORED event, and failing if the
      run was decoded as `junit` (which would flatten the steps into counts).
- [ ] The stored event carries the Gherkin structure the codec produces: scenario nodes named
      `<Feature> › <Scenario>`, each holding its steps IN ORDER with the step text as the leaf name.
      Asserted against a real run of the 16-feature suite, not a fixture.
- [ ] A failing step's `failure.message` survives to the stored event on THAT step — proven by a
      deliberately failing scenario, so the report can say which step of the specification broke.
- [ ] `tests/playwright-codec.test.ts` keeps its unit coverage unchanged — this CR adds a caller; it
      does not rewrite the parser (whose header records it was pulled forward by CR-CRU-007 C5b).

**§S3**
- [ ] The BDD tab renders the GHERKIN of a real ingested run: the feature, its scenarios, and each
      scenario's `Given`/`When`/`Then` steps in order, each with its own outcome — not a tally and
      not a second Runs timeline. This is the tab's stated purpose (user ruling).
- [ ] A failing scenario renders its failure AT the step that failed, carrying the message, so a
      reader sees which step of the specification broke.
- [ ] A Chromium-tier test drives the tab against a real ingested run and asserts the rendered
      Gherkin — feature title, scenario titles, ordered step text and per-step outcomes — at the
      storyboard compliance bar, not a smoke check.
- [ ] `public/app.js:2644`'s "a dedicated BDD surface does not exist yet" note is DELETED, because
      it is no longer true; a test asserts the claim is gone rather than left contradicting the UI.
- [ ] With no run recorded, the tab shows a definitive empty state rather than a broken or greyed
      surface (CR-CRU-078's empty-state rule) — and that empty state still names NO CR id and NO
      release version, so `tests/project-independence-strings.test.ts` (CR-CRU-097 AC1) keeps
      passing UNCHANGED. The guard is not re-pinned to new copy; if satisfying §S3 requires editing
      it, that is a finding to escalate.
- [ ] The tab stays frontend-only: `workspaceTabs(project)` still returns
      `disabled: true` for `BDD` on a `type !== "frontend"` project, asserted for a backend project
      — the gate exists today and populating the section must not un-gate it.
- [ ] The `greyed(...)` wrapper on the populated section is gone for a frontend project with runs,
      and a test distinguishes "greyed because gated" from "greyed because unbuilt" so the two
      cannot be conflated again.

**§S4**
- [ ] `docs/changes/README.md`'s CR-CRU-018 row lists `015` among its dependencies, so the queue's
      own ordering carries the fact that CR-018's viewport evidence renders in this section.
- [ ] No downstream CR's acceptance criteria are invalidated by this CR — checked against
      CR-CRU-018's two BDD ACs specifically, which must still be satisfiable (its mobile scenarios
      join the same 16-feature suite; nothing here forbids adding features or viewport projects).

## Estimated size

Medium. §S1 is a declaration plus wiring the verb; §S2 is a codec selection and the proof it is
reached; §S3 is a real UI surface with a Chromium-tier test, which is where most of the work is.

## Risk

- **`test:e2e` already collects these features.** A careless §S1 could double-collect them or stop
  collecting them — which is why an AC compares what each target collects either side of the change.
- **The e2e tier is excluded from the pre-merge gate.** Filing BDD runs correctly does not put them
  in the gate; who runs and gates the browser tiers is DN open question 5, still unanswered, and this
  CR does not pre-empt it.

## Non-goals

- **Server-side execution of Playwright** (the original premise): retired by user ruling. Crucible
  ingests; the client runs. No dashboard button that spawns a suite, no `sutRoot` execution.
- Renaming or removing `test:e2e`, beyond whatever §S1's measured relationship decision requires.
- Answering DN open question 5 (who runs and ingests the browser tiers).
- Rewriting the playwright codec. It works and is tested; it lacks a caller.
