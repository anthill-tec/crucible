# CR-CRU-109 — a wave row's dependency annotation fits the box it is drawn in

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 096, 102
- **Status**: COMPLETED (0.2.0) — shipped 2026-09-07, filed 2026-09-06 on user direction, found by CR-CRU-093's RED phase when CR-CRU-096's live-board probe measured a real overflow — gap-analysed 2026-09-07: the cap is TWO ids, not three (three measures 321px against the 300px budget); §S1 records the supersession of CR-CRU-102 AC1's four-id example AND — user ruling 2026-09-07, "cap wins" — of CR-CRU-096 §S4/AC13's completeness claim for zone 2, whose two ACs (AC13 completeness, AC20/AC4 budget) were in latent conflict from the day both shipped. Shipped constant `DEPENDENCY_ANNOTATION_CAP = 2` (`public/app-logic.mjs`); the live board's wave box now measures **293.1px** against `BUDGET.wave = 300`, re-measured by VERIFY and again by FIX. Cycle 357's FIX also re-measured the suite's three narration boards post-cap (240.0 / 279.9 / 520.0px — each exactly 39.9px narrower, §S1's own delta arriving independently) and replaced two tautologous assertion groups with a `SHUFFLED_QUEUE` board that discriminates authored order from sorted.
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

### §S1 The annotation states at most two ids, then a remainder

**Surfaces (verified 2026-09-06):** the annotation is assembled in `RoadmapFlowNode`
(`public/app.js`) — `deps` filters `entry.dependsOn` for a `PENDING` row, the `next` marker is
pushed first when `marked === true`, each id is written by `L.bareDependencyId(entry.cr, dep)`
(CR-CRU-102 §S1), and the parts are joined with ` · ` into one
`[data-testid="roadmap-node-annotation"]` span.

The row states the first **two** declared ids in the authored order, then how many it did not
state. The remainder is a COUNT, never an ellipsis: a reader must be able to tell four dependencies
from seven without opening the table. Zone 3's `deps` column is unchanged and remains the surface
that states the whole set (CR-CRU-078 §S5).

**Two, not three — measured on the live board 2026-09-07 (user ruling).** The first draft of this
CR capped at three. Injecting each candidate into the running board's own DOM and reading the wave
box's width settles it: dropping one id saves ~11px while the `+N` token costs ~2, so

| annotation on the CR-CRU-075 row | wave box | vs the ~300px budget |
|---|---|---|
| `next · deps 014, 091, 092, 095` (today) | 332.4px | over |
| `next · deps 014, 091, 092 +1` (cap 3) | 321.0px | **still over** |
| `next · deps 014, 091 +2` (cap 2) | **292.5px** | inside, ~7.5px headroom |
| `next · deps 014 +3` | 264.1px | inside (the floor other rows set) |

A three-id cap would have shipped this CR without fixing the failure it exists to fix. Two is also
what the approved artifact draws (`deps 091, 092`), so the cap agrees with the design rather than
merely fitting the budget.

**This supersedes CR-CRU-102 AC1's four-id EXAMPLE — user-confirmed 2026-09-07.** That AC states
"a multi-dependency row renders `deps 014, 091, 092, 095`", and
`tests/roadmap-bare-dependency-annotation.test.ts` asserts the string byte-exact. CR-CRU-102 is
SHIPPED, so its spec is not edited (the standing rule from CR-CRU-099 cycle 322); this CR records
the supersession here, in its own scope section, and its RED updates that assertion to the capped
form. What CR-102 actually owns is UNCHANGED: how a single id is abbreviated
(`bareDependencyId`), and that the abbreviation is display-only.

**It also supersedes CR-CRU-096 §S4/AC13's COMPLETENESS claim for zone 2 — user ruling 2026-09-07,
"cap wins".** AC13 reads "a pending row with dependencies names every one of them", and
`tests/roadmap-wave-rollup.test.ts` enforces it with a per-dependency loop over a four-dep fixture
plus an explicit anti-truncation clause (`not.toMatch(/\bmore\b/)`, `not.toContain("…")`, comment:
"ALL of them means all: the slot does not truncate to three, nor to an 'and 1 more'"). Unlike
CR-CRU-102 AC1 this is the requirement itself, not an illustrative string.

**Two of CR-CRU-096's own ACs were in latent conflict from the moment the budget was set**, and
nothing surfaced it until real data carried four dependencies plus the `next` marker:

- **AC13** — zone 2 names EVERY declared dependency (unbounded content).
- **AC20/AC4** — the wave box fits the design's ~300px (bounded surface).

Both cannot hold: the measured row is 333px. The user's ruling is that the BUDGET wins and zone 2
stops being a complete record. That is affordable only because the completeness moves rather than
disappearing — zone 3's `deps` column states the whole set for the same row, which AC7 asserts in
the SAME render so the two cannot drift. The row still says how much it is not showing (AC3's
count), so a reader is never misled about the size of what is hidden.

CR-CRU-096 is SHIPPED, so its spec is not edited (the standing rule from CR-CRU-099 cycle 322);
the supersession is recorded here and its rollup assertions are rewritten to the capped rule —
"names the first two and states the count of the rest" — keeping the test's purpose and its
non-vacuity block. This is also the case that put the bounded-surface check into the gap-analysis
skill: a design that fixes a SIZE and a data rule that states no LIMIT contradict each other from
the day both ship, and the contradiction is legible from the two specs with no test run.

### §S2 The budget is the reason, so the budget is what proves it

The cap exists to keep the wave box inside the design's ~300px at 1600×900 with the marker present.
That is CR-CRU-096 AC20/AC4's existing live-board probe, so this CR adds no geometry harness: it
makes that probe pass on the board's own data and pins the arithmetic with a fixture carrying the
worst case the wire allows.

Nothing else about the row moves: the `next` marker, the status mark, the lifecycle badge, the
click/drill behaviour, and `entry.dependsOn`'s full ids (CR-CRU-102 AC3 — the abbreviation is
display-only) all stay as they are.

## Acceptance criteria

- **AC1** — a `PENDING` row declaring **three or more** dependencies renders the first **two** bare
  ids in authored order followed by a remainder stating the count of the rest, in the form
  `deps 014, 091 +2` — one span, still `[data-testid="roadmap-node-annotation"]`, still visible
  text with no `title` and no tooltip (CR-CRU-102 AC14).
- **AC2** — a row declaring **two or fewer** dependencies is UNCHANGED: `deps 096, 102` with no
  remainder token. A `+0` is the defect this AC forbids.
- **AC3** — the remainder is a COUNT, not an ellipsis: a row with 7 declared dependencies states
  `+5` and a row with 5 states `+3`, so the two are distinguishable from the row alone.
- **AC4** — the `next` marker composes unchanged: a marked row with four dependencies reads
  `next · deps 014, 091 +2` — marker first, one ` · ` between the parts.
- **AC5** — **the live board's wave box is inside the design's budget again.** The existing live
  corroboration test passes with the board in the state that broke it — `CR-CRU-075` drawn, marked
  `next`, declaring four dependencies. That test is
  `"AC4 — the LIVE board corroborates the wave box and REPORTS its spine, or says why it cannot"`,
  **inside the `"CR-CRU-096 AC20 — zone 2's spine is horizontal in a real engine, and fits the
  surface"` describe** in `tests/roadmap-visual-grammar.test.ts`; its assertions are CR-CRU-102
  AC4's, and it is the ONLY live wave-box measurement in the tree. AC5 is decided by that test's
  own width assertion against `BUDGET.wave`, never by a new one. The measurement that sets the cap
  (§S1) puts that box at **292.5px** against the ~300px budget, so the AC has ~7.5px of headroom
  and a THIRD id would fail it at 321px.
  *Cited by NAME, not by line — corrected twice on 2026-09-07.* The orchestrator first wrote
  "CR-CRU-096 AC20/AC4's live-board probe"; the RED agent read that as wrong and reported the AC20
  describe never touches the live board; the run output then proved the test IS nested in that
  describe after all, and the orchestrator verified the nesting directly. The line numbers moved
  twice during the same cycle, which is why this AC now names the describe and the test instead of
  citing either by number.
  **Why AC5 was unreachable without AC9's third edit:** that same test asserts the annotation's
  four-id SHAPE *before* it measures the width. Once the cap ships, the shape guard throws first
  and the measurement is never evaluated — the box could be any width and AC5 would still fail.
  This CR therefore re-pins that one guard to the capped shape and touches nothing else in the
  test: it may not edit the measurement it cites as its own proof.
- **AC6** — the cap is a DISPLAY rule only: `entry.dependsOn` still carries every full id, and every
  consumer that resolves one still reads them — `roadmapSelectOn` / `roadmapDrillIn`,
  `roadmapLateDeps`'s inversion check, and the order warning that names the offending pair. A test
  drives a 5-dependency row and asserts the drill-through and the inversion warning still see all
  five.
- **AC7** — zone 3's `deps` column is UNCHANGED and still states the WHOLE set for the same row, so
  a capped row has a place to be read in full. Asserted on the same fixture, both zones in one
  render.
- **AC8** — the two-id cap is a named constant, not a literal at the call site, and no test asserts
  the number by re-deriving it from a magic literal. The number has already moved once before
  implementation (three → two, on measurement), which is exactly why it lives in one place.
- **AC9** — every shipped assertion the cap supersedes is UPDATED to the capped rule, never deleted
  and never weakened, and each retains its purpose and its non-vacuity block:
  - `tests/roadmap-bare-dependency-annotation.test.ts` — CR-CRU-102 AC1's four-id string reads the
    capped rendering; the test still proves zone 2 renders the BARE form. Its zone2/zone3 agreement
    composition (`:442-443`) composes through the cap, zone 3 still stating all four.
  - `tests/roadmap-wave-rollup.test.ts` — CR-CRU-096 §S4/AC13's completeness test asserts the NEW
    rule: the slot names the first two declared ids and STATES THE COUNT of the rest. Its
    anti-truncation clause is re-aimed, not dropped: an ellipsis (`…`, `...`) or a `+N`-less
    `more` remains forbidden, because a remainder must be a countable number. The per-dependency
    loop becomes named-vs-counted, so a renderer that names the WRONG two still fails. Its "no
    deps, no annotation" half and its non-vacuity block are untouched, and the describe/test NAMES
    stop claiming completeness — a test named "names every one of them" while asserting a cap is
    the next reader's trap.
  - `tests/roadmap-visual-grammar.test.ts` — three pinned four-id patterns, all CR-CRU-102 example
    shapes: two synthetic (`:2973`, `:3044-3046`) and **one inside the live corroboration test
    itself** (`:3195-3200`). That third one is re-pinned to the capped shape and nothing else in
    that test moves — see AC5. Stale narration comments (`:457`, `:467`, `:511`) are corrected so
    the file stops describing a rendering it no longer asserts.
  - `tests/roadmap-release-focus.test.ts` (`:1131-1143`) — `expectedAnnotation()` encodes AC13
    completeness in its body and doc-comment and is green today ONLY because its fixtures top out
    at two dependencies. It composes through the cap so it is correct by construction rather than
    accidentally green; its fixtures are unchanged.
  - `tests/roadmap-flow-axis.test.ts` — swept, nothing: it reads the annotation only to find the
    `next` marker and asserts no `deps` string. `tests/roadmap-wave-rows.test.ts` (`:828-831`)
    states two declared ids and is unaffected by the cap.
  A suite left asserting `deps 014, 091, 092, 095`, or left asserting that every declared
  dependency is named in zone 2, fails this CR.

## Estimated size

XS — one bound in one annotation builder, its fixture, and the live-board probe it exists to satisfy.

## Risk

The cap changes what zone 2 says about a row, and zone 2 is the surface CR-CRU-096's artifact
comparison measures. The failure mode to avoid is a cap that reads as data loss — a row saying
`deps 014, 091, 092 …` states less than it knows without saying how much, which is why AC3 makes the
count load-bearing.

Second risk retired by measurement, and worth keeping as the reason: the first draft's three-id cap
was a JUDGEMENT, and it was wrong — the box still measured 321px against 300. Two is a measurement
(292.5px, ~7.5px headroom, §S1's table). If a later design change re-measures the box, AC8's named
constant is the single place that moves, and §S1's table is the method to re-run.

## Non-goals

- Widening CR-CRU-096's ~300px budget — refused by user ruling 2026-09-06; the budget is the design's.
- Editing CR-CRU-096 or CR-CRU-102 in any way — both are shipped.
- Changing `bareDependencyId` or how an individual id is abbreviated — CR-CRU-102, shipped.
- Zone 3's `deps` column, its grouping, or the table's width rules — CR-CRU-078.
- How dependencies are DECLARED (`cr-depends`) or stored — CR-CRU-106, shipped.
