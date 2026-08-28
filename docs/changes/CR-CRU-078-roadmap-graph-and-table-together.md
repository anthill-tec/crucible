# CR-CRU-078 — the roadmap is a release-paged flowchart with its scoped table

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 077, 084, 091
- **Status**: PENDING (0.2.0) — re-based 2026-08-28 on the approved flowchart design
- **Design document — READ IT FIRST**: `/home/antonyj/Documents/data_projects/crucible/.lavish/crucible-workflow-flowchart.html` §1–§8, §14 (approved 2026-08-28). Absolute path so it resolves from a worktree. Mirrored in `docs/research/DN-crucible-roadmap-view.md` §Visual contract.
- **Also**: `docs/research/DN-crucible-wave-track-release.md` (wave/track/release model)

> **The look is specified. Read the design document and implement what it shows.**
> Zone order, shape grammar, colour semantics, motion, and the whole-container paging invariant are
> all fixed there. Do not substitute another visual vocabulary, layout engine or colour scheme.
> AC21–AC26 exist to fail an implementation that looks different from the approved design even when
> every behavioural AC passes.

## Problem

The roadmap forces a choice between two readings of the same dataset. CR-014 shipped an
**exclusive toggle** — `roadmap-view-table` / `roadmap-view-graph` buttons plus an exclusive
view state — so exactly one of table or graph renders at a time.

CR-077 then built the graph half as a dependency-composed DAG. On the live board that rendered
**94 nodes and 208 edges, 160 of them `dependsOn`** — the relationship web the surface exists to
eliminate. The composition was rejected and is superseded by the approved design; the reusable
half (release membership from `crs`, ship-order sorting, authored `seq`, id+status labels, the
four derived statuses, `packages`) carries forward.

Two secondary defects on the same surface:

- **Row text bloat.** The table row renders the full CR title (`span.app-roadmap-title`) on top
  of id, wave, deps and status, so the identifier competes with a sentence.
- **Graph labels** read `title ?? cr`, burying the id (fixed in CR-077 §S4; this CR must not
  reintroduce full titles into node labels).

## Design

Three zones on one surface, no toggle: a **release strip**, the **active release's flowchart**,
and a **table scoped to the focused release**. Positions are derived from declared data only —
no layout engine, no crossing heuristic, no dependency edges drawn.

## Scope

### §S1 Remove the toggle

Delete the `roadmap-view-table` / `roadmap-view-graph` buttons and the exclusive view state. All
zones render unconditionally. Any test asserting toggle behaviour is retired with its reason
stated — the contract it defended no longer exists.

### §S2 Zone 1 — the release strip, paged, whole containers only

The strip is the release sequence: `Start → ◇release … → End`, shipped gates solid, proposed
gates dashed. It is the only zone that grows without bound, and it does **not** scroll.

- The window holds `floor(available width / gate pitch)` gates and **never a fraction of one**.
  A partially drawn container is a defect, not a labelled edge case.
- The remainder becomes a **clickable tag** on each side — `◀ N earlier` / `N later ▶` — which is
  both the hidden count and the affordance. A click pages a whole window.
- A tag with nothing behind it is **not rendered** rather than rendered disabled.
- The landing window **contains the focused release**, never offset 0.
- Window size is **measured, not hardcoded**: it changes when the project rail collapses
  (CR-093), so collapsing the rail reduces the hidden counts.

### §S3 Zone 1 — gates carry their dates

A shipped gate carries its ship date (`releases[].releasedAt`, epoch **seconds** —
`public/app-logic.mjs:874`). A proposed gate carries its declared `--target` (CR-091), or an
explicit "no target declared" empty state. Both render through **one shared formatter**; a naive
`new Date(seconds)` yields 1970 and must fail review.

Ordering stays **by version** for proposals and ship date for shipped releases. A declared target
that contradicts version order is surfaced as a planning conflict, never a reason to re-sort.

### §S4 Zone 2 — only the focused release gets wave detail

If the focused release is **in flight**, its flowchart draws `Start → wave container(s) → ◇gate →
End`, the wave being the container of its CRs in authored `seq` order. If the focused release has
**shipped**, zone 2 states what it delivered — CR count, waves spanned, ship date, packages — and
does **not** reconstruct its waves: the Workflow history view owns historical waves.

Multi-track swimlanes inside a wave are **CR-085**, not this CR.

### §S5 Zone 3 — the table follows the focused release

The table renders the focused release's CRs and nothing else — never the whole project. Landing
focuses the release in progress, so the table lands on that release's rows.

Row grammar: **CR id + brief title + bare depends-on + status + cycle overlay**. The brief title
is a **new required column** (user directive 2026-08-28) sourced from the CR's own H1; this
amends the DN's flat "no titles" row grammar, which continues to hold for **flowchart node
labels**. The table gains a `wave` column only when the release spans more than one wave, and a
`track` column only when more than one track is reported.

### §S6 Authored order is carried, never re-derived

A CR's position comes from the orchestrator-assigned order and nothing else. The store keeps it
(`queue_entries.seq`) and CR-077 shipped its consumption as `data.seq`.

Today `roadmapTopoOrder` (`public/app.js:2334`) walks `dependsOn` depth-first, pulling any CR
whose dependencies sit later in `seq` forward — discarding the assigned order despite a comment
claiming to preserve it. It also emits a wave divider on every wave change, so the live board
repeats waves (`Wave 1,2,3,4,3,4,5,6,5,6,5`).

New rule: **topology validates, it does not re-sequence.** An authored order placing a CR before
its own dependency raises a **warning on that row** and is not reshuffled — quiet reshuffling
hides an authoring error and overrides the orchestrator's intent (CR-091 §S5).

### §S7 Selection and highlight

Clicking a gate refocuses zones 2 and 3. Clicking the active wave opens/closes it in place and
narrows the table to that wave. Clicking a CR node or its row drills to that CR's cycles in
Workflow — the jump itself is **CR-079**. Selecting on either side highlights the other.

## Acceptance criteria

- **AC1** — no toggle exists: `roadmap-view-table` and `roadmap-view-graph` are absent from the
  DOM and from the source, and all three zones render simultaneously.
- **AC2** — the strip renders above the flowchart, which renders above the table (asserted
  geometrically, not by source order).
- **AC3** — **no gate is ever drawn partially**: for every rendered gate, its bounding box lies
  wholly inside the strip's box. Asserted on landing and after paging both directions. A gate
  clipped by one pixel fails.
- **AC4** — with more releases than fit, the hidden count on each side is rendered as a clickable
  tag; a click pages by a whole window and the counts update. With nothing hidden on a side, that
  tag is **absent from the DOM**, not merely disabled.
- **AC5** — the landing window **contains the release in progress**; a fixture with 20 releases
  whose in-flight release is last must not land on offset 0.
- **AC6** — a shipped gate renders its ship date; a proposed gate renders its declared target or
  an explicit "no target declared". A date rendered as `1970-…` fails this AC (seconds-vs-ms).
- **AC7** — **no forecast date renders.** A release with no declared target shows the empty state;
  no estimated, interpolated or placeholder date may appear while CR-022 is unshipped. A
  *declared* target is authored data and is not a forecast.
- **AC8** — focusing a **shipped** release shows its delivered summary (CR count, waves, date,
  packages per CR-084) and draws **no wave containers**. Where `packages` is empty it renders an
  explicit "no package recorded" state, never an apparently complete release.
- **AC9** — focusing the **in-flight** release draws its wave container with that wave's CRs in
  authored `seq` order.
- **AC10** — the table shows **only** the focused release's CRs; clicking another gate replaces
  the rows. The row count equals that release's membership, never the project total.
- **AC11** — a table row renders the CR id **and its brief title**; a row missing the title column
  fails. Flowchart **node** labels carry no title — a node label containing its entry's `title`
  string fails.
- **AC12** — the `wave` column appears only when the focused release spans more than one wave;
  the `track` column only when more than one track is reported.
- **AC13** — rows preserve authored `seq` verbatim within the release. Asserted against a fixture
  whose authored order differs from a dependency-only walk, so a renderer that re-derives order
  fails.
- **AC14** — **order is editable**: re-registering with two CRs swapped (same wave, same deps)
  changes their rendered order accordingly.
- **AC15** — an authored order placing a CR before its own dependency renders a warning on that
  row and is **not** reordered.
- **AC16** — no wave is rendered twice inside one region; the live repeated sequence
  (`Wave 1,2,3,4,3,4,5,6,5,6,5`) must fail this AC. A single wave carrying no information renders
  no wave chrome.
- **AC17** — selecting a row highlights its node and vice versa.
- **AC18** — an `IN_PROGRESS` row is clickable and marked as the drill-through source; the jump is
  CR-079's AC.
- **AC19** — with **no** queue and **no** releases registered, every zone renders one definitive
  empty state naming the registration verb, and no error. **Observed 2026-08-28 on the cleared
  board, and this is the failure to fix:** the table shows "No execution queue registered yet …"
  while the graph renders two orphan terminals — a `Start` and an `End` bubble, 2 nodes and 0
  edges, with no message at all. Drawing skeleton chrome for an empty project fails this AC: an
  empty board renders **no** terminals, no strip and no wave box, only the empty state.
- **AC20** — **zero dependency edges are drawn.** A rendered edge whose meaning is `dependsOn`
  fails this AC; dependency is stated only as the table's column.

### Visual fidelity — asserted against the design document, not taste

These are as binding as the behavioural ACs. An implementation that passes AC1–AC20 but looks
different from `.lavish/crucible-workflow-flowchart.html` §1–§8/§14 is **not** done.

- **AC21 — shape grammar.** Each element renders as its declared shape: `Start`/`End` as
  **stadium/pill** terminals (exactly one of each), a release as a **diamond**, a **proposed**
  release as a **dashed-border diamond**, a wave as a **box** containing its CRs, a CR as a **leaf
  rectangle**. Asserted on computed style/geometry, not on class names — a diamond rendered as a
  rectangle fails even if its class says `gate`.
- **AC22 — colour semantics.** `COMPLETED` green · `COMPLETED_UNTRACKED` dimmed green ·
  `IN_PROGRESS` ember · `PENDING` plain/neutral · a release amber · a non-focused release dimmed.
  Asserted per state against the rendered colour.
- **AC23 — colour is never the only channel.** For every state, the status is **also present as
  text**. Test: with colour stripped (greyscale / `filter: grayscale(1)` or comparing text content
  alone), every node's state is still determinable. A node whose state is legible only from its
  colour fails.
- **AC24 — motion means live, and only that.** Only an `IN_PROGRESS` CR animates; `COMPLETED`,
  `COMPLETED_UNTRACKED` and `PENDING` nodes are **completely static**. Asserted by sampling rendered
  state across at least two animation frames: a static node that changes fails, and an
  `IN_PROGRESS` node that never changes fails.
- **AC25 — zone order and identity.** Exactly three zones render, in order: release strip, then the
  focused release's flowchart, then its table. Asserted geometrically (vertical order), and each
  zone is individually identifiable.
- **AC26 — no layout engine decides position.** Every node's position is derived from declared data
  (ship order, version order, wave membership, authored `seq`). A force-directed, crossing-minimising
  or otherwise heuristic layout fails this AC — CR-CRU-077 was reverted for exactly that, and the
  price was measured (+41% adjacent-rank crossings, 94 nodes / 208 edges on the live board).

## Estimated size

L — three zones, paging with measured window, date formatting, selection plumbing, and the
removal of `roadmapTopoOrder`'s re-derivation.

## Risk

Selection state is new shared state across three zones; the failure mode is a desynchronised
highlight. AC17 asserts both directions.

The paging window is measured from layout, so it interacts with CR-093 (rail collapse) and with
any container that changes width. AC3 is the invariant that catches a bad measurement: it fails
on any partial gate rather than tolerating a near-miss.

Removing the toggle deletes a shipped affordance; the retired tests must state that rather than
vanishing silently.

## Non-goals

- Multi-track swimlanes inside a wave — **CR-085**.
- The registration verbs, proposed-release records and the `release` column — **CR-091**.
- The chip URL fix and the active-CR jump implementation — **CR-079**.
- Velocity, burndown, P50/P80 forecast — **CR-022, post-0.2.0**.
- The collapsible project rail — **CR-093**.
- Release→gate association — needs a data model that does not exist.
- Historical wave reconstruction for shipped releases — the Workflow history view owns it.
