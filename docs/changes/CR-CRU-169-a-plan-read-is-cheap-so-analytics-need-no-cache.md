# CR-CRU-169 — a plan read is cheap, so analytics need no cache

**Type** fix · **Points** 5 (confirmed at gap analysis 2026-10-07) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-158 ·
**Status** PENDING — filed 2026-10-06; amended at gap analysis 2026-10-07 (user-approved)

## Problem

CR-CRU-158 added a server cache for the four analytics reads (`AnalyticsCache`, held per project,
read and UTC day, dropped on that project's `events` change). **Measured 2026-10-06** on a scratch
board (develop) against a file copy of the dev store, with the roadmap page open, an agent cycle
(register, run start, 60 heartbeats, a 3052-test ingest), then a reload, a second tab and a
navigation:

| | Analytics reads | Hits | Misses |
|---|---|---|---|
| Load, run start and ingest (live work) | 9 | **0** | 9, 70–80 ms each |
| Reload, second tab, navigation (nothing changed) | 12 | 12 | 0 |

While work goes on the cache never hits: every write that can move the figures emits `events`, which
drops the cache, and the page re-reads analytics only on `events` frames. It only saves a repeat
view when nothing changed (about 220 ms of server time per view).

The cost it hides is not the analytics: velocity, burndown and forecast each compute in under 1 ms.
It is `Store.listPlans` (about 71 ms for this project's 154 plans), which every plan read pays —
the Workflow page, `status`, `plans`, the roadmap and each analytics miss:

- each plan is built on its own (`toPlan`), with its own cycle query;
- each **closed** plan re-derives its commit boundary on every read (`deriveCommitBoundary`): one
  indexed query per cycle against each of the events, milestones and gates tables, and a parse of
  each row's `context` JSON for its git commit. A closed plan's boundary never changes.

**Re-measured 2026-10-07 (gap analysis, schema v18, a file copy of the dev store, in process):**
CR-CRU-167/168 shrank the events table, so the costs moved but the shape did not:

| | 2026-10-06 | 2026-10-07 |
|---|---|---|
| `listPlans` (160 plans, 151 closed, 603 cycles) | ~71 ms | **20 ms** |
| `listPlans` with the boundary derivation stubbed out | — | **6.7 ms** |
| statements per plan read | — | **1,895**: 1,734 boundary seeks (578 cycles × events, milestones, gates) + 160 cycle reads + 1 |
| each analytics read, uncached (velocity, burndown, forecast, changes) | 70–80 ms | **~22 ms** |

**And a correctness reason (2026-10-07):** the boundary is derived from test events, which retention
evicts (the default cap is 5,000 events per project; the dev store holds 4,385). Once a closed plan's
earliest runs are evicted, its `firstRunCommit` silently changes or disappears. A closed plan's
boundary is a record, and §S1 makes it one.

## Steps

### §S1 — a closed plan's commit boundary is stored when it closes

`cr-close` (`Store.closePlan`, the plan's only close path) derives the boundary once, in the same
transaction, and stores it on the plan row: `plans` gains `boundary_branch`, `boundary_first_commit`
and `boundary_last_commit` (merge commit and close time are already columns), through the
migration chain (schema v18 → v19). The migration backfills every plan already closed with a merge,
derived exactly as today. A plan read returns the stored boundary and never derives it; a closed
plan's `commitBoundary` on the wire is byte-identical to today's (absent fields stay absent,
never null).

### §S2 — a project's plans are read in a constant number of queries

`listPlans` reads the project's plans and all their cycles in a fixed number of queries however many
plans the project holds, and builds each plan from them. An active cycle's accumulated attention
time (`activeMs`) and its checkpoint are unchanged. Every plan read's payload is byte-identical to
today's.

### §S3 — the analytics cache is removed

With §S1 and §S2 in place, `AnalyticsCache` (`src/analytics-cache.ts`), its use in the four
analytics handlers (`handleAnalyticsVelocity`, `…Burndown`, `…Forecast`, the plan-change counts) and
its test (`tests/analytics-cache-invalidated-by-store-changes.test.ts`) are removed; each analytics
read is computed on every request. The answers are unchanged.

## Acceptance criteria

- [ ] After the migration, every plan's `commitBoundary` on a copy of the dev store equals today's,
      byte for byte, asserted on the server.
- [ ] A store at schema v18 migrates to v19 through the chain (backup written; every closed, merged
      plan's stored boundary equals its derived one; open, aborted and unmerged plans store none);
      a fresh store is built at v19.
- [ ] A plan read runs the same number of statements for a project with 10 plans and with 200, and no
      plan read queries the events, milestones or gates tables, asserted on the statements run (not
      timing).
- [ ] Closing a plan stores its commit boundary, and a later run filed against one of its cycles does
      not change it, asserted on the server.
- [ ] Every plan read (`plans`, `status`, the Workflow and roadmap reads) answers byte-identically to
      today's on a copy of the dev store, asserted on the server.
- [ ] `AnalyticsCache` no longer exists, and each of velocity, burndown, forecast and the plan-change
      counts answers under 15 ms on a copy of the dev store, measured in process the way this CR's gap
      analysis did (median of 5 after a warm-up; the 2026-10-07 baseline is ~22 ms each).
