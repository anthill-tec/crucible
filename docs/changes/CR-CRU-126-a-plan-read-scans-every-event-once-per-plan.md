# CR-CRU-126 — a plan read scans every event, once per plan

**Status:** PENDING (0.2.0 — born mid-release, D4)
**Type:** bugfix
**Priority:** P1
**Depends on:** none
**Labels:** bugfix, server, performance
**Phase:** Wave 6 (0.2.0 — user-directed, live orchestrator session 2026-09-12)
**Design reference:** `PRD-crucible-v2.md` §4.7 — *"One Bun process is the single writer"*: the design
that makes a synchronous O(n×m) derivation on a polled read path a whole-server stall rather than a
slow endpoint

## Context

Found 2026-09-12 by measurement, after the user reported a run detail that showed
`loading run detail…` for nearly a minute and never rendered. The UI was not at fault. The run's own
endpoint answers in **18ms** on an idle board; the identical click stalled for ~a minute while a
sub-agent was running tests against the same server.

**Measured A/B on the live board (114 plans, 2000 events), same data, one variable — whether a
sub-agent was running:**

| endpoint | agent running | board idle | payload |
|---|---|---|---|
| `GET /api/v2/health` | **6.89s** | **0.01s** | 0.2 KB |
| `GET …/plans` | 5.09s | **2.53s** | 103.6 KB |
| `GET /api/v2/events?limit=2000` | 5.04s | **0.20s** | 706.4 KB |
| `GET …/queue` | 5.07s | **2.45s** | 23.2 KB |

Two facts fall out of that table, and they are different problems:

1. **Under load every endpoint queues behind a blocked event loop.** `/health` only counts three
   tables; it cannot be slow for any reason of its own, yet it measured 6.89s and then 0.01s — a
   700× swing with no change to the endpoint. And 706 KB served in 0.20s while 0.2 KB took 6.89s, so
   payload size is irrelevant. That is the signature of a saturated single-writer loop serving a
   queue, exactly as PRD §4.7 designs it to be.
2. **`/plans` and `/queue` are slow with NO load at all** — 2.53s and 2.45s on a completely idle
   board. That is not contention; that is the work itself, and it is what turns ordinary agent
   activity into a freeze.

**The cause of (2), read from source.** `Store.toPlan` (`src/store.ts:4501`) calls
`deriveCommitBoundary` (`src/store.ts:4550-4583`) for **every plan on every `listPlans`**, and each
call runs:

```sql
SELECT * FROM events WHERE project_key = ? AND context IS NOT NULL ORDER BY timestamp ASC, rowid ASC
```

then `JSON.parse`s `row.context` for every row returned, to find the first and last commit among the
plan's own cycles. Measured on the live board: **105 closed-and-merged plans × 2000 events =
~210,000 row loads plus 210,000 JSON parses per single `/plans` request** — and the SPA polls
`/plans` every **5 seconds** (`public/app.js:413`).

The cost is the product of two growing numbers, so it has been degrading invisibly all along: the
2026-09-07 queue note recording *"`GET …/queue` takes ~1.4 s for 108 entries"* is this same defect
measured earlier and smaller; it is now 2.45s.

**What it has already cost, beyond the reported symptom:** the fleet clients hardcode a 10s GET
timeout (`clients/python-crucible.py:175`, `_get(path, timeout=10)`), and 2.5s idle plus any agent
load crosses it — so **every** `cycle-activate`/`cycle-done` in this session failed with
`TimeoutError` and had to be issued as a direct route PATCH instead. Orchestrator `ctx_shell` probes
hit their 30s cap against the same endpoints.

**Surfaces (verified 2026-09-12):** `deriveCommitBoundary` and its caller `toPlan`
(`src/store.ts:4501-4583`); `listPlans`; the `commitBoundary` field's only consumers.

## Scope

### §S1 A plan's commit boundary is derived only when it is needed

`commitBoundary` is computed eagerly for every plan on every read, but is only ever *read* when a
specific plan's boundary is displayed. The derivation moves off the list path: `listPlans` stops
computing it, and it is produced only for a single-plan read (or lazily on access) so a plans LIST
costs nothing per plan.

Where the field must still appear in a list response, it is derived by ONE bounded pass instead of a
whole-table scan per plan. Three compounding changes, each verified against the schema 2026-09-12:

1. **Hoist the derivation out of the per-plan loop.** `listPlans` performs ONE lookup covering every
   cycle of every plan it is about to return, builds a `cycleId -> {branch, firstRunCommit,
   lastRunCommit}` map, and each `toPlan` reads its own cycles out of that map. This removes the
   per-plan multiplication: `O(plans x events)` becomes `O(events)`, once.
2. **Project two columns and filter in SQL.** `events` already carries a first-class `cycle_id`
   column (`src/store.ts:1477`), written at insert (`:2866`), so the membership test belongs in the
   WHERE clause, not in a JS skip-loop. `SELECT *` is the other half of the cost: it materialises
   `tree`, `coverage`, `compile` and `payload` - the wide columns - in order to extract two strings.
   `ORDER BY timestamp ASC, rowid ASC` is load-bearing (it is what makes first/last correct) and
   stays.
3. **Add the missing index.** `events` is indexed only on `(project_key, timestamp)` (`:1480`);
   there is no index on `cycle_id`. `CREATE INDEX IF NOT EXISTS idx_events_project_cycle ON events
   (project_key, cycle_id)` - additive and idempotent, in the same style as the existing index.

Explicitly NOT chosen: persisting the boundary on the `plans` row at close time. A closed plan's
boundary is settled history so there is no invalidation hazard, and reads would become O(1) - but it
costs a schema change, a chain step and a backfill, and it converts a DERIVED value into a stored
one, against this project's deliberate derived-status posture (`deriveQueueStatus`). It is the
escalation if the three changes above do not measure well enough, not the opening move.

The ONE observable contract that must not change: a closed, merged plan still reports the same
`commitBoundary` values it reports today (`mergeCommit`, `branch`, `firstRunCommit`,
`lastRunCommit`, `closedAt`), and a plan that is open, unmerged or has no linked runs with git
context still reports the field as ABSENT — never null, never fabricated.

### §S2 The cost is pinned by a TIMED test

This is a performance defect, so the pin is a wall-clock measurement - a read-count proxy can pass
while the endpoint is still slow. Flakiness is controlled by the test's SHAPE, not by declining to
measure time:

- **In-process, idle store.** The fixture builds its own `Store` over `:memory:` and calls
  `listPlans` directly - no HTTP, no server process, no agent traffic - so the contention that
  produced this session's false readings cannot reach it.
- **A scaling assertion, which is the real subject.** The same plan count is timed against M events
  and against 10xM events; elapsed time must NOT scale with the event count. That is the property
  being fixed, and it holds regardless of how fast the host is.
- **An absolute ceiling set an order of magnitude above the expected figure**, so it fires on a
  genuine regression rather than on a loaded box.

The scan's return is what the test detects: restore the unbounded per-plan query and both the
scaling assertion and the ceiling go red.

### §S3 The fleet's 10s client GET timeout is stated, not incidental

`clients/python-crucible.py:175`'s `_get(path, timeout=10)` is a bare default that silently converts
a slow board into a `TimeoutError` traceback with no envelope — which is how every cycle transition
in this session failed. This CR does not change the timeout's VALUE (that would paper over §S1);
it makes the failure legible: a plans-GET timeout surfaces as the fleet's standard `ok:false`
envelope naming the condition, the way `PlansFetchFailed` already does for an unreachable board
(`clients/_crucible_axi.py:292-306`), rather than an unhandled stack trace.

## Acceptance criteria

**§S1**
- [ ] `listPlans` over a fixture of 50 closed-and-merged plans and 2000 context-bearing events
      completes within §S2's ceiling, and its elapsed time does not scale with the event count.
- [ ] A closed, merged plan's `commitBoundary` is byte-identical to today's value for the same
      fixture: `mergeCommit`, `branch`, `firstRunCommit`, `lastRunCommit`, `closedAt` all unchanged.
- [ ] An OPEN plan, a closed plan with no `merge`, and a closed merged plan whose linked runs carry
      no `context.git` each still report `commitBoundary` ABSENT — not null, not partially populated.
- [ ] A plan whose linked runs span several cycles still reports the EARLIEST `firstRunCommit` and
      the LATEST `lastRunCommit` across all its cycles, in timestamp order — the ordering the current
      `ORDER BY timestamp ASC, rowid ASC` scan provides, preserved by whatever replaces it.
- [ ] Events belonging to ANOTHER plan's cycles never contribute to this plan's boundary —
      regression pin on the `cycleIds` membership check the current implementation performs in JS.

**§S2**
- [ ] The timed pin runs in-process against a `:memory:` store with no server and no concurrent
      traffic - the conditions under which a wall-clock assertion is sound.
- [ ] Timing the same plan count against M and 10xM events shows no scaling with the event count.
- [ ] The pin fails if the whole-table per-plan scan is reintroduced - proven by mutation: restore
      the unbounded query and BOTH the scaling assertion and the absolute ceiling must go red.

**§S3**
- [ ] A plans GET that exceeds the client timeout emits the fleet's standard `ok:false` envelope
      naming the timeout as the condition, and exits non-zero — asserted for `cycle-activate` and
      `cycle-done`, the two verbs that failed this way in practice.
- [ ] No stack trace reaches stdout/stderr on that path.
- [ ] The timeout VALUE is unchanged (10s) — this section is about legibility, not tuning.

## Estimated size

M — one or two cycles. §S1 is a store-layer change to a derivation with a precisely pinned output
contract; §S2 is a counting harness; §S3 is a client-side envelope on an existing failure path.

## Risk

- **`commitBoundary`'s output contract is the whole risk.** It feeds the workflow lens's history
  rendering, so a subtly different boundary is a silently wrong UI rather than a test failure —
  which is why §S1 carries four separate output-equality ACs before any performance claim.
- **A timed assertion carries a flakiness risk** that §S2's shape is designed to absorb: in-process
  over `:memory:`, a scaling comparison rather than a bare number, and a ceiling set an order of
  magnitude above the expected figure. The project has already recorded one false latency alarm
  (2026-09-07) from measuring under contention, and this CR's own diagnosis was initially wrong for
  the same reason until A/B'd against an idle board - that is an argument for controlling the
  measurement, not for refusing to measure.

## Non-goals

- Changing the 5s poll interval, the per-project `retention` (2000 here), or any client polling
  behaviour — the poll is not the defect; the per-poll cost is.
- Changing the single-writer architecture (PRD §4.7) or introducing concurrency.
- Tuning the clients' 10s GET timeout value.
- `GET …/queue`'s own 2.45s cost, if it proves to have a separate cause — the 2026-09-07 note
  suspected per-row derivation in `listQueue`/`deriveQueueStatus`. Measure it after §S1 lands and
  file separately if it survives; this CR's measured subject is the plans path.
