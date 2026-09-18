# CR-CRU-145 — the BDD section is a run VIEW, not a snapshot of the last run

**Type** fix · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-015 · **Status** PENDING

## Problem

**User-reported 2026-09-18, looking at the shipped surface:** *"There is a disconnect between it and
the other runs views, i.e. each run of the e2e is not being shown. There is no tree view rather than
the last e2e run's output."*

Measured on the live board at `8f8312d`:

| Surface | What it offers |
|---|---|
| Runs pane | **21 e2e run cards** — agent, tier, codec, relative time, duration, counts — each opening its own drill-in at `/p/<key>/run/<id>` |
| BDD pane | the **latest** run only (`latestBddEventId()`, `public/app.js:2682`), no selection, no history, and a flat always-expanded 524-row dump |

**The cause is a refusal CR-CRU-015 §S3 wrote, and it contradicted the approved design.** §S3 refused
"a run list" and "a second Runs timeline", and hardened that into an AC — *"a test that would pass if
counts appeared does not satisfy this criterion"* — with a test (`tests/bdd-section.test.ts`, the
`NAMED, never TALLIED` case) that forbids any count in the pane. Storyboard frame **F11
("Frontend project — the BDD harness", `badge: approved`)** had already designed the opposite:

```
▾ Feature: property search      11 ✓   1 ✗
    ✓ filters by price range · chromium · 2.1s
    ✗ map view sync · chromium · 4.8s · trace ↗
```

Per-feature pass/fail counts, collapsible feature nodes, and per-scenario browser and duration. The
refusal was authored without reading F11; the storyboard is the design authority and it wins.

## Scope

### §S1 — the run is reached through the hierarchy that already exists

**USER RULING 2026-09-18, and it supersedes "invent a selector":** *"today there is a seamless link
between a workflow run (cycle → agent-run → detail)"* and *"when an e2e test run takes place as part
of the cycle that hierarchy should be honoured."*

So the PRIMARY path is not new navigation — it is the chain the Workflow view already owns:

| Link in the chain | What already implements it |
|---|---|
| cycle → its runs | `linkedRunsFor(cycleId)` (`public/app.js:4082`), rendered as the cycle's `▸ N runs` (`:1168`) |
| the cycle's evidence read | the anchored route `GET /api/v2/events?project=<key>&cycleId=<id>` (`:4305-4316`) — CR-CRU-140 §S1, the read that CR made findable |
| run → detail | the run card's drill-in at `/p/<key>/run/<id>` (CR-CRU-016 §S3, `:813-820`) |
| a run's cycle binding | first-class `cycleId` on the event (CR-CRU-094 §S1), stamped at registration (CR-CRU-056 §S3) |

An e2e run that belongs to a cycle is reached the same way every other run in that cycle is reached,
and its detail IS its Gherkin. The BDD tab stops being a dead end that only ever shows the newest
run: it is where a cycle's e2e evidence lands when you follow the chain into it.

**The tab's own list is secondary, and it must not fork the hierarchy.** It exists for the reader who
opens the tab directly, it defaults to the latest run (today's behaviour becomes the default rather
than the only state), and it shows each run's cycle so the list agrees with the Workflow view rather
than presenting a flat history beside it. Runs legitimately carry NO cycle — a fleet gate or an
ad-hoc probe files unbound, which CR-CRU-094 §S3 treats as a prompt and not a defect — so those stay
reachable and are shown as unbound, never hidden and never invented into a cycle.

Nothing new is needed to find the runs: `visibleEvents()` (`public/app.js:461`) already holds the
project's history client-side and `latestBddEventId()` already uses the predicate a list needs
(`kind === "test" && codec === "playwright"`). One selected-run state serves every entry, so the
chain, the tab's list and a direct deep-link cannot disagree about which run is on screen.

### §S2 — a MELD of three things, and the shipped Gherkin view is the part that stays

**USER RULING 2026-09-18:** *"I like the Gherkin view output you are giving in BDD now so we have to
meld both the design in F11 and the current drill down capabilities to get to the BDD view."*

This matters because F11 and the shipped pane disagree about the leaf, and F11 is the SHALLOWER of
the two. F11's mock draws scenario rows and stops:

```
▾ Feature: property search      11 ✓   1 ✗
    ✓ filters by price range · chromium · 2.1s
    ✗ map view sync · chromium · 4.8s · trace ↗
```

No `Given`/`When`/`Then` anywhere in it. The shipped pane renders every Gherkin STEP with its own
outcome — 524 rows for this project's suite — which is what the user endorses and what the CR-015
ruling asked for ("showing the Gherkin execution output is what it is for"). So the meld is
explicit, and it is NOT "implement F11":

| Contributes | What it gives |
|---|---|
| **The shipped pane (KEEP)** | the leaf: every step, verbatim Gherkin text, per-step status, the failing step's message at that step |
| **F11 (ADD)** | the frame: collapsible feature nodes with their own ✓/✗ counts, and per-scenario browser + duration + the trace affordance |
| **The drill-in (REUSE)** | the behaviour: failures float, green folds, virtualization — the same functions, not a copy |

A future author must not "correct" the step view down to F11's two-line scenario rows on F11's
authority: F11 predates the step-level ruling, and the steps are the point of the surface. F11 is the
authority on the FRAME around them.

And the affordances every other run view already has, reused rather than reinvented —
`L.foldSuites`, `L.digestFailures` and `L.drillinDefaultMode` are pure and exported from
`public/app-logic.mjs` (:446-494), and `drillinDefaultMode("e2e")` **already returns `"Density"`**:
failures float, green folds. The drill-in's §S4.4 virtualization lives inside the run-overlay render
(`public/app.js:5092`, `:5273`) rather than in a reusable seam — extracting it or following its
pattern is this CR's call, but a 524-row pane must not render every row eagerly.

### §S3 — two F11 elements the pipeline cannot express yet

Measured in `src/codecs/playwright.ts`:

- **Browser badge (`· chromium ·`) is NOT available.** `collectScenarios` (:81-86) passes only
  `suite.title` and the spec; the playwright report's per-test `projectName` is dropped. F11 asks for
  it on every scenario row. Adding that one field is additive and does not "rewrite the parser"
  (CR-CRU-015's non-goal) — but it IS a codec change, so it is stated here rather than smuggled in.
- **`trace ↗` means two different things and the CR must not blur them.** The codec's `failure.trace`
  is `step.error.stack` (:58) — a stack string. `playwright.config.ts` separately declares
  `trace: "retain-on-failure"`, which writes a **trace.zip artifact** that the Playwright trace
  viewer opens; nothing ingests or serves that file today. Rendering the stack is free; linking the
  artifact needs artifact storage and is a larger question. Decide explicitly: ship the stack now and
  file the artifact link separately, or take both. Do not ship a link that silently shows a stack.

### §S4 — CR-CRU-015's no-tally bound is superseded, and its test is amended

This CR is authorised to narrow the `NAMED, never TALLIED` case in `tests/bdd-section.test.ts` and
the §S3 AC behind it, because F11 — approved, and predating that AC — draws per-feature counts. What
SURVIVES of the refusal, and must stay asserted: the BDD pane is not a duplicate of the Runs
timeline's card grammar. Counts that belong to the specification being read (a feature's own ✓/✗, as
F11 draws them) are content; re-rendering the timeline's cards, badges and ratio pills inside this
pane is still out.

The run-identity byline CR-015 §S3 shipped (cycle C3) stays and grows one field: it names the
SELECTED run and, when that run carries a cycle binding, the cycle — which is what makes the
hierarchy legible at the leaf. The follow-the-subject assertion holds against SELECTION as well as
arrival.

**F11's `▶ Run BDD suite` button stays retired.** F11 also drew Crucible executing Playwright
against `sutRoot`; the user retired that premise when re-specifying CR-CRU-015 (the client runs, the
board ingests). This CR takes F11's CONTENT design and not its execution model — stated so a future
reader does not restore the button on F11's authority.

## Acceptance criteria

**§S1 — the hierarchy**
- [ ] Following the EXISTING chain from a cycle to one of its e2e/playwright runs lands that run's
      Gherkin: cycle → its linked runs (`linkedRunsFor`) → that run → its detail IS the BDD
      rendering. Asserted through the real chain, driven as a reader drives it, not by calling the
      pane with an id.
- [ ] The run reached that way is the run rendered: its identity byline names it AND names the cycle
      it belongs to, so the Workflow view and the BDD view cannot disagree about whose evidence is
      on screen.
- [ ] A run with NO cycle binding (a fleet gate or ad-hoc probe — legitimate per CR-CRU-094 §S3) is
      still reachable and is shown as unbound. Asserted: it is neither hidden nor attributed to a
      cycle it does not carry.
- [ ] The tab's own list is secondary and consistent with the chain: it defaults to the latest run,
      shows each run's cycle, and selecting from it lands the same state the chain lands — one
      selected-run state, asserted through BOTH entries rather than one.
- [ ] Selecting a different run replaces the rendered specification: the previously selected run's
      content is gone, asserted rather than assumed.
- [ ] A project with no BDD-bearing run still shows the CR-CRU-078 empty state, with no list or
      selector chrome implying runs exist.

**§S2 — the meld**
- [ ] **The shipped step-level view does NOT regress.** Every Gherkin step still renders, with its
      verbatim text and its own outcome, and a failing step still carries its message AT that step —
      the assertions CR-CRU-015 C2 shipped keep passing UNCHANGED. A pane that showed only scenario
      rows would satisfy F11's mock and FAIL this CR.
- [ ] Feature nodes collapse and expand, and each carries its own pass/fail counts as F11 draws
      them — with the steps still reachable underneath, not replaced by the counts.
- [ ] Scenario rows carry status and duration.
- [ ] Failures float and green folds, through `L.foldSuites` / `L.digestFailures` /
      `L.drillinDefaultMode` — asserted to be the SAME functions the run drill-in uses, not a second
      implementation.
- [ ] A 524-row run does not render every row eagerly; asserted on rendered row count against a
      large fixture, not on wall time.

**§S3**
- [ ] Each scenario row names the browser it ran in, sourced from the report's `projectName` through
      the codec — and `tests/playwright-codec.test.ts` gains the case for that field rather than
      having its existing cases rewritten.
- [ ] A failing step's stack is reachable in the UI, and whatever is NOT shipped (the trace.zip
      artifact link) is named in the CR's close-out rather than left as an implied gap.

**§S4**
- [ ] `tests/bdd-section.test.ts`'s `NAMED, never TALLIED` case is amended, not deleted: it still
      asserts the pane does not reproduce the Runs timeline's card grammar, while permitting the
      per-feature counts F11 designs.
- [ ] The identity byline names the SELECTED run and follows selection, not only arrival.

## Risk

- **The pane becoming the Runs timeline.** The reason §S3 refused a list at all. The bound in §S4 is
  what keeps this honest: feature-level counts are the specification's own, card grammar is not.
- **Two entry points drifting.** One selected-run state is the mitigation, and an AC asserts both
  entries land on it.

## Non-goals

- Server-side execution of Playwright (F11's button) — retired by user ruling at CR-CRU-015.
- Rewriting the playwright codec. §S3 adds one dropped field; the parser's existing behaviour and its
  unit coverage stand.
- Artifact storage for trace.zip, unless §S3's decision takes it explicitly.
