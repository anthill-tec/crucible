# CR-CRU-085 — multi-track swimlanes inside a wave

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 078
- **Status**: PENDING (0.2.0) — moved into 0.2.0 by user direction 2026-08-28 — re-scoped 2026-08-28: the wave container ships in CR-078; this CR owns lanes only — gap-analysed 2026-09-05 (§S1 collapsed, §S2 names the track source, AC5/AC7 simplified, row-cap ruled by the user, Risk corrected)
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

### §S1 Wave container — shipped, not this CR's

The container is CR-CRU-078's (`RoadmapFlowWave`) and CR-CRU-096's; its drawing rules live there.
This CR adds lanes INSIDE it and changes nothing about when or how the box itself is drawn (AC4).

### §S2 Track swimlanes

Within a wave container, each track renders as its own lane, in the design's §4 grammar: a grid
of `label cell · row`, one pair per track, the label being the declared track id.

**The track source is the queue row's declared `track`** (`entry.track`, CR-CRU-091 §S2's wire
field, the metadata that rode in with `wave-sequence` — design §10 step 3), read through the SAME
derivation the table's `track` column already uses (`roadmapTableColumns`' distinct-labels rule,
CR-CRU-078 AC12), so lanes and column cannot disagree. It is NOT the plan's `track`: CR-CRU-078's
`roadmap-lane-badge` reads `plan.track` for an ACTIVE row and stays as it is. The project's mainline
orchestrator decides how many tracks exist; Crucible neither sets nor caps that number.

**The wave's row cap is unchanged — user ruling 2026-09-05.** The box still shows CR-CRU-096
§S5.2's rows (the top of the scheduled queue union every running member) and one wave-level
`+N more`; lanes PARTITION those shown rows. The lane count comes from the wave's WHOLE membership,
so a track whose members are all beyond the cap still draws its lane, with its label and no rows.

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
- **AC5** — laning is a partition, asserted on the rendered DOM: every `roadmap-node` in a laned
  wave is a descendant of exactly ONE lane, lanes are siblings in the design's grid form (label
  cell then row), and the wave's node count and `+N more` are identical with and without lanes.
  *Simplified 2026-09-05:* the earlier "no overlap or clipping on rendered output" defended
  against a layered graph layout CR-CRU-078 deleted; zone 2 is plain DOM and the lanes are a CSS
  grid, which cannot overlap by construction.
- **AC6** — CR-078's behaviour is unchanged when this chrome is absent: removing track data from
  the fixture reproduces exactly the CR-078 render.
- **AC7** — the table's `track` column is UNCHANGED: it already appears under exactly the lanes'
  condition (CR-CRU-078 AC12, `roadmapTableColumns`), and the lanes read that same derivation
  rather than adding a second rule. A test asserts lanes and column appear and disappear together.

## Estimated size

M — nested containers plus lane assignment, and the layout verification that goes with them.

## Risk

*Corrected 2026-09-05:* the layered-layout risk this section carried is gone — CR-CRU-078 replaced
the cytoscape graph with plain DOM, and the lanes are the design's CSS grid. The remaining risk is
the row cap: a lane must partition the rows the wave already shows, never widen or re-derive them
(§S2's ruling), or the box's count, `+N more` and AC6's identical-render guarantee all break.

Second risk: this CR is unobservable on Crucible's own board (single-track), so it must be proven
against multi-track fixtures rather than by looking at the live dog-food instance.

## Non-goals

- The graph itself — CR-077.
- The table, its grouping, or the graph/table relationship — CR-078.
- Deciding how many tracks a project runs — that is the project's mainline orchestrator's call,
  never Crucible's.
