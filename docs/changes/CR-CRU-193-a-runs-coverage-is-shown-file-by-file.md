# CR-CRU-193 — a run's coverage is shown file by file

**Type** feature · **Points** 8 (provisional, set at filing 2026-10-16; the estimate is revisited
at gap analysis) · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-152 · **Status** PENDING — filed 2026-10-16
(Model B request, user ruling: its own CR in 0.4.0; design is settled with the user before its gap
analysis)

## Problem

Raised by Model B (2026-10-15). The python client's `_collect_coverage` sums the lcov report's
`LF`/`LH`/`FNF`/`FNH` counts into one total, and the board stores and shows only that overall line
and function percentage. A project cannot see which of its files are uncovered. It has to run
coverage.py's own report by hand, outside the board.

## Intent

A test run's ingested coverage carries a per-file breakdown (each file's lines found and hit, and
functions found and hit) alongside the totals it carries today. The board keeps it with the run and
shows it, so a project sees which files are uncovered.

## Open design questions (settled with the user before gap analysis)

- **Which stacks:** the python client only (Model B's ask), or every stack whose coverage is lcov
  (bun, rust, python) plus mvn's JaCoCo.
- **Where it is decoded:** *settled 2026-10-27 (user ruling):* on the server, in CR-CRU-152's `lcov` and
  `jacoco` coverage codecs; this CR follows CR-CRU-152.
- **Where the board shows it:** the Coverage tab, a run's detail, or both. It needs a storyboard
  frame before RED.
- **Store and payload:** the schema change and the shape of the coverage object in the ingest,
  kept additive so older clients' totals-only coverage is still accepted.

## Steps

Written at design, once the questions above are answered.

## Acceptance criteria

Written at design.
