# CR-CRU-026 — Patch: workspace plan scoping — navigation refetch + render guard

**Status:** PENDING
**Type:** patch
**Priority:** P2 (cross-project data leak on a primary surface)
**Depends on:** CR-CRU-011, CR-CRU-021
**Labels:** patch, ui, workflow, navigation
**Phase:** Wave 4 (proposed: immediately after CR-012 merges, before 008 —
user to confirm the slot)
**Design reference:** user bug report 2026-07-17 (screenshot,
crucible_inactive_project_bug.jpg): "These inactive projects have no data and
clicking on them lands in Workflow tab populated with the active Crucible
projects workspace data! This is a bug"; filing directive: "Put the fix in
the next appropriate patch CR!"

## Context
`state.plans` is fetched project-scoped (`refetchPlans()`, app.js ~L134) but
ONLY inside `refetch()`, which runs on SSE change frames and the poll
fallback. `navigate()` (~L49) and the `popstate` handler set `state.route`
without triggering any refetch, and the Workflow lens renders `state.plans`
wholesale with no `projectKey` check. Net effect: navigating home → any
workspace (or workspace → workspace) shows the PREVIOUS project's plans on
the Workflow landing tab until some unrelated server change fires an SSE
frame — indefinitely on a quiet server. Reported against the no-data fixture
projects, which rendered the active Crucible project's entire workflow.

## Scope

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

## Acceptance criteria
- [ ] With project A's workspace open and plans loaded, `navigate("/p/<B>")` renders the Workflow tab WITHOUT any of A's plan content at ANY point (assert synchronously post-navigate: zero plan groups from A) and fires exactly one `GET /api/v2/projects/<B>/plans` (mock-asserted) without waiting for an SSE frame.
- [ ] A workspace for a project with zero plans shows the CR-011 workflow empty state; the previous project's active-plan section and history groups are absent (testid sweep).
- [ ] Browser back/forward (`popstate`) across two workspaces re-scopes identically (clear + scoped fetch per transition).
- [ ] Render guard: seeding `state.plans` with a plan whose `projectKey` ≠ routed key renders nothing from it (unit-level pin on the lens).
- [ ] Regression: SSE change frames still refetch plans for the CURRENT route (existing cadence unbroken); home ignores plans (no fetch fired when `route.page !== "workspace"`).
- [ ] E2E: from the seeded active project's workspace, click a fixture project's badge → Workflow tab shows that project's empty state, not the seeded project's plans; navigate back → the seeded project's plans return.

## Estimated size
XS.

## Non-goals
Scoping changes to the events/agents slices (globally fetched, already
filtered per surface at render); offline/error-state UX changes (the
keep-last-known-on-failure behavior stays for the SAME project).
