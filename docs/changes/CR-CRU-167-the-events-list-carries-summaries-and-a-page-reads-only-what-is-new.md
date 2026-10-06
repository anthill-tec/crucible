# CR-CRU-167 — the events list carries summaries, and a page reads only what is new

**Type** fix · **Points** set at gap analysis · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-158 ·
**Status** PENDING — filed 2026-10-06

## Problem

CR-CRU-158 stopped the board's own pages from asking for the events list on every stream frame. The
list itself is still the board's most expensive read, and every page load, reconnect, poll and
`events` frame still pays for it in full.

**Profiled 2026-10-06** (in process, on a file copy of the dev store; this project's retention
5000):

| `GET /api/v2/events?project=…&limit=<retention>` | |
|---|---|
| Rows returned | 4209 |
| Response size | **439 MB** |
| of which each test run's `tree` | 263 MB |
| of which each test run's `raw` output | 175 MB (one run alone: 100 MB) |
| SQL (`.all()` over the three tables) | 251 ms |
| Rows decoded into events (`Store.toEvent`) | 722 ms |
| Serialising the response | 1325 ms |

So the cost is not SQLite and not the row count: 99.6 % of the payload is per-test detail that the
list's readers do not draw. The run view already reads that detail per run, through
`GET /api/v2/events/<id>?depth=suites` and `?suite=`.

`GET /api/v2/status` (`handleStatus`) reads the project's whole event history, `store.listEvents(project, Number.MAX_SAFE_INTEGER)`, to find two rows.

The analytics recompute is **not** in scope: each of velocity, burndown and forecast computes in
under 1 ms; their read cost is `listPlans` (71 ms), which CR-CRU-158's analytics cache already holds.

## Steps

### §S1 — the list carries summaries

`GET /api/v2/events` (the recent-N feed, with or without `project`) answers each event without its
`tree` and `raw`, and without any other field that only the run view draws. Every other field is
unchanged on the wire. The per-run reads (`GET /api/v2/events/<id>`, `?depth=suites`, `?suite=`) and
the anchored cycle fetch (`?cycleId=`) are unchanged. The store reads only the columns the list
answers with; it never decodes `tree` or `raw` for the list.

### §S2 — a page reads only what is new

`GET /api/v2/events` accepts a cursor: the newest event the caller already holds. With it, the answer
is only the events newer than that one (in the list's newest-first order), plus `openRuns` as today.
A cursor the server no longer knows (evicted by retention, or from another project) is answered with
the full list and says so, so the caller can replace rather than merge. The page:

- reads the full list on load and on a reconnect after an error;
- on an `events` frame, the poll and a mutation, reads with its newest event as the cursor and merges
  the answer into what it holds, newest first, trimmed to the project's retention;
- removes from what it holds any event the server has retired, so a retired gate leaves the
  timeline as it does today.

### §S3 — no whole-history read for two rows

`GET /api/v2/status` derives the project's last test run and last compile run with bounded queries, never the project's whole history. Its payload is byte-identical to today's.

## Acceptance criteria

- [ ] On a store holding a run whose `raw` is at least 10 MB, the project's events list answers in
      under 100 KB per 100 events, carries no `tree` or `raw`, and every other field of every event
      equals today's, asserted on the server.
- [ ] The run view of such a run still draws its suites, scenarios and raw output, asserted in a real
      browser.
- [ ] A read with a known cursor returns exactly the events newer than it; a read with an unknown
      cursor returns the full list and marks it as such, asserted on the server.
- [ ] After load, an `events` frame makes the page read the events list with its newest event as the
      cursor, and the timeline then equals a fresh full load's, asserted on the requests made and the
      rendered timeline.
- [ ] `GET /api/v2/status` reads a constant number of rows however many events the
      project holds, and its payload is byte-identical to today's, asserted on the server.
- [ ] Replaying CR-CRU-158's AC1 measurement, a full events-list read on the dev store's copy takes
      under 100 ms.
