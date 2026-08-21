# CR-CRU-078 — graph and table are complementary, shown together

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 077
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
| a **release diamond** is clicked | that release's **metadata** — tag, commit, date, CR count / waves |

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

The queue is a **full replace of an ordered list**, and the store already keeps that authored
position: `queue_entries.seq INTEGER NOT NULL`. `GET …/queue` returns entries in `seq` order
(verified: `001 … 080` exactly as written in the queue file). So the execution order is already
the author's to edit — reorder rows in the queue file, re-register with `queue-file`, and the new
sequence is stored. **This is the mechanism for mid-flight re-sequencing** after a refactor or
redesign changes the plan, and it must not be second-guessed by the renderer.

Today the renderer overrides it. `roadmapTopoOrder` (`public/app.js:2334`) walks `dependsOn`
depth-first and emits each dependency before its dependent, so any CR whose dependencies sit
*later* in `seq` is pulled forward, and **wave is never consulted at all**. Its own comment
claims a "stable, seq-preserving order", which is not what it does. Live consequences on the
78-CR board:

- wave-6 rows render **above** wave-5 rows — CR-015 (deps 004, 007, both early) lands at row 62
  while CR-076 is at 74 — so work deliberately deferred *out* of 0.2.0 still appears inside it;
- wave dividers repeat: `Wave 1, 2, 3, 4, 3, 4, 5, 6, 5, 6, 5`, because a divider is emitted on
  every wave change and the walk revisits waves.

New ordering rule:

1. group by **release**, then by **wave** — groups never interleave;
2. **within** a group, preserve the **authored `seq`** order verbatim;
3. topology is used to **validate**, not to re-sequence: if the authored order places a CR before
   one of its own dependencies, that is surfaced as a **warning on the offending row**, because a
   plan that executes a CR before its prerequisite is an authoring error the author must see and
   fix — silently reshuffling it hides the mistake and destroys the author's intent.

Each wave divider appears exactly once. Ordering therefore stays editable, and what you wrote is
what you see.

### §S5 Bidirectional highlight

Expanding a graph container expands its rows; selecting a row highlights its graph node, and
selecting a node highlights its rows.

## Acceptance criteria

- **AC1** — no toggle exists: `roadmap-view-table` and `roadmap-view-graph` are absent from the
  DOM and from the source, and **both** graph and table are present simultaneously on the
  roadmap surface.
- **AC2** — the graph renders **above** the table (asserted geometrically, not by source order).
- **AC3** — opening a wave container makes the table list exactly that wave's CRs.
- **AC4** — clicking a release diamond makes the table show that release's metadata: tag,
  commit, date, CR count. It shows **no gate rows**.
- **AC5** — for a release **not yet cut**, the table shows its CR counts and **omits** the
  possible-date row entirely. No estimated, interpolated or placeholder date may render while
  CR-022 is unshipped.
- **AC6** — a table row renders **no CR title** as a row field; row text starts with the CR id.
- **AC7** — expanding a container in the graph expands the matching rows; selecting a row
  highlights its node and vice versa.
- **AC8** — an `IN_PROGRESS` row is clickable and marked as the drill-through source; the jump
  itself is CR-079's AC.
- **AC9** — the surface renders the live 78-CR roadmap with both zones and no error.
- **AC10** — every wave divider appears **exactly once**; the live duplicate sequence
  (`Wave 1,2,3,4,3,4,5,6,5,6,5`) must fail this AC.
- **AC11** — rows group by release then wave and **preserve authored `seq`** within a group:
  **every** wave-6 row renders after every wave-5 row. Asserted with the real deferral
  (015/018/022 after 075–080), the case that exposed the bug.
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
