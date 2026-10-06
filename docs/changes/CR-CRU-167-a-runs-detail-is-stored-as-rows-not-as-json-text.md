# CR-CRU-167 — a run's detail is stored as rows, not as JSON text

**Type** fix · **Points** 8 (provisional, 2026-10-06; set at gap analysis) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-158 ·
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

**Why the detail rides along.** The codecs decode every report into a typed run (suites, cases,
statuses, durations), but the store then writes that structure back out as JSON text: the whole
per-test tree in the `events.tree` column, and the run's raw output inside the `events.payload`
blob beside a milestone's `commit`/`crs`/dates. Only the counts are native columns. So any read of
a run's row carries its whole tree and raw output, `Store.toEvent` parses `payload` (raw with it)
for every row, and a single suite of a run can only be answered by parsing that run's whole tree.

The analytics recompute is **not** in scope: each of velocity, burndown and forecast computes in
under 1 ms; their read cost is `listPlans` (71 ms), which CR-CRU-169 makes cheap.

This CR changes how a run's detail is stored; CR-CRU-168 then stops the events list from carrying
it and lets a page read only what is new.

## Steps

### §S1 — a run's detail is stored as rows, not as JSON text

A schema migration (the next version) stores each test run's per-test detail natively, decoded once
at ingest:

- the tree's suites in a suites table and its leaves (scenarios, cases, steps, with status,
  duration, failure message and per-leaf raw output) in a cases table, keyed by run and suite and
  indexed for "the suites of run R" and "the leaves of suite S of run R" (and the browser axis where
  a run has one);
- the run-level raw output in its own column or table, outside `payload`.

No test result is stored as JSON: every suite and every test is a row with native columns, and a
failure's trace and the raw output are plain text. Each row keeps its position, so a run's suites
and each suite's tests read back in the order the codec decoded them. The store maps each row type
to the codecs' own types (`SuiteNode`, `TestLeaf`) on read and back on ingest; the codecs and the
wire are unchanged.

A BDD scenario's suites row also stores its feature, split once at ingest from the codec's
`<Feature> › <Scenario>` name, so a feature's scenarios are a query. The name on the wire is
unchanged.

A compile report is stored natively too: its `format`, `errorCount` and `warningCount` as columns,
each diagnostic (file, line, column, code, message, level, position) as a row of a diagnostics table,
and its raw output as plain text, in place of the `events.compile` JSON column. Every compile read
answers byte-identically to today's.

The migration moves every existing run's `tree` and `raw` into the new storage in place, behind the
store's existing pre-upgrade backup, and leaves `events.tree` and `payload.raw` empty for migrated
rows. Ingest writes only the new storage. `GET /api/v2/events/<id>` (full), `?depth=suites` and
`?suite=` answer byte-identically to today's from the new storage: `?depth=suites` from a SQL
aggregate over the suites, `?suite=` from an indexed read of one suite's leaves.

## Acceptance criteria

- [ ] After the migration, every run's full read, `?depth=suites` read and `?suite=` read of every
      suite answer byte-identically to before it, on a copy of the dev store, asserted on the server.
- [ ] `?suite=` on a 3000-test run reads only that suite's rows, and `?depth=suites` reads no leaf
      row, asserted on the rows read (not timing).
- [ ] After the migration, every compile event reads back byte-identically, and no compile report,
      suite or test is held in a JSON column, asserted on the server.
- [ ] The scenarios of one BDD feature of a run are read by a query on the feature column, asserted
      on the rows read.
- [ ] A run filed after the migration is stored in the new tables only, and reads back identically to
      the report it was decoded from, asserted on the server.
