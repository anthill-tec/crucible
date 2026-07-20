# CR-CRU-032 — Patch: Runs-window governance + project-settings integrity

**Status:** PENDING
**Type:** patch
**Priority:** P2
**Depends on:** CR-CRU-025 (the `→ Runs` affordance), CR-CRU-012 (project manager), CR-CRU-008 (§S4 run-deletion toggle)
**Labels:** patch, ui, runs, navigation, project-settings, server
**Phase:** Wave 4 (follow-up — user-directed 2026-07-20)
**Design reference:** user live review 2026-07-20 (CR-025 close-out, Lavish F13 + the live dashboard). Three findings the user raised, all traced to the orchestrator (vidushi) letting them ship in CR-012/CR-008/CR-025:
1. approved option (b): anchor-fetch a beyond-window boundary on `→ Runs` click;
2. "This value is supposed to be controlled by project-level settings" — the timeline's `?limit=50` is HARDCODED and disconnected from the project `retention` setting; "make both governed by the same setting";
3. project-settings edit form has NO field labels, and carries an unlabeled run-deletion checkbox never drawn in the F12 mock.

## Context (verified in code 2026-07-20)
- Runs feed fetches a **hardcoded** `GET /api/v2/events?limit=50` (`app.js:156`). The project holds 232 raw events; only 50 show.
- The project `retention` setting (default `DEFAULT_RETENTION=100`, this project 200; edited via `manager-edit-retention`, `app.js:1286`) feeds only the **server-side raw-event rollup cap** (§S4, `store.ts`). It does NOT govern the display fetch. Two numbers, one user-facing control, no connection.
- The manager edit form (`app.js:1247-1307`) renders `name / type / sutRoot / t1 / t2 / t3 / retention / allow-deletion` as **bare inputs with NO labels**.
- `manager-edit-allow-deletion` (`app.js:1294`) is the CR-008 §S4 guarded run-deletion DANGER toggle — real + user-ruled, but unlabeled and absent from the F12 storyboard mock.

## Scope

### §S1 Server: anchored events query
Add an anchored read: `GET /api/v2/events?project=<key>&cycleId=<id>` — param name
**`project`** to match every sibling v2 GET route (RED/gap-analysis confirmed
2026-07-20; `projectKey` was an illustrative error). Returns that cycle's linked
runs (events whose `context.cycleId === id`) in `events`, PLUS the cycle's declared
`Cycle done` boundary as an additive top-level **`cycle`** field shaped like a
`PlanCycle` — `{id, label, kind, status, activatedAt?, doneAt?}`, resolved via
`findCycle` (CR-024 §S7) — NOT a synthesized RunEvent inside `events`. TOON-negotiable
like siblings; existing `?limit=N` recent-feed behavior unchanged; unknown cycleId →
200 with empty `events` and no `cycle` field (never 4xx).

### §S2 Client: anchor-fetch on `→ Runs` click (option b)
When `cycle-to-runs` is clicked and `[data-testid="declared-marker"][data-cycle-id=<id>]` is not in the loaded feed after the retry budget, issue the §S1 anchored fetch, merge the events into the Runs feed so the marker mounts, then `scrollIntoView` + `locateBlink`. No silent give-up.

### §S3 Honest dim state + explicit no-op feedback
The pill distinguishes **pruned** (server confirms the boundary is gone → dim, accurate "pruned" reason) from **beyond-window** (present server-side → stays LIVE, reached via §S2). A click that truly cannot locate a pruned boundary gives explicit feedback, never a bare tab-switch-and-nothing.

### §S4 The workspace Runs window is governed by `retention` (the disconnect fix)
**Gap-analysis (2026-07-20/21, architecture verified):** PRD §4.7 KEEPS the events
API's `?limit` param (default 50) — a real contract for programmatic callers, NOT
removed. The actual drift: `refetchCore` (`app.js:150`) fetches ONE all-projects
`/api/v2/events?limit=50` into `state.events`, and the workspace Runs pane FILTERS
that client-side by projectKey (`app.js:1610`) — so a project's Runs tab shows only
its slice of the recent 50 across all projects (exactly the "so little" bug). Fix —
make the events fetch **surface-aware**, mirroring the existing `refetchPlans`
(CR-026 §S3.2: workspace→scoped, home→global): when `state.route.page === "workspace"`,
fetch `/api/v2/events?project=<key>&limit=<project.retention ?? DEFAULT_RETENTION>`
so the Runs tab shows THAT project's runs up to ITS retention; HOME keeps the
recent-N collective `?limit=50`. Editing retention in project settings then visibly
changes the workspace Runs count. The API's default-50 (PRD §4.7) is untouched.
(HOME per-project up-to-retention is a server concern — non-goal here.)

### §S5 Project-settings UI integrity
1. **Labels** — every manager-edit field gets a visible label: name, type, SUT root, liveness T1/T2/T3 (seconds), **retention (runs — now governs the timeline window)**, and the run-deletion toggle. No more bare number boxes.
2. **Run-deletion toggle** — `manager-edit-allow-deletion` gets a clear destructive label (e.g. "Allow agents to delete runs — guarded, per-call approval"), and is **reconciled with the F12 storyboard mock**: draw it into F12 with its label (it is a real CR-008 §S4 feature; it was simply never mocked or labeled). If the user rejects the toggle on sight, that is a separate remove-decision — this CR only makes it honest + visible.

## Acceptance criteria
- [ ] §S1: `GET …/events?cycleId=<id>` returns that cycle's runs + its `Cycle done` boundary (200); unknown id → empty; TOON negotiation matches siblings.
- [ ] §S2: a boundary OUTSIDE the loaded window but present server-side → clicking `cycle-to-runs` fetches+merges it, marker `scrollIntoView`'d + blinks (e2e); the in-window happy path fires NO extra fetch.
- [ ] §S3: beyond-window → pill LIVE; genuinely pruned → pill dim with accurate reason; a pruned-click shows explicit feedback (no silent no-op).
- [ ] §S4: on a WORKSPACE route, `refetchCore` fetches `/api/v2/events?project=<key>&limit=<project.retention ?? DEFAULT_RETENTION>` (asserted on the fetch call); a project with `retention=N` renders up to N of ITS OWN runs in the Runs tab (not a slice of the all-projects 50); changing retention changes the count. HOME still fetches the recent-N collective `?limit=50` (unchanged). No hardcoded 50 governs the workspace window.
- [ ] §S5.1: every manager-edit input has an associated visible label (asserted per field testid); the retention label states it governs the timeline window.
- [ ] §S5.2: the allow-deletion toggle carries its destructive label; the F12 storyboard frame renders the labeled toggle (storyboard-fidelity assertion updated).

## Estimated size
M (anchored server route + client fetch-merge + retention-drives-limit wiring + settings-form labels + F12 mock sync).

## Non-goals
Infinite scroll / virtualization of the Runs feed; removing the run-deletion feature (only labeling + mock-sync it); a separate per-view display-limit field (retention is the single control unless the user later asks to split).
