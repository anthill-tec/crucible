# CR-CRU-161 — velocity and the forecast follow the release so far

**Type** feature · **Points** 8 (gap analysis 2026-10-07) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-158 ·
**Status** PENDING — filed 2026-09-27, re-specified 2026-10-07

## Problem

**User direction (2026-09-27):** the velocity computation assumes sprint periodicity, but agentic
delivery has no sprints. **User rulings (2026-10-07), reviewing the burndown:** the forecast's horizon
is **the release itself, so far**, working against its declared target; the Velocity card shows that
same pace; a forecast is dated as soon as the release has merged a pointed CR. This supersedes the
trailing 3/7/14-day window first specified here on 2026-09-27, which was never built.

**Today (CR-CRU-022, still running):** velocity is the mean of the project's last 3 **completed ISO
calendar weeks** (`VELOCITY_WINDOW_WEEKS`, `weeklyVelocity`, `velocity` in `src/analytics.ts`). The
forecast is a Monte Carlo over the project's whole weekly history (`forecast`), sampling whole weeks,
and refuses with fewer than 3 completed weeks.

**Measured 2026-10-07 on the dev board, 0.3.0:**

- The forecast answers P50 = P80 = 10-20. Each draw adds whole weeks, so every completion lands on
  `now + k · 7 days`; with 23 points left and most sampled weeks above 23, nearly every draw finishes
  in the same one or two weeks, and the percentiles collapse onto one date. The burndown's green P50
  trace is then drawn exactly under the amber P80 one.
- The forecast samples the **project's** history (every release, since the first pointed merge), not
  the release's own pace.
- Velocity reads `pts / week` on the Velocity card, the phone foot strip and the release band.

## Scope

### §S1 — the release's pace

Velocity is the focused release's points merged since the release started (its earliest `filed_at`,
the burndown's start), divided by the days since then, today included: **points per day**. A merge
counts on its plan's merged close; unpointed CRs never count. `GET …/analytics/velocity` takes the
release (`?release=`), and answers its start, the per-day series since then, the days it covers and
the rate; the flow line (exec · gate per cycle) stays project-level and unchanged.

### §S2 — the forecast samples the release's days

The forecast is a Monte Carlo over the release's **daily** pointed throughput since it started: each
draw samples whole days (a day with no merge is a real zero) until the release's remaining points reach
0, so completions fall on whole days. P50/P80 as today. It is dated as soon as one pointed CR of the
release has merged; before that it refuses with `insufficient_history`, saying no pointed CR of the
release has merged yet. Its answer says how many days it rests on (`sampleDays`, replacing
`sampleWeeks`). `unpointed` and `scheduleHealth` are unchanged.

### §S3 — every surface reads the release's pace per day

The Project pane's Velocity card shows the focused release's rate (`2.4 pts / day`), what it covers
(`0.3.0 so far · 27 days`) and the release's daily bars; the phone band's foot-strip figure
(`project-band-velocity`) and the release band's rate read per day too. The burndown's caption and the
forecast card say how many days the forecast rests on.

### §S4 — the burndown draws two traces

With a dated forecast whose P50 and P80 differ, the burndown draws the green P50 trace and the amber
P80 trace each from the today marker to zero at its own date, and the band between them, as F16 shows.
What uPlot drew for each trace and the band is described in the chart's DOM description (CR-CRU-160's
`burndown-chart-labels` layer), so a test reads what was drawn, not what was asked for.

### §S5 — the design follows

DN-crucible-analytics §5, §7 and §9 are amended to this model (done with this re-specification,
2026-10-07). Storyboard F18 §1 (the Velocity card) is redrawn to the release's pace before RED, and
F18 §2 (the projects manager's window control) is withdrawn.

## Acceptance criteria

- [x] **AC1** — Velocity is the release's pointed points merged since its start divided by the days
      since, today included, asserted against fixed merge fixtures (merges on the first day, after idle
      days, today; unpointed CRs; another release's merges, which never count), and every surface that
      shows it (Velocity card, phone foot strip, release band) reads `pts / day` for the focused
      release.
- [x] **AC2** — The forecast samples the release's daily throughput since its start (zero days
      included), completes on whole days, is dated as soon as one pointed CR of the release has
      merged, and refuses before that saying so; its answer carries `sampleDays`, asserted with a fixed
      seed.
- [x] **AC3** — On the dev board's own history (a copy of its store), 0.3.0's forecast is dated and
      its P50 and P80 fall on different days.
- [x] **AC4** — With a dated forecast whose P50 and P80 differ, the burndown draws both traces from the
      today marker to zero at their own dates and the band between them, read from what uPlot drew,
      asserted in a real browser.
- [x] **AC5** — The Velocity card matches storyboard **F18 §1** as redrawn, checked in a real browser
      at VERIFY; the projects manager has no velocity-window control.
- [x] **AC6** — Every existing analytics test still passes, or is re-pinned in this CR's RED where it
      pinned the calendar-week model, each such change named in the RED report.
