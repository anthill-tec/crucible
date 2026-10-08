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

### §S1 — `queue` rows carry seq, release, points and dependencies

Every row of the `queue` verb (all five clients — it is the shared `cmd_queue`) gains `release`,
`seq`, `points` (null when unpointed) and `dependsOn` (the CR ids, `-`-free and comma-joined in the
table cell, empty when none), keeping the table uniform (every key on every row, null rather than
omitted). The existing six columns keep their names, order and meaning; the new ones follow them.

### §S2 — the order the queue already implies is visible

Rows are listed in the board's order (by `seq`), so reading the table top to bottom is reading the
plan; and a row whose dependency sits after it carries a `warning` column naming it (empty
otherwise), the same "before its dependency" fact the roadmap table shows.

## Acceptance criteria

- [ ] `queue` (each client) prints `release`, `seq`, `points` and `dependsOn` on every row after the
      six existing columns, uniform, null when absent — asserted per client against a recording
      board; every existing consumer of the verb's output (the release ceremony, tests) still reads
      it — asserted by the existing suites.
- [ ] Rows come in `seq` order, and a row placed before one of its dependencies names it in
      `warning` — asserted on fixed fixtures, including the shape of today's CR-CRU-171 incident
      (pending CRs sent above merged ones).
