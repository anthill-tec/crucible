# CR-CRU-216 — the client reads a stored run back

**Type** feature · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-29
(user ruling 2026-10-29, from CR-CRU-204's merge sign-off: `runs` list and `run <id>` detail, sequenced after
CR-CRU-215)

## Problem

A client files a run and prints the board's answer, but no client verb reads a stored run back. CR-CRU-204's
AC12 asked that this repo's gate runs be shown stored with `codec: "junit"` and the counts the runners printed,
"read from the board at the merge sign-off" — and the orchestrator, who reads the board only through client
verbs, had no verb to do it with. The board already serves what is needed: `GET /api/v2/events?project=<key>`
with `cycleId=<id>` or `release=<label>` lists a cycle's or a release's runs as briefs (id, kind, tier, codec,
stack, counts, cycle, release, agent), and `GET /api/v2/events/<id>` returns one run, with `?depth=suites` for
its per-suite counts. The shared client module already reads one run internally (`_event_failing_tests`, for a
gate milestone's failing tests).

## Design (user ruling 2026-10-29)

- **Two read-only verbs**, in every client, implemented once in `clients/_crucible_axi.py` and wired the way
  `status`, `queue` and `history` are: `runs` lists a cycle's or a release's stored runs; `run <event-id>` shows
  one.
- **Client only.** The board's routes are read as they are; no server change.

## Steps

### §S1 — `runs`

`runs --cycle <id>` or `runs --release <label>` (exactly one; neither, or both, is refused before any request)
reads the board's list for the project and prints a TOON table, one row per stored run in the board's order:
`event`, `kind`, `tier`, `codec`, `stack`, `passed`, `failed`, `pending`, `total`, `agent`, plus `cycleId` or
`release`. A field the board does not carry for a run is empty, never invented. The list is cut and counted as
`queue` cuts its list (`totalCount` the true total; `--full` emits it whole), and `--fields` narrows the columns.
An unknown cycle or release is an empty table, `ok: true`.

### §S2 — `run <event-id>`

`run <event-id>` reads that run and prints its brief (`kind`, `tier`, `codec`, `stack`, the four counts,
`cycleId`, `release`, `agent`, its coverage line percent when stored), its per-suite counts (`suites` table:
`name`, `passed`, `failed`, `pending`) from `?depth=suites`, and its failing tests named `suite > test`. An id the
board does not hold is `ok: false`, the error naming the id, exit non-zero.

### §S3 — every client, one implementation

The five clients (`bun`, `python`, `mvn`, `rust`, `arduino`) register both verbs through one shared function in
`_crucible_axi.py`; each verb's help names what it reads. `_event_failing_tests` is the one reading of a run's
failing tests, used by both the gate milestone and `run`.

## Acceptance criteria

- [ ] **AC1 — `runs`.** Against a board holding runs in two cycles and one release, `runs --cycle <id>` lists
      exactly that cycle's runs and `runs --release <label>` exactly that release's, each row carrying the
      columns §S1 names with the board's values; an unknown cycle is an empty table, `ok: true`; neither flag,
      or both, is refused naming the two flags, with no request sent.
- [ ] **AC2 — the list is bounded.** Past the list limit the table is cut, `totalCount` states the true total,
      and `--full` prints every row; `--fields` narrows the columns.
- [ ] **AC3 — `run`.** For a stored failing run, `run <id>` prints its brief, its per-suite counts and its failing
      tests as §S2 states; for an id the board does not hold it is `ok: false`, names the id and exits non-zero.
- [ ] **AC4 — every client.** All five clients expose `runs` and `run`, registered through the one shared
      function; the fleet's verb-surface census lists both for each client.
- [ ] **AC5 — read only.** Neither verb sends anything but `GET` requests.
- [ ] **AC6 — through the real board.** One test files a run through a client against a board it spawns, then
      reads it back with `runs --cycle` and `run <id>`, and the values printed equal the stored ones.

## Non-goals

- Any server change; deleting or editing a stored run.
- Reading lifecycle or gate records as runs beyond what the board's list already returns.
