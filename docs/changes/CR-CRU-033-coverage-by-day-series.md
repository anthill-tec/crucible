# CR-CRU-033 — Date-keyed coverage-by-day series (CR-028 data prerequisite)

**Status:** COMPLETED (shipped 2026-07-21)
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-023 (durable rollup series), CR-CRU-032 (§S4 within-retention project feed)
**Labels:** server, coverage, vitals
**Phase:** Wave 4 — prerequisite for CR-CRU-028
**Design reference:** [DN-crucible-coverage-trend.md](../research/DN-crucible-coverage-trend.md) §6 (data-model amendment) + §2–§3

## Context
The coverage trend the client receives today (`project.coverageTrend`) is a flat
`number[]` derived only from the retention-prune rollups (`v2.ts` project brief,
`store.listRollups`). Two properties block CR-028's day/week/month hierarchy:
rollups are **prune-only** (recent within-retention coverage runs never appear —
the exact "unrepresented" defect), and rollup buckets are keyed
`context.wave ?? UTC-day` — wave-keyed buckets carry **no date**, so they cannot
sit on a time axis. This CR replaces the flat payload with a **date-keyed
coverage-by-day series** covering both recent (live events) and old (rollups)
days. Verified sole consumer of `listRollups` is the coverage series (via
`lastCoverage`); no surface reads the rollup's wave-grouping or its
run/pass/fail aggregates.

## Scope

### §S1 Coverage rollups keyed by UTC day
`Store.foldIntoRollup` (`store.ts`) buckets by
`new Date(row.timestamp).toISOString().slice(0, 10)` **always** — the
`context.wave ??` prefix is dropped. Only the bucket KEY changes; the
runs/passed/failed/duration/lastCoverage aggregation is unchanged. Legacy
wave-keyed rows already in the table are left as-is (§S2 excludes them).

### §S2 Server date-keyed coverage-by-day series
The `/api/v2/projects` project brief's `coverageTrend` becomes
`{ day: string, percent: number }[]` (`day` = `YYYY-MM-DD`), oldest→newest,
computed by MERGING per UTC day:
- **old days** — day-keyed rollups whose `lastCoverage` is set;
- **recent days** — within-retention coverage-bearing GREEN-regression events
  (the CR-023 population: `kind:"test"`, coverage present — failing runs already
  discard coverage) grouped by their UTC day, **last event of the day wins**.

A day present in BOTH halves yields ONE point (the live/last-of-day value wins
over the rollup's older `lastCoverage`). Legacy wave-keyed rollup buckets (a
non-`YYYY-MM-DD` bucket string) contribute NOTHING. The key stays ABSENT (not
null/empty) when no coverage exists anywhere — the existing convention.

### §S3 CoverageTrendCard consumes the dated series
`CoverageTrendCard` (`public/app.js`) reads `.percent` for bar height and `.day`
for the caption endpoints (was: bare numbers). Recent within-retention days now
render. CR-027 fixed-slice geometry and the `coverage-trend-bar` testids are
unchanged — the day/week/month hierarchy is CR-028, not here.

## Acceptance criteria
- [ ] §S1: a coverage event with `context.wave="4"` and a `timestamp` on `2026-07-14` folds (on retention prune) into rollup bucket `"2026-07-14"`, never `"4"` (assert the persisted `bucket`); two coverage events on the same UTC day — one wave-tagged, one not — fold into the SAME `"YYYY-MM-DD"` bucket with `runs=2`.
- [ ] §S1 regression: a grep for readers of `listRollups`/the `rollups` table returns only the §S2 coverage-series computation — the bucket-key change reaches no run-stats consumer (mechanically auditable; VERIFY runs it).
- [ ] §S2 shape: the `/api/v2/projects` brief carries `coverageTrend` as `{day: string, percent: number}[]`, `day` matching `^\d{4}-\d{2}-\d{2}$`, ordered oldest→newest (assert types + order against a seeded fixture).
- [ ] §S2 merge: a project with 2 pruned day-rollups (07-15=90, 07-16=91) + coverage events within retention on 07-17=93 and 07-18=94 returns exactly 4 points `[{07-15,90},{07-16,91},{07-17,93},{07-18,94}]`.
- [ ] §S2 same-day dedup: a day with BOTH a pruned rollup (percent 80) AND a within-retention coverage event (percent 88) yields ONE point for that day with `percent=88` (live/last-of-day wins).
- [ ] §S2 legacy exclusion: a wave-keyed rollup bucket `"4"` (non-date string) contributes NO point; a failing run carrying coverage contributes none; a project with zero coverage anywhere OMITS the `coverageTrend` key entirely.
- [ ] §S3 render: `CoverageTrendCard` renders one `coverage-trend-bar` per dated point with `height` from `.percent`; a 3-point fixture renders 3 bars; the caption reads the first/last point's percent.
- [ ] §S3 integration (the recent-day fix): a project whose ONLY coverage runs are within retention (NONE pruned) renders ≥1 `coverage-trend-bar` via the production render path — asserted by driving `/api/v2/projects` data through the mounted app, NOT by constructing the payload directly.
- [ ] §S3 caller-existence: a grep shows `CoverageTrendCard` in `public/app.js` reading the dated `coverageTrend` (≥1 non-test caller).

## Estimated size
S–M (one-line fold key + a read-time merge + the client adapter; the payload
shape change updates the existing `coverage-trend.test.ts` assertions).

## Risk
- The `coverageTrend` payload shape change (`number[]` → `{day,percent}[]`) is a
  breaking change to the existing 4 `tests/coverage-trend.test.ts` assertions and
  the current `CoverageTrendCard` — both migrate inside this CR (RED updates the
  tests, §S3 updates the card).
- Legacy wave-keyed rollup coverage is permanently dropped from the series (its
  source events are deleted — no recoverable day). Bounded one-time gap per
  DN §6; recent history is preserved via the live-event half of the merge.
- Same-day rollup-vs-live tie-break is pinned to "live wins" (§S2 AC).

## Non-goals
The day/week/month auto-coarsening hierarchy, drill-down accordion, and per-run
heat strip (all CR-CRU-028); the rollup run/pass/fail aggregates (untouched —
only the bucket KEY changes); function-coverage series (lines only, as today);
cross-project aggregation.
