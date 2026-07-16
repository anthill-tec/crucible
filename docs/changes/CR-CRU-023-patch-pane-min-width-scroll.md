# CR-CRU-023 — Patch: pane minimum width + horizontal scroll floor

**Status:** PENDING
**Type:** patch
**Priority:** P3
**Depends on:** CR-CRU-021
**Labels:** patch, ui, layout
**Phase:** Wave 4 (after 021)
**Design reference:** user live review 2026-07-17 ("when the screen size goes
too small introduce a horizontal scroll in the Active workflow window. This
can be a global behaviour for all panes, minimum expected size on standard
computer screens is 1024x640. We will introduce responsive design guidelines
in 0.2.0 to support mobile and tablets")

## Context
Below the supported viewport, pane content crushes: rows wrap awkwardly and
badges distort (the cycle-timer blob was the visible symptom; CR-021 cycle 19
fixes the badge itself, but the pane-level behavior is global scope — hence
this patch). The supported minimum for 0.1.0 is **1024×640** on standard
computer screens; real responsive design (mobile/tablet) is CR-CRU-018's
0.2.0 scope, which this patch explicitly does NOT preempt.

## Scope

### §S1 Global pane scroll floor
Every central content pane (workspace tab panes — Workflow/Runs/Coverage/
Compile/BDD —, the home timeline pane, and the in-pane run detail) gains a
MINIMUM CONTENT WIDTH floor with `overflow-x: auto` on the pane container:
when the viewport is narrower than the supported minimum, the pane scrolls
horizontally instead of crushing its content. One shared mechanism (a pane
container class), not per-pane one-offs. Panes never wrap/distort content to
fit below the floor; the page body never scrolls horizontally at ≥1024px
(the pane scrolls inside itself below its floor).

## Acceptance criteria
- [ ] A shared pane-container class carries `overflow-x: auto` and a `min-width` floor (styles.css source assertion names the class; every central pane — `workflow`, `runs`, `coverage`, `compile`, `bdd` panes, home timeline, run detail — renders inside it, asserted via DOM class presence per pane).
- [ ] E2E (Playwright, viewport 800×640): the Workflow pane with a long-label active plan renders a horizontal scrollbar on the PANE (pane `scrollWidth > clientWidth`), the cycle-timer badge keeps its single-line pill form, and `document.body.scrollWidth <= window.innerWidth` (no page-level horizontal scroll).
- [ ] E2E (viewport 1024×640): standard fixture content renders with NO horizontal scroll on any pane (`scrollWidth <= clientWidth` for each central pane).

## Estimated size
XS.

## Non-goals
Responsive/mobile/tablet layouts, breakpoint redesigns, rail collapsing —
all CR-CRU-018 (0.2.0, which will supersede this floor with real responsive
guidelines).
