# CR-CRU-175 — the queue verb shows each CR's place in the plan

**Type** fix · **Points** 2 (provisional, 2026-10-08; set at gap analysis) · **Wave** 7 (0.3.0) · **Depends on** none ·
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

## Acceptance criteria

- [ ] `queue` answers one TOON envelope per the AXI contract; by default its table is exactly
      today's six columns; `--fields release,seq,points,dependsOn` (and `--full`) add those columns
      after them on every row, uniform, primitive, null when absent — asserted per client against a
      recording board, and by decoding the output with the official TOON decoder (CR-CRU-046's
      round-trip); the release ceremony and the existing suites still read the default table.
- [ ] Rows come in `seq` order; with the place-in-plan columns asked for, a row placed before one of
      its dependencies names it in its `warning` cell and in one `warnings[]` entry — asserted on fixed
      fixtures, including the shape of the CR-CRU-171 sequencing incident (pending CRs sent above
      merged ones).
