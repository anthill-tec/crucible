# CR-CRU-006 — Dashboard shell (Mission Control + workspace + navigation)

**Status:** PENDING
**Type:** feature
**Priority:** P1
**Depends on:** CR-CRU-004
**Labels:** ui, spa
**Phase:** Wave 3
**Design reference:** PRD §2 (UI stack), §4.11 (dashboard + navigation model); storyboard frames F1–F2, F8–F10, §nav

## Context
The approved A+B hybrid shell: Mission Control home, project workspace, routing, live
data plumbing. Run cards/drill-in depth is CR-CRU-007.

## Scope

### §S0 Event-brief reshape (Wave-3-open decision 2026-07-15 — the SPA's data shape)
v2 event BRIEFS (GET `/api/v2/events` list items, `status.lastTest/lastCompile`,
project-rollup `lastEvent`) hoist the run numbers to top-level scalars: `{id,
projectKey, agentId, kind, tier, codec, timestamp, total, passed, failed, pending,
duration_ms, hasCoverage: boolean}` — NO nested `summary` in briefs. Full detail
(`GET /api/v2/events/:id`) keeps the nested `summary`/`tree` unchanged. The v1 shim's
`GET /api/events` shape is UNTOUCHED (contract-locked). Effect: TOON's uniform-table
form applies to `events[]` (DN §Measured token-ratio addressed).

### §S1 Stack + theme (`public/`)
Vendored only: `van-1.5.5.nomodule.min.js`, `van-x-0.6.3.nomodule.min.js`,
`tailwind-browser-4.2.4.js`, `daisyui-5.5.19.css` (+themes). Forge palette as a
custom DaisyUI theme `[data-theme="forge"]` (primary `#ff7a1a`, the §5 token set from
the storyboard). No CDN, no build step; served by the Bun process at `/`.

### §S2 Routing (2 pages + overlay)
Hash-free History routing in Van: `/` (Mission Control), `/p/<key>` (workspace),
overlay suffix `/run/<eventId>` on either. Esc / scrim / browser-back closes the
overlay restoring the underlying surface's state (scroll, filters). All three states
deep-linkable (server serves the SPA for any non-/api path).

### §S3 Mission Control home (layout revised 2026-07-15, user-directed)
Top bar: logo, project chips (filter in place, "All projects" reset), server-health
pill. **Two-column layout: the timeline occupies the WIDE left column** (more room
for cards and the future drill-in); the **right rail stacks two sections — Projects
ABOVE Agents**. Projects section: project cards (name, type badge, online-agent
count, last-run status, latest-green coverage meter) from `GET /api/v2/projects`
rollups. Agents section below: liveness dots (🟢/🟡 stale/⚰ tombstoned greyed with
last message + died-ago; pruned disappear), from `GET /api/v2/agents`. Empty states
per storyboard F1.

### §S4 Project workspace
`/p/<key>`: header (← projects, name, type, agent count), tabs Runs / Agents /
Coverage / Compile / BDD (BDD tab disabled+greyed for `backend` projects), vitals
rail (latest green coverage meters, coverage trend bars from rollups + retained
events, cycle stats).

### §S5 Live plumbing + health
`EventSource` on `/api/stream`: change frames trigger slice refetch; keep-alive
watchdog — no frame for >20 s AND `GET /api/health` failing → pill flips to
"backend unreachable", all live regions get the greyed class + "last synced <t>"
stamp; auto-recover on reconnect. Poll fallback every 5 s when SSE is unavailable.

### §S6 E2E harness seed (storyboard as contract — PRD §5)
Playwright (headless chromium, devDependency) driving the REAL served SPA against a
real server instance on an ephemeral port. Seed suite `tests/e2e/shell.e2e.ts`
covering this CR's storyboard frames: F1 (empty state renders the register prompt),
F2 (agent registered via API appears in the rail live), F9 (tombstoned agent renders
greyed with last message), F10 (killing the server flips the health pill + greys
regions; restart recovers). Each test title cites its frame (`"F1: …"`). E2E results
are ingested to the dev Crucible instance with `tier: "e2e"` (dog-food).

## Acceptance criteria
- [x] `GET /api/v2/events` list items carry top-level `total`/`passed`/`failed`/`pending`/`duration_ms` numbers and `hasCoverage` boolean, and NO `summary` key; `GET /api/v2/events/:id` still returns nested `summary` + `tree`; v1 `GET /api/events` unchanged (contract suite still green).
- [x] `GET /api/v2/events?fmt=toon` on ≥2 briefs emits the uniform-table form (body contains a line matching `/^events\[\d+\]\{/`); measured ratio for a 50-event listing re-recorded in DN-crucible-toon-subset.md ≤ 70% of JSON bytes.
- [x] `GET /` serves the SPA; view-source contains NO `http(s)://` script/style URLs (fully vendored).
- [x] `document.documentElement.dataset.theme === "forge"`; computed `--color-primary` (or DaisyUI primary var) resolves to `#ff7a1a`.
- [x] Navigating `/p/<key>` directly (fresh load) renders that project's workspace — deep link works without visiting `/` first.
- [x] With a `backend` project the BDD tab element carries `disabled`/aria-disabled; with a `frontend` project it does not.
- [x] Project chips filter the DOM in place: after clicking chip NAI, agent rail shows only NAI agents and `location.pathname` is still `/`.
- [x] A tombstoned agent (lastSeen between T2 and T3) renders with the ⚰ marker, reduced opacity, its last `message`, and a "died … ago" timestamp.
- [x] Killing the server: within 25 s the pill text contains "unreachable" and the timeline container has the greyed class + a "last synced" stamp; restarting the server restores the pill within 10 s without a manual reload.
- [ ] An ingest via the API produces a visible DOM update (timeline/agent rail) within 2 s with no page reload (SSE path).
- [ ] Esc from `/p/<key>/run/<id>` lands on `/p/<key>` with prior scroll position (state restore).
- [ ] Integration: UI fetches only `/api/v2/*` + `/api/stream` (grep the SPA source for `"/api/` — no legacy v1 paths).
- [x] E2E: `bun run test:e2e` executes the §S6 Playwright suite against a real booted server; F1/F2/F9/F10 tests pass headless, and each test title names its storyboard frame.
- [x] Layout (revised §S3): the home page's main grid has exactly 2 columns — the timeline column is the widest element; the right rail contains the projects section ABOVE the agents section (E2E asserts DOM order: projects section precedes agents section within the same rail, and no left rail exists).

## Estimated size
L.

## Risk
Browser-run UI assertions need a driver — VERIFY uses chrome-devtools-axi (or
Playwright headless) for the DOM ACs; keep them selector-stable via data-testid.

## Non-goals
Run cards, transitions, drill-in, density features (CR-CRU-007); BDD tab content.
