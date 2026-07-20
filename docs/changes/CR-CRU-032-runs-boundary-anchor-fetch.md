# CR-CRU-032 — Patch: `→ Runs` beyond-window boundary reach (anchor-fetch)

**Status:** PENDING
**Type:** patch
**Priority:** P3
**Depends on:** CR-CRU-025 (the `→ Runs` / `cycle-to-runs` affordance + `revealDeclaredMarker`)
**Labels:** patch, ui, runs, navigation, server
**Phase:** Wave 4 (follow-up to CR-025 — user-approved 2026-07-20, option (b))
**Design reference:** user live review 2026-07-20 during CR-025 close-out (Lavish F13):
"what if the run history is not showing the marker because of number of items on
the (Runs tab) active view constraint … what happens if I click the pill of an
old cycle?" — approved **option (b): anchor-fetch the boundary on click** ("it
enables that traversal if the user desires").

## Context
CR-025 §S1's `→ Runs` pill switches to the Runs tab and scrolls the cycle's
declared `⟲ Cycle done` marker into view. But the Runs tab loads only the
**most-recent 50 events** (`GET /api/v2/events?limit=50`, `app.js:156`); the
project currently holds far more (232 at the time of filing). So a cycle whose
boundary is older than that window is not in the feed, and two rough edges show:
1. `revealDeclaredMarker` retries ~30×/150 ms then **silently gives up** — the
   tab switches to Runs but nothing scrolls or blinks.
2. The pill's dim/live gate is `linkedRunsFor(cycleId).length > 0` over the
   loaded 50, and its disabled tooltip reads `"boundary pruned — no runs
   retained"` — **inaccurate** for a boundary that is merely beyond the loaded
   window (not server-pruned).

## Scope

### §S1 Server: anchored events query
Add an anchored/targeted events read so the client can fetch a specific cycle's
boundary + surrounding runs without pulling the whole history — e.g.
`GET /api/v2/events?projectKey=<k>&cycleId=<id>` (returns that cycle's linked
runs + its declared-boundary row) OR an `?anchor=<eventId|cycleId>&around=<n>`
window. Additive, TOON-negotiable like sibling v2 GET routes; existing
`?limit=N` recent-feed behavior unchanged.

### §S2 Client: anchor-fetch on `→ Runs` click
When `cycle-to-runs` is clicked and `[data-testid="declared-marker"][data-cycle-id=<id>]`
is not in the loaded feed after the existing retry budget, the client issues the
§S1 anchored fetch, merges the returned events into the Runs feed (so the marker
mounts), then `scrollIntoView` + `locateBlink` it. A truly-pruned cycle (server
returns no boundary) falls through to §S3.

### §S3 Honest dim state + explicit no-op feedback
- The pill distinguishes **pruned** vs **beyond-window**: `"boundary pruned — no
  runs retained"` ONLY when the server confirms the boundary is gone; otherwise
  the pill stays **live/clickable** (beyond-window is reachable via §S2).
- If the boundary genuinely cannot be located (pruned), the click gives
  **explicit feedback** (inline note / toast) instead of switching tabs and
  doing nothing silently.

## Acceptance criteria
- [ ] §S1: `GET /api/v2/events?…cycleId=<id>` returns that cycle's linked runs + its declared `Cycle done` boundary row (200); an unknown cycleId → empty set (not 4xx); TOON negotiation matches sibling v2 GET routes.
- [ ] §S2: with a cycle whose boundary is OUTSIDE the loaded 50-window but present server-side, clicking `cycle-to-runs` fetches + merges it, and the declared marker is `scrollIntoView`'d + blinks (asserted end-to-end); no silent give-up.
- [ ] §S3 dim semantics: a beyond-window boundary renders the pill LIVE (not dim); a genuinely pruned boundary renders it dim with the accurate "pruned" reason; the two are distinguishable.
- [ ] §S3 feedback: a click that cannot locate a pruned boundary shows explicit user feedback (no bare tab-switch-and-nothing).
- [ ] Regression: the in-window happy path (CR-025 §S1) is byte-unchanged; no extra fetch fires when the marker is already loaded.

## Estimated size
S (one anchored server route + client fetch-merge-then-reveal + the dim-reason split).

## Non-goals
Infinite scroll / virtualization of the Runs feed; changing the default
`?limit=50`; the inverse (`⚑ Cycle`) direction (its target is always the
plan-derived Workflow lens, not the windowed events feed).
