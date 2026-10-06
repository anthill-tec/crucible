# CR-CRU-167 — a run's detail is stored as rows, not as JSON text

**Type** fix · **Points** 8 (gap analysis 2026-10-06) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-158 ·
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

- the tree's suites in a suites table — position, name, status, browser (where the run has one), and
  the suite's counts (total, passed, failed, pending) — and its leaves (scenarios, cases, steps) in a
  cases table — position, name, status, duration, and a failure's message, type and trace — keyed by
  run and suite and indexed for "the suites of run R" and "the leaves of suite S of run R" (with the
  browser axis);
- the run-level raw output in its own storage, outside `payload`.

No test result is stored as JSON: every suite and every test is a row with native columns, and a
failure's trace and the raw output are plain text. A failure's message, type and trace are each
optional (a stored failure may carry only its type). Each row keeps its position, so a run's suites
and each suite's tests read back in the order the codec decoded them; where a run holds two suites
with the same name and browser, `?suite=` answers the first, as today. The store maps each row type
to the codecs' own types (`SuiteNode`, `TestLeaf`) on read and back on ingest; the codecs are
unchanged.

A BDD scenario's suites row also stores its feature, split once at ingest from the codec's
`<Feature> › <Scenario>` name, so a feature's scenarios are a query. The name on the wire is
unchanged.

A compile report is stored natively too: its `format`, `errorCount` and `warningCount` as columns,
each diagnostic (file, line, column, code, message, level, position) as a row of a diagnostics table,
and its raw output as plain text, in place of the `events.compile` JSON column.

`POST /api/v2/runs/parsed` validates the tree it is given against `SuiteNode` and `TestLeaf`, as the
PRD's parsed path requires, and refuses with a 400 naming the first offending node a tree it cannot
store; it no longer accepts any array.

A run's detail rows go with the run on every path that removes it: retention eviction, a single
event's deletion, clearing a project's events and deleting a project.

### §S2 — a run's raw output is read only when asked for

`GET /api/v2/events/<id>` (the full read) still carries the run's raw output. `?depth=suites` and
`?suite=` no longer do; instead they carry `rawBytes`, the raw output's length in bytes, when the run
has raw output (the key is absent when it has none). Every other field of their answer is unchanged.
The run view shows the raw toggle when `rawBytes` is present (a run without raw output still shows
none), reads the raw output with the full read when the panel is first opened, and draws it as
today.

### §S3 — the migration

The migration moves every existing run's tree, raw output and compile report into the new storage
in place, behind the store's existing pre-upgrade backup, and leaves `events.tree`, `payload.raw` and
`events.compile` empty for migrated rows; it then compacts the store file (`VACUUM`), so the store does
not keep the freed space. Ingest writes only the new storage. `GET /api/v2/events/<id>`,
`?depth=suites` and `?suite=` answer from the new storage: `?depth=suites` from the suites rows
alone, `?suite=` from an indexed read of one suite's leaves.

## Acceptance criteria

- [ ] After the migration, on a copy of the dev store, every run's full read, `?depth=suites` read
      and `?suite=` read of every suite answers with the same JSON value as before it (key order
      aside), except that `?depth=suites` and `?suite=` carry no `raw`, asserted on the server.
- [ ] `?suite=` on a 3000-test run reads only that suite's rows, and `?depth=suites` reads no leaf
      row, asserted on the rows read (not timing).
- [ ] After the migration, every compile event reads back with the same JSON value, and no compile
      report, suite or test is held in a JSON column, asserted on the server.
- [ ] The scenarios of one BDD feature of a run are read by a query on the feature column, asserted
      on the rows read.
- [ ] A run filed after the migration is stored in the new tables only, and reads back with the same
      JSON value as the report it was decoded from; a parsed tree with a node that is not a
      `SuiteNode`/`TestLeaf` is refused with a 400 and nothing is stored, asserted on the server.
- [ ] Evicting, deleting or clearing a run, or deleting its project, leaves none of its detail rows,
      asserted on the server.
- [ ] `?depth=suites` and `?suite=` carry `rawBytes` equal to the raw output's length for a run with
      raw output, and no `rawBytes` for a run without, asserted on the server.
- [ ] The run view of a run with raw output shows the raw toggle and draws its raw panel when opened,
      and loading its suites fetches no raw output; a run without raw output shows no toggle,
      asserted in a real browser on the requests made.
- [ ] The migration of a copy of the dev store completes, and the store file afterwards is no larger
      than 1.25 × its size before, asserted on the copy.
