# CR-CRU-079 — roadmap deep-link parity and active-CR drill-through

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 078
- **Status**: PENDING (0.2.0) — AC3/AC5 re-based 2026-08-28 on the paged release model; re-analysed
  2026-09-05 after CR-CRU-078/083/105 landed (AC3 rewritten, AC6 scoped, AC8 widened, §S1 and Risk corrected)
- **Design documents — READ THESE FIRST**: `docs/research/DN-crucible-roadmap-view.md` — the TRACKED decision record, and the governing one; **decision 7c** (`:28`, approved) is the drill-through contract this CR implements. The visual it was approved on is `/home/antonyj/Documents/data_projects/crucible/.lavish/crucible-workflow-flowchart.html` §6, §14 (2026-08-28) — absolute path, but `.lavish/` is **gitignored**, so where the two disagree or the flowchart is absent, the DN governs. Storyboard frames F14/F14½/F14a are illustrations, not the record: F14a was superseded and trimmed to a pointer on 2026-08-28 while its decision 7c survives in the DN.

> The design document is the contract for this CR. Implement what it specifies — do not
> re-derive the model, the vocabulary or the look from scratch.

## Problem

Two roadmap navigation contracts are specified and neither is honoured. Both were verified
against the running app on the live 78-CR board, not inferred:

### 1. Neither entry point is deep-linkable

*Heading and diagnosis corrected 2026-08-28 by gap analysis — the original said "the chip is not
deep-linkable" and concluded "one of two specified doors silently fails". Both halves were wrong,
and the correction widened §S1.*

F14 locks **two** entry points: PRIMARY the Roadmap tab in the workspace strip, SHORTCUT the
Project pane's `🗺 roadmap` chip — and states *"Both activate the tab at `/p/<key>/roadmap`
(deep-linkable)"*.

**Neither honours it.** Both are bare tab-state assignments:

- the chip — `data-testid="roadmap-chip"` inside `project-pane`,
  `onclick: () => (state.workspaceTab = "Roadmap")` (the `roadmap-chip` button in the project pane);
- the tab strip — `onclick: () => { if (!t.disabled) state.workspaceTab = t.name; }`
  (the workspace tab strip's `onclick`).

Both render the roadmap; neither touches the URL. After either click `location.pathname` is still
`/p/<key>`, so you cannot copy the URL of what you are looking at and a reload lands on Workflow.
What *does* work is direct entry: the parser sets `route.roadmap` (`routeParse` in `public/app-logic.mjs`) and
the shell flips the tab on load. So the route exists and is honoured **inbound only** —
nothing in the app ever produces it.

That reframes the defect. It is not one door failing while the other works; it is that the
shareable URL is reachable only by typing it. And the chip's behaviour is not a silent failure at
all — CR-CRU-014 shipped it deliberately as a "one-rule tab swap" (the chip's own comment in `public/app.js`), with a
passing test named for that contract (`tests/roadmap-pane.test.ts`, the test named for that contract). The real conflict is
F14's "deep-linkable" against CR-014's swap; §S1 records how it was resolved.

### 2. The row drill-through does not target the clicked CR

F14½ specifies the roadmap row → Workflow drill-through, and F14a decision 7c sharpens it:
clicking an `IN_PROGRESS` CR row lands on **that CR's active cycles** as they are displayed and
tracked.

What actually happens: clicking a roadmap row **does** swap to the Workflow tab, but it lands on
generic Workflow history with **nothing targeted**. Verified by clicking the row for
`CR-CRU-017` on the live board: all **63** CR groups remained collapsed, none expanded, none
highlighted, nothing scrolled into view, and the URL stayed `/p/<key>/roadmap`. You are dropped
into a 63-group history and must find the CR by hand — which is precisely the work the
drill-through exists to remove.

F14½'s badge reads *NOT YET IMPLEMENTED*, which is misleading in both directions: the tab swap
is implemented, the targeting is not.

## Scope

### §S1 Deep-link parity — BOTH doors route

**User decision 2026-08-28, after gap analysis: both entry points navigate.** The analysis found
the Problem statement's premise wrong in a way that changes this section's scope — the tab strip
(the workspace tab strip's `onclick`) mutates `state.workspaceTab` exactly as the chip does
(the chip), so **neither** door produced the URL; only direct entry did
(direct entry through `routeParse`). Fixing the chip alone would have inverted the privilege instead of removing
it, and left AC2 unsatisfiable.

So both the Roadmap **tab** and the `🗺 roadmap` **chip** navigate to `/p/<key>/roadmap` through
the existing `navigate(pathname)` helper (`navigate(pathname)`, whose `history.pushState` is what AC2c's Back/Forward relies on) rather
than assigning tab state. One rule for both doors: the destination is a route, not a mode flag.

**The route is the source of truth and the tab FOLLOWS it — on navigate and on popstate.** Today
`route.roadmap` flips `workspaceTab` exactly once, at boot; `navigate()` and the `popstate` handler
carry CR-CRU-016's one rule that a same-surface navigation *"never touches the active workspace
tab"*, so navigating to `/p/<key>/roadmap` would change the URL and leave Workflow on screen, and
Back would restore the URL without the roadmap. The Roadmap segment is therefore the one carved
exception to that rule: whenever the route is (re)parsed on the workspace surface, the Roadmap tab
is active if and only if `route.roadmap` is set. CR-CRU-016's comment in `navigate()` is corrected
to name the exception.

**Routing IN requires routing OUT.** The moment either door owns the URL, leaving the Roadmap tab
must return the pathname to `/p/<key>` — otherwise the address bar claims `roadmap` while Workflow
is on screen, which is a worse failure than the one this CR fixes, because it is silently
shareable. Every exit routes: another tab, and the row drill-through of §S2.

**This overturns a shipped characterisation, deliberately and on the record.** CR-CRU-014 shipped
the chip as a "one-rule tab swap" — stated in the chip's own comment and named in a passing test in
`tests/roadmap-pane.test.ts` ("same destination, one-rule tab swap"). That test asserts only
`tabIsOn("Roadmap")` and never the pathname, so it does not break here — but its NAME and comment
become false and MUST be corrected in this CR rather than left to mislead the next reader. The
conflict was between F14's "deep-linkable" claim and CR-014's swap; the user resolved it in F14's
favour.

**Scope of the rule: the Roadmap tab only.** `/p/<key>/roadmap` is the ONLY routed workspace tab
(CR-CRU-014 §S3, `routeParse` in `public/app-logic.mjs`). Runs, Coverage, Compile and BDD have no
route segment, so they keep the state swap — there is no URL for them to navigate to, and inventing
one is a different CR. The un-routed Runs tab's "NOT a navigate() pathname change" comment
describes that tab and stays true.

### §S2 Targeted drill-through

Clicking a CR row navigates to that CR's context in the Workflow view and **lands on it**:
the CR's group expanded, scrolled into view, and marked as the drill-through target. For an
`IN_PROGRESS` CR this lands on its **active cycles** as they are tracked (decision 7c).

The expansion state to address is the one the Workflow pane already holds: `lensOpenKeys`, hoisted
outside the render tree and keyed `cr:<project>:<cr>` (`lensKey`), which is exactly the addressed,
per-CR open set the Risk section asks for. Landing ADDS the target's key; it does not introduce a
second expansion holder or an "expand all".

The back affordance returns to the roadmap with expansion and scroll intact, per the one-rule
pane model (`← roadmap`), consistent with CR-020 §S2's navigation contract.

### §S3 Honest state for the unreachable case

If a clicked CR has no workflow history at all (`PENDING`, never planned), the drill-through
must not pretend: it either stays put or lands with an explicit empty state naming the CR. It
never silently drops the user into unrelated history — the current failure mode.

## Acceptance criteria

- **AC1** — **each door, independently, produces the URL.** Clicking the `🗺 roadmap` chip results
  in `location.pathname === "/p/<key>/roadmap"`; clicking the Roadmap **tab** does the same. Both
  asserted on the URL, because the tab swap already passes today while the URL contract fails —
  a test that only checks `tabIsOn("Roadmap")` would pass against the unfixed code and prove
  nothing. Reloading that URL renders the roadmap.
- **AC2** — **no door is privileged.** The pathname after a tab click is byte-identical to the
  pathname after a chip click, from the same starting state. Fixing one door and not the other
  fails this AC — which is what the original single-door scope would have shipped.
- **AC2b** — **leaving the Roadmap tab returns the pathname to `/p/<key>`.** From
  `/p/<key>/roadmap`, clicking any other workspace tab leaves `location.pathname === "/p/<key>"`.
  A URL still reading `roadmap` while Workflow is on screen fails this AC, and is a worse defect
  than the one this CR fixes: it is silently shareable, so the recipient sees something the sender
  never saw. The §S2 drill-through is an exit like any other and is covered by the same assertion.
- **AC2c** — **browser back and forward move between the two URLs.** After chip-or-tab into the
  roadmap and then out to another tab, browser Back returns to `/p/<key>/roadmap` **with the
  roadmap rendered**, and Forward returns to `/p/<key>`. This is the payoff of routing rather than
  swapping, and it is what `navigate()`'s existing `pushState` (`navigate()`'s `pushState`) buys; a
  `replaceState` implementation passes AC1/AC2 and fails this one.
- **AC3** — clicking a `COMPLETED` or `IN_PROGRESS` CR row lands on **that CR** in the Workflow
  view: its `cr-group` is expanded, scrolled into view, and marked as the drill-through target,
  and no other group is expanded by the landing. Asserted for a specific CR id on a board holding
  several groups — a landing that leaves every group collapsed (today's behaviour) fails this AC.
  *Rewritten 2026-09-05:* the prior text described a roadmap-side landing (focus the CR's release,
  page the strip) for a click that §S2 sends to Workflow, and its "must fail when the target sits
  in another release" limb could not fail — the table draws only the focused release's rows, so a
  clicked row is always in it.
- **AC4** — for an `IN_PROGRESS` CR the landing shows its **active cycles**, not merely its
  group header.
- **AC5** — the back affordance returns to the roadmap with the **prior focused release and page
  window** intact — not reset to the default focus.
- **AC6** — a `PENDING` or `COMPLETED_UNTRACKED` row stays inert under §S1's routing: the click
  changes neither the tab nor the pathname. The inertness itself shipped in CR-CRU-083 AC7
  (`roadmapDrillable`) and is already covered there and in the roadmap-graph e2e; what this CR
  adds is the pathname half, since §S1 makes every exit a route and an inert row must not become
  one. *Scoped 2026-09-05:* the earlier text re-asserted CR-083's coverage and added an
  untestable "if later made navigable" clause; both dropped.
- **AC7** — The storyboard's F14½ frame status matches what shipped. **NOT TEST-VERIFIABLE, and
  said so deliberately:** `.lavish/` is gitignored, so no test in this repo can assert it. It is a
  CLOSE-OUT OBLIGATION recorded as an AC so it is not forgotten, and the tracked
  `docs/research/DN-crucible-roadmap-view.md` is the governing record where the two disagree.
- **AC8** — **the superseded characterisation is corrected where it is written, not just
  overridden in code.** The `roadmap-pane` test named for the swap contract, the chip's own
  comment, and the row's drill comment (which also calls the drill "a one-rule tab swap") all
  describe a tab swap. Once §S1 lands that is false for the chip AND for the drill, which is now
  a route-out. All are updated to state the routed contract and to name this CR as the CR that
  changed it. Leaving a
  passing test whose NAME asserts the opposite of the shipped behaviour is how the next reader gets
  misled — the same class of defect as the chip comment's current promise, which promises
  targeting the code never implemented.

## Estimated size

S–M — a route change for **both** doors plus the matching route-out, target-and-expand plumbing in
the Workflow pane, and the empty-state path. Slightly larger than first estimated: gap analysis
widened §S1 from one door to two and added the exit rule (AC2b/AC2c).

## Risk

The drill-through mutates Workflow-pane expansion state from outside, so the risk is fighting
the pane's own default-collapsed behaviour. **Cited correctly after gap analysis 2026-08-28:**
this rule is NOT CR-020 §S1.3 — that CR has only §S1 and §S2, and its `§S1.3` acceptance
checkbox concerns which CR groups appear for open vs closed plans, not collapse. The
behaviour is real but emergent: expansion is an OPT-IN open set, empty on load, so everything
reads as collapsed by default. *Corrected 2026-09-05:* `roadmapExpandedKeys` no longer exists;
the Workflow pane's `lensOpenKeys` is ALREADY the hoisted, project-keyed, per-CR open set, so the
risk is already mitigated by shipped structure. §S2 adds the target's key to it. The residual risk
is only that a landing expands more than its target, which AC3 asserts against.

Second risk: this changes the mechanism of TWO shipped affordances from state-mutation to routing,
and one of them (the chip) had that mechanism deliberately specified and tested by CR-CRU-014. The
user resolved the F14-vs-CR-014 conflict in F14's favour on 2026-08-28; AC2 ensures the two doors
converge rather than diverging into two behaviours, and AC8 ensures the superseded wording is
corrected rather than left to contradict the code.

Third risk, and the one most likely to be missed: **routing IN without routing OUT desynchronises
the URL.** A pathname reading `/p/<key>/roadmap` while Workflow renders is worse than no routing at
all, because it is shareable — the recipient sees a different screen from the sender. AC2b covers
every exit, including §S2's drill-through, which is itself an exit.

## Non-goals

- Graph topology, waves, gates, lanes, motion — **CR-077**.
- Removing the toggle, selection-driven table, row grammar — **CR-078**.
- Tab ordering — **CR-076**.
- Changing the workspace **landing** pane — still **CR-021 §S1** ("Tab order + default":
  the default active tab on entry is `Workflow`), untouched. *Corrected 2026-08-28: that
  section carries no `AC2`; the earlier citation named a criterion that does not exist.*
- **Giving the other workspace tabs routes.** `/p/<key>/roadmap` is the only routed tab
  (CR-CRU-014 §S3); Runs, Coverage, Compile and BDD have no route segment and keep their state
  swap. §S1's rule is Roadmap-specific because Roadmap is the only tab with a URL to navigate to —
  extending routing to the rest of the strip is a separate CR with its own back/forward and
  landing-pane consequences.
- Release→gate association and the P50/P80 forecast — out of 0.2.0 (CR-022, deferred).
