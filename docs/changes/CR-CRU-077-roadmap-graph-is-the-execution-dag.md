# CR-CRU-077 — the roadmap graph is the execution DAG, not a relationship web

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 014, 076
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
3. **release boundaries as in-flow gates** — everything in a release precedes its diamond;
   post-release CRs follow it. The diamond sits *in* the flow, never beside it.
4. **parallel fan-out** — where no dependency exists between CRs, branches run concurrently.

**Scale:** each **closed** wave collapses to a single node carrying its CR count, expandable on
click. Exactly **one wave is ACTIVE** at a time (it always runs up to a release boundary), and
only that wave gets a **cluster box**; completed waves stay collapsed.

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

- **AC1** — a release milestone has **at least one inbound and one outbound edge** whenever
  CRs exist on both sides of it. A milestone node with zero edges is a failure.
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
