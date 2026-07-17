# DN — Coverage Trend: long-term project health from a test-coverage POV

**Author:** Antony John
**Co-author:** claude (orchestrator — crucible)
**Date:** 2026-07-17
**Status:** LOCKED (design rounds 2026-07-17 on the F8 vitals card; user:
"Approving the Coverage graphics design")
**Consumed by:** CR-CRU-028 (implementation) · storyboard F8 (visual contract)
**Depends on designs:** CR-CRU-023 §S2 (durable rollup series) · CR-CRU-027
(sparkline geometry) · DN-crucible-analytics §3 (two-clock separation — this
card is coverage, not time)

## 1 Purpose
One card that answers "how healthy is this project's test coverage, long
term?" at a glance, and lets the eye drill from months down to the exact
run that moved the number — without ever congesting.

## 2 Population
Coverage-BEARING green regressions ONLY (the series CR-023 defined). This
keeps every level naturally sparse: a heavy dog-food day produced ~150
events but ~5 coverage points.

## 3 The model (locked)
1. **Auto-coarsening bucket bars (top level):** recent days render as DAY
   bars; older history coarsens to WEEK bars, then MONTH bars — the card
   never exceeds ~16 bars regardless of project age. Bar WIDTH hints the
   zoom level (month < week < day). Derived entirely from the daily/wave
   rollups, which persist forever — aggregation only, no schema change.
2. **Level color:** every bar/slice is colored by ITS value on the
   orange→yellow→green ramp (F8 legend: orange <65 · yellow 65-80 · green
   ≥80 — exact thresholds pinned at CR-028 gap analysis). The latest
   element keeps an emphasis treatment composed with its level color.
3. **Drill-down (one gesture, every altitude):** clicking a bar unfolds
   the next-finer level beneath it, accordion-style (month → its weeks,
   week → its days); a DAY unfolds its coverage runs as a **heat strip**
   (one thin level-colored slice per run, hover = value + time). Clicking
   a slice opens the EXISTING run drill-in via the one-rule pane state —
   the interaction table's coverage-point contract, unchanged.
4. **Retention honesty:** per-run strips exist only for days whose runs
   are inside the project's run retention (count-based, per-project,
   editable via the manager). Aged-out days keep their bar; the drill-down
   affordance dims — per-run detail is genuinely no longer stored, only
   the bucket survives. Never a dead click.
5. **Geometry:** CR-027's fixed-slice discipline carries over (no
   stretching at any count; the F8 mock is the geometry contract).

## 4 Health story by altitude
Months = trajectory · weeks/days = momentum · day strip = intra-day
stability · run drill-in = the suite that moved the number.

## 5 CR mapping & non-goals
CR-CRU-028 implements the model end-to-end (§S1 bars, §S2 drill-down).
Non-goals: charting-library adoption (CR-022's analytics pane); the
coverage METER (separate element); function-coverage series (lines only,
as today); cross-project aggregation.
