# CR-CRU-022 — Roadmap analytics: SCRUM velocity, burndown and forecast

**Status:** PENDING
**Type:** feature
**Priority:** P3
**Depends on:** CR-CRU-011, CR-CRU-014, CR-CRU-091 (the declared release target this CR reads)
**Labels:** api, analytics, roadmap, ui, client
**Phase:** Wave 7 (0.3.0)
**Design reference:** [DN-crucible-analytics.md](../research/DN-crucible-analytics.md), **amended and
approved 2026-09-24** to the SCRUM model; this CR implements that DN. The visual contract is storyboard
frames **F16** (placement and story-point rules) and **F14¾** (the analytics pane), both approved
2026-09-24.
Origin: user ask 2026-07-16; re-specified 2026-09-24 at gap analysis.

## Context

Crucible already stamps every unit of work (runs, cycles, plans, merges), but it has no estimate of how
big a CR is. The first version of this CR weighted CRs by a queue `size`, and gap analysis measured
that **0 of 144 queue rows carry one and no verb can set one**. The user ruled a SCRUM model instead:
each CR is given **story points** in a **planning game** at design time, **velocity** is story points
merged per week, and the **burndown** is a real SCRUM chart for the focused release. Everything except
the points is derived from data the board already holds.

## Scope

### §S1 Story points are declared, once, at design

- `cr-plan --points N` records a CR's story points. The scale is planning-poker Fibonacci —
  **1 · 2 · 3 · 5 · 8 · 13** — and any other value is refused, naming the scale.
- The queue read publishes `points` on each entry that has them; an unpointed entry omits the key
  (absent, never defaulted).
- Every point declaration, and every per-CR write that moves a release's scope (`cr-plan` adding a CR
  to a release or changing its points, `cr-void`, `cr-supersede`, a release change), appends a row to
  an **append-only declaration journal**: CR, verb, change, author (the registered caller), time.
  **No `queue_snapshots` table.** (The first version of this CR assumed such a journal existed; gap
  analysis measured that it does not — the only event kinds today are test, compile, gate, lifecycle
  and milestone.)
- This is a **client verb change**: all five stack clients delegate `cr-plan` to the shared
  `_crucible_axi.py`, so `--points` lands once and appears on every client. Model B must be told when
  it ships (standing contract).

### §S2 Velocity (project-level)

`GET /api/v2/projects/<key>/analytics/velocity` returns `{pointsPerWeek, weeks:[{week, points}],
sampleWeeks, flow:{execMsPerCycle, gateMsPerCycle, sampleCycles}}`.

- `pointsPerWeek` is the mean of the last **3 completed calendar weeks** of story points merged; a CR
  counts in the week its plan closed with a merge.
- `flow` keeps the DN's two clocks — exec and gate time per cycle — as a secondary measure, never
  summed into velocity. Every `cycleId`-linked run counts toward exec time, including BDD e2e runs.
- Weeks before the first pointed merge are absent, not zero.

### §S3 Burndown (release-level)

`GET /api/v2/projects/<key>/analytics/burndown?release=<label>` returns a SCRUM burndown for that
release: `{release, committedPoints, target?, ideal?, points:[{ts, remaining, event, cr, verb, delta}],
unpointed:[cr]}`.

- The release starts at the earliest `filed_at` among its CRs; `committedPoints` is its point total
  then.
- **Ideal line:** from `committedPoints` at the start to 0 on the release's declared target
  (CR-CRU-091). No declared target → no ideal line (absent).
- **Actual line:** steps down when a CR's plan closes with a merge; steps up or down on each journalled
  scope declaration. **Every step names its CR and what moved it.**
- A CR whose `lifecycle.state` is VOID or SUPERSEDED contributes nothing to the remaining total.
  CR-CRU-147 needs the same dead-CR predicate: whichever of 022 and 147 lands first owns it, and the
  other asserts it.
- Unpointed CRs are listed in `unpointed` and excluded from every total — never counted as 1.

### §S4 Forecast (release-level, Monte Carlo)

`GET /api/v2/projects/<key>/analytics/forecast?release=<label>` returns `{release, remainingPoints,
p50Ts?, p80Ts?, scheduleHealth?, sampleWeeks, status}`.

- `N = 1000` draws: sample weekly velocities from the project's history until the release's remaining
  points reach 0; P50/P80 of the completion dates.
- `status: "insufficient_history"` below **3 completed weeks** of pointed velocity, and
  `status: "unpointed"` (naming them) while any remaining CR in the release is unpointed — both with
  **no** band values.
- `scheduleHealth` against the release's declared target: `P80 ≤ target` → `ahead`;
  `P50 ≤ target < P80` → `at-risk`; `P50 > target` → `behind`. No target → the field is absent.
- A test-only seed parameter makes the draws deterministic. Nothing is persisted.

### §S5 UI: the hybrid (F16 + F14¾)

- **Project band → Velocity card:** `N pts / week`, the weekly bars, the sample, and a secondary flow
  line with the exec/gate split. Project-level; the same on every tab.
- **Release band** in the header of **zone 3**, above the release-scoped table (testid
  `roadmap-progress`): a burndown thumbnail, `remaining of committed pts`, velocity, the P50/P80 chip,
  and the schedule-health chip when a target is declared. Unpointed CRs are named on the band.
- **Tap the band** → the Roadmap pane swaps to the analytics pane (testid `analytics-pane`, F14¾): the
  burndown chart (testid `burndown-chart`) and the forecast. `← roadmap`, Esc or back restores the
  roadmap with scroll intact (CR-016 one-rule pane state). Velocity is not duplicated into the pane.
- CR rows in the release-scoped table show their points.
- **Phone** (DN-crucible-responsive-model): the band collapses to one ≥44px line; velocity rides the
  Project band's foot strip; the pane fills the viewport and the chart scrolls inside its own box.
- **Chart library: uPlot 1.6.32**, vendored to `public/vendor/` beside VanJS, zero-build. Colours are
  read from CSS variables at draw time.

### §S6 One wait for a tab's own pane (folded in from CR-CRU-148, user ruling 2026-09-24)

CR-CRU-148 found that a step reading `pane-scroll` straight after a tab click can resolve the OUTGOING
tab's pane before the swap lands, and measure a detached node. It fixed CR-CRU-018's AC10 with a shared
helper, `mountedPaneScroll` (`tests/e2e/steps/pane-mount.ts`), and listed three more steps with the same
exposure. The user ruled that this CR carries them, since its own new phone scenario has the same race:

- this CR's phone analytics scenario measures `pane-scroll` through `mountedPaneScroll`, never a bare
  lookup;
- the three exposed steps in `tests/e2e/steps/pane-scroll.steps.ts` adopt it: "the active pane-scroll
  element scrolls horizontally", "no pane scrolls horizontally" (VERIFY caught it **passing silently** on
  a detached node: `0 ≤ 0`), and "the pane-scroll element's scrollTop is {int}".

This is test-side only. `mountedPaneScroll` is extended for any tab it doesn't yet cover, never
duplicated.

## Acceptance criteria

**§S1 — story points**
- [ ] `cr-plan --points 5` stores 5 and the queue read returns `points: 5`; `--points 4` is refused,
      naming the Fibonacci scale; an unpointed entry omits `points`.
- [ ] `--points` appears on all five stack clients through the shared `_crucible_axi.py`, asserted
      once per client — not re-implemented per client.
- [ ] Setting points, re-pointing, planning a CR into a release, `cr-void` and `cr-supersede` each
      append one journal row carrying CR, verb, change, author and time; the journal is never
      rewritten. No `queue_snapshots` table exists in the schema.

**§S2 — velocity**
- [ ] On a fixture with pointed merges across four known calendar weeks, `pointsPerWeek` equals the
      hand-computed mean of the last three completed weeks, and `weeks` lists exactly the weeks that
      had pointed merges.
- [ ] `flow.execMsPerCycle` / `flow.gateMsPerCycle` equal hand-computed means on the same fixture, and
      a cycle-linked BDD e2e run counts toward exec time.

**§S3 — burndown**
- [ ] On a fixture release, the series starts at `committedPoints`, drops by a CR's points at its merge
      (`event: "merged"`), rises at a journalled scope addition, and drops at a `cr-void` — each point
      naming the CR and the verb.
- [ ] With a declared target the ideal line runs from `committedPoints` at release start to 0 on the
      target; with none, `ideal` and `target` are absent.
- [ ] A VOID CR contributes nothing; an unpointed CR appears in `unpointed` and in no total.

**§S4 — forecast**
- [ ] With a fixed seed and ≥3 weeks of pointed velocity, `status: "ok"` with exact `p50Ts ≤ p80Ts`.
- [ ] Below 3 weeks → `insufficient_history`; with any remaining CR unpointed → `unpointed` naming it;
      both carry no band values.
- [ ] `scheduleHealth` is `ahead`, `at-risk` and `behind` on three seeded fixtures, and absent when the
      release declares no target. No per-wave target field exists anywhere.

**§S5 — UI**
- [ ] The Project band shows the Velocity card (points/week, weekly bars, sample, flow line) on every
      workspace tab.
- [ ] `roadmap-progress` renders in zone 3's header, above the release-scoped table, for the focused
      release, and names any unpointed CRs.
- [ ] Tapping the band swaps to `analytics-pane` with `burndown-chart` and the forecast; closing it
      restores the roadmap with scroll intact; velocity does not appear inside the pane.
- [ ] With `insufficient_history` or `unpointed`, no date text renders anywhere on the band or the pane.
- [ ] At the phone band, the release band is one line measuring ≥44px, velocity appears on the foot
      strip, and the pane's chart scrolls inside its own container with the page unscrolled.

**§S6 — one wait for a tab's own pane**
- [ ] This CR's phone scenario and the three listed steps in `pane-scroll.steps.ts` measure through
      `mountedPaneScroll`; no step in `tests/e2e/steps/` resolves `pane-scroll` with a bare lookup
      straight after a tab click or pane swap.
- [ ] Each migrated step rejects a detached pane and a wrong-tab pane. The detached case is proven per
      step by replaying its old bare lookup (it must fail), and no existing assertion is weakened.

## Estimated size

**L** (re-sized from M at gap analysis): a client verb, a journal, three endpoints, a Monte Carlo, a
vendored chart library, a band, a pane and a Project-band card.

## Risk

- **Early forecasts are noisy.** Points exist only from this CR on, so velocity has no history until
  pointed CRs merge. The 3-week gate keeps the forecast honest in the meantime; the band says why it
  has no dates rather than showing none silently.
- **Pointing drift.** Re-pointing after a release starts is legitimate and is journalled as a scope
  change, so the burndown shows it instead of hiding it.
- **Model B pins released clients**, so `--points` reaches them at release time.

## Non-goals

Cross-project analytics; person/agent productivity scoring; UI-side editing of points or targets;
Gantt scheduling; persisting forecasts; pointing releases that have already shipped.

## Implementation Notes

**Gap analysis, 2026-09-24.** Baseline bun 2642 / 0 / 0, python 2014 / 0 / 0 on `d3f4807`. Findings
folded above: the stale LOCKED DN (now amended); the missing declaration journal (now §S1); the
size-weighting that could never be populated (replaced by story points); the per-wave forecast set
against a per-release target (now release-scoped); the coupling to CR-CRU-147 (§S3) and to CR-CRU-018's
responsive bands (§S5); the empty `fix`-kind distribution (moot — the forecast no longer samples per
cycle kind); and the chart-library pick (uPlot). **The planning game for 0.3.0 — confirmed by the user 2026-09-24.** Written with
`cr-plan --points` as this CR's close-out step, once §S1 ships, so the burndown has real data on day one.

| CR | Points | Basis |
| --- | --- | --- |
| CR-CRU-139 | 8 | merged; 5 cycles, 33 ACs |
| CR-CRU-015 | 8 | merged; 5 cycles, 20 ACs |
| CR-CRU-018 | 13 | merged; 5 cycles + fix round, 2,699 lines, two engines, a new DN |
| CR-CRU-022 | 13 | this CR |
| CR-CRU-098 | 5 | resolver ported server-side, 77 behaviours carried |
| CR-CRU-145 | 8 | renderer retired, 13 assertions migrated, 14 ACs |
| CR-CRU-144 | 5 | classifier instrument + targeted-run tier |
| CR-CRU-147 | 5 | next, wave card, strikethrough, two queue fields |
| CR-CRU-141 | 3 | CI path gating |
| CR-CRU-146 | 2 | hit area shipped in CR-018; pixel-offset step + assertion-only |

Total **70** across the release, merged **29**, remaining **41**. (Corrected 2026-09-24: this said
"committed 70". In the burndown, `committedPoints` means the points in the release at its START — the
earliest `filed_at` — so for 0.3.0, whose CRs were filed one at a time, it is far smaller than the
total, and later filings appear as scope steps. 70 is the total, not the commitment.)

**C3 rulings (2026-09-24), where the spec was silent.** Accepted as implemented at `a9cb2b9`:

1. Weeks are ISO weeks, Monday 00:00 UTC, labelled by their Monday (`YYYY-MM-DD`).
2. A week with no merges AFTER the first pointed merge counts as 0 in the mean and the forecast's
   sampling, but is left out of `weeks` (the AC's wording). Before the first pointed merge, weeks are
   absent entirely. With no history, `pointsPerWeek` is absent, not 0.
3. The current, unfinished week is excluded from velocity and from the forecast's history.
4. A CR's first points declaration counts from the moment it JOINED the release; only later changes
   appear as `repointed` steps. Without this, pointing merged CRs at this CR's close-out would read as
   "committed 0" followed by one large step.
5. Step labels: `start` (delta 0), `merged` (verb `cr-close`), `planned` / `moved-out` / `repointed`
   (verb `cr-plan`), `voided` / `superseded`. Steps that predate the journal carry no verb.
6. When history is short AND CRs are unpointed, `insufficient_history` wins, and the forecast still
   names the unpointed CRs.
7. `target` stays in seconds (CR-CRU-091's declared unit); `ideal` and step timestamps are milliseconds.
   Each field states its unit.
8. **Overruled:** the analytics routes had skipped the project-key validation every other v2 route
   applies, to fit test fixtures using non-UUID keys. They must validate identically, and the fixtures
   move to valid keys (C4).

The dead-CR predicate is `isDeadCr(entry)` in `src/types.ts`, and CR-CRU-147 imports it rather than
re-implementing it. The forecast's seeded RNG is mulberry32 (`?seed=`), sampling the weekly history
uniformly; P50/P80 by nearest rank.
