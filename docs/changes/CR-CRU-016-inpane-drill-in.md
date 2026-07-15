# CR-CRU-016 — In-pane drill-in: run detail inside the Run Timeline pane

**Status:** PENDING
**Type:** feature
**Priority:** P1
**Depends on:** CR-CRU-007
**Labels:** ui, timeline, drill-in
**Phase:** Wave 4 (0.1.0 — user-directed "new CR after 007"; runs BEFORE 011 in the lane)
**Design reference:** board rounds during CR-007 execution (user: "the current right side drill-in view is not very cohesive and it hides the project panel. This view should be drill in to the Run Timeline central pane itself"); F4/F4½ anatomy contract (CR-007 §S3) carries over verbatim

## Context
CR-007 ships the drill-in as a right slide-over sheet (the then-current
storyboard form). Reviewing it live, the user found the sheet **hides the
Project pane** and reads as non-cohesive. Decision: the run detail renders
**inside the Run Timeline central pane itself** — the pane's content swaps from
the feed to the detail and back, while the Project pane (agents, vitals) stays
visible and live throughout. The regression/density context rules are unchanged
and apply identically in-pane.

## Scope

### §S1 In-pane detail (replaces the slide-over)
Clicking a run card / marker / coverage point swaps the CENTRAL pane's content
(home timeline pane or workspace Runs pane) to the run detail; the right
Project pane (workspace) and every other surface region remain mounted,
visible, and live (SSE). `← timeline` (and Escape) restore the feed at its
exact prior scroll position. Routes are unchanged and deep-linkable
(`/run/<id>`, `/p/<key>/run/<id>` — cold load renders the in-pane detail).
The slide-over container, scrim, and `app-slideover-right` contract are
RETIRED — no overlay/scrim element remains for run detail (the /manage and
/roadmap slide-overs are unaffected).

### §S2 Anatomy + context rules carry over verbatim
The F4 anatomy contract (mono tree lines with inline status counts, glyph +
name + duration leaves, failing-suite auto-expand, inline failure box,
`▸ N more failures · toggle raw output` footer) and the density rules
(**regression-only**: focused tiers always Detail with NO mode switch; broad
tiers open Density with the override switch; F4½ status-chips row + heat-strip;
virtualization + suites-first paging always-on) apply identically in-pane —
the container changes, the content contract does not. Compile and gate
(CR-013) bodies render in-pane the same way.

### §S3 Storyboard + nav-model update (design artifacts)
F4/F4½ mocks redrawn to the in-pane form (detail inside the central pane with
the Project pane visible beside it); the nav diagram/model text changes from
"two routed pages + one overlay" to: the run detail is a PANE STATE of L1/L2
(routes unchanged); overlays remain only /manage and /roadmap. Interaction
table + PRD §4.11 synced.

## Acceptance criteria
- [ ] Clicking a run card on the workspace Runs pane swaps that pane's content to the run detail while `data-testid="project-pane"` remains present and visible (same DOM mount — reference equality or absence of remount asserted via a marker attribute); the home timeline pane behaves identically on `/`.
- [ ] `← timeline` and Escape both restore the feed with the exact prior `scrollTop` (fixture scrolls, opens, closes, asserts).
- [ ] Cold-loading `/p/<key>/run/<id>` renders the in-pane detail (Project pane present); `/run/<id>` on home likewise.
- [ ] No `run-overlay-scrim` and no `app-slideover-right` element exists anywhere for run detail (grep + DOM assertions); /manage and /roadmap overlays are untouched.
- [ ] Context rules in-pane: a `unit`-tier detail renders NO `drillin-mode`; a `regression`-tier detail opens in Density with the chips row + heat-strip; the F4 anatomy assertions (tree lines, inline failure box, footer) pass against the in-pane container (re-targeted from the CR-007 slide-over tests — the approved-modification list is part of this CR's RED report).
- [ ] SSE liveness: with the detail open, a new run ingested for the project updates the Project pane's agent row (visible beside the detail) without closing the detail.
- [ ] BDD E2E: a `drill-in.feature` scenario set covering open-from-card, back-restores-scroll, cold-load, and project-pane-stays-visible; results ingested `tier:"e2e"`.

## Estimated size
M.

## Risk
Scroll restoration + virtualized tree interplay; mitigated by the existing
windowing contract (tree-scroll) and explicit scrollTop ACs.

## Non-goals
Anatomy/density changes (carried verbatim); /manage & /roadmap overlay model;
gate pane (CR-013).
