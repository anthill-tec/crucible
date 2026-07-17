# CR-CRU-028 — Coverage trend: auto-coarsening health hierarchy (DN-locked)

**Status:** PENDING
**Type:** feature (grew from patch — the locked DN model supersedes the
flat-bar card)
**Priority:** P2
**Depends on:** CR-CRU-027 (fixed-slice geometry discipline), CR-CRU-023
(rollup series + retention)
**Labels:** ui, vitals, coverage
**Phase:** Wave 4 — slot proposed after CR-CRU-008 (user to confirm)
**Design reference:** [DN-crucible-coverage-trend.md](../research/DN-crucible-coverage-trend.md)
— LOCKED 2026-07-17 (user: "Approving the Coverage graphics design");
supersedes the interim gradient-only and granularity questions from the
same day's rounds — both dissolved by the hierarchy (buckets AND per-run,
layered).

## Context
After CR-027 fixed the geometry, two semantic gaps remained: bar color
carried no meaning (a 94.4% and a 60% bar looked identical), and the series
was bucket-coarse (one bar per day, valued only as runs aged past the
100-run retention — measured live: two bars [94.4, 93.1] while five+
coverage runs sat unrepresented). The design rounds resolved both into the
DN's model: level-colored auto-coarsening bucket bars with an accordion
drill-down that ends at the per-run heat strip and the existing run
drill-in.

## Scope

### §S1 Auto-coarsening level-colored bucket bars (DN §3.1-§3.2)
Top level renders ≤16 bars: recent DAY bars, older WEEK bars, oldest MONTH
bars — width-hinted zoom (month < week < day widths). Every bar is colored
by ITS value on the orange→yellow→green ramp (thresholds pinned at gap
analysis as named constants; the F8 legend is provisional at 65/80); the
latest bar's emphasis composes with its level color. Derived entirely from
the immortal daily/wave rollups — aggregation only, no schema change.
CR-027's fixed-slice geometry discipline holds at every level (no
stretching at any count).

### §S2 Drill-down hierarchy (DN §3.3-§3.4)
Clicking a bar unfolds the next-finer level beneath it (accordion;
one-open-per-card is a gap-analysis call): month → its weeks, week → its
days, day → the coverage-run HEAT STRIP — one thin level-colored slice per
coverage-bearing green regression inside retention, hover = value + time.
Clicking a slice opens the existing run drill-in as a pane state (the
interaction table's coverage-point contract, unchanged). Days aged past
run retention keep their bar with a DIMMED drill affordance — never a dead
click (per-run detail is genuinely no longer stored; the bucket survives).

## Acceptance criteria
- [ ] Bucketing: a fixture series spanning 3 months renders month bars for the old range, week bars for the mid range, day bars for the recent days, ≤16 total; widths strictly increase month < week < day (class/style pin); the top level reads ONLY rollup data (no event queries).
- [ ] Level color: bars below/inside/above the pinned thresholds carry the orange/yellow/green classes respectively; the latest bar composes emphasis + level (both classes present); a monotone high series renders all-green (the user's screenshot case).
- [ ] Drill-down: clicking a month bar reveals its week row; a week its day row; a day its heat strip with exactly one slice per retained coverage-bearing green regression of that day (count pinned against a seeded fixture), each slice colored by its own value.
- [ ] Slice → run drill-in: clicking a slice opens /run/<eventId> of that regression as a pane state (existing contract, testid-pinned).
- [ ] Retention honesty: a day whose runs are pruned renders its bar (rollup value intact) with the dimmed affordance; clicking does NOT unfold — no dead strip.
- [ ] CR-027 regression: fixed-slice geometry pins stay green; caption stays consistent with the rendered top level per gap analysis.
- [ ] Eyes-parity: Chrome-measured against the synced F8 mock before verify.

## Estimated size
S-M (hierarchy + drill-down + strip; re-estimate at gap analysis).

## Non-goals
Charting-library adoption (CR-022's analytics pane); the coverage METER
(separate element, already mock-faithful); function-coverage series (lines
only, as today); cross-project aggregation (DN non-goal).
