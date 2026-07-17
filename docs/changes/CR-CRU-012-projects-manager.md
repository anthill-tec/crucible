# CR-CRU-012 — Projects manager: add + edit project parameters

**Status:** IN_PROGRESS (2026-07-17 — plan 7 filed in Crucible, cycles 25-29; §S1b done, §S1 executing)
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-004, CR-CRU-007
**Labels:** ui, projects, api
**Phase:** Wave 4 (before 009 — user-requested, board round 13, 2026-07-15)
**Design reference:** storyboard F12; decision ledger "Project activity + manager" (round 13); §nav interaction table (⚙ manage chip row)

## Context
Board round 13: "Another UI that is missing is a projects manager view where you
can add new projects or edit an existing project's parameters." Registration
exists (F1 empty-state + `POST /api/v2/projects`); editing does not — there is
no update endpoint and no management surface.

## Scope

### §S1 Server: `PATCH /api/v2/projects/<key>` (additive)
Editable fields: `name`, `type` (`backend|frontend`), `sutRoot`, per-project
liveness overrides `{t1_ms, t2_ms, t3_ms}`, `retention` (max runs). Unknown
fields → 400 naming the field; invalid `type` → 400 naming `type`;
**`projectKey` is immutable** — a body attempting to change it → 400 naming
`projectKey`. Successful PATCH emits the projects SSE change event. Shim
untouched (no v1 equivalent).

### §S1b Archive / unarchive (user-added round 14, wanted in 0.1.0)
`POST /api/v2/projects/<key>/archive` and `.../unarchive` (additive). Archiving
sets `archivedAt` — the project and ALL its records stay stored but are
**excluded from every internal query**: projects listing (default), events,
agents, rollups, SSE change payloads. Agent API calls against an archived
project → 404 with an `archived` hint in `help[]` (registration does NOT
resurrect; unarchive is explicit). `GET /api/v2/projects?archived=true` lists
archived projects (manager-only view). Unarchive restores full visibility —
records were never deleted.

### §S2 Manager UI (slide-over `/manage`)
Reached via the **⚙ manage chip** on the home projects row; a slide-over over
home with route suffix `/manage` (deep-linkable, cold-load renders), `← home`
back chip + Esc/scrim close (consistent level model). Lists every project
(canonical name + type badge) with its parameters (sutRoot, liveness T1/T2/T3
showing defaults vs overrides, retention, immutable key). Per-project
**edit-in-place** form (name, type, sutRoot, liveness overrides, retention) →
PATCH; **+ Add project** form (name, type, sutRoot) → existing
`POST /api/v2/projects` — the same surface F1's "+ Register a project" opens.
Per-project **archive** action (with confirm) + an "archived (N)" fold at the
bottom listing archived projects with an **unarchive** action.

## Acceptance criteria
- [ ] `PATCH /api/v2/projects/<key> {name:"NAI-2"}` → 200; `GET /api/v2/projects` shows `name:"NAI-2"`; an SSE `projects` change event was emitted (assert via stream capture).
- [ ] `PATCH` with `{type:"desktop"}` → 400 with `error` naming `type`; with `{projectKey:"other"}` → 400 naming `projectKey`; with an unknown field `{foo:1}` → 400 naming `foo`; stored project unchanged after each.
- [ ] `PATCH` with `{liveness:{t1_ms:120000}}` → subsequent liveness computation for that project uses T1=120 s (agent silent 90 s reads `online`, not `stale`); other projects keep defaults.
- [ ] Home projects row renders a `data-testid="manage-chip"`; clicking it opens `data-testid="projects-manager"` and the URL becomes `/manage`; cold-loading `/manage` renders the same manager; `← home`, Esc, and scrim each close it back to `/`.
- [ ] Adding a project via the manager form (name/type/sutRoot) creates it through `POST /api/v2/projects` and its badge appears in the projects row without reload (SSE).
- [ ] Editing a project's name in the manager updates its badge text in the projects row without reload; the key shown in the manager is read-only in the DOM (no input element bound to it).
- [ ] §S1b: `POST /api/v2/projects/<key>/archive` → 200; afterwards `GET /api/v2/projects` omits the project, `GET /api/v2/events?project=<key>` and the agents listing return 404/empty per contract, and project rollups exclude it; `GET /api/v2/projects?archived=true` includes it; `.../unarchive` restores it to every listing with all prior events intact (count equality asserted before/after).
- [ ] §S1b: an agent `register`/`runs` call against an archived project → 404 whose `help[]` mentions the archived state; the call does NOT unarchive it.
- [ ] §S1b: the manager renders an archive action per project and an `archived (N)` fold with an unarchive action; archiving from the manager removes the badge from the home projects row without reload (SSE).
- [ ] E2E: `tests/e2e/manager.e2e.ts` — open manager via chip → add project → edit its name → archive it → badge disappears live → unarchive → badge returns; results ingested `tier:"e2e"`.

## Estimated size
M (grew with §S1b archive/unarchive, round 14).

## Risk
None material — additive endpoint + one overlay surface reusing shell
conventions.

## Non-goals
Hard-DELETING projects (archive covers the need; physical deletion deferred);
system-wide config editing from the UI (project-inactive timeout etc. stay
server config); authentication.
