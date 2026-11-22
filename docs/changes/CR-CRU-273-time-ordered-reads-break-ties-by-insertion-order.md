# CR-CRU-273: time-ordered reads break ties by insertion order

**Status:** PENDING. Filed 2026-11-22. It comes from the burndown flake fixed in CR-CRU-271's FIX 1003 and from the
test-cull survey (`test-reports/work/cull-survey-report.md` §6 item 1). User ruling: filed after the cull, ahead of
CR-CRU-267. The gap analysis follows this filing.
**Type:** bugfix
**Points:** 2
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** store, analytics
**Design reference:** `test-reports/work/cull-survey-report.md` §6 item 1; the CR-CRU-271 close-out (gate 1002).

## Problem

Several store reads order rows by a millisecond timestamp alone. When two rows share a millisecond, their order is
whatever SQLite returns. Rows written in one request, or by a fast client, can share a millisecond.

The burndown read showed this. A release member's `start` step and its re-point step landed in the same millisecond.
The re-point then came back first, and the series ended on the wrong step. CR-CRU-271's gate failed on it, and FIX 1003
worked around it in the test (`Date.now() + 1`), not in the product.

The survey lists the same pattern in `src/store.ts`, and the burndown merge has a tie of its own:

- `listProjects` orders by `created_at` alone;
- the agent reads order by `last_seen` alone, in two queries;
- `listOpenRuns` orders by `started_at` alone, in two queries;
- the open-runs read orders by `started_at` ascending;
- an inner subquery orders by `timestamp` descending;
- the burndown series merges its `start` and change steps by time alone.

## Behaviour

- **S1. Every time-ordered read has a tiebreak.** Rows with the same timestamp come back in insertion order (`rowid`,
  or the table's integer key), in the read's own direction.
- **S2. The burndown series keeps its steps in event order.** A member's `start` step comes before any change to that
  member made in the same millisecond.
- **S3. The FIX 1003 workaround goes.** The burndown test writes its re-point at the same `Date.now()` as the start
  step again, and passes.

## Acceptance criteria

- **AC1.** For each read listed in the Problem, a unit test writes two rows with the same timestamp and asserts they
  come back in insertion order, in the read's direction. This runs against an in-memory store.
- **AC2.** The burndown test in `tests/unit/analytics-reads-reflect-every-store-change.test.ts` uses the same
  timestamp for the re-point and the start step. Its last step is the re-point.
- **AC3.** A `### Fixed` entry under `[Unreleased]` in `CHANGELOG.md`. The entry is reviewed, not tested.

## Non-goals

- Changing timestamp resolution.
- Any read whose order does not depend on time.
