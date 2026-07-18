# CR-CRU-029 — Patch: dual-axis scroll always operable in narrow viewports

**Status:** PENDING
**Type:** patch
**Priority:** P2
**Depends on:** CR-CRU-023 (the pane horizontal-scroll floor)
**Labels:** patch, ui, responsive, a11y
**Phase:** Wave 4 (0.1.0 — user-filed 2026-07-18)
**Design reference:** user bug report 2026-07-18 (screenshot
crucible_horizontal_scroll_issue.jpg): "The horizontal scroll on reduced
screen resolution itself scrolls out of view when there is a vertical scroll
in the display. Both vertical and horizontal scroll should be operable at all
times when operating in a smaller view port."

## Context
CR-023 §S1 gave panes a horizontal-scroll FLOOR for narrow viewports
(`.app-pane-content { overflow-x: auto }` + a child `min-width: 660px`, the
1024×640 supported minimum). But the horizontal scrollbar renders at the
BOTTOM of the (tall) scrollable content, not pinned to the viewport. When the
pane also overflows VERTICALLY (long history lists, deep run trees), scrolling
down carries the horizontal scrollbar off-screen — the user can no longer
reach it. Only ONE axis is operable at a time. The requirement: BOTH axes
operable at ALL times at the supported minimum viewport.

## Scope

### §S1 Viewport-bounded dual-axis scroll container
The pane scroll surface (`.app-pane-content`, the `data-testid="pane-scroll"`
elements from CR-023) must be a HEIGHT-BOUNDED scroll container so both
scrollbars belong to the same viewport-sized box and stay reachable
simultaneously — not a horizontal scroller whose bar sits at the bottom of
overflowing vertical content. Mechanism is a gap-analysis decision; candidates:
(a) the pane owns BOTH axes (`overflow: auto` on a flex/grid-bounded
`min-height:0` box, so the horizontal bar pins to the pane's bottom edge and
the vertical bar to its right edge — both visible regardless of scroll
position); or (b) a sticky horizontal scroll affordance pinned to the pane's
bottom. Preference: (a) — one bounded container, native scrollbars, no
custom sticky JS — unless it breaks the CR-016 scroll-restore contract.

### §S2 Preserve the existing contracts
- CR-023 §S1 horizontal floor (660px child min-width, 1024×640 minimum) is
  unchanged in effect — this fixes REACHABILITY, not the floor value.
- CR-016 pane scroll-restore (the detail returns the feed to its exact prior
  scrollTop) must still hold on the bounded container.
- The pane-scroll testids and the surfaces they cover (CR-023) stay.

## Acceptance criteria
- [ ] At the supported minimum viewport (1024×640, and narrower down to the 660px floor), a pane whose content overflows on BOTH axes exposes a horizontal scrollbar that remains visible/reachable while the pane is scrolled vertically to any position (e2e/viewport assertion: the horizontal scroll affordance's bounding box stays within the viewport at top, middle, and bottom vertical scroll).
- [ ] Horizontal scrolling still works (content wider than the pane scrolls left↔right) AND vertical scrolling still works, at the same time, without either bar leaving the viewport.
- [ ] CR-016 scroll-restore: opening then closing a run detail returns the feed to its exact prior scroll position on the bounded container (regression).
- [ ] The CR-023 pane-scroll-floor pins stay green (660px child min-width, testids intact).
- [ ] E2E: a viewport scenario at ≤1024×640 with over-tall + over-wide content asserts both scrollbars operable (drives a horizontal scroll after a vertical scroll).

## Estimated size
S.

## Non-goals
Mobile/tablet responsive redesign (0.2.0, CR-018); changing the 1024×640
supported minimum or the 660px floor; custom scrollbar styling.
