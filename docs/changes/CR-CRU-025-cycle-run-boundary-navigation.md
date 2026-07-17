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
view, scroll the view up."

## Context
Completed cycles exist on two surfaces with no link between them: the
Workflow lens (cycle rows) and the Runs timeline (declared `Cycle done`
boundary markers, CR-011 §S0b). Chrome-verified current forms: Workflow row
`✓ cycle <n> · "<label>"` + aligned ⏱; Runs boundary
`↺ Cycle done · <label> · <cr> · closed in <duration>`.

## Scope

### §S1 Cycle row → Runs boundary
A COMPLETED cycle row (done/skipped/failed — active-plan section AND history
drill-downs alike) is clickable: navigates to the Runs tab and scrolls the
cycle's declared `Cycle done` boundary marker into view (center-ish), with
the same 10s locate-blink treatment as §S2.4 applied to the marker. Cycles
without a declared boundary on the retained timeline (pruned past retention)
show a dim non-clickable state — never a dead click.

### §S2 Runs boundary → cycle row (inverse)
Clicking a `Cycle done` boundary marker on the Runs timeline:
1. Switches to the Workflow tab (one-rule tab swap).
2. Locates the exact CR and cycle: in the ACTIVE section directly, or in
   HISTORY — auto-expanding the containing CR group (and its wave, if
   grouping hides it) when collapsed.
3. Scrolls the cycle row into view (History long/off-screen → the pane
   scrolls to it).
4. Renders a **locate blink**: a blinking indicator against the exact cycle
   row for EXACTLY 10 seconds, then stops (CSS animation with a JS-cleared
   marker class; no residue after 10s; re-triggering resets the clock).

### §S3 Symmetry + state rules
The behavior works for any completed cycle of the currently active plan AND
any cycle in history. The expansion state changes caused by auto-expand
persist (they ARE the lens toggles — no phantom restore); the one-rule
scroll-restore contract is unaffected for other navigations.

## Acceptance criteria
- [ ] A done cycle row in the ACTIVE section carries a navigation affordance; clicking it lands on the Runs tab with the matching `Cycle done` boundary (matched by cycleId) scrolled into view and blinking; the blink class is GONE after 10s (injected-clock or bounded-wait assertion).
- [ ] Same from a HISTORY cycle row (inside an expanded group).
- [ ] Clicking a `Cycle done` boundary in Runs → Workflow tab active; the containing collapsed CR group auto-expands; the exact cycle row is scrolled into view with the 10s blink; re-clicking within the window resets the animation clock (single indicator, never two).
- [ ] A completed cycle whose boundary is pruned past retention renders the row's navigation affordance disabled/dim; clicking does nothing (no tab switch).
- [ ] E2E: full round-trip — Workflow cycle → Runs boundary → back via the boundary → Workflow with blink present; scroll positions asserted (`scrollIntoView` effect on the pane, not the page).

## Estimated size
S.

## Non-goals
Linking ACTIVE (unfinished) cycles to the timeline (the open span already
lists its runs inline); deep-linking the blink state via URL; animating
anything longer than the 10s window.
