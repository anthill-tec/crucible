# CR-CRU-085 — multi-track swimlanes inside a wave

- **Type**: feature
- **Wave**: 6 (post-0.2.0)
- **Depends on**: 078
- **Status**: PENDING (post-0.2.0) — re-scoped 2026-08-28: the wave container ships in CR-078; this CR owns lanes only
- **Design document — READ IT FIRST**: `/home/antonyj/Documents/data_projects/crucible/.lavish/crucible-workflow-flowchart.html` §4, §5, §7 (approved 2026-08-28). Absolute path so it resolves from a worktree; it carries the lane grammar, the shape/colour vocabulary it must reuse, and the conditional-chrome rule.

> The design document is the contract for this CR. Implement what it specifies — do not
> re-derive the model, the vocabulary or the look from scratch.

## Problem

Split out of CR-CRU-077 with approval, so that CR's scope is honest.

The roadmap design carries two pieces of wave/track chrome (roadmap-view DN, decisions 2 and 4):

- a **wave container** drawn around the CRs it holds, and
- **track swimlanes** inside it — horizontal lane boxes, one per track, with the lane count
  **data-driven** (N tracks → N lanes; one track → no lane chrome; no track data → no lanes, and
  that is not an error).

Both are approved design. Neither delivers anything to **this** project, and together they are the
riskiest part of the graph to build:

- Per `DN-crucible-wave-track-release.md`, a wave is an abstract temporal container of one or more
  parallel tracks and is **largely a synchronization indicator for orchestrators**. In a
  **single-track (trackless)** project it carries almost no information — and **Crucible is
  single-track**.
- Because lanes are data-driven, on Crucible's own board this machinery correctly renders
  **nothing at all**. The work would be unobservable in the only project consuming it today.
- It is also the layout-fragile part: lanes are **nested** subgraphs inside a wave container, which
  is where a dagre-style layered layout is most likely to fight back. Carrying that risk inside
  CR-077 would put the release's headline feature behind its least valuable third.

So this is deferred rather than dropped: the design stands, and it is built when a genuinely
**multi-track** project needs to read its own board.

## Scope

### §S1 Wave container

A wave renders as a container around the CRs it holds, drawn **only where it is informative** —
more than one track, or more than one wave inside a release. Never drawn as a boundary that
terminates a release (the release is the delivery unit; the wave is a synchronization device).

### §S2 Track swimlanes

Within a wave container, each track renders as its own lane. Lane membership and count are
**derived from the reported track assignments** — the project's mainline orchestrator decides how
many tracks exist, and Crucible neither sets nor caps that number.

### §S3 Degenerate cases render nothing, not an error

One track → no lane chrome. No track data → no lanes. A single wave in a single release → no wave
container. None of these are error states, and none produce a warning or an empty-state message.

## Acceptance criteria

- **AC1** — with **N** distinct tracks reported in a wave, the graph renders **N** lanes, and each
  CR sits in the lane of its reported track.
- **AC2** — with exactly **one** track, **no** lane chrome renders; with **no** track data, no
  lanes render and **no error or warning** is produced.
- **AC3** — no test asserts a hard-coded track count; lane count is always derived from fixture
  data, so the "Crucible is single-track" case and a multi-track case are both expressible.
- **AC4** — lanes render **only** when more than one track is reported; the wave container itself
  is CR-078's and must be unchanged by this CR.
- **AC5** — the flowchart still lays out without overlap or clipping with lanes present; asserted
  on rendered output, not on the builder's data, since nested-container layout is the risk this CR
  carries.
- **AC6** — CR-078's behaviour is unchanged when this chrome is absent: removing track data from
  the fixture reproduces exactly the CR-078 render.
- **AC7** — the table gains its `track` column under the same condition as the lanes, and loses it
  when only one track is reported.

## Estimated size

M — nested containers plus lane assignment, and the layout verification that goes with them.

## Risk

Nested subgraphs (lanes inside a wave container) are the layout-fragile case. If a layered layout
cannot place a case cleanly, the honest fallback is fewer nested containers — never a fabricated
layout. AC5 asserts against rendered output for exactly this reason.

Second risk: this CR is unobservable on Crucible's own board (single-track), so it must be proven
against multi-track fixtures rather than by looking at the live dog-food instance.

## Non-goals

- The graph itself — CR-077.
- The table, its grouping, or the graph/table relationship — CR-078.
- Deciding how many tracks a project runs — that is the project's mainline orchestrator's call,
  never Crucible's.
