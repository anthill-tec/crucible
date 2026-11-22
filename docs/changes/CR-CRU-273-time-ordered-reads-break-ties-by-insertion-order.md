# CR-CRU-273: time-ordered reads break ties by insertion order

**Status:** COMPLETED (2026-11-22). Filed 2026-11-22 from the test-cull survey (`test-reports/work/cull-survey-report.md` §6 item 1),
with the user's ruling that it comes after the cull and ahead of CR-CRU-267. Revised the same day, first by the gap
analysis (`test-reports/work/cr273-gap-analysis.md`) and the user's ruling on G1, then by the spec pre-review
(`test-reports/work/prereview273-report.md`).
**Type:** bugfix
**Points:** 2
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** store
**Design reference:** `test-reports/work/cr273-gap-analysis.md`, `test-reports/work/prereview273-report.md`.

## Problem

Six store queries in `src/store.ts` order rows by a millisecond timestamp alone:

| Read | Query | Order |
|---|---|---|
| `listProjects` | 1 | `created_at ASC` |
| `listAgents` | 2: all projects, and one project | `last_seen DESC` |
| `listOpenRuns` | 2: all projects, and one project | `started_at DESC` |
| `sweepOpenRuns` | 1 | `started_at ASC` |

When rows share a millisecond, their order depends on the query plan, not on the data.

`listAgents` gets this wrong today. Tied agents come back oldest-registered first across all projects, and in
agent-id order within one project, although the read lists every other agent newest first.

The other reads return insertion order today only because of the index or scan they happen to use. Nothing
guarantees it.

Every other time-ordered read already breaks ties by `rowid` or by a monotonic id (`id`, `seq`, `plan_id`).

## Behaviour

- **S1. Every time-ordered read has a tiebreak.** Each of the six queries ends `ORDER BY <time> <dir>, rowid <dir>`,
  the house pattern. Rows with the same timestamp come back in insertion order, in the read's own direction.
- **S2. Insertion order for agents.** An agent's insertion order is the order its row was created. That is its first
  registration, or its latest one after an unregister or a prune. A heartbeat or an ingest updates `last_seen` but
  does not change this order.
- **S3. What the user sees.** The agent list is the one read whose tie order changes visibly: agents seen in the same
  millisecond now list newest-registered first. The other reads already return this order, and S1 makes it a
  guarantee.
- **S4. The order survives a compaction.** The migration `VACUUM` may renumber rowids, but it copies rows in rowid
  order, so their relative order holds. The existing reads that use the pattern rely on this too.

## Acceptance criteria

All tests run on `new Store(":memory:")`, pin time with `setSystemTime`, and write rows only through the store's own
methods. In each test the rows' keys sort the opposite way to the asserted order, so the result cannot come from key
order.

- **AC1.** `listAgents`, both queries: two agents touched in the same millisecond come back newest-registered first.
  Both tests fail before the change.
- **AC2.** `listProjects` and both `listOpenRuns` queries: two rows written in the same millisecond come back in
  insertion order, in the read's direction. These tests guard the order and pass before and after the change; the
  RED phase records that.
- **AC3.** `sweepOpenRuns`: two open runs started in the same millisecond are aborted in the order they started.
  `listEvents` lists the later-started run's aborted event first. This test is a guard, as in AC2.
- **AC4.** A `### Fixed` entry under `[Unreleased]` in `CHANGELOG.md` for the agent list order. It is reviewed, not
  tested.

## Non-goals

- **The burndown boundary.** `burndown` in `src/analytics.ts` folds a change journalled at or before the release's
  start instant (its earliest `filed_at`) into the committed baseline. That is the designed rule, kept by user ruling
  (gap analysis G1). The burndown test in `tests/unit/analytics-reads-reflect-every-store-change.test.ts` writes its
  re-point at least a millisecond after the start. That is correct, and it stays.
- **`listCoverageDays`.** It already returns one run per UTC day, the run inserted last. Its `RANK()` window can keep
  tied rows, but the `newestFirst` sort and the per-day filter after it discard them (pre-review B1).
- **Sorts done in JavaScript in `src/v2.ts`.** For example, `historyGateRuns` sorts by `at` only, so tied gate runs
  list oldest first. This is noted for a later CR.
- Changing timestamp resolution.

## Close-out

Closed on 2026-11-22. Board plan 271: cycle 1007 (RED+GREEN) and cycle 1008 (VERIFY).

- **RED, `73a83bae`.** `tests/unit/time-ordered-reads-break-ties-by-insertion-order.test.ts` holds 7 unit tests:
  - AC1's three `listAgents` tests failed on order alone;
  - the four AC2 and AC3 guards passed, as the spec states.
- **GREEN, `400a2adf`.** The six queries gained `rowid` in their own direction, and the CHANGELOG gained a `### Fixed`
  entry. The unit tier passed 2694/0.
- **VERIFY, READY.** No blockers and nothing graded should-fix.
  - Sug1, the CHANGELOG wording, was applied in `65c6d2bf`.
  - Sug2 was noted: a test for the re-registration clause of S2. The behaviour is a delete followed by a fresh row.
- **Pre-merge gate, cycle 1008.** 13,281 passed, 0 failed, in 1,814.6 s.
- **Left for later.** The JavaScript sort `historyGateRuns` in `src/v2.ts` is a non-goal here and goes to a later CR.
