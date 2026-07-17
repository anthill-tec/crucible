# CR-CRU-023 — Patch: gate-review defects — pane scroll floor · vitals trend chart · timer restart semantics

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

### §S2 Vitals coverage-trend bar chart regression (user 2026-07-17: "Fix this in the next patch CR!")
The workspace Vitals COVERAGE TREND box regressed from the bar-chart form
(one bar per green-regression coverage point) to a text-only line ("latest
green coverage 93.1%" / "82.1 → 87.3% lines"). Restore the bar chart:
one tinted bar per retained green-regression coverage point (the SQLite
rollup series the meter already reads), latest last, with the existing
range caption beneath. Root-cause note for gap analysis: determine WHEN the
bars stopped rendering (suspect: the trend requires ≥N points and event
retention/rollup pruned the series, or a C2-era Vitals markup change) — fix
the actual cause, not just the symptom.

### §S3 Active-timer restart semantics (user 2026-07-17)
After a power outage the ACTIVE cycle's ticking timer showed "odd values"
(elapsed spans included the downtime — 246m on a cycle that had minutes of
real attention). User-sanctioned outcomes, choose ONE at gap analysis:
(a) **resume from the old setpoint** — accumulate active time in server-up
epochs (persist accumulated `activeMs` per active cycle; on service restart
resume the count, excluding downtime), or
(b) **reset on service restart** — the ticking display anchors to
`max(activatedAt, serverStartedAt)`.
Orchestrator recommendation: (a) — it makes the ticking value MEANINGFUL
(attention time) and honest across outages; note the DN-crucible-analytics
implication either way (its §3 loop-time definition `doneAt − activatedAt`
must state whether downtime is excluded — the DN gets a dated amendment with
whichever semantics is chosen; sealed historical durations are NOT
retroactively rewritten).

### §S4 CR-021 VERIFY follow-ups (cosmetic/tech-debt, verify-recommended 2026-07-17)
1. Singular run hint: collapsed cycle hints read `▸ 1 run` at N=1 (`▸ N runs`
   otherwise) — app.js:1491 region; pin the N=1 case.
2. Retire the hidden legacy rollup span: re-target the two frozen CR-020
   assertions (workflow-lens.test.ts:753, workflow-history-refinements.test.ts
   :344/366) onto the VISIBLE rollup form and delete the `.app-hidden-data`
   `cr-rollup` compatibility span (app.js:1557-1560, styles.css:738-744) —
   sanctioned re-target recorded here.

## Acceptance criteria
- [ ] A shared pane-container class carries `overflow-x: auto` and a `min-width` floor (styles.css source assertion names the class; every central pane — `workflow`, `runs`, `coverage`, `compile`, `bdd` panes, home timeline, run detail — renders inside it, asserted via DOM class presence per pane).
- [ ] E2E (Playwright, viewport 800×640): the Workflow pane with a long-label active plan renders a horizontal scrollbar on the PANE (pane `scrollWidth > clientWidth`), the cycle-timer badge keeps its single-line pill form, and `document.body.scrollWidth <= window.innerWidth` (no page-level horizontal scroll).
- [ ] E2E (viewport 1024×640): standard fixture content renders with NO horizontal scroll on any pane (`scrollWidth <= clientWidth` for each central pane).

- [ ] §S2: with 4 retained green-regression coverage points, the Vitals COVERAGE TREND box renders 4 bar elements (heights monotone with the coverage values, latest last) + the range caption; with 1 point it renders 1 bar (no text-only fallback).
- [ ] §S4: a 1-run collapsed cycle hint renders `▸ 1 run` (N=1 fixture); the `cr-rollup` testid exists ONLY as the visible rollup form (no `.app-hidden-data` span in the DOM), with the two CR-020 assertions re-targeted onto it.
- [ ] §S3: per the option chosen at gap analysis — (a) an active cycle's timer value derives from persisted accumulated epochs and a simulated service restart (store reopen) resumes the accumulated value, not wall-clock-since-activation (CHECKPOINT CADENCE, recorded at the verify fix round: the accumulated value persists at ≤60s intervals while active — a hard crash loses at most one 60s window; the resume pin asserts within that tolerance); or (b) the display anchors to `max(activatedAt, serverStartedAt)` asserted with an injected boot timestamp. Sealed history rows keep `doneAt − activatedAt` untouched either way; the DN amendment ships in the same cycle.

## Estimated size
S.

## Non-goals
Responsive/mobile/tablet layouts, breakpoint redesigns, rail collapsing —
all CR-CRU-018 (0.2.0, which will supersede this floor with real responsive
guidelines).
