# DN — Crucible Analytics: progress, velocity & delivery estimation

**Author:** Antony John
**Co-author:** claude (orchestrator — crucible)
**Date:** 2026-07-16 · **amended 2026-09-24** (CR-CRU-022 gap analysis + user rulings) ·
**amended 2026-09-27** (velocity follows the flow — CR-CRU-161, user rulings)
**Status:** LOCKED 2026-07-16; **AMENDED and APPROVED 2026-09-24** — the SCRUM model below supersedes
the size-weighted, per-wave, snapshot-based model this note first locked. Ships **0.3.0**.
**Consumed by:** [PRD-crucible-v2.md](PRD-crucible-v2.md) (design input) · CR-CRU-022 (implementation) ·
CR-CRU-161 (rolling-window velocity) · CR-CRU-160 (the burndown's size and projection)
**Depends on designs:** [DN-model-b-language.md](DN-model-b-language.md) (Cycle/CR/Wave ontology) ·
[DN-crucible-roadmap-view.md](DN-crucible-roadmap-view.md) (release-focused roadmap) ·
[DN-crucible-responsive-model.md](DN-crucible-responsive-model.md) (bands) · CR-CRU-091 (declared release target)
**Visual contract:** storyboard **F16** (placement + story-point rules) and **F14¾** (the analytics pane),
both approved 2026-09-24.

## What changed on 2026-09-24, and why

The first lock (2026-07-16) was made before the roadmap became release-focused (2026-08-28), before
per-CR declaration verbs replaced the bulk queue post, and without a way to size work. CR-CRU-022's gap
analysis measured the consequences: **0 of 144 queue rows carried a size and no verb could set one**,
the per-wave forecast could not be compared with a target that belongs to a *release*, and the snapshot
table assumed a route that 0.3.0 removes. The user then ruled a SCRUM model:

| Was | Now | Ruling |
| --- | --- | --- |
| Project-wide, per-wave analytics | **Scoped to the focused release**; waves order work inside it | user, 2026-09-24 |
| `size` XS/S/M → "wCR" weights | **Story points**, Fibonacci 1·2·3·5·8·13, declared in the **planning game** | user, 2026-09-24 |
| Velocity = cycles/day + wCR/week | **SCRUM velocity = story points merged per calendar week** | user, 2026-09-24 |
| Burndown from queue snapshots | **SCRUM burndown**: points remaining vs days, ideal line to the target, labelled events | user, 2026-09-24 |
| Per-wave `targetDate` via `queue-file` | The **release's declared target** (CR-CRU-091) | CR-022 re-base, 2026-08-28 |
| Everything in the Roadmap pane | **Hybrid**: velocity in the Project band, release band in zone 3, burndown in the pane | user, 2026-09-24 |

## What changed on 2026-09-27, and why

Measured on the dev board: the calendar-week model read **16 pts/week** from one completed week while
**96 points** had merged since that Monday, and the 0.3.0 forecast could not exist before its own
target (its third completed week closes about two weeks after it). Agentic delivery is continuous and
bursty; the throughput limit is the human approvals, not the agents. The user ruled:

| Was | Now | Ruling |
| --- | --- | --- |
| Velocity = points per completed calendar week, mean of the last 3 | **Points merged in a trailing window of N days, shown per day** | user, 2026-09-27 |
| Forecast samples completed weeks; refuses under 3 | **Forecast samples days in the window; refuses until the history spans one window** | user, 2026-09-27 |
| One fixed iteration | **The window is per project: 3, 7 or 14 days, default 7**, set in the projects manager | user, 2026-09-27 |

## What changed on 2026-10-07, and why

The trailing window of 2026-09-27 (CR-CRU-161 as first filed) was never built; the calendar-week
model still ran. Reviewing the burndown, the user ruled that the forecast's horizon is **the release
itself, so far**, working against its declared target, rather than a fixed window of the project's
history. Measured the same day: 0.3.0's live forecast put P50 and P80 on the same day (10-20),
because whole-week samples give the Monte Carlo only a few distinct outcomes.

| Was (2026-09-27, unbuilt) | Now | Ruling |
| --- | --- | --- |
| Velocity over a trailing 3/7/14-day window of the project's merges | **The focused release's pace so far**: its points merged since the release started ÷ the days since, per day | user, 2026-10-07 |
| Forecast samples the window's days; refuses until the history spans one window | **Forecast samples every day since the release started** (idle days are zeros); **dated as soon as one pointed CR of the release has merged** | user, 2026-10-07 |
| The window is per project, set in the projects manager | **No window setting**: the release's start bounds the history | user, 2026-10-07 |

## 1 Why

Model-B execution already stamps every unit of work: runs carry timestamps and durations, cycles carry
`activatedAt`/`doneAt`, plans carry `filedAt`/`closedAt` + the merge commit, and the queue carries each
CR's release, wave and dependencies. What it lacked was an **estimate of size**. SCRUM supplies it the
standard way — each CR is given story points in a planning game at design time — and everything else
(velocity, burndown, forecast) is derived from that declaration plus the data already collected.

## 2 First principles (binding)

1. **One declaration, everything else derived.** The only new input is a CR's story points, declared
   once at design. Every metric derives from that plus data already collected (runs, cycles, plans,
   lifecycle events, queue). No agent reports anything new.
2. **Bands, never points.** Estimates are P50/P80 ranges. A single predicted date is never rendered.
3. **No fabrication.** Below the confidence gate, and wherever a CR is unpointed, surfaces show what is
   missing and say so — never an extrapolated value, and never a default weight.
4. **Scope changes are visible, and attributed.** Every declaration that moves the burndown (a CR added,
   voided, superseded or re-pointed) is journalled with its author and time, and renders as a labelled
   step — never rewritten history.
5. **Two clocks, kept apart.** Machine time and loop time measure different things and are never summed
   into one number (§3). Neither is velocity.

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

**Amendment (2026-07-17 — CR-CRU-023 §S3, user-sanctioned option (a)):** the
LIVE ticking display on an ACTIVE cycle shows **attention time**
(`activeMs`) — accumulated server-up epochs anchored at
`max(activatedAt, storeBootedAt)` — so service restarts RESUME from the
persisted setpoint and infrastructure downtime is EXCLUDED from the ticking
value. `loop(c)` as defined above (`doneAt − activatedAt`, downtime
INCLUDED) is unchanged and remains what SEALED durations display.
Attention time is a display metric today; if analytics later want it, that
is a new DN decision, not a silent swap.

**Amendment (2026-09-24):** under the SCRUM model these clocks are **flow** metrics, not velocity. They
render as a secondary "flow" line beneath velocity (`exec 38m · gate 22m per cycle`). Every
`cycleId`-linked run counts toward `exec(c)`, **including BDD e2e runs** (CR-CRU-015 landed them
cycle-linked) and orchestrator gate runs bound to a cycle — resolving former open question 2.

## 4 Story points and the planning game

- **Scale:** planning-poker Fibonacci — **1 · 2 · 3 · 5 · 8 · 13**. Any other value is refused.
- **When:** at design, during the CR's **gap analysis** (the planning game): the orchestrator proposes
  points with reasoning; the user confirms or changes them.
- **How:** `cr-plan --points N` — the per-CR declaration verb that already sets release and wave. There
  is no bulk path.
- **Re-pointing** after a release has started is allowed, and is a journalled scope change (§6).
- **Unpointed CRs are never counted as 1.** A release containing unpointed CRs lists them as
  *unpointed* on its band, excludes them from its point totals, and its forecast refuses (§7).

## 5 Velocity (the focused release's pace)

- **Definition (amended 2026-10-07):** story points of the focused release's CRs whose plans **closed
  with a merge** since the release started (§6, the earliest `filed_at` among its CRs), divided by the
  days since that start, today included: **points per day**. It changes on every merge and every day.
  Crucible has no sprints; the release is the iteration that matters, and its target is what the pace
  is judged against.
- **Displayed value:** the per-day rate (`2.4 pts / day`) with what it covers (`0.3.0 so far · 27
  days`) and the release's daily bars.
- **Scope:** the focused release (the one the Roadmap's release band and burndown show). It lives in
  the **Project band**, the same on every tab (F16). The flow line (exec · gate per cycle) stays
  project-level.
- **Payload:** carries the release, its start, the daily series since then and how many days it
  covers, so a consumer can judge it.

## 6 Burndown (release-level)

A SCRUM burndown for the **focused release**:

- **y:** story points remaining in the release; **x:** days, from the release's start to its declared
  target (CR-CRU-091) or to today if later.
- **Release start:** the earliest `filed_at` among the release's CRs.
- **Ideal line:** a straight line from the points committed at release start to 0 on the target date.
  With no declared target there is no ideal line (absent, not defaulted).
- **Actual line:** steps **down** when a CR's plan closes with a merge; steps **up** when points are
  added (a CR planned into the release, or re-pointed upward); steps **down** when points leave by
  declaration (a CR voided, superseded, moved out, or re-pointed downward).
- **Every step is labelled** with the CR and what moved it (`−8 · CR-139 merged`,
  `+5 scope · CR-144 filed`), in F14¾'s style.
- **Source of scope events:** an append-only **declaration journal** written by the per-CR verbs
  (`cr-plan` incl. `--points`, `cr-void`, `cr-supersede`), each row carrying the CR, the verb, the
  change, the author (the registered caller) and the time. No queue snapshots.
- A CR whose `lifecycle.state` is VOID or SUPERSEDED contributes nothing to the remaining total
  (CR-CRU-147's dead-CR predicate — whichever of 022 and 147 lands first owns it).

## 7 Forecast (Monte Carlo, release-level)

1. From the focused release's **daily** pointed throughput since it started (§5), build the empirical
   distribution of points per day; days with no merge are zeros.
2. For each of `N = 1000` draws: sample days until the release's **remaining points** reach 0; record the
   completion date. Waves order the work inside the release but do not change the total.
3. **P50/P80** completion dates across the draws.

- **Confidence gate (amended 2026-10-07):** until one pointed CR of the release has merged →
  `status: "insufficient_history"`, with no band values. Once dated, the answer says how many days it
  rests on.
- **Unpointed gate:** any remaining CR in the release unpointed → `status: "unpointed"`, naming them,
  with no band values.
- **Determinism for tests:** a seed parameter (test-only) so fixtures assert exact values.
- Never persisted.

## 8 Schedule health

Against the **release's declared target** (CR-CRU-091): `P80 ≤ target` → `ahead`;
`P50 ≤ target < P80` → `at-risk`; `P50 > target` → `behind`. No declared target → the field is
**absent**, never defaulted. There is no per-wave target of any kind.

## 9 API surface (additive, 0.3.0)

| Endpoint | Returns |
|---|---|
| `GET /api/v2/projects/<key>/analytics/velocity?release=<label>` | `{release, startTs, pointsPerDay?, days:[{day, points}], sampleDays, flow:{execMsPerCycle, gateMsPerCycle, sampleCycles}}` (amended 2026-10-07; the flow is project-level) |
| `GET …/analytics/burndown?release=<label>` | `{release, committedPoints, target?, ideal?:[…], points:[{ts, remaining, event, cr, verb, delta}], unpointed:[cr]}` |
| `GET …/analytics/forecast?release=<label>` | `{release, remainingPoints, p50Ts?, p80Ts?, scheduleHealth?, sampleDays, status, unpointed?:[cr]}` (amended 2026-10-07) |

Plus: `points` on queue entries (set via `cr-plan --points`); the declaration journal. JSON only, like
every v2 GET (CR-CRU-132 retired TOON rendering). No new SSE event kinds — the UI recomputes on the
existing plan/queue ticks.

## 10 UI surfaces (F16 + F14¾, approved 2026-09-24)

- **Project band → Velocity card (amended 2026-10-07):** the focused release's pace, `N pts / day`,
  what it covers (`0.3.0 so far · 29 days · 188 pts`), the release's daily bars with the dashed rate,
  and a secondary *flow* line with the exec/gate split (project-level). Every tab; with no release in
  focus it says so.
- **Release band** in the **header of zone 3**, above the release-scoped table (testid
  `roadmap-progress`): a burndown thumbnail, `remaining of committed pts`, velocity, the P50/P80 chip,
  and the schedule-health chip when a target is declared, plus (amended 2026-10-07) a
  `verified · N runs ↗` chip (`roadmap-verified-chip`, singular `1 run`) when runs are filed under the
  focused release — it opens the Runs tab filtered to that release (`?release=`); none at 0. Tap
  anywhere else on the band → the analytics pane.
- **Analytics pane** (testid `analytics-pane`; F14¾): the Roadmap pane swaps to the release's SCRUM
  burndown (testid `burndown-chart`) and the forecast; `← roadmap`, Esc or back restores the roadmap with
  scroll intact (CR-016 one-rule pane state). Velocity is not duplicated into the pane.
- **Phone** (responsive DN): the band collapses to one ≥44px line; velocity rides the Project band's foot
  strip; the verified-runs chip moves into the analytics pane's header (never both places); the pane
  fills the viewport and the chart scrolls inside its own box.
- **Charting library — picked at CR-022 gap analysis: uPlot 1.6.32** (MIT, ~48 KB single
  `iife.min.js`, zero-build, vendored beside VanJS). Stepped paths draw the actual line, high/low bands
  draw P50/P80, hooks draw event labels and the target line. It renders to canvas, so unit tests assert
  data and options while Playwright asserts pixels; colours are read from CSS variables at draw time so
  the theme holds. Chart.js (~254 KB) was the fallback and buys nothing here.

## 11 Vocabulary

| Term | Meaning |
|---|---|
| story point | the planning-game estimate on a CR; Fibonacci 1·2·3·5·8·13 |
| planning game | the orchestrator proposes points at gap analysis; the user confirms |
| velocity | the focused release's story points merged since it started, per day (amended 2026-10-07) |
| flow | the two clocks — exec and gate time per cycle; not velocity |
| committed points | a release's points at its start |
| scope-change step | a journalled declaration that moved the release's remaining points |
| band | a P50/P80 range; the only legal estimate form |
| unpointed | a CR with no story points; never defaulted |

## 12 CR mapping & non-goals

- **CR-CRU-022** implements this DN end-to-end (0.3.0).
- Non-goals: cross-project analytics; person/agent productivity scoring; UI-side editing of points or
  targets; Gantt scheduling; persisting forecasts; pointing releases already shipped.

## 13 Open questions (tracked, non-blocking)

- Velocity window controls (last-N-weeks selector) — UI-only; not in 0.3.0.
- ~~Whether BDD-tier runs join `exec(c)`~~ — **resolved 2026-09-24: yes** (§3 amendment).
