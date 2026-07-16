# DN — Crucible Analytics: progress, velocity & delivery estimation

**Author:** Antony John
**Co-author:** claude (orchestrator — crucible)
**Date:** 2026-07-16
**Status:** LOCKED (design round 2026-07-16 — user ask: "velocity computation…
milestone delivery dates… an actual burndown chart"; ships 0.2.0)
**Consumed by:** [PRD-crucible-v2.md](PRD-crucible-v2.md) (design input) ·
CR-CRU-022 (implementation)
**Depends on designs:** [DN-model-b-language.md](DN-model-b-language.md)
(Cycle/CR/Wave ontology) · CR-CRU-011 (plans/cycles) · CR-CRU-014 (queue)

## 1 Why

Model-B execution already stamps every unit of work: runs carry timestamps and
durations, cycles carry `activatedAt`/`doneAt`, plans carry `filedAt`/
`closedAt` + the merge commit, and the CR-014 queue carries the full backlog
with `wave`, `dependsOn` and `size`. That is a complete progress dataset —
enough to DERIVE project progress reporting and delivery estimation without
asking any actor to report anything new. This DN fixes the analytical model:
definitions, formulas, honesty rules, API and UI surfaces. CRs implement it;
they do not reinterpret it.

## 2 First principles (binding)

1. **Zero new reporting.** Every metric derives from data already collected
   (runs, cycles, plans, lifecycle events, queue). If a metric would need a
   new agent-side field, it does not belong to this design.
2. **Bands, never points.** Estimates are P50/P80 ranges. A single predicted
   date is never rendered.
3. **No fabrication.** Below the confidence gate, surfaces show the sample
   count and say "insufficient history" — never an extrapolated value.
4. **Scope changes are visible.** Backlog history is snapshotted; a widened
   or narrowed queue renders as a step in the burndown, never rewritten
   history.
5. **Two clocks, kept apart.** Machine time and loop time measure different
   things and are never summed into one number (§3).

## 3 The two-clock model

A cycle's wall-clock (`doneAt − activatedAt`) contains two different things:

| Clock | Definition | Derived from |
|---|---|---|
| **Execution time** `exec(c)` | time agents actually ran for cycle `c` | Σ `duration_ms` of the cycle's `cycleId`-linked runs (compile + test events) |
| **Loop time** `loop(c)` | `doneAt(c) − activatedAt(c)` | cycle stamps (CR-011 C4) |
| **Gate latency** `gate(c)` | `loop(c) − exec(c)`, floored at 0 | derived |

Execution time is *machine velocity* (how fast the agents deliver when
running); gate latency is *loop overhead* (orchestrator attention, user
review, scheduling). Classic trackers cannot make this split; Crucible can
because every run is stamped and cycle-linked. Reported separately, always.

## 4 Velocity

Over a window `W` (default: since first closed cycle; UI may narrow):

- **Cycle velocity** = closed cycles in `W` ÷ days in `W` (`cyclesPerDay`).
- **Weighted CR throughput** = Σ weights of CRs whose plans closed in `W` ÷
  weeks in `W` (`weightedCrsPerWeek`). Weights from queue `size`:
  `XS=1 · S=2 · M=3 · absent/unknown=1`.
- **Per-cycle means:** `execMsPerCycle`, `gateMsPerCycle` (arithmetic means
  over closed cycles in `W`; skipped cycles excluded, failed cycles included).
- Every velocity payload carries `sampleCycles` so consumers can judge it.

## 5 Burndown

- **Backlog** = the registered queue (CR-014), weighted by `size` ("wCR").
- **Snapshot semantics:** every `POST /queue` full-replace first archives the
  prior entry set (`queue_snapshots(project_key, snapped_at, entries_json)`).
- **Series:** remaining wCR over time. A CR burns down at its plan-close
  timestamp (`plan-closed` point). A snapshot diff that changes total weight
  emits a `scope-change` step. Release/wave boundaries annotate the series.
- PENDING CRs never burn; an OPEN plan does not burn until closed with merge
  (matches the derived-status model of CR-014).

## 6 Forecast (Monte Carlo)

Procedure, per request (never persisted):

1. Build empirical distributions from THIS project's closed history:
   `loop`-duration per cycle **kind** (`red-green`, `verify`, `fix`) and
   cycles-per-CR grouped by **size**.
2. For each of `N = 1000` draws: walk the REMAINING queue in topological
   order (respecting `dependsOn`; a wave starts only when its dependency
   waves complete; CRs on distinct tracks within a wave advance in parallel,
   lanes bounded by the project's historical max concurrent open plans),
   sampling cycles-per-CR then a duration per cycle.
3. Collect completion times per wave and for the release boundary →
   **P50/P80** timestamps.
- **Confidence gate:** `sampleCycles < 15` → `status: "insufficient_history"`,
  no band values in the payload (principle 3).
- **Determinism for tests:** the implementation accepts a seed parameter
  (test-only) so AC fixtures assert exact values.

## 7 Milestone targets & schedule health

- Queue entries accept an optional **per-wave** `targetDate` (ISO
  `YYYY-MM-DD`, registered via `queue-file` — never edited from the UI).
- **Schedule health** per wave with a target:
  `P80 ≤ target` → `ahead`; `P50 ≤ target < P80` → `at-risk`;
  `P50 > target` → `behind`.

## 8 API surface (additive, 0.2.0)

| Endpoint | Returns |
|---|---|
| `GET /api/v2/projects/<key>/analytics/velocity` | `{cyclesPerDay, weightedCrsPerWeek, execMsPerCycle, gateMsPerCycle, sampleCycles}` |
| `GET …/analytics/burndown` | `{points:[{ts, remainingWeighted, event, cr?}], boundaries:[…]}` |
| `GET …/analytics/forecast` | `{perWave:[{wave, p50Ts, p80Ts, scheduleHealth?}], release:{…}, sampleCycles, status}` |

Plus: `queue_snapshots` table; `targetDate?` on queue entries. TOON forms
follow the standard `?fmt=toon` rules. SSE: analytics are read-side derived —
no new event kinds; the UI recomputes on the existing plan/queue SSE ticks.

## 9 UI surfaces

- **Roadmap progress band** (above the queue table, testid
  `roadmap-progress`): burndown sparkline · velocity with the exec/gate split
  · release P50/P80 band · schedule-health chip when a target exists.
- **Analytics pane** (testid `analytics-pane`, user-refined 2026-07-16):
  clicking the progress band swaps the Roadmap pane to the full analytics
  view — a one-rule pane state (`← roadmap` back chip): the full burndown
  chart (testid `burndown-chart`, scope-change steps and wave/release
  boundaries drawn explicitly), velocity detail (exec/gate split, sample
  count), and the per-wave P50/P80 forecast table with schedule health.
- **Charting library (user-directed 2026-07-16):** the storyboard's mono-art
  burndown is representation only — the product uses a real charting library:
  vendored, zero-build, VanJS-compatible, canvas/SVG line+step series with
  annotation support (scope-change steps, boundary markers, P50/P80 bands),
  SSE-driven live updates. Candidates to research on the web at CR-022's gap
  analysis (uPlot's single-file vendorable form is the leading candidate;
  Chart.js the fallback) — final pick is a gap-analysis decision with those
  requirements as the gate, mirroring CR-014's graph-library rule.
- Insufficient history renders the sample count in place of bands (never a
  date). Storyboard: F14's CR-022 target strip (band) + frame F14¾ (the
  analytics pane) are the visual contract.

## 10 Vocabulary

| Term | Meaning |
|---|---|
| wCR | weighted CR unit (size-weighted backlog unit) |
| execution velocity | machine clock — agent run time per cycle |
| loop velocity | wall clock — activate→done including gate latency |
| gate latency | loop − execution; the human/orchestration overhead |
| band | a P50/P80 range; the only legal estimate form |
| scope-change step | burndown discontinuity from a queue re-registration |

## 11 CR mapping & non-goals

- **CR-CRU-022** implements this DN end-to-end (0.2.0, deps 011 + 014).
- Non-goals (this design): cross-project analytics; agent/person productivity
  scoring; UI-side target editing; Gantt scheduling; persisting forecasts.

## 12 Open questions (tracked, non-blocking)

- Window controls on velocity (last-N-days selector) — UI-only, decide at
  CR-022 gap analysis.
- Whether BDD-tier runs join `exec(c)` once CR-015 lands (leaning yes —
  they are cycle-linked runs like any other).
