# DN — Roadmap view (graph + table)

- **Status**: APPROVED (user, 2026-08-21/22). Micro-feature design note for the Roadmap surface.
- **Governing model**: `DN-crucible-wave-track-release.md` (FINAL — wave/track/release definitions).
- **Visual source**: storyboard frame **F14a** in `.lavish/crucible-v2-design.html`.
- **Why this DN exists**: `.lavish/` is **gitignored**, so the storyboard is not version-controlled.
  The approved decisions were surviving only in an untracked local file; this DN is their durable
  home. The storyboard stays the visual surface; this is the record.
- **Implemented by**: CR-CRU-077 (graph — composition superseded 2026-08-28), CR-CRU-091 (declared
  registration), CR-CRU-078 (release-paged flowchart + scoped table), CR-CRU-079 (deep-link +
  drill-through), CR-CRU-085 (multi-track lanes), CR-CRU-093 (rail collapse). Tab order shipped in
  CR-CRU-076.
- **Visual source**: `.lavish/crucible-workflow-flowchart.html` §1–§14, approved 2026-08-28. Where
  this note and that artifact disagree, the artifact is the later decision.

## The decisions

| # | Decision | Status |
|---|---|---|
| **1** | ~~**Scale by collapse.** A closed region collapses to a single node carrying its CR count, expandable on click; the current region stays expanded.~~ **SUPERSEDED 2026-08-28** by release **paging**: the strip draws only whole containers and the remainder becomes a clickable `◀ N earlier` / `N later ▶` tag. A partially drawn container is a defect, so nothing collapses to a fraction. | superseded |
| **2** | **Containers are drawn**, not implied by position. Originally "the active wave gets a cluster box". **Superseded in part** by the governing DN: a wave is a container of *tracks* and is drawn only where informative (more than one track, or more than one wave in a release); it is never drawn as terminating a release. | approved, premise corrected |
| **3** | **Release boundaries gate the flow.** Work after a release boundary does not start before it; the boundary sits *in* the flow, never beside it. | approved |
| **4** | **Track lanes are SWIMLANES** — horizontal lane boxes, not a tint plus badge. **Data-driven**: N tracks → N lanes; one track → no lane chrome; no track data → no lanes, and that is *not* an error. Track count is the project's mainline orchestrator's decision, never capped by Crucible. | approved (overrode the recommendation) |
| **5** | **No synthetic ordering edges.** Order comes from `depends-on` plus the orchestrator-assigned queue sequence; nothing invents an edge to express sequence. | approved |
| **6** | **Motion means live.** A currently-active CR carries a small animation / live state (animated inflow, pulsing ring, cycle position) on the SSE cadence. Merged, pending and idle nodes are completely static, so motion always means "work is happening right now". | approved |
| **7** | **Graph and table are COMPLEMENTARY, shown together.** No table/graph buttons and no mode: both render on one surface. The graph carries structure, the table carries detail — switching would mean losing one to see the other. | approved |
| **7b** | **Layout + selection contract.** *Amended 2026-08-28:* the **release strip** leads and drives focus; the focused release's flowchart sits below it and the **table is scoped to that release**, defaulting to the one in progress. The original clause — graph on top, table driven by opening a container or clicking a release diamond for a milestone reading — is superseded by that release-scoped model. The strip never leaves the screen. | approved, amended |
| **7c** | **Active CR → Workflow.** Clicking an `IN_PROGRESS` CR row jumps to the Workflow view and lands on **that CR's active cycles**; `← roadmap` returns. | approved |
| **8** | **Roadmap leads the tab band** — `Roadmap · Workflow · Runs · Coverage · Compile · BDD`. A project starts with roadmap creation; Workflow is the runtime view of its CRs executing. | **shipped** (CR-076) |

## Deliberate exclusions

- **Gate detail on a release reading.** Nothing can currently answer "which gates belong to release
  X", so the table does not pretend to. Recorded as a decision, not an omission.
- **A forecast/possible release date.** The confidence-gated P50/P80 band belongs to CR-CRU-022,
  deferred past 0.2.0. Until it lands the row is **omitted, not estimated** — the standing rule is
  state the truth rather than fabricate the richer answer. *Clarified 2026-08-28:* a **declared**
  target date (CR-CRU-091) is authored data and is explicitly **not** covered by this exclusion.
  Declared target = the commitment; CR-022's band = the prediction; the gap between them is the
  signal. Nothing may render an estimated date until CR-022 ships.
- ~~**A planned/uncut release.** A release is recorded when it ships a package to users, so an
  upcoming release has no record and no diamond is drawn for it.~~ **REVERSED 2026-08-28 (user
  ruling):** the project's mainline orchestrator **registers proposed releases**, at any time, so a
  planned release *does* have a record and **is** drawn — as a dashed diamond carrying its declared
  target date. It is never inferred by the renderer: no registration, no diamond. Implemented by
  **CR-CRU-091**.

## Row grammar

`CR-id` + bare `depends-on` + status + a terse track/cycle overlay.

**Titles, amended 2026-08-28 (user ruling).** The rule splits by surface, and both halves are
load-bearing:

- **Flowchart node labels carry no title** — the identifier is what every other surface keys on,
  and a full title crowds it out. Unchanged.
- **The table carries a brief title column**, sourced from the CR's own H1. This is the DN's own
  division of labour made explicit: structure in the picture, detail in the rows.

## Visual contract (approved 2026-08-28) — BINDING on implementation

**Why this is here and not only in `.lavish/`:** the storyboard and the flowchart design artifact
are **gitignored**, so an agent working in a worktree or a clean checkout cannot read them. This
section is the **tracked, authoritative** copy of the approved look. Where the artifact
`.lavish/crucible-workflow-flowchart.html` is present it is the richer visual reference and the two
must agree; where it is absent, **this section governs**. Implementing agents may not substitute
their own visual vocabulary.

### Zones, in this order

1. **Release strip** — the release sequence: `Start → ◇release … → End`.
2. **Flowchart of the focused release** — wave container(s) holding its CRs, ending at its gate.
3. **Table scoped to the focused release** — never the whole project.

### Shape says what a thing IS

| Shape | Means |
|---|---|
| **Stadium** (pill) | terminal — exactly one `Start`, one `End` |
| **Diamond** | a release gate, sitting **in** the flow |
| **Diamond, dashed border** | a release **proposed** by the orchestrator, not yet cut |
| **Box** (rectangle container) | a **wave** — the abstract container of CRs |
| **Rectangle** (leaf) | one CR — id + terse status, **never** a title |
| **Dashed divider** | a track swimlane; multi-track only (CR-CRU-085) |

### Colour says WHERE IT STANDS — an independent channel

| Colour | State |
|---|---|
| **Green** | `COMPLETED` — merged |
| **Green, dimmed** | `COMPLETED_UNTRACKED` — shipped before plan tracking |
| **Ember / orange** | `IN_PROGRESS` — and it is **the only thing that ever moves** |
| **Plain / neutral** | `PENDING` — nothing to report yet |
| **Amber** | a release, shipped or proposed |
| **Dimmed** | not the focused release; click to focus |

**Two hard rules on colour:**

- Colour **never encodes anything shape already says**. They are independent channels.
- **No element relies on colour alone.** Status is *also* written as text, so the view survives a
  greyscale screenshot and a colour-blind reader.

### Motion

Motion means **live**. Only an `IN_PROGRESS` CR animates. `COMPLETED`, `COMPLETED_UNTRACKED` and
`PENDING` nodes are completely static, so movement on the surface always means "work is happening
right now".

### Invariants that are part of the look

- **Whole containers only.** The strip renders `floor(width / pitch)` gates and **never a fraction
  of one**; the remainder becomes a clickable `◀ N earlier` / `N later ▶` tag which pages a whole
  window. A tag with nothing behind it is **not rendered**, not disabled.
- **Landing focuses the release in progress**, and the strip's window contains it — never offset 0.
- **A gate carries its date beneath it**: a shipped gate its ship date, a proposed gate its declared
  target, or an explicit "no target declared" empty state. Both render through **one shared
  formatter** (`releasedAt` is epoch **seconds**; a naive `new Date()` yields 1970).
- **Zero dependency edges are drawn.** Dependency is stated once, as a table column.
- **An empty board draws no chrome** — no terminals, no strip, no wave box; only the empty state.
