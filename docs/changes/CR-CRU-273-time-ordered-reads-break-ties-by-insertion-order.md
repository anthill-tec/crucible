# CR-CRU-273: time-ordered reads break ties by insertion order

**Status:** PENDING. Filed 2026-11-22 from the test-cull survey (`test-reports/work/cull-survey-report.md` §6 item 1).
User ruling: filed after the cull, ahead of CR-CRU-267. Revised the same day by the gap analysis
(`test-reports/work/cr273-gap-analysis.md`) and the user's ruling on G1.
**Type:** bugfix
**Points:** 2
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** store
**Design reference:** `test-reports/work/cr273-gap-analysis.md`.

## Problem

Some store reads order rows by a millisecond timestamp alone. When two rows share a millisecond, their order is
whatever SQLite returns, and it can change from one read to the next. Rows written in one request, or by a fast
client, can share a millisecond. The affected reads in `src/store.ts`:

- `listProjects` orders by `created_at` alone;
- `listAgents` orders by `last_seen` alone, in both of its queries;
- `listOpenRuns` orders by `started_at` alone, in both of its queries;
- `sweepOpenRuns` orders by `started_at` alone.

`listCoverageDays` has a worse form of the same problem. It keeps each day's newest coverage run with
`RANK() … ORDER BY timestamp DESC`. Two runs in that day's newest millisecond both rank first, so the coverage feed
lists the day twice.

Every other time-ordered read already breaks ties by `rowid`.

## Behaviour

- **S1. Every time-ordered read has a tiebreak.** In each read listed above, rows with the same timestamp come back in
  insertion order (`rowid`), in the read's own direction. This follows the house pattern
  `ORDER BY <time> <dir>, rowid <dir>`.
- **S2. A coverage day is one run.** `listCoverageDays` returns exactly one run per day. When runs tie on the day's
  newest millisecond, it returns the one inserted last.

## Acceptance criteria

- **AC1.** For each read named in S1, a unit test writes two rows with the same timestamp and asserts they come back
  in insertion order, in the read's direction. For `sweepOpenRuns`, the order is that of the aborted-run events it
  returns. The tests run against an in-memory store.
- **AC2.** A unit test writes two coverage runs with the same timestamp on one day. `listCoverageDays` returns one
  entry for that day, the run inserted last.
- **AC3.** A `### Fixed` entry under `[Unreleased]` in `CHANGELOG.md`. It is reviewed, not tested.

## Non-goals

- **The burndown boundary.** A change journalled in the same millisecond as the release's start folds into the
  committed baseline, as `burndown` in `src/analytics.ts` documents. That is the designed rule, kept by user ruling
  (gap analysis G1). The burndown test writing its re-point a millisecond after the start is correct, and stays.
- Changing timestamp resolution.
- Any read whose order does not depend on time.
