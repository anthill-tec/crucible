# CR-CRU-026 — Patch: workspace plan scoping — navigation refetch + render guard

**Status:** PENDING
**Type:** patch
**Priority:** P1 (primary workspace surface renders blank or with another
project's data; misleads the operator watching live execution)
**Depends on:** CR-CRU-011, CR-CRU-021
**Labels:** patch, ui, workflow, navigation
**Phase:** Wave 4 — IMMEDIATELY after CR-012 merges (user-directed
2026-07-17: "classify this bug correctly and fix in 026")
**Design reference:** user bug report 2026-07-17 (screenshot,
crucible_inactive_project_bug.jpg): "These inactive projects have no data and
clicking on them lands in Workflow tab populated with the active Crucible
projects workspace data! This is a bug"; filing directive: "Put the fix in
the next appropriate patch CR!"; second live occurrence same day: the active
project's OWN workspace rendered the workflow empty state while its plan was
open with an active cycle ("Now workflow view for active Crucible project is
not displaying").

## Classification
**Defect class:** client navigation data-lifecycle — route transitions are
decoupled from data fetching (stale-while-navigate). NOT a server defect
(the scoped API responses are correct); NOT transient (deterministic given
the SSE-frame timeline); NOT introduced by CR-012's cycles (no workflow-view
code in that diff).
**Introduced:** CR-011 C3 wired `refetchPlans()` into the SSE-driven
`refetch()` only; CR-021 §S1 (Workflow as the landing tab) put the affected
surface first in every navigation, raising exposure.
**Masking:** any server change fires an SSE frame that re-scopes plans
within ~a second — so the defect is invisible while agents ingest steadily
and surfaces only in quiet spells. Chrome-verified THREE faces 2026-07-17:
(a) warm state → fixture workspace renders the active project's entire
workflow; (b) cold state + quiet server → the active project's own workspace
renders "no open plan" indefinitely; (c) **marker vocabulary degradation** —
the Runs timeline renders heuristic `RED n/m ➜ GREEN m/m` transition markers
INSTEAD of declared `⟲ Cycle done` boundaries whenever plans are absent
(measured on identical events: cold load = 11 declared / 0 heuristic;
in-app navigation = 0 declared / 9 heuristic). The HOME timeline shows the
degraded form ALWAYS (`refetchPlans` early-returns off-workspace, so home
never has plan data — or shows stale workspace plans, making the vocabulary
depend on navigation history). A browser cold load always displays
correctly (SSE `onopen` fires a full refetch) — the failure is exclusively
in-app navigation plus the home plans gap.
**Process impact (user note 2026-07-17):** face (c) actively misled the
CR-025 design rounds — the user issued the `⊙ Detail` badge instruction
believing the heuristic markers (whole-body drill-in) they were seeing in
the live timeline were the cycle-done markers; the instruction was then
corrected. Inconsistent vocabulary has real design cost, not just cosmetic.

## Context
`state.plans` is fetched project-scoped (`refetchPlans()`, app.js ~L134) but
ONLY inside `refetch()`, which runs on SSE change frames and the poll
fallback. `navigate()` (~L49) and the `popstate` handler set `state.route`
without triggering any refetch, and the Workflow lens renders `state.plans`
wholesale with no `projectKey` check. Net effect: navigating home → any
workspace (or workspace → workspace) shows the PREVIOUS project's plans (or
nothing) on the Workflow landing tab until some unrelated server change
fires an SSE frame — indefinitely on a quiet server.

## Scope

### §S0 Governing principle — remove the hidden navigation state (user ruling 2026-07-17)
"There is a hidden navigation state for Run Timeline … REmove that!!" —
`state.plans` lingering across surface changes IS that hidden state: the
timeline's rendered vocabulary is currently a function of navigation
HISTORY, not of the current route. This CR REMOVES the state, it does not
merely guard against it: after this patch, every timeline/workflow render is
a pure function of (current route, server data). Identical server state MUST
render identically whether a surface is reached by cold load, badge click,
back/forward, or any navigation sequence. §S1-§S3 are the mechanics of that
removal; none of them may leave a code path where stale cross-surface plan
data can influence a paint.

### §S1 Route change triggers an immediate scoped refetch
Any route transition that changes the data scope (home→workspace,
workspace→workspace with a different `projectKey`, workspace→home, and the
`popstate` equivalents) synchronously CLEARS `state.plans` (empty replace —
no frame may render another project's plans) and, when landing on a
workspace, immediately invokes `refetchPlans()` for the NEW `projectKey`
(plus the core `refetch()` slice so events/agents vitals are fresh). The
SSE/poll cadence remains the steady-state refresh; navigation no longer
depends on it.

### §S2 Render guard — plans filtered by routed project
The Workflow lens renders ONLY plans whose `projectKey` equals
`state.route.projectKey` (each plan already carries `projectKey` in the API
payload). Defense in depth: even if stale data survives a race, another
project's plans can never paint. A workspace whose project has no plans
shows the existing CR-011 empty state (`no open plan — file one via POST …`)
— never silence, never foreign data.

### §S3 Marker vocabulary parity — declared boundaries on every surface
The timeline's marker form must reflect DATA TRUTH, never fetch timing or
navigation history:
1. **Workspace:** with §S1 in place, the Runs tab always has the routed
   project's plans — cycleId-linked runs render `⟲ Cycle done` boundaries /
   open spans from the first paint; the heuristic marker appears ONLY for
   genuinely unlinked runs.
2. **Home:** the home timeline gains plan data for the projects it renders
   so declared boundaries appear there too (gap-analysis decision on the
   mechanism — leaning a single additive cross-project read, e.g.
   `GET /api/v2/plans`, over a per-project client fan-out; pick at cycle
   planning with AXI/TOON parity).
3. **Compound matching:** with plans from MULTIPLE projects in client state,
   run↔cycle matching keys on (projectKey, cycleId) — plan cycle ids are
   per-project and MUST NOT collide across projects on the home feed.
4. The heuristic marker itself stays byte-identical for planless projects
   (CR-011 §S0b compatibility clause unchanged).

## Acceptance criteria
- [ ] With project A's workspace open and plans loaded, `navigate("/p/<B>")` renders the Workflow tab WITHOUT any of A's plan content at ANY point (assert synchronously post-navigate: zero plan groups from A) and fires exactly one `GET /api/v2/projects/<B>/plans` (mock-asserted) without waiting for an SSE frame.
- [ ] A workspace for a project with zero plans shows the CR-011 workflow empty state; the previous project's active-plan section and history groups are absent (testid sweep).
- [ ] Blank-view face: navigating home → the project's OWN workspace with `state.plans` empty and NO SSE frame delivered renders the plan content anyway (the navigation fetch alone suffices — assert with the stream mock silenced).
- [ ] Browser back/forward (`popstate`) across two workspaces re-scopes identically (clear + scoped fetch per transition).
- [ ] Render guard: seeding `state.plans` with a plan whose `projectKey` ≠ routed key renders nothing from it (unit-level pin on the lens).
- [ ] Regression: SSE change frames still refetch plans for the CURRENT route (existing cadence unbroken); home ignores plans (no fetch fired when `route.page !== "workspace"`).
- [ ] E2E: from the seeded active project's workspace, click a fixture project's badge → Workflow tab shows that project's empty state, not the seeded project's plans; navigate back → the seeded project's plans return.
- [ ] §S3 vocabulary parity: on the workspace Runs tab reached by IN-APP navigation, cycleId-linked runs render `declared-marker` rows (zero `transition-marker` rows for linked runs) — identical to the cold-load render of the same server state.
- [ ] §S0 no-hidden-state equivalence: for BOTH home and workspace, the set of rendered marker testids is identical between (a) cold load and (b) arrival via any navigation sequence (assert at least: home→ws→home and ws-A→home→ws-B), given unchanged server data.
- [ ] §S3 home parity: home renders `⟲ Cycle done` boundaries for linked runs of every listed project; with two projects each owning a plan whose cycle ids overlap numerically, each run matches only ITS project's cycle (compound-key pin).

## Estimated size
S (grew from XS: §S3 home plan availability + cross-project matching).

## Non-goals
Scoping changes to the events/agents slices (globally fetched, already
filtered per surface at render); offline/error-state UX changes (the
keep-last-known-on-failure behavior stays for the SAME project).
