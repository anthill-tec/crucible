# CR-CRU-015 — BDD harness: Crucible executes Playwright for frontend projects

**Status:** PENDING (0.2.0 — user-scheduled; runs as **track-2 in parallel with CR-CRU-014** — the first multi-track dog-food of the plan/track machinery)
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-004, CR-CRU-007
**Labels:** api, bdd, playwright, codecs, ui
**Phase:** Wave 5 (0.2.0) — track-2; no dependency on CR-CRU-014 (track-1)
**Design reference:** storyboard F11 (approved · later wave, kickoff 2026-07-14); PRD §4.12; E2E harness precedent (playwright.config.ts, CR-006 §S6)

## Context
BDD was approved at kickoff for a later wave: for `type:"frontend"` projects,
Crucible is not just a sink — it **harnesses the run itself**, executing
Playwright against the project's `sutRoot` on demand (dashboard button or agent
API call) and ingesting the result through a playwright codec. The greyed BDD
tab has existed since CR-007's tab row; this CR activates it. User confirmed
(during CR-007 execution): 0.2.0 shifts this project to the **multi-track
model** — this CR executes on track-2 while CR-014 runs track-1, with plans
filed per CR carrying track info, so 0.2.0's own dashboard shows two live lanes.

## Scope

### §S1 Runner (server)
`POST /api/v2/projects/<key>/bdd/run` — frontend projects only (`type:"backend"`
→ 400 naming `type`). Spawns Playwright (headless chromium, the CR-006 harness
engine) against the project's `sutRoot`; returns 202 `{runId}` immediately; job
progress + completion stream over SSE; concurrent run for the same project →
409 with the active `runId`. Completion ingests the result as a run event
(`tier:"bdd"`, codec `playwright`) attributed to the requesting agent (or
`crucible-bdd` when dashboard-triggered). Failures to spawn (missing sutRoot,
no playwright config) → a failed bdd event with the error text, never a silent
drop.

### §S2 playwright codec — PULLED FORWARD to 0.1.0 (CR-CRU-007 C5b, user-directed)
The `playwright` registry codec (feature → scenario → step trees, browser
badge, failure `{message, trace}` + trace link) ships in 0.1.0 with CR-CRU-007's
BDD E2E conversion, so Crucible reports BDD run results from 0.1.0 onward.
THIS CR reuses that codec unchanged; any runner-specific extensions (trace-file
links from server-side runs) are additive here.

### §S3 BDD tab content (frontend projects)
The BDD tab activates: `▶ Run BDD suite` button (calls §S1; disabled while a
run is active, live status over SSE), the feature → scenario → step tree of the
latest bdd event (drill-in reuses the codec-aware body), trace links. Backend
projects keep the greyed tab. The helper text documents the agent path
(`POST …/bdd/run`).

### §S4 Client verb
`bdd-run [--wait]` on the fleet clients + `crucible-axi bdd run` — triggers §S1,
`--wait` polls to completion and exits non-zero on a failed suite (CI-friendly).

## Acceptance criteria
- [ ] `POST /api/v2/projects/<key>/bdd/run` on a backend project → 400 naming `type`; on a frontend project with a seeded fixture SUT (a minimal playwright project under a temp sutRoot) → 202 `{runId}`, then a `tier:"bdd"` event with codec `playwright` appears on the project timeline; a second POST while running → 409 with the active runId.
- [ ] The stored bdd event's tree is feature → scenario → step with per-scenario browser badge; a failing scenario carries `failure.message` and the trace link when the trace file exists.
- [ ] The playwright codec is registry-resolved: `codecs.get("playwright")!.parse` is a function and no direct parser call exists outside the registry entry (grep AC, CR-010 pattern).
- [ ] Workspace BDD tab on a frontend project renders the ▶ button and, after a run, the feature tree; the button is disabled (with live status) while a run is active; a backend project's BDD tab stays greyed/disabled.
- [ ] A missing/invalid sutRoot produces a failed bdd event whose body contains the spawn error text (never a silent drop or a 500).
- [ ] `bdd-run --wait` exits 0 on a green suite and non-zero on a red one (fixture both ways); the run is attributed to the invoking agent id.
- [ ] Multi-track dog-food: this CR's own plan is filed with `track:"track-2"` while CR-014's carries `track:"track-1"` — the wave-5 lens shows both lanes (evidence: dashboard screenshot in the close-out + both plans queryable via `GET /plans?track=`).
- [ ] E2E: `tests/e2e/bdd.e2e.ts` — register frontend project → trigger run via API → tab shows live status then the tree; results ingested `tier:"e2e"`.

## Estimated size
L.

## Risk
Spawning Playwright inside the server (resource + path safety): runs are
serialized per project (409), executed with cwd = sutRoot, and the runner
refuses paths outside the registered sutRoot. Fixture SUT keeps CI hermetic.

## Non-goals
Editing BDD specs from the UI; cross-browser matrices (chromium only, like the
E2E harness); scheduling/cron runs.
