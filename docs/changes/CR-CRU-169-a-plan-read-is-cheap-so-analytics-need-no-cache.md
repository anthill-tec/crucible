# CR-CRU-169 — a plan read is cheap, so analytics need no cache

**Type** fix · **Points** 5 (provisional, 2026-10-06; set at gap analysis) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-158 ·
**Status** PENDING — filed 2026-10-06

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

## Steps

### §S1 — a closed plan's commit boundary is stored when it closes

`cr-close` (the plan's close) derives the boundary once and stores it with the plan. A plan read
returns the stored boundary and never derives it. A migration stores the boundary of every plan
already closed, derived exactly as today. A plan's `commitBoundary` on the wire is byte-identical
to today's.

### §S2 — a project's plans are read in a constant number of queries

`listPlans` reads the project's plans and all their cycles in a fixed number of queries however many
plans the project holds, and builds each plan from them. An active cycle's accumulated attention
time (`activeMs`) and its checkpoint are unchanged. Every plan read's payload is byte-identical to
today's.

### §S3 — the analytics cache is removed

With §S1 and §S2 in place, `AnalyticsCache` (`src/analytics-cache.ts`) and its use in the four
analytics handlers are removed; each analytics read is computed on every request. The answers are
unchanged.

## Acceptance criteria

- [ ] After the migration, every plan's `commitBoundary` on a copy of the dev store equals today's,
      byte for byte, asserted on the server.
- [ ] A plan read runs the same number of queries for a project with 10 plans and with 200, and no
      plan read queries the events, milestones or gates tables, asserted on the queries run (not
      timing).
- [ ] Closing a plan stores its commit boundary, and a later run filed against one of its cycles does
      not change it, asserted on the server.
- [ ] Every plan read (`plans`, `status`, the Workflow and roadmap reads) answers byte-identically to
      today's on a copy of the dev store, asserted on the server.
- [ ] `AnalyticsCache` no longer exists, and each of velocity, burndown, forecast and the plan-change
      counts answers under 15 ms on a copy of the dev store, measured the way CR-CRU-158's gap analysis
      measured its reads.
