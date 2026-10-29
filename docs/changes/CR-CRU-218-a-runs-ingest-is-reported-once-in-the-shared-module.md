# CR-CRU-218 — a run's ingest is reported once, in the shared module

**Type** refactor · **Points** 3 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-204 · **Status** PENDING — filed
2026-10-30 (split from CR-CRU-206 at its gap analysis, user ruling: the F2 hoist first, then one CR per client);
spec pre-review 2026-10-30 (CR-CRU-218-SPEC-REVIEW, F1–F11 folded; user ruling on F10: the line is printed
inside `ingest_reports`)

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
- The ingest line is printed by `ingest_reports` itself, on every path it returns by (user ruling, over a
  shared print function each client would call after it), so a client's `_file_reports` is one call of it,
  and the route census (`test_every_verb_that_runs_a_test_runner_is_classified.py`), which reads a call of
  `ingest_reports` as the shared site whichever function holds it, is unchanged.
- The line's label is `ingest:` for every client that reaches the shared ingest. CR-CRU-206 and CR-CRU-219
  re-aim their clients' `ingest junit:` / `ingest parsed:` test pins when they move onto it.
- No behaviour changes but one: bun's ingest line gains the `files=` figure python's already prints.

## Steps

### §S1 — the shared module

The new code sits beside `ingest_reports`, after the citations the tripwire's prose names into
`_crucible_axi.py`.

- `ingest_reports` prints one line on stderr as the last line it prints before it returns, on each of its
  paths:
  `ingest: ok=<ok> codec=<codec> passed=<p> failed=<f> pending=<n> total=<t> files=<files>`, followed,
  space-separated, by `lines=<pct>%` and `funcs=<pct>%` for each of those axes the answer's `run.coverage`
  carries, then by `error=<error>` when the answer carries an error. The figures are the answer's `run`
  block's, `None` when it has none. On a refusal before sending, the line follows the `[crucible] ERROR:`
  line it prints today and, with a run open, the line the abort prints. Its docstring says it prints the line.
- `filed_run(resp)` (PURE): the answer's `run` block, `{}` when the run was not filed — the body both
  clients' `_filed_run` hold today.
- `COVERAGE_NOT_MEASURED_CODE = "coverage-not-measured"` and `coverage_not_measured_warning(where)`, the
  body both clients' `_coverage_not_measured_warning` hold today.

### §S2 — the bun and python clients

- `_file_reports` in each client has one statement besides its docstring: `return
  _axi().ingest_reports(...)`, with the arguments it passes today. Its docstring no longer says it prints.
- Every call of `_filed_run` and `_coverage_not_measured_warning` reads the shared one: in bun
  `cmd_regression` and `_emit_ingest_axi`; in python `_emit_ingest_axi` and `_regression_run`. The clients'
  own `_filed_run`, `_coverage_not_measured_warning` and `COVERAGE_NOT_MEASURED_CODE` are deleted.
- Prose naming the moved behaviour follows: `docs/research/DN-crucible-api-reconstruction.md` (which says
  bun's `_file_reports` prints the error) and the comment in `tests/clients-bun-crucible.test.ts` that names
  `_file_reports` as the line's printer.

## Acceptance criteria

- [ ] **AC1 — defined once.** `_crucible_axi.py` defines `filed_run`, `coverage_not_measured_warning` and
      `COVERAGE_NOT_MEASURED_CODE`. In each of `bun-crucible.py` and `python-crucible.py` a source scan
      asserts: no definition of `_filed_run`, `_coverage_not_measured_warning` or
      `COVERAGE_NOT_MEASURED_CODE`; no string literal (a `Constant`, or a `JoinedStr`'s first part) that
      begins with `ingest:` and a space; and bun's `cmd_regression` and `_emit_ingest_axi`, and python's `_emit_ingest_axi`
      and `_regression_run`, each call `_axi().filed_run` or `_axi().coverage_not_measured_warning` where
      they called the client's own.
- [ ] **AC2 — `_file_reports` is one call.** In each of the two clients, `_file_reports`'s only statement
      besides an optional docstring is `return _axi().ingest_reports(...)`; the route census's bun and
      python tables are unchanged and pass as they stand.
- [ ] **AC3 — one line on every path.** Driven through `ingest_reports` with stubbed transport, exactly one
      `ingest:` line reaches stderr, and it is the last line `ingest_reports` prints, for each of:
      a run the board filed with coverage (the line carries `files=` and `lines=`/`funcs=`, the answer's);
      a run filed without coverage (no `lines=`);
      each refusal before sending — an unreadable health, an older board, a report or coverage file it
      cannot read, a body over the limit — `ok=False` and `error=` naming the cause, the line following the
      `[crucible] ERROR:` line, and, for one of them driven with a `run_id`, following the abort's line too;
      a 413 (`error=` naming `ingest_body_bytes`);
      and a board that answers health but cannot be reached at the POST (`ok=False`, `error=` the
      transport's).
- [ ] **AC4 — the clients' runs read as before.** `tests.client.test_bun_client_sends_its_runners_reports`
      and `tests.client.test_python_client_sends_its_runners_reports` pass with no existing assertion
      edited, and each gains one assertion that its client's `ingest:` line carries `files=<n>`, the
      figure of the answer it scripted.
- [ ] **AC5 — the citation floor (close-out).** `PROSE_CITATIONS.clients.head` in
      `tests/project-namespace-tripwire.test.ts` is re-measured at the close-out and, if the CR literals this
      CR adds under `clients/` moved it (the deleted bodies carry none), re-recorded once, in its own commit.

## Non-goals

- The maven, rust and arduino clients (CR-CRU-206, CR-CRU-219, CR-CRU-220), which call these functions when
  they move onto the shared ingest.
- Any change to what `ingest_reports` sends, refuses or returns.
- The `.pi/agents/python-*-agent.md` example ingest line (`ingest junit: ok=…`), drift older than this CR.
