# CR-CRU-025 — Cycle ↔ run-boundary navigation (bidirectional, with locate blink)

**Status:** PENDING
**Type:** feature
**Priority:** P3
**Depends on:** CR-CRU-012 (tab plumbing as merged), CR-CRU-011
**Labels:** ui, workflow, runs, navigation
**Phase:** Wave 4 (tentatively after 024, before 009 — scheduling open to the user)
**Design reference:** user live review 2026-07-17 (board annotations on the
Workflow cycle rows + the Runs-view cycle boundary): "Make the cycle element
clickable and allow for navigation to the corresponding cycle done boundary
in runs view (scroll into view) and vice versa … work on any completed cycle
in currently active cycle plan or in history"; inverse ruling: "the workflow
view is opened and the exact CR and cycle is scrolled into view. If the cycle
plan containing this exact cycle is in history and is in hidden mode, unhide
the cycle and show a blinking icon against it for user to identify … This
animation should run only for 10 seconds … If the History is long and out of
view, scroll the view up."; amendment ruling (2026-07-17, follow-up round):
"My previous requirement to navigate from the cycle done marker to workspace
reference will override the existing behaviour of a drill down! Update the
requirement to showing distinct click items on the marker for both
behaviours." — navigation NEVER hijacks an existing click contract; each
surface renders a DISTINCT click item per behavior. Third round (same day):
the `⊙ Detail` badge was retired ("You dont need to have a detail badge on
it!") and the declared marker's whole-body click was assigned to a NEW
feature — the Run Timeline accordion (§S2b): "Effectively we are converting
the Run Timeline to behave like an accordion widget."

## Context
Completed cycles exist on two surfaces with no link between them: the
Workflow lens (cycle rows) and the Runs timeline (declared `Cycle done`
boundary markers, CR-011 §S0b). Chrome-verified current forms: Workflow row
`✓ cycle <n> · "<label>"` + aligned ⏱; Runs boundary
`↺ Cycle done · <label> · <cr> · closed in <duration>`.

## Scope

### §S0 Distinct click items — no contract hijack (amendment ruling)
Every click target owns exactly ONE behavior, and existing contracts survive
unchanged: HISTORY cycle rows toggle their cycleId-linked runs drill-down
(CR-020 §S2 / interaction table); the HEURISTIC RED➜GREEN marker keeps its
whole-body run drill-in. The CR-025 navigation therefore ships as a SEPARATE
trailing badge — never a rebinding of an existing body click. The DECLARED
marker's body click is assigned by §S2b (accordion), NOT drill-in — the user
corrected the earlier drill-in assumption 2026-07-17: "my assumption that
body click on Cycle done marker will give a detail is wrong! You dont need
to have a detail badge on it!"

### §S1 Cycle row → Runs boundary
A COMPLETED cycle row (done/skipped/failed — active-plan section AND history
drill-downs alike) renders a trailing navigation affordance
(`data-testid="cycle-to-runs"`): clicking IT navigates to the Runs tab and
scrolls the cycle's declared `Cycle done` boundary marker into view
(center-ish), with the same 10s locate-blink treatment as §S2.4 applied to
the marker. The row's existing body click (runs toggle in history; no-op
where none exists today) is untouched. Cycles without a declared boundary on
the retained timeline (pruned past retention) show the affordance dim and
non-clickable — never a dead click.

### §S2 Runs boundary → cycle row (inverse)
A declared `Cycle done` boundary marker renders ONE distinct trailing badge,
**`⚑ Cycle`** (`data-testid="boundary-to-cycle"`, init-caps label, badge
styling — user refinements 2026-07-17; the earlier `⊙ Detail` badge was
RETIRED by the same-day correction: no detail badge on declared markers).
The heuristic RED➜GREEN marker keeps its shipped whole-body drill-in click
untouched. Clicking `⚑ Cycle` (and ONLY the badge — the click must not
trigger §S2b's accordion toggle):
1. Switches to the Workflow tab (one-rule tab swap).
2. Locates the exact CR and cycle: in the ACTIVE section directly, or in
   HISTORY — auto-expanding the containing CR group (and its wave, if
   grouping hides it) when collapsed.
3. Scrolls the cycle row into view (History long/off-screen → the pane
   scrolls to it).
4. Renders a **locate blink**: a blinking indicator against the exact cycle
   row for EXACTLY 10 seconds, then stops (CSS animation with a JS-cleared
   marker class; no residue after 10s; re-triggering resets the clock).

### §S2b Run Timeline accordion (user-declared new feature 2026-07-17)
"The entire marker has a click event which can be used to hide the runs
within that Cycle in the Run Timeline! … By default the run Timeline will
not hide the runs. … Effectively we are converting the Run Timeline to
behave like an accordion widget."
1. The DECLARED `Cycle done` marker's whole-body click toggles the
   visibility of that cycle's `cycleId`-linked run cards in the Run
   Timeline: first click HIDES them (collapsed), next click restores.
2. Default state: EXPANDED — a fresh load/poll/SSE re-render never hides
   runs on its own; collapse is purely a user act, and a cycle's collapsed
   state survives feed re-renders within the pane session (no URL
   deep-linking, no persistence across reloads).
3. Each cycle group toggles independently (accordion panels, not an
   exclusive accordion — collapsing one never expands/collapses another).
4. A collapsed marker shows a collapsed cue (e.g. `▸ N runs` suffix, matching
   the workflow lens vocabulary); expanded markers stay visually as today.
5. Boundaries: the ACTIVE cycle's open span stays ALWAYS inline (CR-021
   §S6a mock-wins rule — not part of the accordion); heuristic RED➜GREEN
   markers are NOT accordion handles (their body click stays drill-in);
   unlinked/planless run cards are never hidden by any toggle.

### §S3 Symmetry + state rules
The behavior works for any completed cycle of the currently active plan AND
any cycle in history. The expansion state changes caused by auto-expand
persist (they ARE the lens toggles — no phantom restore); the one-rule
scroll-restore contract is unaffected for other navigations.

## Acceptance criteria
- [ ] A done cycle row in the ACTIVE section carries `data-testid="cycle-to-runs"`; clicking IT lands on the Runs tab with the matching `Cycle done` boundary (matched by cycleId) scrolled into view and blinking; the blink class is GONE after 10s (injected-clock or bounded-wait assertion).
- [ ] Same from a HISTORY cycle row (inside an expanded group) — and clicking that row's BODY still toggles its linked-runs drill-down exactly as before (no rebinding; §S0).
- [ ] A declared `Cycle done` boundary renders exactly ONE badge, `boundary-to-cycle` (no `boundary-detail` — retired); clicking it → Workflow tab active, the containing collapsed CR group auto-expands, the exact cycle row is scrolled into view with the 10s blink; re-clicking within the window resets the animation clock (single indicator, never two); the badge click does NOT toggle the §S2b accordion.
- [ ] §S2b accordion: clicking a declared marker's body hides that cycle's `cycleId`-linked run cards (and only that cycle's); the marker gains a collapsed cue; a second body click restores the cards; other cycles' cards and unlinked cards are unaffected throughout.
- [ ] §S2b default + persistence: cold load renders ALL runs visible; a feed re-render (poll/SSE tick) while one cycle is collapsed keeps exactly that cycle collapsed and everything else expanded.
- [ ] §S2b boundaries: the ACTIVE cycle's open-span runs stay inline regardless of any accordion state; a heuristic RED➜GREEN marker's body click still opens the run drill-in (no accordion on heuristic markers).
- [ ] A completed cycle whose boundary is pruned past retention renders `cycle-to-runs` disabled/dim; clicking does nothing (no tab switch).
- [ ] E2E: full round-trip — Workflow cycle → Runs boundary → back via the boundary → Workflow with blink present; scroll positions asserted (`scrollIntoView` effect on the pane, not the page).

## Estimated size
S.

## Non-goals
Linking ACTIVE (unfinished) cycles to the timeline (the open span already
lists its runs inline); deep-linking the blink state via URL; animating
anything longer than the 10s window.
