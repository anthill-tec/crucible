# CR-CRU-109 — a wave row's dependency annotation fits the box it is drawn in

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 096, 102
- **Status**: PENDING (0.2.0) — filed 2026-09-06 on user direction, found by CR-CRU-093's RED phase when CR-CRU-096's live-board probe measured a real overflow
- **Design reference**: `/home/antonyj/Documents/data_projects/crucible/.lavish/crucible-workflow-flowchart.html` §14 (the wave box's ~300px budget, measured at 1600px) and §5 (the shape/colour grammar the row obeys)

> **This CR edits neither CR-CRU-096 nor CR-CRU-102.** Both are COMPLETED — 096 shipped
> 2026-09-03, 102 before it — and the standing rule (recorded 2026-09-03 from CR-CRU-099 cycle 322
> VERIFY, `docs/changes/README.md`) is that an AC may not require editing a shipped CR. It cites
> them as lineage: 096 set the budget and owns the probe that measures it, 102 owns how a single id
> is written.

## Problem

CR-CRU-096 AC20/AC4 measures the LIVE board's wave box against the design's ~300px budget. It
fails on genuine data:

```
the LIVE wave box carrying CR-CRU-075 measures 333px against the design's ~300px,
annotated "deps 014, 091, 092, 095"     → Expected: <= 300, Received: 333.0
```

The row reads `CR-CRU-075 pending next · deps 014, 091, 092, 095` — the widest content zone 2 has
drawn, and the first row to carry the `next` marker **and** a four-dependency list at once. Measured
on the running board: box **332.4px**, every child stretched to 310.6px.

Isolated by experiment: the pre-CR-CRU-085 tree fails identically at 333px against the same board,
so no shipped code caused it. The trigger was ordinary execution state — an orchestrator activating
a plan moved the `next` marker onto the row that declares four dependencies.

The overflow is unbounded, not a one-off: `entry.dependsOn` has no declared maximum, and
CR-CRU-102 already shrank each id as far as it goes (`014` is the bare form of `CR-CRU-014`), so
nothing is left to shorten per id. What is missing is a bound on **how many** ids the row states.

**The rejected alternative, recorded so it is not re-proposed:** widening 096's budget to fit
today's longest row. Refused by user ruling 2026-09-06 — one more declared dependency overflows any
new figure, so it postpones the defect instead of fixing it.

## Scope

### §S1 The annotation states at most three ids, then a remainder

**Surfaces (verified 2026-09-06):** the annotation is assembled in `RoadmapFlowNode`
(`public/app.js`) — `deps` filters `entry.dependsOn` for a `PENDING` row, the `next` marker is
pushed first when `marked === true`, each id is written by `L.bareDependencyId(entry.cr, dep)`
(CR-CRU-102 §S1), and the parts are joined with ` · ` into one
`[data-testid="roadmap-node-annotation"]` span.

The row states the first three declared ids in the authored order, then how many it did not state.
The remainder is a COUNT, never an ellipsis: a reader must be able to tell four dependencies from
seven without opening the table. Zone 3's `deps` column is unchanged and remains the surface that
states the whole set (CR-CRU-078 §S5).

### §S2 The budget is the reason, so the budget is what proves it

The cap exists to keep the wave box inside the design's ~300px at 1600×900 with the marker present.
That is CR-CRU-096 AC20/AC4's existing live-board probe, so this CR adds no geometry harness: it
makes that probe pass on the board's own data and pins the arithmetic with a fixture carrying the
worst case the wire allows.

Nothing else about the row moves: the `next` marker, the status mark, the lifecycle badge, the
click/drill behaviour, and `entry.dependsOn`'s full ids (CR-CRU-102 AC3 — the abbreviation is
display-only) all stay as they are.

## Acceptance criteria

- **AC1** — a `PENDING` row declaring **four or more** dependencies renders the first **three** bare
  ids in authored order followed by a remainder stating the count of the rest, in the form
  `deps 014, 091, 092 +1` — one span, still `[data-testid="roadmap-node-annotation"]`, still visible
  text with no `title` and no tooltip (CR-CRU-102 AC14).
- **AC2** — a row declaring **three or fewer** dependencies is UNCHANGED: `deps 014, 091, 092` with
  no remainder token. A `+0` is the defect this AC forbids.
- **AC3** — the remainder is a COUNT, not an ellipsis: a row with 7 declared dependencies states
  `+4` and a row with 5 states `+2`, so the two are distinguishable from the row alone.
- **AC4** — the `next` marker composes unchanged: a marked row with four dependencies reads
  `next · deps 014, 091, 092 +1` — marker first, one ` · ` between the parts.
- **AC5** — **the live board's wave box is inside the design's budget again.** CR-CRU-096 AC20/AC4's
  existing live-board probe passes with the board in the state that broke it: `CR-CRU-075` drawn,
  marked `next`, declaring four dependencies. Asserted by that probe, not by a new one.
- **AC6** — the cap is a DISPLAY rule only: `entry.dependsOn` still carries every full id, and every
  consumer that resolves one still reads them — `roadmapSelectOn` / `roadmapDrillIn`,
  `roadmapLateDeps`'s inversion check, and the order warning that names the offending pair. A test
  drives a 5-dependency row and asserts the drill-through and the inversion warning still see all
  five.
- **AC7** — zone 3's `deps` column is UNCHANGED and still states the WHOLE set for the same row, so
  a capped row has a place to be read in full. Asserted on the same fixture, both zones in one
  render.
- **AC8** — the three-id cap is a named constant, not a literal at the call site, and no test
  asserts the number by re-deriving it from a magic literal.

## Estimated size

XS — one bound in one annotation builder, its fixture, and the live-board probe it exists to satisfy.

## Risk

The cap changes what zone 2 says about a row, and zone 2 is the surface CR-CRU-096's artifact
comparison measures. The failure mode to avoid is a cap that reads as data loss — a row saying
`deps 014, 091, 092 …` states less than it knows without saying how much, which is why AC3 makes the
count load-bearing.

Second risk: three is a judgement, not a measurement. It is chosen because four ids plus the marker
overflowed (333px against 300px) and three ids plus the marker measures inside; if a later design
change re-measures the box, AC8's named constant is the single place that moves.

## Non-goals

- Widening CR-CRU-096's ~300px budget — refused by user ruling 2026-09-06; the budget is the design's.
- Editing CR-CRU-096 or CR-CRU-102 in any way — both are shipped.
- Changing `bareDependencyId` or how an individual id is abbreviated — CR-CRU-102, shipped.
- Zone 3's `deps` column, its grouping, or the table's width rules — CR-CRU-078.
- How dependencies are DECLARED (`cr-depends`) or stored — CR-CRU-106, shipped.
