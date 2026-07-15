# CR-CRU-014 — Execution roadmap: queue registration + Wave/CR sequence table

**Status:** PENDING (0.2.0 opener — user-scheduled round 24, 2026-07-15;
backend data structures designed NOW so 0.1.0 → 0.2.0 needs no migration)
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-011, CR-CRU-013
**Labels:** api, workflow, roadmap, ui
**Phase:** Wave 5 — the 0.2.0 opener (waves number continuously across releases; user-corrected)
**Design reference:** board rounds 23–24; storyboard F14 (roadmap table, drawn
in the 0.1.0 design iteration for the clear picture)

## Context
Round 23: the project workspace should expand to Wave → CR sequences using the
depends-on table with PENDING / IN_PROGRESS / COMPLETED info. Round 24 verdict:
UI lands in 0.2.0; the 0.1.0 backend must be forward-compatible. The key
insight (agreed): **statuses are DERIVED, zero extra reporting** — PENDING = no
plan filed for the CR, IN_PROGRESS = open plan, COMPLETED = plan closed with
merge commit. Only the queue itself (CR list, waves, depends-on) needs
registering.

## Forward-compatibility contract (binding on 0.1.0 CRs — CR-011)
- `plans.cr` (string, e.g. `CR-NAI-042`) is the STABLE JOIN KEY between plans
  and the future queue table — 0.1.0 stores it verbatim, never normalized.
- The queue table is a NEW additive SQLite table in 0.2.0
  (`queue_entries(project_key, cr, title, wave, depends_on_json, size,
  filed_at)`) — no 0.1.0 table changes required. 0.1.0 code MUST NOT assume
  plans are the only CR-shaped records (no `SELECT DISTINCT cr FROM plans` as
  "the full CR list" in UI copy).

## Scope

### §S1 Queue registration (server, additive)
`POST /api/v2/projects/<key>/queue` — full replace:
`{entries:[{cr, title?, wave, dependsOn:[cr…], size?}]}`; validation 400s name
the field + index; unknown `dependsOn` targets are allowed (forward refs) but
flagged in the response. `GET …/queue` returns entries with DERIVED `status`
(PENDING/IN_PROGRESS/COMPLETED via plans) + the plan link when present. SSE on
change.

### §S2 Client verb
`queue-file` parses the project's `docs/changes/README.md` queue table (CR,
title, depends-on, wave columns) → POST; `--from-file` override.

### §S3 Roadmap slide-over (workspace — placement resolved round 25)
The workspace Project pane gains a **`roadmap` chip** opening a slide-over at
`/p/<key>/roadmap` (deep-linkable, `← workspace` back chip, Esc/scrim close —
the same overlay model as the run drill-in and `/manage`).
**Design inspiration (user-directed): the lavish review board's CR Queue &
Status table** — rows in EXECUTION SEQUENCE derived from the depends-on graph
(topological order), one line per CR, minimal status flags, wave-boundary and
release-boundary divider rows. Columns: CR · title · wave · depends-on chips ·
status badge (derived: PENDING / IN_PROGRESS / COMPLETED). A **graph view
toggle** renders the same depends-on graph as nodes/edges (table is the
default; graph is the alternate lens over identical data).
**Graph node grammar (user whiteboard, during CR-007):** ellipse terminals
(Start/End) · rectangles = **action nodes** (CRs) · diamonds = **milestone
nodes** (release boundaries, gates) · wave/track/status carried by **node
styling** (color, border, lane bands) — never crammed into label text.
**Graph library (user-directed):** mermaid is representation-only — the
product needs a real interactive graph library: vendored, zero-build,
VanJS-compatible, with DAG layout, per-node styling hooks, pan/zoom,
click-through to the Workflow tab, and SSE-driven live restyling.
Candidate: **Cytoscape.js + cytoscape-dagre** (single vendorable files, no
build step — matches the van.js/Tailwind-runtime philosophy); final pick is
a gap-analysis decision with those requirements as the gate.
**Live execution overlay (multi-track):** when the project has >1 active
track, in-progress rows carry a live overlay — the executing track's lane
badge + current cycle position (e.g. `track-2 ▶ cycle 3/5`), streaming over
SSE from the open plan; single-track projects show the plain active highlight
(no lane noise). Rows link into the Workflow tab's live view. Storyboard F14
is the contract.

## Acceptance criteria
- [ ] `POST /queue` with 3 entries → `GET /queue` returns them with derived statuses: a CR with no plan → `PENDING`; after `plan-file` → `IN_PROGRESS`; after plan close with merge → `COMPLETED` (single fixture walks all three).
- [ ] Queue replace is idempotent and full-replace (POST twice → no duplicates; removing an entry removes it); unknown `dependsOn` target is accepted and flagged in the response.
- [ ] `queue-file` against this repo's `docs/changes/README.md` registers every row of the CR table with correct wave + dependsOn (spot-assert CR-CRU-009's five dependencies).
- [ ] Workspace Roadmap renders rows in topological (depends-on) execution order — one line per CR: CR · title · wave · depends-on chips · minimal status badge matching `GET /queue`, with wave/release boundary divider rows; a graph-view toggle renders the same data as a depends-on node graph; the row whose plan is open carries the active highlight; clicking it lands on the Workflow tab.
- [ ] Live overlay: with two open plans on `track-1`/`track-2`, each in-progress row shows its lane badge + live cycle position (`track-N ▶ cycle a/b`, updating over SSE when a cycle activates); a single-track project's active row shows the plain highlight with NO lane badge.
- [ ] E2E: register queue → file plan for one CR → its roadmap row flips PENDING→IN_PROGRESS live (SSE); close plan with merge → COMPLETED.

## Estimated size
M.

## Risk
README-parsing fragility in `queue-file` — mitigated by `--from-file` and the
API being the contract (the parser is a convenience).

## Non-goals
Editing the queue from the UI; cross-project roadmaps; Gantt-style scheduling.
