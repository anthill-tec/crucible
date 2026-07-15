# CR-CRU-018 — Responsive Crucible: mobile + tablet media support

**Status:** PENDING (0.2.0 — user-filed during CR-007 execution: "we have not
considered media like a mobile phone")
**Type:** feature
**Priority:** P3
**Depends on:** CR-CRU-016 (final pane/drill-in geometry must exist first)
**Labels:** ui, responsive, mobile
**Phase:** Wave 5/6 (0.2.0) — lane allocated by mainline at 0.2.0 planning

## Context
Crucible's layout is desktop-only: fixed multi-column grids (timeline +
Project pane), a wide projects row, hover-dependent affordances. On a phone
the dashboard is unusable. The density system (comfortable/compact/ultra) is
already global; this CR makes the LAYOUT adapt to the medium.

## Scope

### §S1 Breakpoint system
Forge-token breakpoints (e.g. ≤640px phone, ≤1024px tablet) applied
throughout: the projects row wraps/scrolls gracefully; home timeline goes
single-column full-width; the workspace's [content | Project pane] stacks
(pane collapses to an expandable summary strip under the tabs); the in-pane
drill-in (CR-016) fills the viewport with the ← back chip prominent; /manage
and /roadmap slide-overs become full-screen sheets on phones.

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
