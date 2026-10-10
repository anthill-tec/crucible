# CR-CRU-168 — a list read loads no run's detail

**Type** fix · **Points** 2 (gap analysis 2026-10-06; was 5 with a cursor, dropped) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-167 ·
**Status** PENDING — filed 2026-10-06

## Problem

Every read that answers with event briefs (`eventBrief`: summary counts, coverage percent, a compile
report's counts and first two diagnostics, the gate, context and run lifecycle — never a tree or raw
output) still builds each event in full first and throws the detail away:

- `GET /api/v2/events?project=…&limit=<retention>` (the workspace timeline, read on load, on every
  `events` frame, on the poll and after a mutation), through `Store.listEvents`;
- `GET /api/v2/events?project=…&cycleId=` (a cycle's runs), through `Store.listEventsForCycle`;
- `GET /api/v2/status`, through `Store.listEvents(project, Number.MAX_SAFE_INTEGER)`, to find two rows;
- `GET /api/v2/projects`, each card's last event, through `Store.newestEvent`.

**Measured 2026-10-06** on a file copy of the dev store (schema v17, 4275 events): the list read
takes **1522 ms** in `Store.listEvents`, of which reading every run's suites, cases and raw output
is about 1350 ms; the answer itself is about 1.6 MB of briefs. With the store skipping that detail
(`loadRunDetails` already has a switch for it), the same read takes **15 ms**, and `/status`'s
whole-history read 14 ms (the events table is capped by the project's retention).

## Steps

### §S1 — a read answered with briefs loads no run's detail

`Store.listEvents`, `Store.listEventsForCycle` and `Store.newestEvent`, and `GET /api/v2/status`,
read each run's summary columns, coverage and compile report (its counts and diagnostics) but no
suite, test case or run-level raw output. Every brief they answer with is byte-identical to today's.
The per-run reads (`GET /api/v2/events/<id>`, `?depth=suites`, `?suite=`) are unchanged.

## Acceptance criteria

- [x] The events list, a cycle's runs, `/status` and the projects list read no suites, cases or run
      raw-output row, asserted on the rows read (not timing).
- [x] Each of those answers is byte-identical to today's on a seeded store holding test runs with
      trees, raw output and coverage, compile reports with diagnostics, gates and milestones,
      asserted on the server.
- [x] On a copy of the dev store, a full events-list read (limit = the project's retention) answers
      in under 100 ms, measured the way CR-CRU-158's gap analysis measured its reads.
