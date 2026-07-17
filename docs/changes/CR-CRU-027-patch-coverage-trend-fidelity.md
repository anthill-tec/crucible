# CR-CRU-027 — Patch: coverage-trend mock fidelity (F8 vitals sparkline)

**Status:** IN_PROGRESS — AWAITING MERGE GATE (2026-07-17: cycle plan complete; regression 762/762 + coverage 89.2%/84.7% ingested; playwright 29/29 ingested tier:e2e evt-1784291999440-7; tsc 0; eyes-parity MEASURED)
**Type:** patch
**Priority:** P1 (repeat drift — flagged by the user in two separate live
rounds; the second time with maximum displeasure)
**Depends on:** CR-CRU-023 (§S2 trend series plumbing — data side is done)
**Labels:** patch, ui, vitals, storyboard-fidelity
**Phase:** Wave 4 — proposed immediately after CR-CRU-026, before 008
**Design reference:** storyboard F8 vitals mock (THE contract, user-ruled
2026-07-17: "I want this MOCK view to be implemented in UI, NOT YOUR SHIT!
… PATCH CR THIS DRIFT!"); first flagged 2026-07-17 morning round ("Vitals
dont display coverage trend as bar chart anymore!") → CR-023 §S2 fixed the
render GATE (bars at ≥1 point) but shipped the wrong GEOMETRY.

## Context
The F8 mock draws the trend as a compact left-aligned sparkline: fixed
`width:9px` bars, `gap:3px`, cluster `height:26px`, `align-items:flex-end`,
bar height = the coverage percent, history bars `--ember-dim`, latest bar
`--ember`, caption `<first> → <last>% lines`. The shipped
`.app-trend-bar` uses `flex: 1 1 0` in a 36px-tall container
(public/styles.css:321-334) — bars STRETCH to split the full card width, so
a 2-point series renders as two giant slabs. Caption and coloring already
match; the drift is pure geometry. **Chrome-measured 2026-07-17 (live
workspace, getBoundingClientRect): 2 bars × 131px wide × 34px tall filling
the 281px card — vs the mock's 9px × ≤26px left-aligned cluster (~21px total
for 2 points). Zoom screenshot captured in the round.**

## Scope

### §S1 Bar geometry — mock-exact
`.app-trend-bars`: height 26px (was 36), left-aligned flex-end cluster.
`.app-trend-bar`: fixed `width: 9px` (`flex: 0 0 9px`), `gap: 3px`,
rounded-top as shipped. NO stretching at any point count — 1 point renders
one 9px bar, 2 points render two, never slabs. Bar height stays the percent
of the cluster height; dim/latest coloring unchanged.

### §S2 Series windowing (cap proposal — confirm at gap analysis)
Retention allows up to ~100 points; the card fits ~16 9px bars. Render the
MOST RECENT 16 points (chronological, latest last + bright); the caption's
`<first>` refers to the first RENDERED point (window-consistent, never a
value the bars don't show). Cap value is the gap-analysis knob; the
no-stretch rule is not.

### §S3 Eyes-parity gate
Orchestrator Chrome-pass against the F8 mock BEFORE verify (per
storyboard-100-percent-compliance): same cluster proportions, same
left-aligned silhouette, dim→bright progression, caption form. Screenshot
into the gate presentation.

## Acceptance criteria
- [ ] With a 2-point series, each `coverage-trend-bar` has computed width 9px (getComputedStyle assertion) and the cluster is left-aligned — total bars width ≈ 21px, NOT the card width; with 1 point, one 9px bar.
- [ ] With a 20-point series, exactly 16 bars render (the most recent 16), latest-last carries `app-trend-bar-latest`, the other 15 `app-trend-bar-dim`; the caption reads `<points[4]> → <points[19]>% lines` (window-consistent first value).
- [ ] Bar heights equal each point's percent of the 26px cluster (style assertion on height:%).
- [ ] E2E/visual: the workspace vitals card renders the sparkline silhouette (bounded-width bars) at the standard viewport — pixel-width assertion via bounding boxes, not screenshot diffing.
- [ ] Existing CR-023 §S2 pins stay green (bars at ≥1 point; absent-not-null trend).

## Estimated size
XS.

## Non-goals
Changing the trend DATA series (CR-023 server plumbing stays); charting-
library adoption (that is CR-022's analytics scope — this card stays
hand-rolled per the mock); touching the coverage meter (.app-meter is
already mock-faithful).

## Implementation Notes
- Delivered in one red-green cycle + verify: §S1 geometry (styles.css —
  `.app-trend-bar` `flex: 1 1 0` → `flex: 0 0 9px`, dead `min-width: 4px`
  removed; `.app-trend-bars` 36px → 26px; gap/flex-end/rounding unchanged)
  and §S2 windowing (app.js CoverageTrendCard — one `slice(-16)` at the
  series entry point; bars, latest/dim classes and the caption stay
  window-consistent from the single site).
- Eyes-parity gate (Chrome-measured on the live workspace, per the
  storyboard-compliance measured rule): bar widths [9, 9] px, cluster
  height 26px, two-point span 21px (mock math 9+3+9), left-aligned, bar
  heights 25/24px = 94.4%/93.1% of the cluster, caption
  `94.4 → 93.1% lines`. The 131px-slab drift is gone.
- Test route: happy-dom resolves no CSS cascade (probe-verified:
  getComputedStyle returns "" for width/flex without a loaded stylesheet),
  so the width/height contracts pin via the established styles.css
  source-assertion technique (`ruleBody()`, f13-fidelity precedent) with
  DOM-side pins for counts/classes/inline heights; rationale documented in
  the test file header.
- VERIFY: PASS — zero blocking, zero should-fix, all 5 ACs MET; suggestion
  recorded here for traceability (the eyes-parity evidence lives in these
  notes; a durable playwright bounding-box guard is a possible follow-up,
  suggestion-tier).
