# CR-CRU-018 — Responsive Crucible: mobile + tablet media support

**Status:** PENDING (0.3.0 — user-filed during CR-007 execution: "we have not
considered media like a mobile phone"; carried past 0.2.0, now wave 7)
**Type:** feature
**Priority:** P3
**Depends on:** CR-CRU-015 (its BDD section renders this CR's viewport evidence; see the note below), CR-CRU-016 (final pane/drill-in geometry must exist first), CR-CRU-093 (the pane-collapse mechanism this reuses)
**Labels:** ui, responsive, mobile
**Phase:** Wave 7 (0.3.0)

> **NOTE FROM CR-CRU-015 (2026-09-18), so this CR's RED phase does not rediscover it.** The e2e
> suite's ordering constraint changed: `shell-storyboard.feature`'s F1 empty-DB precondition is now
> selected by an `@empty-db` TAG into its own `chromium-empty-db` project, and every other project
> depends on that one — nothing depends on the main body, so a body failure skips nothing. A mobile
> viewport project added here that re-runs the whole suite body **MUST carry
> `grepInvert: /@empty-db/`**, or it runs the ordering precondition a second time — which both reds
> `tests/e2e-suite-dependency-graph.test.ts`'s invariant (the precondition must run exactly once)
> and seeds the "empty" database ahead of that second run. One line; free if known up front.

## Context
**Interim floor already shipped by CR-CRU-023 (0.1.0 patch):** panes carry a
min-width + `overflow-x:auto` scroll floor for sub-1024×640 viewports; this
CR's responsive guidelines SUPERSEDE that floor with real breakpoints.

Crucible's layout is desktop-only: fixed multi-column grids (timeline +
Project pane), a wide projects row, hover-dependent affordances. On a phone
the dashboard is unusable. The density system (comfortable/compact/ultra) is
already global; this CR makes the LAYOUT adapt to the medium.

## Scope

### §S1 Breakpoint system
Forge-token breakpoints (e.g. ≤640px phone, ≤1024px tablet) applied
throughout: the projects row wraps/scrolls gracefully; home timeline goes
single-column full-width; the workspace's [content | Project pane] stacks
(pane collapses to an expandable summary strip under the tabs — this **reuses
CR-CRU-093's collapse mechanism and its persisted state**, viewport-driven here
rather than user-driven; two independent collapse implementations on one region
is a defect); the in-pane drill-in (CR-016) fills the viewport with the ← back
chip prominent; /manage and /roadmap slide-overs become full-screen sheets on
phones. The roadmap release strip pages by whole containers at every breakpoint
(CR-CRU-078): a narrower viewport shows **fewer** gates and a higher hidden
count, never a partial one.

### §S2 Touch affordances
Hover-only affordances get touch equivalents: tap targets ≥44px on
interactive rows/chips; the cursor-affordance rule translates to visible
pressed/active states; heat-strip cells enlarge on touch media; density
default on phones = compact.

### §S3 No horizontal overflow — ever
At every breakpoint, no page-level horizontal scroll; wide content (trees,
diagnostics, raw output) scrolls inside its own container.

## Acceptance criteria
- [ ] BDD E2E with mobile viewport projects (Playwright devices "Pixel 7" or equivalent + a tablet profile): home renders single-column, no page-level horizontal scroll (scrollWidth ≤ innerWidth asserted on every routed surface + open drill-in).
- [ ] Workspace on phone: tabs row wraps/scrolls in its own container; Project pane renders as the collapsed summary strip and expands on tap; the in-pane detail fills the viewport with the ← chip visible without scrolling.
- [ ] Touch targets: every interactive chip/row/card measures ≥44px in either dimension on the phone profile (sampled assertions on badges, tabs, cards, back chips).
- [ ] Density defaults to compact on phone media (overrideable by the toggle; persisted as usual).
- [ ] Desktop is pixel-unchanged at ≥1280px (the existing desktop BDD scenarios re-run green with zero modifications).

## Estimated size
M.

## Risk
Storyboard mocks are desktop-form — mobile mocks (a design micro-iteration on
the board) precede RED, per the storyboard-100%-compliance rule.

## Non-goals
Native apps; PWA/offline; push notifications; portrait-specific redesigns of
the graph views (they scroll).
