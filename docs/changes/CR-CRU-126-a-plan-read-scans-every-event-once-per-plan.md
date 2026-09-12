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

`ORDER BY timestamp ASC, rowid ASC` is load-bearing — it is what makes `firstRunCommit`/
`lastRunCommit` the earliest and latest — and is preserved exactly.

**The API shape does not change.** An earlier draft proposed deriving the field only on a
single-plan read, which would have removed it from the unfiltered `GET /plans`. The measurement
makes that unnecessary: at one indexed query per plan the field can stay on every response that
carries it today. No consumer, in-repo or external, sees any difference except speed.

**Batching is permitted but not required.** If one query covering every returned plan's cycles is
cleaner than one query per plan, either satisfies the ACs — what is forbidden is a scan whose cost
grows with the event table.

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

## Close-out steps (orchestrator, performed ONCE — not per cycle)

- **Re-record `PROSE_CITATIONS.src.head`** in `tests/project-namespace-tripwire.test.ts`. It is
  **605** at the branch cut (measured 2026-09-12); this CR's prose naming CR-CRU-126 in
  `src/store.ts` will raise it. Measured at close-out, never transcribed.
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
