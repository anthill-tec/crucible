# DN — Roadmap view (graph + table)

- **Status**: APPROVED (user, 2026-08-21/22). Micro-feature design note for the Roadmap surface.
- **Governing model**: `DN-crucible-wave-track-release.md` (FINAL — wave/track/release definitions).
- **Visual source**: storyboard frame **F14a** in `.lavish/crucible-v2-design.html`.
- **Why this DN exists**: `.lavish/` is **gitignored**, so the storyboard is not version-controlled.
  The approved decisions were surviving only in an untracked local file; this DN is their durable
  home. The storyboard stays the visual surface; this is the record.
- **Implemented by**: CR-CRU-077 (graph), CR-CRU-078 (graph+table together), CR-CRU-079 (deep-link
  + drill-through). Tab order shipped in CR-CRU-076.

## The decisions

| # | Decision | Status |
|---|---|---|
| **1** | **Scale by collapse.** A closed region collapses to a single node carrying its CR count, expandable on click; the current region stays expanded. | approved |
| **2** | **Containers are drawn**, not implied by position. Originally "the active wave gets a cluster box". **Superseded in part** by the governing DN: a wave is a container of *tracks* and is drawn only where informative (more than one track, or more than one wave in a release); it is never drawn as terminating a release. | approved, premise corrected |
| **3** | **Release boundaries gate the flow.** Work after a release boundary does not start before it; the boundary sits *in* the flow, never beside it. | approved |
| **4** | **Track lanes are SWIMLANES** — horizontal lane boxes, not a tint plus badge. **Data-driven**: N tracks → N lanes; one track → no lane chrome; no track data → no lanes, and that is *not* an error. Track count is the project's mainline orchestrator's decision, never capped by Crucible. | approved (overrode the recommendation) |
| **5** | **No synthetic ordering edges.** Order comes from `depends-on` plus the orchestrator-assigned queue sequence; nothing invents an edge to express sequence. | approved |
| **6** | **Motion means live.** A currently-active CR carries a small animation / live state (animated inflow, pulsing ring, cycle position) on the SSE cadence. Merged, pending and idle nodes are completely static, so motion always means "work is happening right now". | approved |
| **7** | **Graph and table are COMPLEMENTARY, shown together.** No table/graph buttons and no mode: both render on one surface. The graph carries structure, the table carries detail — switching would mean losing one to see the other. | approved |
| **7b** | **Layout + selection contract.** The **graph occupies the top** as the 360° view of the whole roadmap with openable containers; the **table below is driven by the graph's selection**. Open a container → the table lists its CRs. Click a **release diamond** → the table shows that release's milestone (version + delivered package(s) + commit + date + bundled CRs). The graph never leaves the screen. | approved |
| **7c** | **Active CR → Workflow.** Clicking an `IN_PROGRESS` CR row jumps to the Workflow view and lands on **that CR's active cycles**; `← roadmap` returns. | approved |
| **8** | **Roadmap leads the tab band** — `Roadmap · Workflow · Runs · Coverage · Compile · BDD`. A project starts with roadmap creation; Workflow is the runtime view of its CRs executing. | **shipped** (CR-076) |

## Deliberate exclusions

- **Gate detail on a release reading.** Nothing can currently answer "which gates belong to release
  X", so the table does not pretend to. Recorded as a decision, not an omission.
- **A forecast/possible release date.** The confidence-gated P50/P80 band belongs to CR-CRU-022,
  deferred past 0.2.0. Until it lands the row is **omitted, not estimated** — the standing rule is
  state the truth rather than fabricate the richer answer.
- **A planned/uncut release.** A release is recorded when it ships a package to users, so an
  upcoming release has no record and no diamond is drawn for it.

## Row grammar

`CR-id` + bare `depends-on` + status + a terse track/cycle overlay. **No titles** — the identifier
is what every other surface keys on, and a full title crowds it out.
