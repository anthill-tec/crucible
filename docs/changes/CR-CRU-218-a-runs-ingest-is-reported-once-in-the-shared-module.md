# CR-CRU-218 — a run's ingest is reported once, in the shared module

**Type** refactor · **Points** 3 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-204 · **Status** PENDING — filed
2026-10-30 (split from CR-CRU-206 at its gap analysis, user ruling: the F2 hoist first, then one CR per client)

## Problem

CR-CRU-204 moved the bun and python clients onto the shared `ingest_reports` (`clients/_crucible_axi.py`),
and its VERIFY found what each client still writes for itself (F2): `_file_reports` calls the shared
ingest and then prints the human ingest line from the board's answer; `_filed_run` reads the answer's `run`
block; `_coverage_not_measured_warning` and `COVERAGE_NOT_MEASURED_CODE` build the `coverage-not-measured`
warning. Each is written twice, once per client, and the maven, rust and arduino moves (CR-CRU-206,
CR-CRU-219, CR-CRU-220) would write each three more times. The user ruled at CR-CRU-204's merge that they
move into the shared module, and at CR-CRU-206's gap analysis that the move is its own CR, ahead of the three.

## Design (user rulings 2026-10-29 and 2026-10-30)

- The shared module holds each of the four once; the bun and python clients keep no copy.
- The ingest line is printed by `ingest_reports` itself, on every path it returns by, so a client's
  `_file_reports` is one call of it, and the route census (`test_every_verb_that_runs_a_test_runner_is_classified.py`),
  which reads a call of `ingest_reports` as the shared site whichever function holds it, is unchanged.
- No behaviour changes but one: bun's ingest line gains the `files=` figure python's already prints.

## Steps

### §S1 — the shared module

- `ingest_reports` prints one line on stderr before it returns, on each of its paths — a refusal before
  sending (after the `[crucible] ERROR:` line it prints today), an answer from the board, a 413, an
  unreachable board:
  `ingest: ok=<ok> codec=<codec> passed=<p> failed=<f> pending=<n> total=<t> files=<files>`, followed,
  space-separated, by `lines=<pct>%` and `funcs=<pct>%` for each of those axes the answer's `run.coverage`
  carries, then by `error=<error>` when the answer carries an error. The figures are the answer's `run` block's, `None` when
  it has none.
- `filed_run(resp)` (PURE): the answer's `run` block, `{}` when the run was not filed — the body both
  clients' `_filed_run` hold today.
- `COVERAGE_NOT_MEASURED_CODE = "coverage-not-measured"` and `coverage_not_measured_warning(where)`, the
  body both clients' `_coverage_not_measured_warning` hold today.

### §S2 — the bun and python clients

- `_file_reports` in each client is one call of `_axi().ingest_reports(...)` returning its answer, with the
  arguments it passes today; it prints nothing itself.
- Every call of `_filed_run`, `_coverage_not_measured_warning` and `COVERAGE_NOT_MEASURED_CODE` in either
  client reads the shared one; the clients' own definitions are deleted.
- The provenance floor `PROSE_CITATIONS` pins for `clients` in `tests/project-namespace-tripwire.test.ts`
  moves with the deleted docstrings: one re-record, in its own commit at the close-out, if it moves.

## Acceptance criteria

- [ ] **AC1 — defined once.** `_crucible_axi.py` defines `filed_run`, `coverage_not_measured_warning` and
      `COVERAGE_NOT_MEASURED_CODE`; neither `bun-crucible.py` nor `python-crucible.py` defines `_filed_run`,
      `_coverage_not_measured_warning` or `COVERAGE_NOT_MEASURED_CODE`, and neither prints an `ingest:`
      line (a source scan asserts all three facts per client).
- [ ] **AC2 — `_file_reports` is one call.** In each of the two clients, `_file_reports`'s body is a single
      return of `_axi().ingest_reports(...)`; the route census's bun and python tables are unchanged and
      pass as they stand.
- [ ] **AC3 — one line on every path.** Driven through `ingest_reports` with stubbed transport, exactly one
      `ingest:` line reaches stderr for each of: a run the board filed with coverage (the line carries
      `files=` and `lines=`/`funcs=`), a run filed without coverage (no `lines=`), a refusal before sending
      (an unreadable health, an older board, a body over the limit — `ok=False`, `error=` naming it), a 413,
      and an unreachable board; the figures are the answer's.
- [ ] **AC4 — the clients' runs read as before.** A bun run and a python run, each through its client
      against a board it spawns, print one `ingest:` line each carrying `files=`, and their envelopes'
      `run:` blocks and `warnings[]` (a `--coverage` run that left no coverage report carries
      `coverage-not-measured`) are what they were before this CR.

## Non-goals

- The maven, rust and arduino clients (CR-CRU-206, CR-CRU-219, CR-CRU-220), which call these functions when
  they move onto the shared ingest.
- Any change to what `ingest_reports` sends, refuses or returns.
