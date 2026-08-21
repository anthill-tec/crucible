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

### The wave/release model (user-stated, 2026-08-21 — governing)

**A release is a milestone that acts as the END of a wave.** A wave exists because CRs inside it
run in **parallel**; the CRs of that wave, and the features they bring, are **bundled into** the
release that closes it. The roadmap then continues: another wave exists targeting another release.

So the roadmap's spine is `wave → release → wave → release → …`, and this is the structure the
graph draws:

- a **wave** is the parallel-execution region — its CRs fan out subject only to `depends-on`;
- its **release diamond terminates it**, and nothing in the next wave starts before that diamond;
- **multiple waves** therefore mean multiple releases, in roadmap order.

Two consequences the builder must respect. A release is **not** an annotation hanging beside the
graph — it is the join point every CR of its wave flows into, which is exactly why an edgeless
milestone node is the defect this CR fixes. And a wave is a **planning** grouping whose membership
can be **reassigned** during refactoring or reprioritisation when targeting a release, so the graph
renders the wave a CR is in *now* and never assumes today's label described a past release.


**Flow composes four inputs**, not one:

1. **depends-on** — hard prerequisite edges.
2. **wave order** — waves execute in sequence; a later wave's work follows earlier waves.
3. **release boundaries as in-flow gates** — everything in a release precedes its diamond;
   post-release CRs follow it. The diamond sits *in* the flow, never beside it. Membership comes
   from CR-080's `crs`, and consecutive diamonds chain so a release that shipped no CRs is still a
   boundary rather than a floating node.
4. **parallel fan-out** — where no dependency exists between CRs, branches run concurrently.

**Scale:** each **closed** wave collapses to a single node carrying its CR count, expandable on
click. Exactly **one wave is ACTIVE** at a time and it runs up to a release boundary, so only that
wave gets a **cluster box**; completed waves stay collapsed.

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

## Gap analysis round 2 (2026-08-21, post-CR-080) — READY

**Method correction.** My first pass at this derived design rules from Crucible's *own* CR history
and got it backwards. That history is not a specification: it is one project's accidental record,
carrying a first release that swept up four waves at once, CRs that landed without a naming merge
commit, and waves legitimately **reassigned** during refactoring and reprioritisation when
targeting a release. Those are artifacts. **F14a is the design contract**, and the graph is built
to it; where our own data disagrees with the design, that is a data problem to fix, never a reason
to bend the design.

- **Design source of truth**: storyboard **F14a**, decisions 1–8 (approved 2026-08-21). The PRD is
  essentially silent on the graph (one incidental mention), so F14a governs.
- **The data prerequisite landed.** CR-080 shipped, so a release now carries `releasedAt` (its tag's
  own date) and `crs` (what it shipped). The app already fetches `GET …/releases` into
  `state.releases` (`app.js:292`), so no new endpoint or client work: `crs` and `releasedAt` arrive
  free. Release gating and ship-order sorting are therefore implementable as designed.
- **Wave is a mutable planning field; release membership is immutable history.** A CR can be moved
  between waves during refactoring or reprioritisation, so the graph renders the wave a CR is in
  **now**, while a shipped CR's release is settled fact. The builder must read the current wave and
  never assume a CR's wave label is what it was when a past release shipped.
- **Pinned sites**, enumerated multi-line-aware: `tests/roadmap-graph.test.ts` (16 hits — the
  contract suite), `public/app-logic.mjs` (7 — the builder), `public/app.js` (2 — the render seam).
- **No public symbol is removed**; `buildRoadmapGraph(entries, releases)` keeps its signature.

**One genuine data defect found, out of scope here and filed separately (CR-081):** CR-080's `crs`
is computed by matching CR ids in **merge subjects**, so a CR that landed without a naming merge
commit is silently omitted — `CR-CRU-021` and `CR-CRU-023` shipped in 0.1.0 yet appear in no
release. Commit **ancestry** is the exact rule (CR-080's own F3 said so; plans already carry their
merge sha). That is a bug in the provenance producer, not a constraint on this view, and this CR
consumes `crs` as specified rather than compensating for it.

**Verdict: READY.** Build F14a as approved.

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
- **AC1b** — release membership comes from `crs`; a CR flows into the diamond of the release that
  shipped it and out of the preceding one.
- **AC1c** — CRs not yet in any release flow after the newest diamond.
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
