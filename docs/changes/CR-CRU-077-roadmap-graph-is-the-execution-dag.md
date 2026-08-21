# CR-CRU-077 — the roadmap graph is the execution DAG, not a relationship web

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 014, 076, 080
- **Status**: PENDING (0.2.0)

## Problem

CR-014 shipped a roadmap graph that draws **relationships, not the plan**. It answers "what
does this CR need" when the roadmap must answer "what is the plan, and where are we". Verified
against the shipped code and the live board, not from memory:

1. **Edges come from `dependsOn` alone.** `buildRoadmapGraph` (`public/app-logic.mjs`) emits
   one `dep:<a>-><b>` edge per declared dependency plus `start`/`end` brackets. Wave order and
   release boundaries contribute **nothing** to the flow, so a viewer cannot read execution
   order off the graph.
2. **Release diamonds are created with zero edges.** Milestone nodes are pushed as nodes and
   never referenced by any edge, so they *float beside* the DAG instead of gating it. A release
   is the hardest ordering constraint in the project and it is currently decorative.
3. **Node labels bury the CR id** — `label: e.title ?? e.cr`, so a node shows a long title and
   the identifier (the thing every other surface keys on) is invisible or truncated.

Storyboard **F14a** is the approved design for this view, decided over a review round with
eight recorded decisions. This CR implements it.

## Design (F14a, as approved)

**Flow composes four inputs**, not one:

1. **depends-on** — hard prerequisite edges.
2. **wave order** — waves execute in sequence; a later wave's work follows earlier waves.
3. **release boundaries as in-flow gates, resolved per CR** — a CR belongs to the release whose
   `crs` contains it (CR-080's provenance), so a CR flows into that release's diamond and out of
   the previous one. Diamonds also **chain to each other**, so a release that shipped **zero** CRs
   (real case: `0.1.1`) is still a boundary in the flow. Gating is never inferred from wave
   numbers — measured: wave 4 spans `0.1.0` and `0.1.2` and still has unreleased members.
4. **parallel fan-out** — where no dependency exists between CRs, branches run concurrently.

**Scale:** each **closed** wave collapses to a single node carrying its CR count, expandable on
click. The **active wave** gets a **cluster box**; completed waves stay collapsed. The cluster is a
**presentation** grouping only — it does not define gating, because a wave can straddle releases
(H1). CRs in **no** release form the trailing **unreleased region**, which spans waves by nature
(H3) and flows after the newest diamond.

**Track lanes are purely data-driven.** The number of tracks is decided by the project's
**mainline orchestrator** — never by Crucible, and never capped at the Crucible end. N distinct
tracks render N lanes; one track renders a single sequential chain with no lane chrome; absent
track data renders no lanes and is **not** an error state. Lanes must be derived, never
hard-coded or assumed.

**Labels lead with the CR id** plus a terse status suffix: `CR-NAI-040 ✓ merged`,
`CR-NAI-042 ▶ 2/3`, bare id when PENDING.

**Motion means live.** A node for a currently-active CR carries live state — animated inflow
plus a pulsing ring and its cycle position, on the existing SSE cadence. Merged, pending and
idle nodes are completely static, so motion always means "work is happening right now".

**No synthetic wave→wave edge** between waves that share no dependency; column position
conveys ordering.

## Gap analysis (2026-08-21, pre-RED) — **BLOCKED on one decision**

Verified against the running app and the live store. Wave sequencing, fan-out, collapse, lanes,
labels and motion are all implementable from data that exists. **Release gating is not**, and it
is §S1's centrepiece, so RED has not been dispatched.

- **F1 — release diamonds have no edges *and* no association data.** Confirmed in
  `buildRoadmapGraph`: milestone nodes are pushed and never referenced by any edge. The deeper
  problem is that nothing links a CR to a release. `queue_entries` has **no release column**
  (CR-074's own spec flagged this), and the renderer does not associate either — all release
  dividers are emitted in one loop **at the top of the table**, before any CR row
  (`app.js:2439–2449`), so today's "release boundaries" are three labels stacked at the head.
  `rel.version` itself is fine (`releaseBrief` maps `label`→`version`; live payload carries
  `version`, `commit`, `timestamp`).
- **F2 — timestamp association is unusable.** A release's `timestamp` is when it was
  **recorded**, not when it shipped. All three of ours were backfilled today (2026-08-21 13:45)
  while the real tags are 2026-08-19 / 08-20, and **all 62 closed plans predate every recorded
  release timestamp**. So a `closedAt < releaseTs` rule would attribute the entire backlog to
  0.1.0. The tag date is known to git and **not stored** anywhere in Crucible.
- **F3 — commit-ancestry association is exact but unavailable client-side.** Plans carry `merge`
  and `commitBoundary`; releases carry `commit`. "CR's merge commit is an ancestor of the release
  commit" is the correct rule and is timestamp-proof — but it needs git, and neither the browser
  nor the server runs it.
- **F4 — an uncut release has no record at all.** F14a draws a pending `Release 0.2.0` diamond
  gating the active wave, but a release is only recorded at tag time, so nothing describes an
  upcoming release. Crucible has no concept of a planned release or horizon; "0.2.0" exists only
  as a storyboard annotation.

**Implementable now, from real data:** §S2 wave containers and collapse, §S3 data-driven lanes,
§S4 labels and live motion, plus wave-order sequencing and parallel fan-out (AC2, AC3, AC4, AC5,
AC6, AC7, AC8). **Not implementable:** AC1 (a diamond with inbound and outbound edges), because
no data says which CRs sit on either side of it.

**Verdict: RESOLVED by dependency (user decision, Option A, 2026-08-21).** The prerequisite is
supplied by **CR-080 §S4**, which makes the release milestone record `releasedAt` (the tag's own
commit date) and `crs` (the CR ids the tag shipped, computed from `git log <prev>..<tag>`
intersected with the queue) — the association is produced by the ceremony, the only actor with
git in reach. `GET …/releases` exposes both. This CR therefore **depends on 080** and gates flow
from `crs`, never from ingest timestamps.

F4 stands unresolved and is **out of scope here**: an uncut release still has no record, so a
pending release diamond is **not drawn** rather than faked. The active wave flows to `End` until
a planned-release concept exists.

## Gap analysis round 2 (2026-08-21, post-CR-080) — **SPEC_UPDATE_NEEDED**

The data prerequisite landed: CR-080 shipped and our own three releases now carry real provenance
(`0.1.0` shipped 2026-08-19 with 58 CRs, `0.1.1` 2026-08-19 with 0, `0.1.2` 2026-08-20 with
`CR-CRU-066`). Ordering by `releasedAt` works. But querying that real data breaks two assumptions
this spec and F14a were built on, and they must be fixed before RED.

- **H1 — release gating must be per-CR, never per-wave. `wave 4 spans two releases.`**
  Measured on the live board: `0.1.0` shipped 50 wave-4 CRs, `0.1.2` shipped one more wave-4 CR
  (`CR-CRU-066`), and further wave-4 CRs are **still unreleased**. So a wave is **not** contained
  by a release; waves and releases are orthogonal groupings. F14a decision 2's premise — *"there
  will always be only one active wave i.e. leading to a release boundary"* — does not hold for this
  project's actual history, and any rule of the form "the release diamond gates the wave" is
  ill-defined. The gate is a property of a **CR**: a CR flows out of the diamond of the release
  that preceded it and into the diamond of the release whose `crs` contains it. §S1 is re-scoped
  accordingly, and the active-wave cluster box becomes a **presentation** grouping only, never the
  unit of gating.
- **H2 — a release can ship zero CRs. `0.1.1` did.**
  It was the `repository`-field hotfix: a real, tagged, published release whose `crs` is empty. So
  a diamond may legitimately have **no inbound CR edges**, and AC1 as written ("at least one
  inbound and one outbound edge whenever CRs exist on both sides") silently permits it to dangle.
  Consecutive diamonds must **chain to each other** (`0.1.0 → 0.1.1 → 0.1.2`) so an empty release
  is still a boundary in the flow rather than a floating node — which is the exact defect this CR
  exists to fix.
- **H3 — the unreleased set is not a wave.** 20 queue entries are in no release's `crs`, spanning
  waves **4, 5 and 6** simultaneously. They flow after the newest diamond. "Unreleased" is
  therefore its own flow region, not a wave and not a release, and it mixes waves by nature.
- **H4 — knock-on for CR-078, must be fixed there too.** I gave 078 an **AC10** requiring "every
  wave divider appears exactly once" alongside **AC11** requiring grouping by release then wave.
  On real data those are **contradictory**: wave 4 legitimately appears in the `0.1.0` group, again
  in the `0.1.2` group, and again in the unreleased region. AC10 must become *"once per release
  group"*, with duplicates **within** a group being the bug. Left unamended, 078 is unimplementable.
- **H5 — no new plumbing needed.** The app already fetches `GET …/releases` into `state.releases`
  (`app.js:292`), so `crs` and `releasedAt` arrive with no new endpoint or client work. PRD says
  essentially nothing about the graph (one incidental mention), so the storyboard remains the
  governing design record.

Pinned sites, enumerated multi-line-aware: `tests/roadmap-graph.test.ts` (16 hits — the contract
suite), `public/app-logic.mjs` (7 — the builder itself), `public/app.js` (2 — the render seam).

**Verdict: SPEC_UPDATE_NEEDED, applied below.** §S1 now gates per-CR from `crs`, diamonds chain so
an empty release still gates, and the unreleased region is explicit. F14a's decision-2 premise is
corrected in the spec rather than silently coded around.

## Scope

### §S1 Compose the flow

`buildRoadmapGraph` gains wave sequencing and release gating alongside dependency edges, and
release milestones become **connected** nodes: every CR in a release flows into its diamond,
and the diamond flows into the CRs that follow it. Start/End terminals bracket the whole DAG.

### §S2 Wave containers and collapse

Closed waves render as one expandable node with a CR count; the single active wave renders as a
cluster box holding its CRs. Expansion state is UI state, not persisted.

### §S3 Data-driven lanes

Lanes are derived from reported track assignments. No policy, no cap, no default track count.
One track → no lane chrome. No track data → no lanes, no error.

### §S4 Labels and live state

Labels lead with the CR id + terse status. Active CRs carry animated inflow, a pulsing ring and
cycle position; everything else is static.

## Acceptance criteria

- **AC1** — **no milestone node is ever edgeless.** Every release diamond has at least one
  inbound and one outbound edge, including a release that shipped **zero** CRs (`0.1.1`), which
  chains from the previous diamond to the next. A milestone with zero edges is the defect this CR
  fixes and must fail this AC.
- **AC1b** — release membership comes from `crs`, **not** wave numbers: a CR in `0.1.2`'s `crs`
  flows into the `0.1.2` diamond even though other CRs of the same wave shipped in `0.1.0`.
  Asserted with the real straddle case (wave 4 across `0.1.0` and `0.1.2`).
- **AC1c** — CRs in no release form a trailing region after the newest diamond, and a wave that
  straddles a release boundary is **not** duplicated as a node.
- **AC2** — for two CRs in different waves with **no** declared dependency, the graph still
  places the later wave downstream (via the wave/release chain), so execution order is readable
  without inventing a dependency.
- **AC3** — two CRs in the same wave with no dependency between them render as **parallel
  branches** from the same upstream node, not a chain.
- **AC4** — a closed wave renders as a single node whose label carries its CR count; expanding
  it reveals its CRs. Exactly one wave renders as a cluster box, and it is the active one.
- **AC5** — lanes are data-driven: with N distinct tracks the graph renders N lanes; with one
  track it renders no lane chrome; with **no** track data it renders no lanes and **no error**.
  No test may assert a hard-coded track count.
- **AC6** — every CR node label **starts with the CR id**; a node label never consists of the
  title alone.
- **AC7** — only nodes for `IN_PROGRESS` CRs carry live/animated state; `COMPLETED` and
  `PENDING` nodes are static. Asserted on the rendered output, since the previous animation
  attempt looked correct in source while binding nothing.
- **AC8** — no synthetic wave→wave edge exists between waves sharing no dependency.
- **AC9** — the graph renders the live 78-CR roadmap without a parse/layout error, and
  `unknownDependencies` stays empty.

## Estimated size

M — one builder rewritten, container/collapse state, lane derivation, live-state styling.

## Risk

The graph is the headline of 0.2.0, so a layout regression is highly visible. Mitigations: the
builder is pure and unit-testable (edges asserted structurally, not visually); AC7 and AC9 are
asserted against **rendered** output because a source-only check already gave a false positive
once this cycle (mermaid silently ignored an animation directive while the source looked right).

Nested lane subgraphs inside the active-wave box are the layout-fragile part; if dagre cannot
lay out a case, the honest fallback is fewer nested containers, never a fabricated layout.

## Non-goals

- Table behaviour and the graph/table relationship — **CR-078**.
- Deep-link and drill-through — **CR-079**.
- Velocity, burndown and the P50/P80 forecast — **CR-022, deferred past 0.2.0**.
- Tab ordering — CR-076.
