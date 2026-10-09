# CR-CRU-175 — the queue verb shows each CR's place in the plan

**Type** fix · **Points** 8 (re-scored 5 → 8 at gap analysis 2026-10-09, user ruling) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-173, CR-CRU-177 ·
**Status** PENDING — filed 2026-10-08 (user ruling: 0.3.0, after CR-CRU-173)

## Problem

**Observed 2026-10-08:** after a sequencing write (`wave-sequence`, `cr-plan`), the orchestrator must
check that every pending CR sits after the CRs it depends on and after the merged ones
(crucible-workflow `wave-sequence-sends-the-whole-wave`). The `queue` verb cannot answer that: its
rows carry six columns — `cr`, `wave`, `status`, `planId`, `title`, `lifecycle`
(`_crucible_axi.build_queue_rows`) — and no `seq`, no `points`, no dependencies and no release. So
the check was made by reading the board's HTTP API directly, which the orchestrator must never do
for state (user ruling 2026-10-08: board state only through client verbs; the API is for the code
agents build). The verb is the gap.

## Steps

### §S0 — it stays an AXI verb answering TOON

`queue` keeps the fleet's AXI contract (CR-CRU-030, CR-CRU-046): one TOON envelope on stdout
(`axi: verb, ok, …, help[], context, warnings[]`), the rows as a uniform TOON table (every row the
same key-set, primitive values only, null rather than an omitted key), a `count`, the stderr human
line, and the §S10 projection rules — the default columns stay the minimal set consumers already
read, `--fields a,b,c` ADDS columns to that set (never replaces it), and `--full` prints every column
and untruncated text. Nothing here is a new endpoint or a new format; the client reads the board
through its existing queue read.

### §S1 — the queue's place-in-plan columns, asked for by `--fields`

`queue` (all five clients — it is the shared `cmd_queue`) can add `release`, `seq`, `points` (null
when unpointed) and `dependsOn` to its rows through `--fields` (and `--full`); the default six
columns (`cr`, `wave`, `status`, `planId`, `title`, `lifecycle`) are unchanged in name, order and
meaning, so the release ceremony and every other consumer read the same table. `dependsOn` is a
single primitive cell, as a TOON table requires — the CR ids joined the way the fleet's other verbs
render a list in a table (settled at gap analysis), empty when none.

### §S2 — the order the queue implies is visible

Rows are listed in the board's order (by `seq`), so reading the table top to bottom is reading the
plan; with the place-in-plan columns asked for, a row placed before one of its dependencies carries
a `warning` cell naming it (empty otherwise), and the envelope's `warnings[]` carries one structured
`{code, detail}` per such row — the same "before its dependency" fact the roadmap table shows, on
both channels.

### §S3 — a client whose output pipe closes still closes its run

**Observed 2026-10-09 (CR-CRU-173 cycle 637's RED; added here by user ruling).** An agent ran
`bun-crucible.py test … --tests <file> | head -160`. When `head` had its lines it closed the pipe, the
client died on the broken pipe mid-run, and its run stayed OPEN on the board beside the agent's next,
live run — a double entry the user saw. CR-CRU-170 made every client close its run on a no-report,
signal or refused-ingest exit through the shared `abort_run`; a broken stdout/stderr pipe
(`BrokenPipeError` / `SIGPIPE`) is the exit it missed.

In all five clients, a run whose stdout or stderr pipe closes keeps running the suite to the end and
files it as usual (its output is not the run), or — if the client cannot continue — closes its run
through `abort_run` with a reason naming the closed pipe. Either way no run is left open by a closed
pipe, and the board never shows a run that nothing is driving.

### §S4 — an agent reads a project's history through its client (moved from CR-CRU-173 §S3, 2026-10-09)

**User ruling 2026-10-09.** No client verb exposed the history read, so an agent could not see a
project's releases, their states, waves, gate runs or verification — only the page could. Every
client gains a `history` verb over `GET /api/v2/projects/<key>/history`, following the fleet's AXI
contract (CR-CRU-030/046): one TOON envelope on stdout, a uniform primitive table, a `count`, the
stderr human line, `help[]`, `context`, `warnings[]`. Default columns: `release`, `state`,
`shippedAt`, `tag`, `crs` (completed count), `pending` (CR-CRU-177's `pendingCount`), `target`
(user ruling at gap analysis 2026-10-09: the pending count every History row shows); `--fields` ADDS `waves` (e.g. `8:3`, wave:count pairs
joined as the fleet's other verbs join a list cell), `gateRuns` (count), `lastGate` (outcome · stop
step), `verified` (run count), `packages`; `--full` prints every column untruncated. `--release
<label>` narrows to one release and lists its gate runs as the table (outcome, stopStep, fixRounds,
duration, pushedCommit, eventId, retired). A read verb: no `--agent` required.

## Acceptance criteria

- [ ] `queue` answers one TOON envelope per the AXI contract; by default its table is exactly
      today's six columns; `--fields release,seq,points,dependsOn` (and `--full`) add those columns
      after them on every row, uniform, primitive, null when absent — asserted per client against a
      recording board, and by decoding the output with the official TOON decoder (CR-CRU-046's
      round-trip); the release ceremony and the existing suites still read the default table.
- [ ] Rows come in the board's published order (wave, release, seq — `listQueue`'s order, never re-sorted); with the place-in-plan columns asked for, a row placed before one of
      its dependencies names it in its `warning` cell and in one `warnings[]` entry — asserted on fixed
      fixtures, including the shape of the CR-CRU-171 sequencing incident (pending CRs sent above
      merged ones).
- [ ] A client run whose stdout is closed early (e.g. piped to `head -1`) leaves no open run on the
      board: it either completes and files, or is closed through `abort_run` naming the closed pipe —
      asserted per client (bun, python, mvn, rust, arduino) against a recording board, for stdout and
      for stderr.
- [ ] **The `history` verb (§S4).** In each of the five clients (bun, python, mvn, rust, arduino —
      the shared implementation called from each, the caller count asserted), `history` answers one
      TOON envelope whose default table is exactly the seven columns above, uniform and primitive, in
      the read's order; `--fields` adds the listed columns; `--release <label>` lists that release's
      gate runs; an unknown project or release is a refusal with `help[]` — asserted against a
      recording board and by decoding with the official TOON decoder.

## Gap analysis (2026-10-09)

**Baseline:** develop `65fd2a1` = CR-CRU-178's gated tree (bun 3326/0, python 2341/0 at its gate; e2e
1180/0 at its VERIFY).

| # | Dim | Finding | Fix | Blocking |
|---|---|---|---|---|
| DRIFT-1 | 4 | The queue read (`GET …/queue`, `listQueue`) already publishes `seq`, `release`, `points` (from the declaration journal), `dependsOn` and `lifecycle` on every entry — §S1/§S2 are client-only | `build_queue_rows` widens; `queue` gains `--fields`/`--full` (no server change) | No |
| DRIFT-2 | 2 | §S2 said "seq order"; the board's ONE order is `listQueue`'s published order (wave, release, seq — CR-CRU-095 AC18: never re-derived) | rows in published order, never re-sorted | No |
| DRIFT-3 | 4 | "before its dependency" is computed only on the page (`lateDeps` in the roadmap table, app.js) | the client computes it from the same rule: a dependency that appears LATER in the published order; `warning` cell `before its dependency CR-…` + one `{code: "before-its-dependency", detail}` per row | No |
| DRIFT-4 | 1 | §S1 left the `dependsOn` cell format open; no list-in-cell convention exists in the client tables | space-separated ids (`CR-CRU-172 CR-CRU-164`), empty string when none — a primitive cell TOON need not quote | No |
| DRIFT-5 | 3 | §S3's death point: `run_streamed` echoes every runner line to `sys.stderr`; a closed pipe raises `BrokenPipeError` there, the `except BaseException` kills the runner and re-raises, the run stays open; the final envelope write to `sys.stdout` raises it again | the echo stops on `BrokenPipeError` (the log and the capture keep going, the run completes and files); the envelope/legacy writes swallow a closed pipe; a client that still cannot continue closes its run through `abort_run` naming the closed pipe | No |
| DRIFT-6 | 1 | §S4 predates CR-CRU-177's `pendingCount` and its withdrawn `planned` state | default columns gain `pending` (user ruling); no `planned` | No |
| DRIFT-7 | 7 | Cost: 2 + 2 + 3 ≈ 7 | 5 → 8 (user ruling); 0.3.0's committed total +3 | — |

**Consumed:** `build_queue_rows`, `cmd_queue`, `select_status_fields`-style projection, `truncate_field`
(`--full`), `emit`, `run_streamed`, `abort_run`, `GET …/history` (CR-CRU-173/177). **Per-client:**
each of the five clients registers its own `queue` parser (add `--fields`/`--full`) and needs a
`history` parser calling the shared `cmd_history` — the caller count is the AC's.

### Cycles

1. the queue verb shows each CR's place in the plan (§S0–§S2, AC1–AC2)
2. a client whose output pipe closes still closes its run (§S3, AC3)
3. an agent reads a project's history through its client (§S4, AC4)
4. verify
