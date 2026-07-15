# CR-CRU-016 — In-pane drill-in: run detail inside the Run Timeline pane

**Status:** IN_PROGRESS (2026-07-16 — user "Go with 016, do a gap analysis first"; branch feature/CR-CRU-016)
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
to the run detail; the right Project pane (workspace) and every other surface
region remain mounted, visible, and live (SSE).
**ONE RULE, user-approved 2026-07-16:** the detail is a pane state of
WHICHEVER central pane is active — home timeline pane, workspace Runs pane,
or the Compile/Coverage tab panes (a Compile-tab card and the Coverage tab's
`view run` swap THEIR OWN pane; no tab switching) — and the Project pane's
coverage-meter/trend clicks follow the same rule. `← timeline` (and Escape)
restore that pane's prior content at its exact prior scroll position. Routes are unchanged and deep-linkable
(`/run/<id>`, `/p/<key>/run/<id>` — cold load renders the in-pane detail).
The slide-over container, scrim, and `app-slideover-right` contract are
RETIRED — no overlay/scrim element remains for run detail (the /manage and
/roadmap slide-overs are unaffected).

### §S2 Anatomy + context rules carry over verbatim
The F4 anatomy contract (mono tree lines with inline status counts, glyph +
name + duration leaves, failing-suite auto-expand, inline failure box +
never-empty degradation, `▸ N more failures · toggle raw output` footer) and
the density rules (**purely tier-contextual, NO mode switch anywhere** —
re-baselined 2026-07-16 to CR-007's final §S4.0 form; this section's original
"override switch" wording predated that correction: broad tiers RENDER
Density with the F4½ status-chips row + heat-strip, focused tiers RENDER
Detail, compile renders the status line + diagnostics body; virtualization +
suites-first paging always-on) apply identically in-pane — the container
changes, the content contract does not. Compile and gate (CR-013) bodies
render in-pane the same way.
**VERIFY carryover seam (CR-007 should-fix, documented here):** the
footer-jump FOCUS model — which failure box `▸ N more failures` scrolls to
and what "visible" means for `failureBoxVisible` — was a blessed judgment
seam in CR-007; the in-pane re-target must pin it as an explicit contract
(jump advances to the next failing leaf's box and scrolls it into the pane's
viewport) instead of inheriting it implicitly.

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

## Gap analysis (2026-07-16, pre-design)
What exists (CR-007 final tree, develop 895fce0) vs what this CR changes:
- **Container:** `RunOverlay` (public/app.js:965) renders the detail as a
  fixed sheet on a scrim (`run-overlay-scrim` :1440) with
  `app-drillin app-slideover-right` (:1453); Escape handled at :72;
  `openDrillin` (:444) pushes the `/run/<id>` route. ALL of this is the
  retirement surface — the detail becomes a STATE of the central pane
  (home timeline pane / workspace Runs pane) with everything else mounted.
- **Scroll restore:** current mechanism saves `window.scrollY`
  (`state.savedScrollY`, :28-46) because the sheet overlays the page. AC2
  demands the FEED's exact `scrollTop` — in-pane, the feed's scroll context
  must be captured per-pane (central pane scroller), not window-level.
  Implementation seam, called out for RED precision.
- **Anatomy/density content:** carries verbatim — the inner bodies
  (TestBody/CompileBody, density set, failure boxes incl. the round-3
  degradation, compile status line) are container-agnostic today except for
  overlay-specific assertions. Test surfaces pinning the container:
  tests/storyboard-fidelity.test.ts, tests/e2e/steps/drillin.steps.ts,
  tests/e2e/features/shell-storyboard.feature (grep `slideover|scrim`);
  drill-in/density suites mount by route and mostly assert inner anatomy —
  the RED re-target list (AC5's approved-modification list) starts from
  these three files.
- **Spec drift fixed in this commit:** §S2's "override switch" wording
  predated CR-007's final no-switch rule — re-baselined; VERIFY's carryover
  seam (footer-jump focus model) now an explicit §S2 contract.
- **New surfaces landed AFTER this spec was filed (007 fix round 3) needing
  design decisions in §S3's board iteration:** (a) the workspace now has
  real Coverage/Compile tab panels — decide whether opening a detail from
  the Compile tab's cards or the Coverage tab's `view run` swaps THAT tab's
  pane or activates Runs first (recommendation: the detail is a pane state
  of the ACTIVE central pane, whichever tab hosts it — one rule, no tab
  switching); (b) the Project pane's coverage-meter/trend click opens the
  detail in the central pane while the pane stays live (same rule).
- **Routes:** unchanged and already deep-linkable; cold-load auto-expand
  works (007 fix). Only the render target moves.

## Cycle plan
- C0 (design, precedes RED): F4/F4½ mocks redrawn to in-pane form + nav
  model text ("pane state", overlays only /manage + /roadmap) + the two tab
  interaction decisions — board micro-iteration, user approval gates RED.
- C1: §S1 in-pane container swap + routes + pane-scroll restore + slide-over
  retirement (RED → GREEN).
- C2: §S2 anatomy/density re-target with the approved-modification list +
  focus-model contract (RED → GREEN).
- C3: SSE-liveness + integration ACs (project pane live beside detail).
- C4: BDD drill-in.feature set + VERIFY + close-out.

## Estimated size
M.

## Risk
Scroll restoration + virtualized tree interplay; mitigated by the existing
windowing contract (tree-scroll) and explicit scrollTop ACs.

## Non-goals
Anatomy/density changes (carried verbatim); /manage & /roadmap overlay model;
gate pane (CR-013).
