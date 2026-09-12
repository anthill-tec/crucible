# CR-CRU-126 — a plan read scans every event, once per plan

**Status:** PENDING (0.2.0 — born mid-release, D4)
**Type:** bugfix
**Priority:** P1 — the only P1 in the queue
**Depends on:** none
**Labels:** bugfix, server, performance
**Phase:** Wave 6 (0.2.0 — user-directed, live orchestrator session 2026-09-12)
**Design reference:** CR-CRU-011 §S0's commit-boundary paragraph, which states this CR's target in
its own words: *"an orchestrator doing review/code analysis asks Crucible for a CR's boundary **in
one indexed query** instead of scanning `git log`."* `PRD-crucible-v2.md:428` states the performance
budget (*"ingest of a 1000-case JUnit directory < 500 ms"*) and §4.7 the single-writer architecture.

**Gap analysis:** run by the orchestrator 2026-09-12, nine findings (four blocking), all folded in
below. Baseline MEASURED 16:48 IST on clean tree `71b3a9e`: `tests/plans.test.ts` **53 pass / 0 fail
/ 291 expect()**, `bun x tsc --noEmit` exit 0.

## Context

`deriveCommitBoundary` (`src/store.ts`, symbol) runs for **every closed-and-merged plan on every
`toPlan`**, and each run scans the project's whole event table with `SELECT *` and `JSON.parse`s
every returned row. `toPlan` is called by `listPlans`, and `listPlans` is on far more paths than a
plans poll.

**Measured on the live board, 2026-09-12, quiet (no agent running, no cycle active):**

| endpoint | latency (best of 3) | payload |
|---|---|---|
| `GET /api/v2/health` — counts three tables | **0.3 ms** | 0.2 KB |
| `GET …/plans` | **2567.9 ms** | 104.6 KB |
| `GET …/queue` | **2557.7 ms** | 23.8 KB |
| `GET /api/v2/events?limit=2000` | **155.8 ms** | 707.9 KB |

`/events` serves **7× the bytes in 1/16th the time**, so payload size is irrelevant. Board shape,
read from SQLite: **115 plans, 107 closed-with-merge** (the only rows where the derive fires),
**1214 context-bearing events**, **125 queue rows**, and **37.0 MB** held in the wide columns
(`tree`/`coverage`/`compile`/`payload`/`context`) that `SELECT *` materialises.

**Per `/plans` request: 107 × 1214 = 129,898 row loads and JSON parses, and ~3.87 GB of column
data marshalled to produce a 104.6 KB response.**

### The user-visible stall is this cost TIMES the queue depth

A 2.5s request does not explain a minute-long stall, and the user said so. Measured with read-only
concurrent load (no writes, nothing mutated):

| concurrent `/plans` readers | `GET /health` | run detail (`?depth=suites`) | loader p50 |
|---|---|---|---|
| 0 | 0.2 ms | 0.2 ms | — |
| 1 | 2.2 ms | 1.2 ms | 2569 ms |
| 2 | **2551.9 ms** | **5080.5 ms** | 5099 ms |
| 4 | 7634.0 ms | 10179.8 ms | 10210 ms |
| 8 | **20795.4 ms** | **19156.9 ms** | 21406 ms |

Run-detail latency is **k × 2.5s**, to within noise. This is **head-of-line blocking, not lock
contention**: `deriveCommitBoundary` is synchronous CPU+IO on Bun's single JS thread (PRD §4.7's
single writer), so one `/plans` request stalls the entire event loop for ~2.5s and a 0.2 ms health
check waits its full turn behind it.

That is why the stall appears **only during execution**, as the user observed: one SPA tick already
fires `/plans`, `/queue`, `/events` and `/health` concurrently (two at 2.5s each), the 5s poll
interval refires before the previous tick drains, and **every agent ingest adds another 2.5s**
through `resolveIngestAttach`. Minute-scale latency needs only a handful of overlapping readers.

**The corollary that makes §S1 the whole fix:** because latency is `k × cost`, cutting the
per-request cost to ~20 ms collapses the queue with it — k=8 goes from 20.8 s to ~160 ms. The
contention is a multiplier on the cost, not a separate defect.

### Every caller pays, and most never read the field

`listPlans`' full caller set, enumerated (gap analysis DRIFT-3):

| caller | reads `commitBoundary`? | runs when |
|---|---|---|
| `validateCycleBinding` (`src/v2.ts`) | **no** — `.find()` by planId | every cycle-bound registration |
| `activeCycleIds` (`src/v2.ts`) | **no** | per call |
| `resolveIngestAttach` (`src/v2.ts`) | **no** — `.find()` by planId | **every ingest from a bound agent** |
| `deriveQueueStatus` (`src/store.ts`) | **no** — status facts only | **once per queue row** |
| `handlePlansList` (`src/v2.ts`) | yes | every poll |
| `handlePlansGlobalList` (`src/v2.ts`) | yes | `flatMap` over ALL projects |

Four of six never look at the boundary and pay for it in full. Two consequences:

- **`GET …/queue` is the SAME defect** (DRIFT-2), not a separate one: `deriveQueueStatus` calls
  `listPlans({cr})` once per queue row, so the 107 derivations are reached 125 separate times.
  Measured 10 ms apart from `/plans`. The 2026-09-07 candidate note suspected exactly this. It was
  previously listed as a non-goal here; that was wrong and is corrected.
- **The PRD's stated ingest budget is violated** (DRIFT-6): `PRD-crucible-v2.md:428` requires
  *"ingest of a 1000-case JUnit directory < 500 ms"*, and `resolveIngestAttach` spends ~2.5 s before
  that budget begins, on every RED/GREEN/FIX/VERIFY ingest.

### What the field is, and why it is not deleted

`commitBoundary` has **zero consumers in `public/`** — measured by a byte-safe scan of 473 files,
because `public/app-logic.mjs` carries 12 NUL bytes and pattern search silently skips it. Its
in-repo readers are `src/types.ts`, `toPlan`, and `tests/plans.test.ts`. The clients' `mergeCommit`
derives from `plan.merge.commit`, not from the boundary.

Deleting the derivation outright would remove the cost completely and was evaluated as the
subtractive option. **Refused, with a reason:** the field is a user-added affordance (CR-CRU-011 §S0,
added during CR-007 execution) whose consumer is an orchestrator reading the API — external to this
repo, so no in-repo test would notice its loss. Removing it needs the user's ruling, not an
orchestrator's inference. Recorded so it is not re-proposed blindly.

The same fact raises the stakes on correctness: because no `public/` test reads the field, **the
output-equality ACs below are the only thing standing between a refactor and a silently wrong API.**

## Scope

### §S1 A plan's commit boundary costs one indexed query

The derivation stops being a per-plan table scan. Three changes, ordered by MEASURED effect:

1. **Project two columns instead of `SELECT *`.** This is the dominant cost, not a refinement:
   `SELECT *` materialises `tree`/`coverage`/`compile`/`payload` — 37.0 MB per scan, ~3.87 GB per
   request — to extract two strings. The query needs `cycle_id` and `context` only.
2. **Filter in SQL on the existing `cycle_id` column.** `events.cycle_id` is a first-class column
   (`src/store.ts`, in `createBaseTables`), written at insert from `context.cycleId`. The membership
   test belongs in the WHERE clause, not in a JS skip-loop over every row in the project.
3. **Add the missing index.** `events` is indexed only on `(project_key, timestamp)`. Add
   `idx_events_project_cycle ON events (project_key, cycle_id)` — additive, idempotent, in the
   existing style. This is what makes change 2 a seek rather than a scan, and what earns CR-CRU-011
   §S0's phrase *"one indexed query."*

**The index must be COMPOSITE, and the reason is measured (RED, 2026-09-12).** A bare
`(project_key, cycle_id)` index is not enough: RED's first probe proved nothing because
`EXPLAIN QUERY PLAN` showed SQLite choosing `idx_events_project_timestamp` over the new index, since
`ORDER BY timestamp ASC` makes the timestamp index **sort-free** and therefore cheaper in the
planner's estimation. RED had to force `INDEXED BY` to get a real comparison.

So adding a bare `(project_key, cycle_id)` index does **not** guarantee the planner uses it while
the derivation keeps its `ORDER BY timestamp`. GREEN has two defensible options and must state
which it took and why:

1. **`(project_key, cycle_id, timestamp)`** — the index then serves the filter AND the ordering, so
   it is both a seek and sort-free, and the planner should prefer it on its own merits.
2. Keep the two-column index and **drop the SQL `ORDER BY`**, sorting the handful of surviving rows
   in JS. Cheap once the filter is indexed, but it moves a correctness-critical ordering out of the
   query — and `firstRunCommit`/`lastRunCommit` depend on it, so §S1's ordering AC becomes the only
   guard.

Option 1 is the orchestrator's recommendation: it keeps the ordering where the ACs can see it. Note
that the §S1 index AC as written CANNOT catch this class of mistake — RED flagged that its probe
asserts a lookup with no `ORDER BY`, which is exactly why ruling 1 requires GREEN to quote its
production query and its own `EXPLAIN` output as evidence.

`ORDER BY timestamp ASC, rowid ASC` is load-bearing — it is what makes `firstRunCommit`/
`lastRunCommit` the earliest and latest — and is preserved exactly.

**The API shape does not change.** An earlier draft proposed deriving the field only on a
single-plan read, which would have removed it from the unfiltered `GET /plans`. The measurement
makes that unnecessary: at one indexed query per plan the field can stay on every response that
carries it today. No consumer, in-repo or external, sees any difference except speed.

**Batching is permitted but not required.** If one query covering every returned plan's cycles is
cleaner than one query per plan, either satisfies the ACs — what is forbidden is a scan whose cost
grows with the event table.

**Batching by `IN (…)` is MEASURED to be wrong on this store (GREEN, 2026-09-12).** GREEN probed
both shapes. With `ANALYZE` statistics the `IN` form does plan to the new index; **without** them —
and this store runs no `ANALYZE` — it falls back to
`SEARCH events USING INDEX idx_events_project_timestamp (project_key=?)`, i.e. the full project scan
this CR exists to remove, because the sort-free ordering outbids a multi-seek the planner has no
statistics for. That is §S1's own warning surviving the composite index. The shipped form is
therefore **one equality seek per cycle**, which plans to `idx_events_project_cycle`
unconditionally; a multi-cycle plan's per-cycle results are merged back into one `(timestamp, rowid)`
order in JS before the walk, so `firstRunCommit`/`lastRunCommit` stay the earliest/latest across the
whole plan.

### §S1a `toPlan` is not a pure read — do not cache it

`toPlan` calls `deriveAndCheckpointActiveMs` for every ACTIVE cycle, which performs an
`UPDATE plan_cycles SET active_ms_accumulated` at a ≤60 s cadence. That is CR-CRU-023 §S3(a)'s
**designed** read-path piggyback: it is how a crash loses at most one 60 s window of attention time
instead of the whole epoch.

**So memoising `toPlan` or `listPlans` is PROHIBITED.** A cache would silently suppress the
checkpoint and turn a bounded loss into a total one. The fix makes the derivation cheap; it does not
make the read skippable. AC pinned below (gap analysis DRIFT-5).

This also names a dogfooding hazard: a load harness hammering `/plans` while a cycle is active is
**not** read-only — it drives real checkpoint writes. Harnesses run with no cycle active, or state
the added writes.

### §S1b The historical `cycle_id` column is backfilled

**Found by GREEN 2026-09-12 on a `.backup` replica; ruled by the user the same day.** §S1 filters on
`events.cycle_id`, and that column is **NULL for 712 of 1306 context-bearing events** — CR-CRU-094
§S1 added it with *"history left NULL"* and never backfilled. So the column filter is NOT
output-equal on real data: of 124 closed-and-merged plans, **13 lose `branch`, `firstRunCommit` and
`lastRunCommit` entirely**, degrading to the no-git shape (`mergeCommit` + `closedAt` survive).

The 13, enumerated: `CR-SAN-045` (plan 13), `CR-MDB-016` (45), `CR-CRU-091` (94), `CR-CRU-092` (95),
`CR-CRU-096` (99), `CR-CRU-099` (101), `CR-CRU-100` (102), `CR-CRU-101` (103), `CR-CRU-102` (104),
`CR-CRU-103` (105), `CR-CRU-104` (106), `CR-CRU-106` (107), `CR-CRU-079` (110). Concretely, plan 99
(`CR-CRU-096`) today reports `branch: feature/CR-CRU-096`, `firstRunCommit: d2b0e82c…`,
`lastRunCommit: 61d118fb…`; under a bare column filter it reports none of the three.

**Why the ACs could not catch it, and this is the important part.** Every row a test fixture inserts
goes through `insertEvent`, which sets the column — so all 11 derivation tests pass either way. The
five output-equality ACs that §S1's Risk section calls "the whole risk" are structurally blind to
this case. The orchestrator's gap analysis confirmed the column EXISTS and is WRITTEN AT INSERT and
never asked what historical rows contain: a values-not-types miss, the exact failure Dimension 3
names.

**The fix: one appended migration step.**

```sql
UPDATE events SET cycle_id = json_extract(context, '$.cycleId') WHERE cycle_id IS NULL
```

This is not fabrication — it is the rule `insertEvent` already applies
(`event.context?.cycleId ?? event.cycleId ?? null`), applied retroactively to rows that predate it.
It restores byte-identical output AND keeps the indexed seek.

**Costs, accepted knowingly:** `SCHEMA_VERSION` is derived from `MIGRATIONS.length`, so appending a
step bumps it and the pre-CR-126 binary will REFUSE to open this store (`StoreVersionTooNewError`) —
a deliberate one-way door. CR-CRU-071 writes a pre-upgrade backup before the first migrating write,
so the live board is protected by machinery that already exists.

**The NULL set is FROZEN, not a leak — measured, not assumed.** `src/store.ts` has exactly ONE
`INSERT INTO events` (`insertEvent`), reached by all nine recording paths, and it binds the column
unconditionally. The replica confirms it behaviourally: the last context-bearing row with a NULL
column is 2026-09-07 06:19 UTC, the first with a non-NULL column is 07:23 UTC — a clean cutover at
CR-CRU-094's deploy, 535 rows since carrying both, zero overlap. That is what disqualified the
alternative of a permanent `cycle_id IS NULL` branch in the read path: it would pay forever for a
finite 712-row historical defect that can never grow.

### §S2 The cost is pinned by a TIMED test

**User ruling 2026-09-12:** this is a performance defect, so the pin is a wall-clock measurement — a
read-count proxy can pass while the endpoint is still slow. Flakiness is controlled by the test's
SHAPE:

- **In-process, idle store.** The fixture builds its own `Store` over `:memory:` and calls
  `listPlans` directly — no HTTP, no server, no agent traffic, so the contention that produced this
  session's first (wrong) readings cannot reach it.
- **The fixture's plans MUST be closed-with-merge.** `deriveCommitBoundary` returns immediately
  unless `status === "closed"`, `merge` is present and `closedAt` is present. A fixture of open plans
  exercises zero derivations and would pass on today's code — a born-vacuous pin (DRIFT-7).
- **A scaling assertion, which is the real subject.** The same plan count is timed against M events
  and 10×M events; elapsed time must NOT scale with the event count.
- **An absolute ceiling an order of magnitude above the expected figure**, so it fires on a
  regression rather than on a loaded box.
- **The fixture's events MUST carry wide-column payloads** (`tree`/`coverage`/`payload`) on a
  realistic share of rows. **Ruled 2026-09-12 (RED escalation 4).** RED's fixture used small events,
  so its pre-fix figure was 133 ms rather than production's 2.5 s, and it flagged that honestly. The
  gap matters: DRIFT-4 measured `SELECT *`'s marshalling of the wide columns as the DOMINANT cost
  (37.0 MB per scan, ~3.87 GB per request), so a fixture without blobs lets a fix that adds the
  index and the WHERE clause but KEEPS `SELECT *` pass the gated pin while production stays slow.
  The blobs are what make the pin feel the cost the CR is actually about. The §S2a harness carries
  the production figure, but it is a script — only this pin is gated.

**Calibration (RED escalation 5, accepted).** The 50 ms ceiling and 30 ms scaling tolerance are
RED's, derived on this box against a post-fix expectation of ~3-5 ms. If they ever need widening,
widen the CEILING and not the scaling delta: the delta is the assertion that carries the CR, and a
ceiling is a smoke alarm.

**Calibration CONFIRMED by measurement, 2026-09-12 (RED, fixture hardened to `633ae28`).** The
blobs were sized from the live board's own per-column distribution rather than a flat average —
`tree` on 93.75% of rows at 22,961 B, `payload` on 91.67% at 9,866 B, `coverage` on 1% (it is three
fixed axes and cannot be large) — giving **30,625 B/row against production's measured 30,600**. The
pin's pre-fix figure moved **133 ms → 1896.3 ms**, the same order as the live `/plans` at 2567.9 ms;
it had been understating the defect ~14×.

The calibration was NOT widened, because the measurement showed 50 ms now falls BETWEEN the only two
outcomes that can ship:

| query shape (50 plans, 2000 events) | at 2000 | ceiling 50 ms | delta 30 ms |
|---|---|---|---|
| today — unbounded scan + `SELECT *` | 1896.8 ms | FAIL | FAIL |
| indexed + cycle-filtered, **keeps `SELECT *`** | **57.6 ms** | **FAIL** | **FAIL** (52.5) |
| indexed + cycle-filtered + two columns | 13.6 ms | pass (3.7×) | pass (2.4×) |

So the pin discriminates the RIGHT fix from the almost-right one. Without blobs both candidate
shapes finish in single-digit ms and neither bound can separate them — which is precisely why the
hardening was required rather than accepted as a stated limit.

### §S2a The end-to-end curve is reproducible

The contention table above is produced by a committed harness (read-only, GET-only) so the fix is
provable end to end and the next regression is measurable by re-running it, not re-deriving it. It
is a script, not a gated test: it needs a live server and real data, which is exactly what
`pre-merge-gate` must not depend on.

### §S3 The fleet's 10s client GET timeout is stated, not incidental

`clients/python-crucible.py`'s `_get(path, timeout=10)` is a bare default that converts a slow board
into a `TimeoutError` traceback with no envelope — which is how every cycle transition in this
session failed, forcing direct route PATCHes. This CR does **not** change the timeout's VALUE
(user ruling: fix the performance, not the symptom). It makes the failure legible: a plans-GET
timeout surfaces as the fleet's standard `ok:false` envelope naming the condition, the way
`PlansFetchFailed` already does for an unreachable board.

## Acceptance criteria

**§S1**
- [ ] `listPlans` over a fixture of 50 closed-and-merged plans and 2000 context-bearing events
      completes within §S2's ceiling, and its elapsed time does not scale with the event count.
- [ ] A closed, merged plan's `commitBoundary` is byte-identical to today's value for the same
      fixture: `mergeCommit`, `branch`, `firstRunCommit`, `lastRunCommit`, `closedAt` all unchanged.
- [ ] An OPEN plan, a closed plan with no `merge`, and a closed merged plan whose linked runs carry
      no `context.git` each still report `commitBoundary` ABSENT — not null, not partially populated.
- [ ] A plan whose linked runs span several cycles still reports the EARLIEST `firstRunCommit` and
      the LATEST `lastRunCommit` across all its cycles, in timestamp order.
- [ ] Events belonging to ANOTHER plan's cycles never contribute to this plan's boundary.
- [ ] **Every response that carries `commitBoundary` today still carries it** — the unfiltered
      `GET …/plans`, the `?cr=` and `?track=` filtered forms, and the global cross-project list —
      asserted per route, so a fix that quietly narrows the API surface fails (DRIFT-8).
- [ ] `idx_events_project_cycle` EXISTS in `sqlite_master`, and a cycle-scoped lookup of the shape
      the derivation issues plans to it under `EXPLAIN QUERY PLAN`.
      **Ruled 2026-09-12 (RED escalation 1):** this AC is deliberately worded to what is
      ASSERTABLE. The store's `db` handle is private, so no test can `EXPLAIN` the production
      statement itself; RED asserts a representative lookup through a second connection to the same
      file. That proves the index exists and is reachable for that shape — it does NOT prove the
      production query is the one planned to it, and if GREEN batches the lookup into a single
      `IN (…)` (which §S1 permits) SQLite may plan it differently while the probe still passes.
      The gap is closed by EVIDENCE, not by a stricter test: **GREEN must quote its production
      query verbatim and its own `EXPLAIN QUERY PLAN` output in its report.** The timed pin is what
      proves speed.
- [ ] `GET …/queue` no longer pays the derivation: `deriveQueueStatus`'s path performs a number of
      event-row reads that does not scale with the event table (DRIFT-2).

**§S1a**
- [ ] An ACTIVE cycle read through `listPlans` still checkpoints `active_ms_accumulated` at the
      ≤60 s cadence — CR-CRU-023 §S3(a)'s contract, asserted as a regression, so a memoising
      "optimisation" fails the suite instead of silently losing timer state.

**§S1b**
- [ ] A store whose events carry `context.cycleId` but a NULL `cycle_id` COLUMN derives the SAME
      boundary as one whose column is set — the fixture MUST write NULL-column rows directly, since
      `insertEvent` cannot produce them, which is why no existing test can see this.
- [ ] After the migration, zero context-bearing rows with a `context.cycleId` are left with a NULL
      `cycle_id` column.
- [ ] The migration is IDEMPOTENT: running the chain twice changes nothing the second time.
- [ ] A row whose `context` carries NO `cycleId` is left NULL — the backfill derives, it never
      invents.
- [ ] The event COUNT is unchanged by the migration: it is an UPDATE, never an insert or a delete
      (the dogfood migration test asserts counts).
- [ ] **The new index must not break the pre-CR-094 fixture.** `makePreCycleIdStore`
      (`tests/store-migration.test.ts`) fabricates a pre-CR-094 store by
      `ALTER TABLE events DROP COLUMN cycle_id`, and `idx_events_project_cycle` references that
      column, so SQLite refuses the drop: *"error in index idx_events_project_cycle after drop
      column: no such column: cycle_id"*. The fixture drops the INDEX before the column.
      **Ruled 2026-09-12** — this is a genuine consequence of §S1's index, found by running the
      suite that owns `MIGRATIONS` (which the orchestrator's first verification of GREEN failed to
      run; the miss was the orchestrator's, not GREEN's).
- [ ] **CR-CRU-094's two chain-length pins are RETARGETED, not deleted.**
      `tests/store-migration.test.ts` asserts `schemaVersion() === PRE_CYCLE_ID_VERSION + 1` (9) and
      `migrationChain().length === 9`. `SCHEMA_VERSION` is derived from `MIGRATIONS.length`, so
      appending §S1b's body makes both 10 and both assertions false.
      **Ruled 2026-09-12 (RED escalation):** CR-CRU-094's real contract — *its* body is at 8→9,
      appended, exactly one — is still true and stays asserted, located by DESCRIPTION the way every
      later body in this repo already does. What goes is the two GLOBAL chain-length literals, which
      were never a claim about CR-094 but about the world at that moment, and were always going to
      break on the next migration. A pin that outlived its CR is deleted, never re-pinned to a new
      number — re-pinning would just defer the same break to CR-127's migration.
- [ ] After both edits, `tests/store-migration.test.ts` is fully green and CR-CRU-094's AC2 still
      fails if its body is moved out of position 8→9 or a second body is added beside it — proven by
      mutation, so the retarget is not a weakening.

**§S2**
- [ ] The timed pin runs in-process against a `:memory:` store with no server and no concurrent
      traffic.
- [ ] Its fixture plans are closed-with-merge, and non-vacuity is proven by MUTATION: restore the
      unbounded per-plan scan and both the scaling assertion and the ceiling must go red.
- [ ] Timing the same plan count against M and 10×M events shows no scaling with the event count.

**§S2a**
- [ ] The harness reproduces the k-readers curve on a live board and is committed under `scripts/`,
      GET-only, with the no-active-cycle precondition stated in its own output.

**§S3**
- [ ] A plans GET that exceeds the client timeout emits the fleet's standard `ok:false` envelope
      naming the timeout as the condition, and exits non-zero — asserted for `cycle-activate` and
      `cycle-done`, the two verbs that failed this way in practice.
- [ ] No stack trace reaches stdout/stderr on that path.
- [ ] The timeout VALUE is unchanged (10s) — this section is about legibility, not tuning.
- [ ] **Ruled 2026-09-12 (RED escalations 2 and 3):** these three ACs may be discharged by TWO
      tests (one per verb) rather than three. Each additional test costs a real 10-second wait, and
      the three are properties of one observation — paying 20 s more wall clock to name them
      separately is bad value. Also accepted: the envelope must contain the word "timeout"
      (case-insensitive), NOT the numeral `10` — requiring the number would over-specify GREEN's
      wording. The 10 s VALUE is pinned BEHAVIOURALLY instead, by bounding the elapsed wait to
      [9 s, 15 s), which is the better test: it survives a reword and fails a retune.
- [ ] The mechanism RED measured is the one fixed: `urllib` raises a **bare `TimeoutError`** on a
      read-phase timeout, which is NOT a `urllib.error.URLError`, so `http_request`'s handler misses
      it and `run_verb` converts only three typed hard stops — hence the unhandled traceback and
      empty stdout after 10.08 s. Naming it here so GREEN fixes the actual exception path rather
      than wrapping a broader `except`.

## Estimated size

M — one or two cycles. §S1 is a query rewrite plus an index with a precisely pinned output contract;
§S1a is one regression test; §S2/§S2a are a timed fixture and a harness; §S3 is a client-side
envelope on an existing failure path.

## Risk

- **`commitBoundary`'s output contract is the whole risk, and nothing in `public/` guards it.**
  Measured: zero consumers in `public/`, so a subtly wrong boundary is a silently wrong API rather
  than a failing test. That is why §S1 carries five output-equality ACs before any performance claim.
- **A memoising fix breaks timer persistence** (§S1a). The read path writes by design; that is
  counter-intuitive and is the likeliest wrong turn.
- **A timed assertion carries a flakiness risk** that §S2's shape absorbs: in-process over
  `:memory:`, a scaling comparison rather than a bare number, and a generous ceiling. This project
  has one recorded false latency alarm (2026-09-07) from measuring under contention, and this CR's
  own first diagnosis was wrong for the same reason until it was A/B'd.
- **`EXPLAIN QUERY PLAN` is a plan assertion, not a performance one.** It proves the index is
  reachable, not that the query is fast; the timed pin is what proves the latter. Both, or neither
  means much.
- **A schema/DDL change has a blast radius the obvious suites do not cover.** §S1's index broke
  `tests/store-migration.test.ts` — not through the version number RED predicted, but because a
  fixture DROPS the indexed column. The orchestrator's first verification of GREEN ran the
  derivation suite, `plans.test.ts` and `tsc`, and missed it. **Rule for this CR's remaining work:
  any change under `createBaseTables` or `MIGRATIONS` is verified by running the migration suite,
  not only the suites the CR names.**
- **Two behavioural deltas VERIFY recorded so they are not rediscovered as defects** (both
  SUGGESTION, no change requested):
  1. **The queue read no longer drives a checkpoint.** `deriveQueueStatus` now uses a 4-column
     `planStatusFacts` query instead of `listPlans`, so it never reaches `toPlan` — which is exactly
     what DRIFT-2 asked for, but it means the ≤60 s `active_ms_accumulated` durability bound now
     rests solely on the plans-read callers (`handlePlansList`, `resolveIngestAttach`,
     `validateCycleBinding`, `activeCycleIds`). All four still fire on every SPA tick and every
     ingest, so the bound holds; the delta is that `/queue` is no longer one of its guarantors.
  2. **The membership test's type strictness changed.** It moved from
     `typeof context.cycleId === "number"` to the `cycle_id` column, and SQLite's INTEGER affinity
     converts a well-formed numeric STRING losslessly (VERIFY measured `'42'` and `' 42 '` → integer
     42, `'not-a-number'` stays TEXT, `42.7` → REAL). Since `validateCycleRef` returns `{}` for a
     non-number rather than refusing, a blob carrying `cycleId: "42"` is storable and would now
     contribute where the old type guard excluded it. GREEN's no-`CAST` argument covers only the
     genuinely non-numeric case. Impact today is measured ZERO: the live board's census is 1498
     integer / 642 null bindings, with no text and no real.

## Close-out steps (orchestrator, performed ONCE — not per cycle)

- **Re-record TWO `PROSE_CITATIONS` heads** in `tests/project-namespace-tripwire.test.ts`: `src`
  **605 → 614** and `clients` **814 → 815**; `public` stays **476**.
  **Corrected 2026-09-12 (VERIFY finding 1).** This step originally named `src` alone, because the
  spec was written before §S3 existed — and §S3's comment block in `clients/_crucible_axi.py` also
  names CR-CRU-126, so the `clients` head moved too. VERIFY measured all three with the guard's own
  machinery over a `git archive HEAD` replica. The figures above are VERIFY's; the orchestrator
  re-measures at close-out rather than transcribing them, which is what makes the procedure
  self-correcting — running the guard surfaces every moved head whether or not the spec predicted it.
- **Insertion point matters, measured:** there are **89** `store.ts:<line>` citations across **30**
  files in `tests/`+`clients/`. Edits confined to `toPlan`/`deriveCommitBoundary` (the 4501+ region)
  shift **0** of them; inserting beside the existing index declaration in `createBaseTables` shifts
  **44**. Prefer the former; where the index declaration must be added, accept the shift and do NOT
  re-pin — ~41 of those citations are already stale (recorded 2026-09-07 candidate), so re-pinning
  44 is disproportionate. Recorded as a measurement, deliberately not as work.
- **Re-run the §S2a harness after the fix** and state the new curve in the merge note beside the
  pre-fix one. The claim being made is that k×cost collapsed; the harness is the evidence.

## Non-goals

- Changing the 5s poll interval or the per-project `retention` — the poll is not the defect, the
  per-poll cost is.
- Changing the single-writer architecture (PRD §4.7) or introducing concurrency. Making one request
  cheap is the fix; making many requests parallel is a different CR and a larger one.
- Tuning the clients' 10s GET timeout value.
- **Deleting `commitBoundary`.** Evaluated and refused above; needs the user's ruling.
- Memoising or caching plan reads (§S1a explains why this is prohibited, not merely unchosen).
- **Standing server-side perf instrumentation** (an env-gated request timing log, per-phase
  counters, a debug route). Discussed 2026-09-12 and deliberately NOT folded in: it is production
  code in `src/server.ts` serving a different purpose — catching the NEXT regression rather than
  fixing this one — and it deserves its own CR and its own ruling. The zero-risk alternatives
  (`bun --inspect` CPU profile; a `sqlite3 .backup` replica on a second port) need no code at all
  and are what this analysis used.
