# CR-CRU-022 — Roadmap analytics: velocity + burndown + forecast

**Status:** PENDING
**Type:** feature
**Priority:** P3
**Depends on:** CR-CRU-011, CR-CRU-014
**Labels:** api, analytics, roadmap, ui
**Phase:** Wave 5/6 (0.2.0 — after CR-014)
**Design reference:** [DN-crucible-analytics.md](../research/DN-crucible-analytics.md)
— the LOCKED analytics design (two-clock model, velocity/burndown/forecast
definitions, honesty principles, API + UI surfaces); this CR implements that
DN verbatim. Storyboard F14's CR-022 target strip is the visual contract.
Origin: user ask 2026-07-16

## Context
Runs carry timestamps/durations; cycles carry `activatedAt`/`doneAt`; plans
carry `filedAt`/`closedAt` + merge; the CR-014 queue carries the full backlog
with `wave`, `dependsOn` and `size` (XS/S/M). That is sufficient to DERIVE
progress reporting and delivery estimation. Distinctive split Crucible can
make that classic tools cannot: **execution time** (agents actually running —
run + lifecycle timestamps) vs **loop time** (cycle wall-clock including gate
review latency) — machine velocity vs loop velocity, reported separately.

## Scope

### §S1 Derived metrics (server, additive)
`GET /api/v2/projects/<key>/analytics/velocity` returns
`{cyclesPerDay, weightedCrsPerWeek, execMsPerCycle, gateMsPerCycle,
sampleCycles}` — all derived: velocity from closed cycles/plans over their
close timestamps; weights from queue `size` (XS=1, S=2, M=3; unknown=1);
`execMsPerCycle` = mean of per-cycle summed run durations for `cycleId`-linked
runs; `gateMsPerCycle` = mean of `(doneAt − activatedAt) − exec`. No new
ingest fields, no client changes.

### §S2 Queue snapshots (scope-change history)
Each `POST /queue` full-replace archives the prior entry set into an additive
`queue_snapshots(project_key, snapped_at, entries_json)` table before
replacing. Burndown reads snapshots so scope changes render as honest steps —
never rewritten history.

### §S3 Burndown series
`GET /api/v2/projects/<key>/analytics/burndown` returns
`{points:[{ts, remainingWeighted, event: "plan-closed"|"scope-change"|null,
cr?}], boundaries:[{wave, label, ts?}]}` — remaining weighted CRs over time
from queue snapshots + plan close events, release-boundary rows annotated.

### §S4 Forecast (Monte Carlo, confidence-gated)
`GET /api/v2/projects/<key>/analytics/forecast` runs N=1000 draws over the
REMAINING queue respecting `dependsOn`/wave ordering, sampling per-kind cycle
durations and cycles-per-CR-by-size from this project's closed history →
`{perWave:[{wave, p50Ts, p80Ts}], release:{p50Ts, p80Ts}, sampleCycles,
status:"ok"|"insufficient_history"}`. Gate: `sampleCycles < 15` →
`insufficient_history` with NO band values (never fabricate estimates).
Additive queue field `targetDate?` per wave (ISO date, optional) → response
gains `scheduleHealth: "ahead"|"at-risk"|"behind"` per wave (DN §7 rule,
verbatim: `P80 ≤ target` → `ahead`; `P50 ≤ target < P80` → `at-risk`;
`P50 > target` → `behind`).

### §S5 Roadmap progress band (UI)
The Roadmap tab renders a compact progress band ABOVE the table (testid
`roadmap-progress`): burndown sparkline · velocity (`N.N cyc/day` with the
exec/gate split) · release P50/P80 band · schedule-health chip when a
`targetDate` exists. Clicking the band swaps the Roadmap pane to the
**analytics pane** (testid `analytics-pane`, one-rule pane state, `← roadmap`
back chip) containing the full burndown chart (testid `burndown-chart`),
velocity detail and the per-wave forecast table (DN §9). With
`insufficient_history` the band shows the sample count and no bands —
explicitly, never a fabricated date. F14's CR-022 target strip (band) and
frame F14¾ (the analytics pane) are the visual contract. The burndown chart
uses a real charting library per DN §9 (vendored, zero-build,
VanJS-compatible; web-research + final pick at this CR's gap analysis —
uPlot leading candidate).

## Acceptance criteria
- [ ] `GET /analytics/velocity` on a fixture with 6 closed cycles (known timestamps, 2 linked runs each, queue sizes XS/S/M) returns the hand-computed `cyclesPerDay`, `weightedCrsPerWeek`, `execMsPerCycle`, `gateMsPerCycle`, `sampleCycles: 6` (exact values asserted).
- [ ] `POST /queue` twice → `queue_snapshots` holds the first entry set with a `snapped_at`; `GET /analytics/burndown` renders the scope change as a step (`event: "scope-change"`) and each plan close as a burn (`event: "plan-closed"`, remainingWeighted drops by that CR's weight).
- [ ] `GET /analytics/forecast` with ≥15 closed cycles returns `status: "ok"` with `p50Ts ≤ p80Ts` for every wave, waves ordered by dependency (a wave's p50 never precedes its dependency wave's); with <15 closed cycles returns `status: "insufficient_history"` and NO `perWave`/`release` band values.
- [ ] Queue entries accept optional `targetDate` (ISO `YYYY-MM-DD`, 400 on malformed); forecast response carries `scheduleHealth` per the DN §7 rule — `P80 ≤ target` → `ahead`, `P50 ≤ target < P80` → `at-risk`, `P50 > target` → `behind` (three fixtures, one per verdict, exact values via the seeded forecast).
- [ ] Roadmap pane renders `roadmap-progress` with the sparkline, velocity text containing the exec/gate split, and the P50/P80 band; clicking the band swaps the pane to `analytics-pane` (tabs hidden, back chip `← roadmap`) containing `burndown-chart`, the velocity detail and the per-wave forecast rows; closing restores the Roadmap view (CR-016 one-rule assertions); the `insufficient_history` fixture renders the sample count and NO date text.

## Estimated size
M.

## Risk
Small-N distributions make early forecasts noisy — mitigated by the hard
confidence gate (no bands below 15 closed cycles) and bands-not-points
everywhere.

## Non-goals
Cross-project analytics; person/agent-level productivity scoring; editing
targets from the UI (queue-file owns `targetDate`); Gantt scheduling.
