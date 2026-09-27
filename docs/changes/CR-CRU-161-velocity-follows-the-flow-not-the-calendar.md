# CR-CRU-161 — velocity follows the flow, not the calendar

**Type** feature · **Points** 8 (planning game 2026-09-27) · **Wave** 7 (0.3.0) · **Depends on** — ·
**Status** PENDING — filed 2026-09-27

## Problem

**User direction (2026-09-27):** *"The velocity computation is looking at sprint periodicity.
However we are not operating with a strict sprint model since we are using agentic coders. So is
there a better algorithm to compute velocity? Alternately … make the period configurable per project
and accessible in the project settings UI."*

**Today (CR-CRU-022, DN-crucible-analytics §5 and §7):** velocity is the points merged per
**completed ISO calendar week**, averaged over the last 3 (`weeklyVelocity`, `velocity` in
`src/analytics.ts`). The forecast is a Monte Carlo over those weekly totals and refuses with
fewer than 3 completed weeks (`forecast`).

**Measured 2026-09-27 on the dev board:**

| | Board says | Reality |
|---|---|---|
| Velocity | 16 pts/week (one completed week, 9/14: CR-139, CR-015) | 96 pts merged since Monday 9/21 (11 CRs), not counted until the week closes |
| 0.3.0 forecast | `insufficient_history`, 1 of 3 weeks | the third completed week ends ~10/12, after the 0.3.0 target of 10/03: this release never gets a forecast |

Agentic delivery is continuous and bursty; a whole release can land inside one calendar period.
Calendar buckets, like sprints, discard the current period and need several whole periods before
they forecast anything.

## Scope

### §S1 — rolling-window throughput (user ruling 2026-09-27)

Velocity is the points merged in the trailing **window** of N days, ending now, expressed as a rate
(points per week, so the card reads as before). It updates on every merge. The current, partial day
counts.

### §S2 — the forecast samples days

The forecast is a Monte Carlo over the window's **daily** pointed throughput: each draw samples whole
days (a day with no merge is a real zero, so waiting on approvals is priced in) until the release's
remaining points reach 0. P50/P80 as today. It is available once the project's pointed history spans
one full window; before that it refuses with `insufficient_history`, stating how many days it has and
needs. `unpointed` and `scheduleHealth` are unchanged.

### §S3 — the window is per project

A project carries its velocity window: **7, 14 or 28 days**, default 14. It is set in the projects
manager (`/manage`, F12) beside retention, stored on the project and returned by the project read.
Any other value is refused by the server.

### §S4 — the velocity card and the flow line

The Velocity card (F16) shows the rate, the window it covers (`last 14 days`) and daily bars for the
window in place of weekly bars. The flow line (exec · gate per cycle) is unchanged.

### §S5 — the design follows

DN-crucible-analytics §5 and §7 and F16's "b · the iteration" card are amended to the rolling-window
model. The orchestrator makes the storyboard edit at close-out.

## Acceptance criteria

- [ ] **AC1** — Velocity is the points merged in the trailing window divided by its length in weeks,
      including today's merges, asserted against fixed merge fixtures for 7, 14 and 28 days.
- [ ] **AC2** — The forecast samples daily throughput (zero days included) and is dated as soon as
      the pointed history spans one window; below that it refuses naming the days it has and needs.
- [ ] **AC3** — A project's window is 7, 14 or 28 days (default 14), editable in the projects manager
      in a real browser, and any other value is refused by the server.
- [ ] **AC4** — Changing a project's window changes its velocity and forecast on the next read.
- [ ] **AC5** — On the dev board's own history, 0.3.0 gets a dated forecast.
- [ ] **AC6** — Every existing analytics test still passes, or is re-pinned in this CR's RED where it
      pinned the calendar-week model, each such change named in the RED report.
