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

### §S3 Mission Control home
Top bar: logo, project chips (filter in place, "All projects" reset), server-health
pill. Left rail: project cards (name, type badge, online-agent count, last-run
status, latest-green coverage meter) — data from `GET /api/v2/projects` rollups.
Right rail: agents with liveness dots (🟢/🟡 stale/⚰ tombstoned greyed with last
message + died-ago; pruned disappear), from `GET /api/v2/agents`. Center: timeline
container (cards in CR-CRU-007). Empty states per storyboard F1.

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

## Acceptance criteria
- [ ] `GET /` serves the SPA; view-source contains NO `http(s)://` script/style URLs (fully vendored).
- [ ] `document.documentElement.dataset.theme === "forge"`; computed `--color-primary` (or DaisyUI primary var) resolves to `#ff7a1a`.
- [ ] Navigating `/p/<key>` directly (fresh load) renders that project's workspace — deep link works without visiting `/` first.
- [ ] With a `backend` project the BDD tab element carries `disabled`/aria-disabled; with a `frontend` project it does not.
- [ ] Project chips filter the DOM in place: after clicking chip NAI, agent rail shows only NAI agents and `location.pathname` is still `/`.
- [ ] A tombstoned agent (lastSeen between T2 and T3) renders with the ⚰ marker, reduced opacity, its last `message`, and a "died … ago" timestamp.
- [ ] Killing the server: within 25 s the pill text contains "unreachable" and the timeline container has the greyed class + a "last synced" stamp; restarting the server restores the pill within 10 s without a manual reload.
- [ ] An ingest via the API produces a visible DOM update (timeline/agent rail) within 2 s with no page reload (SSE path).
- [ ] Esc from `/p/<key>/run/<id>` lands on `/p/<key>` with prior scroll position (state restore).
- [ ] Integration: UI fetches only `/api/v2/*` + `/api/stream` (grep the SPA source for `"/api/` — no legacy v1 paths).

## Estimated size
L.

## Risk
Browser-run UI assertions need a driver — VERIFY uses chrome-devtools-axi (or
Playwright headless) for the DOM ACs; keep them selector-stable via data-testid.

## Non-goals
Run cards, transitions, drill-in, density features (CR-CRU-007); BDD tab content.
