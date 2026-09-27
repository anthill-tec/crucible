# CR-CRU-159 — a heat-strip click brings its test into view

**Type** fix · **Points** 3 (planning game 2026-09-27) · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-09-27

## Problem

**User defect (2026-09-27, with a screenshot of a 734-test e2e run):** clicking a cell of a run's
heat strip (the clickable state indicator above the tree) expands the corresponding test node, but
in a large run that node opens **outside the viewport**, so nothing visible happens.

**Found 2026-09-27:** the heat-cell handlers (`HeatCell` and `SynthHeatCell` in `RunDetailBody`,
`public/app.js`) move the suite's virtualisation window, open the failure group and set
`focusedLeaf`, but never scroll. The board already has the pattern elsewhere: the cycle ↔ runs
navigation and the roadmap drill-through (`revealDrillTarget`) call `scrollIntoView()` and then
`locateBlink` on their target.

## Scope

### §S1 — the click reveals the node

A heat-cell click, after it has expanded the node (including a suite whose leaves load on the
click), scrolls the run view's own scroller (`pane-scroll`) so the node is in view and blinks it
with the existing `locateBlink`. It works in both presentations (Detail and Density), for plain
suite trees and for spec runs grouped by feature (`SpecFeatures`), where the node's feature is
unfolded first.

### §S2 — the header stays put

The run-detail header stays pinned (CR-CRU-016 §S1); only the pane's scroller moves.

## Acceptance criteria

- [ ] In a real browser, on a run large enough that the target is below the fold, clicking a heat
      cell leaves the expanded node inside the pane's visible area, and it blinks.
- [ ] The same holds for a cell whose suite was still collapsed (its leaves load on the click) and
      for a spec run whose feature was folded.
- [ ] Clicking a cell whose node is already in view does not move the pane.
- [ ] The behaviour matches storyboard **F20** (drawn 2026-09-27, the visual contract).
