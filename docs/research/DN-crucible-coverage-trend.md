# DN — Coverage Trend: long-term project health from a test-coverage POV

**Author:** Antony John
**Co-author:** claude (orchestrator — crucible)
**Date:** 2026-07-17
**Status:** LOCKED (design rounds 2026-07-17 on the F8 vitals card; user:
"Approving the Coverage graphics design") · amended 2026-07-21 (§6 — data
model corrected to a server date-keyed daily series after CR-028 gap analysis)
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
The model ships in two CRs: **CR-CRU-033** delivers the date-keyed
coverage-by-day SERIES (§6 below — the data prerequisite); **CR-CRU-028**
implements the client hierarchy on that clean series (§S1 bars, §S2
drill-down). Non-goals: charting-library adoption (CR-022's analytics pane);
the coverage METER (separate element); function-coverage series (lines only,
as today); cross-project aggregation.

## 6 Amendment 2026-07-21 — the series is a date-keyed daily series, not the raw CR-023 rollups
CR-028 gap analysis found the §3.1 assumption — "derived entirely from the
daily/wave rollups" — does NOT hold against the CR-023 rollup implementation,
so the model as first locked is not buildable on that data. Two facts:
1. **Rollups are prune-only.** `foldIntoRollup` runs only inside
   `enforceRetention` — a bucket exists only after an event ages PAST
   retention. Recent within-retention coverage runs are never rolled up, so a
   rollups-only top level would render exactly the "recent coverage
   unrepresented" bug this card exists to fix.
2. **Rollup buckets are keyed `context.wave ?? UTC-day`** — mixed, and
   wave-keyed buckets carry no date, so they cannot sit on a day/week/month
   axis (a wave spans many days, collapsed to one undateable bucket).

**Corrected data model (locked 2026-07-21):**
- The card consumes a **server-computed date-keyed coverage-by-day series**,
  `{ day: "YYYY-MM-DD", percent }[]` oldest→newest — NOT the raw rollups and
  NOT the old flat `number[]` payload.
- The server builds it by MERGING, per UTC day: (a) day-keyed rollups (days
  aged past retention) + (b) within-retention coverage-bearing green-regression
  events grouped by their UTC day (last-of-day wins). This closes the recent-day
  gap: recent days come from live events, older days from rollups.
- **Coverage rollups are re-keyed to always UTC-day** (the `context.wave`
  bucket key is dropped for the rollup). Safe: the ONLY consumer of the rollup
  series is this coverage trend (via `lastCoverage`); no surface reads the
  rollup's wave-grouping or its run/pass/fail aggregates.
- **Legacy wave-keyed rollup buckets are excluded** from the date series — their
  source events are already deleted, so no per-day is recoverable. A bounded
  one-time historical gap; going forward every fold is date-keyed, so no new
  gaps accrue. (Recent history is preserved regardless, via the live-event
  half of the merge.)
- §3.4 retention honesty is unchanged: a day whose per-run events are pruned
  keeps its bar (rollup value) with a dimmed drill affordance; the per-run heat
  strip exists only for days still inside retention (read from the live event
  feed the workspace already loads, CR-CRU-032 §S4).

This is aggregation + a payload-shape change + a rollup bucket-key change — no
DB schema change. CR-CRU-033 carries it.
