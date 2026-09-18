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

So sixteen executable specifications run, and what reaches the board is a **tally of verdicts with
the specification stripped out**.

**CORRECTED 2026-09-18 by the RED phase, which refuted this CR's own opening claim.** An earlier
draft of this section said the suite's runs "produce no board record whatsoever". Measured by
driving the real verb (`bun-crucible.py e2e --package-dir <this repo>`) against a board: the run
DOES land — `tier: "e2e"`, `codec: "parsed"`, `summary {total: 46, passed: 45, failed: 1}` — because
CR-CRU-133 already wired the declared target's report mechanism. What the board never receives is a
single `Given`/`When`/`Then`. The stored tree is addressed by **generated spec file**
(`"tests/e2e/features/roadmap.feature.spec.js"`), holding one leaf per scenario, so a reader sees
which FILE broke and never which STEP of the specification broke. The defect is the discarded
Gherkin, not an absent ingest — and the two demand different work, which is why the claim is
corrected here rather than quietly narrowed later.

Compounding it: `test:e2e` is excluded from the pre-merge gate fleet-wide (DN open question 5), so
nothing files these runs in the ordinary workflow either — the capability exists and no routine
exercises it.

And the `playwright` codec is **dead in the real workflow**: reachable only through the raw API, never
selected by the fleet. A codec no caller selects is not a feature, it is an unexercised parser — the
same shape CR-CRU-140 found in the cycle-evidence read, where the capability existed and nothing
pointed at it.

## Scope

### §S1 — the e2e suite is BDD-driven, files as `e2e`, and reaches the board WITH ITS STEPS

**USER RULING 2026-09-17, overriding this CR's first two drafts: for a UI-driven project, `e2e` MAY
use Playwright and BDD.** BDD and Playwright are the MEANS; `e2e` is the tier. So there is no
rename, no `test:bdd`, and no tier change — an earlier draft of this section proposed migrating
`test:e2e` to `test:bdd` on the strength of the DN's marker row ("feature files, generated specs"),
which read the means as the dependency. The dependency this suite takes is the assembled product
driven through a browser, which is `e2e`.

What is measurably wrong is narrower and worse: **the board receives the verdicts and discards the
specification.** Measured on `develop` at `fe7794c`, and re-measured by the RED phase against a
live drive:

- `playwright.config.ts:76-77` is `defineBddConfig({ features: "tests/e2e/features/*.feature" })`
  with `testDir` on the generated output; `bunx playwright test --list` reports
  **`Total: 46 tests in 16 files`**, every one generated from a `.feature`.
- A real `bun-crucible.py e2e` drive DOES file a run (`tier: "e2e"`, `codec: "parsed"`), but its
  tree is addressed by generated spec file with one leaf per scenario — so no `Given`/`When`/`Then`
  ever reaches the board, and `summary.total` equals the scenario count, i.e. the event is a tally.
- `test:e2e` is excluded from the pre-merge gate fleet-wide, so nothing files these runs in the
  ordinary workflow — the ingest path works and no routine walks it.
- The `playwright` codec that would carry the step detail has no caller
  (`grep playwright clients/*.py` → zero hits). Worse, measured during RED: the bun client has NO
  raw-report ingest route at all — every path is `_ingest_parsed → POST /api/v2/runs/parsed` — and
  this project declares no Playwright JSON reporter (`playwright.config.ts` declares `list` +
  `junit` only; `package.json`'s `crucible.reportPath` declares only
  `env:PLAYWRIGHT_JUNIT_OUTPUT_NAME`). So "the codec needs a caller" understates it: the raw report
  does not exist yet and there is no route that would carry it.

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

**Making the report authoritative widens one existing edge, and GREEN measured it.** The suite
enforces a single ordering constraint through Playwright project dependencies:
`shell-storyboard.feature`'s F1 asserts a database nothing has seeded, its `Given a fresh, empty
Crucible database` is a NO-OP step (the emptiness comes from running FIRST), and four features that
sort alphabetically ahead of it were each pinned into their own project depending on `chromium` so
they ran after the main body. That was harmless while the board saw only counts. It is not harmless
once this suite's own report IS the board's evidence: **Playwright skips every dependent project
when its dependency project holds ANY failing test** (`hasFailedDeps` in the runner's phase loop —
measured here as one failing scenario in `chromium` leaving *"14 did not run"*). Those 14 then land
as scenario nodes with no steps and no verdict, and a reader cannot distinguish a SKIPPED
specification from an empty one — the exact confusion this CR exists to remove.

So the dependency is narrowed to the constraint that actually exists: F1 is tagged `@empty-db` in
its own feature file, that tag alone constitutes the dependency project, and every other project
depends on THAT rather than on the main body. A failure anywhere in the body now skips nothing,
because nothing depends on the body. The four keep their own projects declared after `chromium`
(measured: folding them in reds CR-CRU-034 §S1, which needs the DB state the body leaves behind).

### §S3 — the BDD section that already exists gets populated with the Gherkin execution output

**USER RULING: there IS a BDD section in the UI, and showing the Gherkin execution output is what it
is for.** This is a POPULATION of an existing, already-routed surface — not a new tab, not a second
Runs timeline, not a pass/fail tally. Measured, the section is present and wired:

| Site | State today |
|---|---|
| `public/app.js:2638` `BddFeed` | renders ONE string and nothing else |
| `public/app.js:2644-2645` | that string: *"BDD run results already stream into the Runs timeline — a dedicated BDD surface does not exist yet"* |
| `public/app.js:2650` `BddPlaceholder` | wraps `BddFeed` in `greyed("app-center")` — **NOT an "unbuilt" marker; see the correction below** |
| `public/app.js:4841` | `state.workspaceTab === "BDD"` — the route already dispatches here |

So the tab row has promised this since CR-CRU-007 and the dispatch has been in place all along; only
the content is absent. `BddFeed` renders the feature, its scenarios, and each scenario's
`Given`/`When`/`Then` steps in order with the outcome of each, straight off the codec's tree
(scenario nodes named `<Feature> › <Scenario>`, step leaves in step order). A failing step shows its
`failure.message` AT that step — which step of the specification broke is the thing a Gherkin report
is read for, not merely that the scenario did. The "does not exist yet" copy goes, because it is no
longer true once the section renders.

**USER RULING 2026-09-18: the pane must say WHICH run it is showing.** C2 GREEN built the section
to render `latestBddEventId()`'s Gherkin and nothing else — no run id, no timestamp, no agent —
because the ACs demanded the specification and explicitly refused a tally or a second Runs
timeline, and it declared the omission rather than hiding it. The consequence is real: the pane
always shows the LATEST BDD run, so a week-old run is indistinguishable from one that landed a
minute ago, and a reader debugging a broken step cannot tell whether they are looking at their own
run or yesterday's. That is a defect of a surface whose whole purpose is to be read as evidence.

So the section names its subject. This is NOT the run header §S3 refused: what is refused is
re-rendering the Runs timeline's content — counts, pass/fail tallies, a run list — and that refusal
stands. What is required is the run's IDENTITY: when it was recorded and who filed it, in the same
relative-time idiom the rest of the board already uses, so the reader knows which run's
specification is on screen. Delivered as cycle C3 on plan 152.

**CORRECTED 2026-09-18 by C2 RED: the `greyed(...)` claim above was wrong, and the AC built on it
was vacuous.** Measured at `public/app.js:451`: `greyed(cls)` is
`() => (state.backendUp ? cls : cls + " greyed")` — the UNIVERSAL backend-down dimmer, applied
identically by Runs (`:2187`), Coverage (`:2606`), Compile (`:2633`), Workflow (`:4785`), the project
pane and the home timeline; 11 call sites. It has never meant "dimmed because unbuilt". With the
backend UP the BDD pane carries no `greyed` class today, so "the wrapper is gone for a frontend
project with runs" was already true and would have proven nothing — worse, obeying it literally
would have STRIPPED the liveness dimming every other pane has.

So the wrapper STAYS and only the copy goes. The real distinction the AC was reaching for is
between the two dimmings, and it is now stated as two falsifiable halves: a POPULATED pane carries
no `greyed` while the backend is up and gains it only when the shell's own watchdog loses the
backend — with its Gherkin still rendered, because a dimmed pane is a STALE pane, never an unbuilt
one; and "gated" is expressed on the TAB (disabled attribute, dead click, pane never mounts), never
by dimming a pane.

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
it"*. §S3 must therefore (a) keep an empty state for the no-run case and (b) keep it free of CR ids
and version numbers.

**RULED 2026-09-18 after C2 RED escalated a real collision.** That file holds TWO tests, and they
are not equivalent:

- `:172` — *"the rendered empty state names no project's CR id and no release version"*. This is
  CR-097's actual invariant, the reason the CR exists. It MUST keep passing, untouched.
- `:187` — *"the empty state still states the capability and that no dedicated surface exists
  yet"*, asserting `toContain("Runs timeline")` and `toLowerCase().toContain("does not exist
  yet")`. The second clause pins the WORDING of a sentence this CR legitimately makes false.

An earlier draft of this section said to leave the guard passing "rather than re-pinning it to new
text", which RED correctly read as forbidding any edit — and then found the only way to obey both:
keep the literal `"does not exist yet"` alive by predicating it on a missing RUN instead of a
missing SURFACE. **That escape is REFUSED.** It is re-pinning wearing a disguise: the copy gets
contorted to preserve a substring, and the guard is left with a name describing an assertion it no
longer makes. A test that pins incidental wording made false by a legitimate change is narrowed or
deleted — never worked around by bending the product's words to fit it.

So: `:187` is NARROWED to its durable half — the empty state still states the CAPABILITY (results
appear in the Runs timeline) — and its surface-absence clause plus the stale half of its name are
deleted. `:172` is untouched. CR-097's defect stays closed, because what CR-097 actually forbade was
citing the builder's backlog, and nothing here re-introduces a CR id or a version.

**Not related, checked and dismissed:** CR-CRU-022 (roadmap analytics) and CR-CRU-098 (the plan
pointer has no publisher) mention none of these; CR-CRU-082 is VOID; CR-CRU-141 names Playwright
only as the cost of the e2e tier and already defers browser-tier ownership to DN open question 5.

## Acceptance criteria

**§S1**
- [ ] `test:e2e` KEEPS its name and the suite keeps `tier: e2e` — no rename, no second target, no
      tier change. Asserted by a test pinning that the declared target for this suite is `test:e2e`
      and that its runs file as `e2e`, so a later author cannot "tidy" it into `test:bdd`.
- [ ] The stored event addresses scenarios BY SCENARIO, not by generated spec file: a real
      `bun-crucible.py e2e` invocation yields a tree whose nodes are `<Feature> › <Scenario>`,
      replacing today's `"tests/e2e/features/<name>.feature.spec.js"` addressing. (Corrected AC:
      an earlier draft asked for the run to be "ingested at all", which RED measured as ALREADY
      TRUE — the ingest lands, the specification is what it discards.)
- [ ] That ingest carries STEP-LEVEL detail — the thing a specification language exists to produce.
      `summary.total` equalling the scenario count is the current defect and is asserted against,
      so a tally cannot satisfy this criterion.
- [ ] The declared-target guard covers `test:e2e` so its declaration cannot silently change.
      Location corrected after RED measured it: CR-CRU-133's declared-target tests are PYTHON
      (`tests/client/test_declared_target_report_mechanism.py`, which already asserts this repo
      declares `test:e2e` with `crucible.reportPath["test:e2e"] == "env:PLAYWRIGHT_JUNIT_OUTPUT_NAME"`);
      `tests/ci-toolchain-provisioning.test.ts` guards the CI workflow and holds no such guard. The
      bun-side rail therefore lives with this CR's own tests rather than inventing a second
      convention in a CI file or editing another stack's client suite.

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
- [ ] **A failure in the suite's main body skips NOTHING.** No Playwright project may depend on the
      main body, because a dependency-project failure makes Playwright skip every dependent and
      those scenarios then reach the board as nodes with no steps and no verdict — indistinguishable
      from a specification that ran and asserted nothing. The only permitted dependency is the
      single `@empty-db`-tagged ordering precondition. Asserted on the config's own dependency
      graph, so a later author cannot re-widen it back to `dependencies: ["chromium"]` and silently
      reintroduce childless nodes.

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
- [ ] With no run recorded, the tab shows exactly ONE definitive empty state (CR-CRU-078's rule),
      naming NO CR id and NO release version — `tests/project-independence-strings.test.ts:172`
      keeps passing UNTOUCHED. Its sibling at `:187` is NARROWED per the §S4 ruling: the capability
      clause (`"Runs timeline"`) stays, the `"does not exist yet"` surface-absence clause and the
      stale half of its name are deleted. The product's words are NOT contorted to preserve a
      substring.
- [ ] A run carrying no Gherkin (a junit `unit` run, say) does NOT render as Gherkin — it shows the
      same empty state, so the section cannot pass off an unrelated run as a specification.
- [ ] **The pane NAMES the run whose specification it renders (user ruling; cycle C3).** A reader
      can tell WHICH run is on screen: when it was recorded, in the same relative-time idiom the
      rest of the board already uses, and which agent filed it. Asserted on a populated pane, and
      asserted to FOLLOW the subject — ingest a second, newer BDD run and the pane names the newer
      one, so "latest" is observable rather than assumed. Bounded against the surface this CR
      refuses to duplicate: the pane still shows NO pass/fail tally, NO totals and NO run list —
      identity is not a scoreboard, and a test that would pass if counts appeared does not satisfy
      this criterion.
- [ ] The tab stays frontend-only: `workspaceTabs(project)` still returns
      `disabled: true` for `BDD` on a `type !== "frontend"` project, asserted for a backend project
      — the gate exists today and populating the section must not un-gate it. Bounded the other way
      too: every project-type-independent tab (Roadmap/Workflow/Runs/Compile) stays ENABLED for a
      backend project, so accidentally gating one of those reds this as well.
- [ ] The two dimmings can never be conflated again, asserted as two halves (the `greyed(...)`
      wrapper STAYS — see the §S3 correction; it is the universal backend-down dimmer):
      (a) a POPULATED pane carries no `greyed` while the backend is up, and gains it only when the
      shell's own watchdog loses the backend — with its Gherkin STILL rendered, because a dimmed
      pane is a STALE pane, never an unbuilt one; driven through the real health probe, never by
      assigning `state.backendUp`;
      (b) "gated" is expressed on the TAB — disabled attribute, dead click, pane never mounts —
      and never by dimming a pane.

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

- **`test:e2e` already collects these features.** This risk was written when §S1 still contemplated
  migrating the target to `test:bdd`; the user's ruling removed the rename, so no target was added,
  renamed or retired and the double-collect/stop-collect hazard never materialised. An earlier draft
  of this bullet promised *"an AC compares what each target collects either side of the change"* —
  there is no such AC and there should not be, because a count comparison is the wrong instrument:
  collection legitimately GREW by one (16 features / 46 tests → 17 / 47, the §S3 Chromium scenario),
  so a pinned figure would have to be edited by every CR that adds a feature, CR-CRU-018 included.
  What actually protects collection is DERIVATION: the tests read the scenario list from the
  `.feature` sources at run time and never hardcode a total, the declared-target guard pins
  `test:e2e` as the one BDD target, and the dependency-graph rail asserts the ordering precondition
  runs exactly once.
- **The e2e tier is excluded from the pre-merge gate.** Filing BDD runs correctly does not put them
  in the gate; who runs and gates the browser tiers is DN open question 5, still unanswered, and this
  CR does not pre-empt it.

## Non-goals

- **Server-side execution of Playwright** (the original premise): retired by user ruling. Crucible
  ingests; the client runs. No dashboard button that spawns a suite, no `sutRoot` execution.
- Renaming or removing `test:e2e`, beyond whatever §S1's measured relationship decision requires.
- Answering DN open question 5 (who runs and ingests the browser tiers).
- Rewriting the playwright codec. It works and is tested; it lacks a caller.
