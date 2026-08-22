# CR-CRU-078 — graph and table are complementary, shown together

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 077, 084
- **Status**: PENDING (0.2.0)

## Problem

The roadmap forces a choice between two readings of the same dataset. CR-014 shipped an
**exclusive toggle** — `roadmap-view-table` / `roadmap-view-graph` buttons plus an exclusive
view state — so exactly one of table or graph renders at a time.

That is the wrong model. The graph carries **structure** (execution order, release gates,
lanes); the table carries **detail** (deps, status, cycle position). They are complementary
views of one dataset, so switching means losing one to see the other: you give up the DAG's
shape to read a status, or give up detail to keep the shape.

Two secondary defects on the same surface:

- **Row text bloat.** The table row renders the full CR title (`span.app-roadmap-title`) on top
  of id, wave, deps and status, so the identifier competes with a sentence. F14's row grammar is
  CR-id + bare deps + status + a terse track/cycle overlay — no titles.
- **Graph labels** read `title ?? cr`, burying the id (fixed in CR-077 §S4; this CR must not
  reintroduce titles into rows).

Storyboard **F14a** decisions 7, 7b and 7c are the approved design.

## Design (F14a decisions 7 / 7b / 7c)

**One surface, no buttons.** The Roadmap renders both readings simultaneously. There is no
toggle, no mode, and no view state to choose.

**Two zones.** The **graph occupies the top** and is the *360° perspective* of the whole
roadmap, with openable containers. The **table sits below** and reads whatever the graph has
selected.

**The table is selection-driven**, with exactly two readings:

| graph selection | table shows |
|---|---|
| an **executable container** (a wave) is opened | that wave's **CRs** — id, deps, status, terse track/cycle overlay |
| a **release diamond** is clicked | that release's **milestone**: version, the **package(s) delivered** (registry + name + version), commit, date, and the CRs it bundled |

**Gate detail is deliberately excluded.** Nothing today can answer "which gates belong to
release X", so the table does not pretend to. Recorded as a decision, not an omission.

**The possible release date is out of scope for 0.2.0.** The confidence-gated P50/P80 band
belongs to **CR-022, which is deferred past 0.2.0**. For a release not yet cut, the table shows
tag/CR counts and simply **omits** the date row — it is never estimated by other means.

**Coupling both ways.** Expanding a container in the graph expands its rows in the table;
selecting on either side highlights the other. The graph never leaves the screen, so the 360°
view is retained while drilling.

**Active CR → Workflow (decision 7c).** Clicking an `IN_PROGRESS` CR row jumps to the Workflow
view, landing on **that CR's active cycles** as they are displayed and tracked. Implemented in
**CR-079**, which owns the drill-through; this CR only guarantees the row is the defined source
and is clickable for active CRs.

## Scope

### §S1 Remove the toggle

Delete the `roadmap-view-table` / `roadmap-view-graph` buttons and the exclusive view state.
Both zones render unconditionally. Any test asserting toggle behaviour is retired with its
reason stated — the contract it defended no longer exists.

### §S2 Selection-driven table

The table renders from the graph's current selection: wave container → its CRs; release diamond
→ release metadata (tag, commit, date, CR count, waves), with the possible-date row **absent**
until CR-022 lands. Default with nothing selected: the active wave's CRs.

### §S3 Row grammar

Rows carry **CR-id + bare deps + status + terse track/cycle overlay**. The full title is
removed as a row field; it may remain a hover affordance but never occupies row width.

### §S4 Row order is the AUTHORED order, and it is editable

Ordering follows the model in `docs/research/DN-crucible-wave-track-release.md`: a CR's position
comes from **`depends-on` plus the orchestrator-assigned order**, and nothing else. The queue is a
full replace of an ordered list and the store already keeps that authored position
(`queue_entries.seq`); `GET …/queue` returns it (verified). So **re-sequencing is done by reordering
the queue file and re-registering** — that is the supported way to re-plan after refactoring or
reprioritisation, and the renderer must not override it.

Today it does. `roadmapTopoOrder` (`public/app.js:2334`) walks `dependsOn` depth-first, emitting
each dependency before its dependent, so any CR whose dependencies sit later in `seq` is pulled
forward — discarding the orchestrator's assigned order despite a comment claiming to preserve it.
It also emits a wave divider on every wave change, so the live board repeats waves
(`Wave 1,2,3,4,3,4,5,6,5,6,5`).

New rule:

1. **Group by release** — the primary grouping (a release bundles the CRs of one or more waves and
   ships a package to users). Work not yet in any release forms the trailing current region.
2. **Within a release, group by wave only where it is informative** — a wave is an abstract
   temporal container of tracks and largely an orchestrator synchronization indicator, so single
   track and single wave means no wave chrome at all. It is never rendered as a boundary that ends
   a release.
3. **Within a group, preserve the authored `seq` verbatim.**
4. **Topology validates, it does not re-sequence.** An authored order placing a CR before its own
   dependency raises a **warning on that row** rather than being silently reshuffled — quiet
   reshuffling hides an authoring error and overrides the orchestrator's intent.

### §S5 Bidirectional highlight

Expanding a graph container expands its rows; selecting a row highlights its graph node, and
selecting a node highlights its rows.

## Acceptance criteria

- **AC1** — no toggle exists: `roadmap-view-table` and `roadmap-view-graph` are absent from the
  DOM and from the source, and **both** graph and table are present simultaneously on the
  roadmap surface.
- **AC2** — the graph renders **above** the table (asserted geometrically, not by source order).
- **AC3** — opening a wave container makes the table list exactly that wave's CRs.
- **AC4** — clicking a release diamond makes the table show that release's milestone: version,
  its **delivered package(s)** (registry, name, version — CR-084), commit, date and bundled CR
  count. It shows **no gate rows**. Where `packages` is empty it renders an explicit "no package
  recorded" state, never an apparently complete release — a release that delivered nothing to users
  is not a complete release (see the DN).
- **AC5** — for a release **not yet cut**, the table shows its CR counts and **omits** the
  possible-date row entirely. No estimated, interpolated or placeholder date may render while
  CR-022 is unshipped.
- **AC6** — a table row renders **no CR title** as a row field; row text starts with the CR id.
- **AC7** — expanding a container in the graph expands the matching rows; selecting a row
  highlights its node and vice versa.
- **AC8** — an `IN_PROGRESS` row is clickable and marked as the drill-through source; the jump
  itself is CR-079's AC.
- **AC9** — the surface renders the live 78-CR roadmap with both zones and no error.
- **AC10** — no wave is rendered twice inside one region, and the live repeated sequence
  (`Wave 1,2,3,4,3,4,5,6,5,6,5`) must fail this AC. Where a single track and a single wave carry no
  information, no wave chrome renders at all.
- **AC11** — rows group by **release** first, preserve authored `seq` within a group, and place
  work not yet released in a trailing current region. Asserted against a fixture whose authored
  order differs from a dependency-only walk, so a renderer that re-derives order fails.
- **AC11b** — **order is editable**: re-registering the queue with two CRs swapped (same waves,
  same deps) changes their rendered order accordingly. This is the mid-flight re-sequencing
  contract; a renderer that re-derives order would fail this AC.
- **AC11c** — an authored order that places a CR **before its own dependency** renders a warning
  on that row and is **not silently reordered**.
- **AC12** — with releases recorded, release dividers render in order and each CR row sits under
  the release it belongs to; deferred work sits after the last release boundary, visibly outside
  the release.

## Estimated size

M — toggle removal, selection plumbing between the two zones, row grammar, highlight wiring.

## Risk

Selection state is new shared state between two zones; the failure mode is a desynchronised
highlight (a row highlighted whose node is not, or vice versa). AC7 asserts both directions
explicitly for that reason.

Removing the toggle deletes a shipped affordance. Anyone with a bookmarked expectation of "graph
mode" loses it — acceptable and intended, since both views now render at once, but the retired
tests must say so rather than vanishing silently.

## Non-goals

- Graph topology, waves, gates, lanes, motion — **CR-077**.
- The chip URL fix and the active-CR jump implementation — **CR-079**.
- Velocity, burndown, P50/P80 forecast — **CR-022, post-0.2.0**.
- Release→gate association — explicitly excluded above; needs a data model that does not exist.
