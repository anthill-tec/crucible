# CR-CRU-216 — the client reads a stored run back

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-29
(user ruling 2026-10-29, from CR-CRU-204's merge sign-off: `runs` list and `run <id>` detail, sequenced after
CR-CRU-215); gap analysis and spec pre-review 2026-10-30 (re-scored 5 → 8)

## Problem

A client files a run and prints the board's answer, but no client verb reads a stored run back. CR-CRU-204's
AC12 asked that this repo's gate runs be shown stored with `codec: "junit"` and the counts the runners printed,
"read from the board at the merge sign-off" — and the orchestrator, who reads the board only through client
verbs, had no verb to do it with. The board already serves what is needed: `GET /api/v2/events?project=<key>`
with `cycleId=<id>` or `release=<label>` lists a cycle's or a release's records as briefs (`id`, `kind`,
`tier`, `codec`, `stack`, `passed`/`failed`/`pending`/`total`, compile `errors`/`warnings`, `cycleId`,
`release`, `agentId`), and `GET /api/v2/events/<id>` returns one record, with `?depth=suites` for a run's
per-suite counts. The shared client module already reads one run's failing tests (`_event_failing_tests`, for a
gate milestone).

## Design (user rulings 2026-10-29 and 2026-10-30)

- **Two read-only verbs**, in every client, implemented once in `clients/_crucible_axi.py`: `runs` lists a
  cycle's or a release's stored runs; `run <event-id>` shows one. Neither takes `--agent`.
- **A run is a test or compile record.** The board's cycle list also carries the cycle's gate milestones and
  gate records (lifecycle events carry no cycle and never appear); `runs` lists the `test` and `compile` records
  only. `history --release` already shows a release's gate runs.
- **Each kind reads honestly.** The board stores no counts on a compile record — its brief's
  `passed`/`failed`/`pending`/`total` are 0 and its numbers are `errors` and `warnings` — so a compile row
  carries `errors` and `warnings` and empty test counts, and a test row the reverse (PRD §4.6: a compile failure
  never reads as test counts).
- **A client reads its own project's runs.** `run` refuses a record whose `projectKey` is not the client's.
- **Client only.** The board's routes are read as they are; no server change.

## Steps

### §S1 — `runs`

`runs --cycle <id>` (an integer) or `runs --release <label>` — exactly one — reads the board's list for the
client's project and prints a TOON table of its `test` and `compile` records, one row per run in the board's
order (newest first). Every row carries every column, empty where the board has no value, never invented, so
the table stays uniform: `event` (from `id`), `kind`, `tier`, `codec`, `stack`, `passed`, `failed`, `pending`,
`total` (test rows), `errors`, `warnings` (compile rows), `agent` (from `agentId`), `cycleId`, `release`.

The table is cut as the roadmap verbs (`wave-sequence`, `cr-plan`) cut theirs — `truncate_rows` at the client's
`roadmap_list_rows` limit, `totalCount` the true number of runs, `--full` prints every row — and `--fields`
narrows to the named columns. An unknown cycle or release is an empty table, `ok: true`, whose `help` names the
project key it asked about.

Neither flag, both, or a non-integer `--cycle` is refused by the verb itself, before any request: an `ok: false`
envelope naming the two flags, exit 2 (the `next` / `cr-depends` usage-refusal precedent), never argparse's bare
usage exit.

### §S2 — `run <event-id>`

`run <event-id>` reads that record and prints:

- for a **test** run: its brief (`kind`, `tier`, `codec`, `stack`, the four counts, `cycleId`, `release`,
  `agent`, its coverage lines percent when stored); its per-suite counts from `?depth=suites` (a `suites` table:
  `name`, `browser`, `passed`, `failed`, `pending`); and its failing tests named `suite > test` through
  `_event_failing_tests`;
- for a **compile** run: its brief with `errors` and `warnings`, and its diagnostics (a table: `level`, `file`,
  `line`, `code`, `message`), cut and counted as §S1 cuts its list.

It refuses, `ok: false`, exit 1: an id the board does not hold (naming the id); a record whose `kind` is not
`test` or `compile` (naming the kind); a record whose `projectKey` is not the client's (naming both keys). A
read that fails after the first succeeded — the suites read or the failing-tests read — is `ok: false` too, never
a run printed with an empty failing list.

The failing-tests read is the full record, raw output included; that raw output is bounded by the board's
`raw_output_chars` limit (recommended 2,000,000 characters, at most 50,000,000 when an operator raises it). The
second read is kept because the stored per-suite counts come only from `?depth=suites` and the leaves only from
the full record.

### §S3 — every client, one implementation

The five clients (`bun`, `python`, `mvn`, `rust`, `arduino`) register both verbs through one shared registrar in
`_crucible_axi.py` taking a verb → delegator `funcs` mapping, the shape `add_roadmap_verbs` has, with each
client's read-verb `add_args` (its project-dir argument, as it passes to `add_next_verb`). Each client defines
`cmd_runs` and `cmd_run` delegating to the shared bodies and builds no `add_parser("runs")` or
`add_parser("run")` of its own. Every new flag carries its own help text. `_event_failing_tests` stays the one
reading of a run's failing tests, used by both the gate milestone and `run`.

The censuses that enumerate the fleet's verbs take the new verbs in: `runs` and `run` are classified as
read-only, not ingesting, for all five clients in `tests/client/test_every_verb_that_runs_a_test_runner_is_classified.py`;
`tests/client/test_cr054_fleet_inventory.py` gains their section; `tests/client/test_cr128_flag_help_census.py`
and the printed-help walks cover their flags.

## Acceptance criteria

- [ ] **AC1 — `runs`.** Against a board holding test and compile runs in two cycles and one release, plus a gate
      milestone and a gate record in the first cycle, `runs --cycle <id>` lists exactly that cycle's test and
      compile runs and `runs --release <label>` exactly that release's, every row carrying every column §S1 names
      with the board's values — a compile row its `errors` and `warnings` and empty test counts, a test row the
      reverse — and no milestone or gate row; an unknown cycle is an empty table, `ok: true`, naming the project
      key in its `help`.
- [ ] **AC2 — the list is bounded.** Past the `roadmap_list_rows` limit the table is cut, `totalCount` states the
      true number of runs, and `--full` prints every row; `--fields` narrows the columns.
- [ ] **AC3 — `run`.** For a stored failing test run, `run <id>` prints its brief, its per-suite counts (with
      `browser`) and its failing tests; for a failing compile run, its brief with `errors` and `warnings` and its
      diagnostics. It refuses, `ok: false`, exit 1: an id the board does not hold, naming it; a gate or milestone
      id, naming the kind; another project's run, naming both keys; and a failing-tests read that fails after
      the suites read succeeded.
- [ ] **AC4 — usage and the board's absence.** Neither flag, both, or a non-integer `--cycle` is an `ok: false`
      envelope naming the flags, exit 2, with no request sent. Driven as `runs --cycle 1` and `run <id>` against
      a board that is not reachable, each prints one `ok: false` envelope naming the board, exits 1 and prints no
      traceback.
- [ ] **AC5 — every client, one registrar.** All five clients expose `runs` and `run` through the one shared
      registrar, each with its own `cmd_runs` and `cmd_run` and no `add_parser` of its own for either; the fleet
      envelope census reads both verbs as enveloped in every client, and the runner census classifies both as
      read-only.
- [ ] **AC6 — read only.** Neither verb sends anything but `GET` requests.
- [ ] **AC7 — through the real board.** One test files a test run through the python client against a board it
      spawns, then reads it back with `runs --cycle` and `run <id>` through that client, and the values printed
      equal the stored ones.

## Non-goals

- Any server change; deleting or editing a stored run.
- Listing gate milestones, gate records or lifecycle events (`history --release` shows a release's gates).
- Reading another project's runs.
