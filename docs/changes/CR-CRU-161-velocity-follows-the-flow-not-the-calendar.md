# CR-CRU-161 — velocity follows the flow, not the calendar

**Type** feature · **Points** 8 (planning game 2026-09-27) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-158 ·
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

Velocity is the points merged in the trailing **window** of N days, ending now, expressed as
**points per day** (user ruling 2026-09-27: at agentic pace a day is the natural unit; the forecast
already samples days). It updates on every merge. The current, partial day counts.

### §S2 — the forecast samples days

The forecast is a Monte Carlo over the window's **daily** pointed throughput: each draw samples whole
days (a day with no merge is a real zero, so waiting on approvals is priced in) until the release's
remaining points reach 0. P50/P80 as today. It is available once the project's pointed history spans
one full window; before that it refuses with `insufficient_history`, stating how many days it has and
needs. `unpointed` and `scheduleHealth` are unchanged.

### §S3 — the window is per project

A project carries its velocity window: **3, 7 or 14 days**, default **7** (user rulings 2026-09-27).
Measured on the dev board that day: a 3-day window reads the current pace (128 pts/wk-equivalent),
7 days keeps the forecast steady on 7 day-samples, 14 suits a slower project. Throughput is bounded
by the human approvals, not the agents, so idle days are real and a short window swings with them. It is set in the projects
manager (`/manage`, F12) beside retention, stored on the project and returned by the project read.
Any other value is refused by the server.

### §S4 — the velocity card and the flow line

The Velocity card (F16) shows the rate in points per day (e.g. `22 pts / day`), the window it covers
(`last 7 days`) and daily bars for the window in place of weekly bars. The phone band's foot-strip
figure (`project-band-velocity`) and the release band's rate read per day too. The flow line (exec · gate per cycle) is unchanged.

### §S5 — the design follows

DN-crucible-analytics §5 and §7 and F16's "b · the iteration" card are amended to the rolling-window
model. The orchestrator makes the storyboard edit at close-out.

## Acceptance criteria

- [ ] **AC1** — Velocity is the points merged in the trailing window divided by its length in days,
      including today's merges, asserted against fixed merge fixtures for 3, 7 and 14 days, and every
      surface that shows it (Velocity card, phone foot strip, release band) reads `pts / day`.
- [ ] **AC2** — The forecast samples daily throughput (zero days included) and is dated as soon as
      the pointed history spans one window; below that it refuses naming the days it has and needs.
- [ ] **AC3** — A project's window is 3, 7 or 14 days (default 7), editable in the projects manager
      in a real browser, and any other value is refused by the server.
- [ ] **AC4** — Changing a project's window changes its velocity and forecast on the next read.
- [ ] **AC5** — On the dev board's own history, 0.3.0 gets a dated forecast.
- [ ] **AC7** — The Velocity card and the projects manager match storyboard **F18 §1–2**, checked in a
      real browser at VERIFY.
- [ ] **AC6** — Every existing analytics test still passes, or is re-pinned in this CR's RED where it
      pinned the calendar-week model, each such change named in the RED report.
