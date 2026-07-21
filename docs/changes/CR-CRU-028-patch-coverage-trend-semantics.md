# CR-CRU-028 — Coverage trend: auto-coarsening health hierarchy (DN-locked)

**Status:** COMPLETED (shipped 2026-07-21)
**Type:** feature (grew from patch — the locked DN model supersedes the
flat-bar card)
**Priority:** P2
**Depends on:** CR-CRU-033 (date-keyed coverage-by-day series — the data
prerequisite), CR-CRU-027 (fixed-slice geometry discipline)
**Labels:** ui, vitals, coverage
**Phase:** Wave 4 — slot proposed after CR-CRU-008 (user to confirm)
**Design reference:** [DN-crucible-coverage-trend.md](../research/DN-crucible-coverage-trend.md)
§6 (data-model amendment 2026-07-21) — LOCKED 2026-07-17 (user: "Approving the
Coverage graphics design");
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
by ITS value on the orange→yellow→green ramp, thresholds pinned as named
constants: **`COVERAGE_LEVEL_ORANGE_MAX = 65`** and
**`COVERAGE_LEVEL_YELLOW_MAX = 80`** — orange `< 65`, yellow `[65, 80)`,
green `≥ 80` (DN §3.2 legend). The latest bar's emphasis composes with its
level color. The bars are bucketed CLIENT-SIDE (day → week → month grouping)
from CR-033's date-keyed `coverageTrend` series (`{day, percent}[]` on the
project brief) — no server query here. CR-027's fixed-slice geometry
discipline holds at every level (each level its own fixed slice width; no
stretching at any count).

### §S2 Drill-down hierarchy (DN §3.3-§3.4)
Clicking a bar unfolds the next-finer level beneath it, **one branch open per
card** (accordion — opening a bar collapses any sibling branch): month → its
weeks, week → its days, day → the coverage-run HEAT STRIP — one thin
level-colored slice per coverage-bearing green regression inside retention,
hover = value + time. The heat strip's per-run slices are read from the
already-loaded workspace feed (`state.events`, project-scoped up to retention
per CR-032 §S4) — the day/week/month bars come from the CR-033 series, the
strip from live events. Clicking a slice opens the existing run drill-in as a
pane state (the interaction table's coverage-point contract, unchanged). Days
aged past run retention keep their bar with a DIMMED drill affordance — never a
dead click (per-run detail is genuinely no longer stored; the bucket survives).

## Acceptance criteria
- [ ] Bucketing: a fixture CR-033 `coverageTrend` series (`{day, percent}[]`) spanning 3 months renders month bars for the old range, week bars for the mid range, day bars for the recent days, ≤16 total; widths strictly increase month < week < day (class/style pin); the bucketing is a pure client transform of the dated series (no event query for the top level).
- [ ] Level color: bars valued `<65` / `[65,80)` / `≥80` carry the orange / yellow / green classes respectively (against the named constants `COVERAGE_LEVEL_ORANGE_MAX=65`, `COVERAGE_LEVEL_YELLOW_MAX=80`); the latest bar composes emphasis + level (both classes present); a monotone high series renders all-green (the user's screenshot case).
- [ ] Drill-down: clicking a month bar reveals its week row; a week its day row; a day its heat strip with exactly one slice per retained coverage-bearing green regression of that day (count pinned against a seeded fixture), each slice colored by its own value.
- [ ] Slice → run drill-in: clicking a slice opens /run/<eventId> of that regression as a pane state (existing contract, testid-pinned).
- [ ] Retention honesty: a day whose runs are pruned renders its bar (rollup value intact) with the dimmed affordance; clicking does NOT unfold — no dead strip.
- [ ] CR-027 regression: fixed-slice geometry pins stay green; caption stays consistent with the rendered top level per gap analysis.
- [ ] Eyes-parity: Chrome-measured against the synced F8 mock before verify.

## Estimated size
S-M (hierarchy + drill-down + strip; re-estimate at gap analysis).

## Non-goals
The date-keyed coverage-by-day SERIES and the rollup fold re-keying (CR-CRU-033's
scope — this CR consumes the finished series); charting-library adoption
(CR-022's analytics pane); the coverage METER (separate element, already
mock-faithful); function-coverage series (lines only, as today); cross-project
aggregation (DN non-goal).
