# CR-CRU-120 — an active cycle's runs are not reachable

**Status:** PENDING (0.2.0 — born mid-release, D4)
**Type:** bugfix
**Priority:** P2
**Depends on:** CR-CRU-032 (the anchor-fetch mechanism this CR extends), CR-CRU-025 (cycle↔run
boundary navigation), CR-CRU-011 (the open-span rendering this CR does not change)
**Labels:** bugfix, ui, runs, navigation
**Phase:** Wave 6 (0.2.0 — user-directed, live orchestrator session 2026-09-12)
**Design reference:** CR-CRU-032 §S1–§S3 (the anchor-fetch machinery); CR-CRU-011 §S0b/§S6 #3 (the
open-span rendering this CR does not alter)

## Context

User-reported 2026-09-12: drilling from a cycle to one of its test runs works only after the CR
closes; while the CR is active, the same drill-through does nothing.

Traced in code, not reproduced live. Every run-click handler
(`InlineRunEntry`/`EventCard`/`LinkedRunRow` → `openDrillin(e.id)` → `RunDetailBody`'s
`GET /api/v2/events/:id?depth=suites`) is unconditional — no cycle/CR status gate exists anywhere
on the click path or the server route (`handleEventGet`, `src/v2.ts:3455`). The defect is
**visibility, not clickability**: every one of those rows only renders when its run already sits in
`state.events`, the client's capped, polled cache (`refetchCore`, `app.js:283-297`,
`limit=<project.retention>`, refetched wholesale every 5s). If a cycle's linked run has aged out of
that window — or the 5s poll simply hasn't caught up yet — nothing renders and there is nothing to
click.

CR-CRU-032 §S2 already solved exactly this for a **completed** cycle: the `→ Runs` badge
(`CycleToRunsBadge`, `app.js:4016-4063`) triggers `anchorFetchRuns` (`app.js:3966-4003`), which
calls `GET /api/v2/events?project=<key>&cycleId=<id>` (`handleEventsList`, `src/v2.ts:3407-3419`) —
a targeted, cycleId-scoped fetch that bypasses the retention window entirely — and merges the
result into `state.events` so the run reappears.

That recovery path is gated to completed cycles only, by design (CR-CRU-032 §S2's own spec text:
*"When `cycle-to-runs` is clicked and `[data-testid="declared-marker"]…"*, the DOM node
`DeclaredMarkerRow` renders only for `cycle.status ∈ {done, skipped, failed}`). It was never a gap
in CR-032 — an active cycle's own boundary marker (`CycleSpanOpenRow`, `app.js:1064-1068`, rendered
for `cycle.status === "active"` on the Runs timeline) simply didn't exist as a concept CR-032 was
asked to cover. The server side has no such restriction: `handleEventsList`'s `cycleId` branch
(`src/v2.ts:3407-3419`) and `store.listEventsForCycle`/`findCyclePlanEntry` carry no status check —
an active cycle's linked runs are answered identically to a completed one's. The gap is entirely in
the client: which cycles get the recovery affordance at all.

**Surfaces (verified 2026-09-12):**
- `CycleToRunsBadge`'s render gate, `cycleIsCompleted(cycle)` (`app.js:4134-4135`), used at
  `app.js:4185` (`CycleRow`, the Active-workflow panel) and `app.js:4411` (`LensCycleRow`, the
  Workflow History tree).
- `revealDeclaredMarker`'s DOM search (`app.js:3939-3958`) only recognises
  `[data-testid="declared-marker"][data-cycle-id]`.
- `CycleSpanOpenRow` (`app.js:1064-1068`) carries no `data-cycle-id`, unlike `declared-marker`
  (`app.js:1101-1105`, added by CR-CRU-025 §S1/§S2) and `lens-cycle-row` (`app.js:4382-4387`,
  already carries `data-cycle-id`).
- `anchorFetchRuns` (`app.js:3966-4003`): when the fetch returns zero events AND the server DID
  resolve the cycle (`body.cycle` present — the genuinely-not-pruned, genuinely-empty case), the
  function falls through silently (no merge, no `state.anchorFeedback`, no visible reaction). This
  branch is rarely hit for a completed cycle (a finished cycle usually has ≥1 run); this CR makes it
  common (an active cycle that just activated has zero runs by construction), so it needs honest
  feedback distinct from "pruned".

## Scope

### §S1 An active cycle's boundary is locatable on the Runs timeline

`CycleSpanOpenRow` (`app.js:1064-1068`) gains `"data-cycle-id": cycle.id`, mirroring
`declared-marker`'s existing attribute. Purely additive — no rendered content changes.

### §S2 The `→ Runs` recovery badge covers an active cycle, not only a terminal one

Both `CycleToRunsBadge` call sites — `CycleRow` (`app.js:4185`) and `LensCycleRow`
(`app.js:4411`) — extend their render condition from `cycleIsCompleted(cycle)` to
`cycleIsCompleted(cycle) || cycle.status === "active"`. A `pending` cycle (never activated,
guaranteed zero runs) still gets nothing: the badge exists only where runs could plausibly exist.

### §S3 The reveal mechanism recognises an active cycle's own boundary

`revealDeclaredMarker` (`app.js:3939-3958`) extends its DOM query: when no
`[data-testid="declared-marker"][data-cycle-id=<id>]` is found, it also tries
`[data-testid="cycle-span-open"][data-cycle-id=<id>]` (added by §S1) before falling through to the
retry budget and, eventually, the anchor-fetch. Either match scrolls + blinks identically — the
function does not need to know which kind of boundary it found. The retry budget (30 attempts × 5ms)
and the `anchored` single-fetch guard (`app.js:3957`) are unchanged.

**Verified mechanism (2026-09-12, read not assumed):** `timelineRows` (`app-logic.mjs:761-777`)
emits `cycle-span-open` (like `declared-marker`) ONLY while iterating an event it finds linked to
that cycle — the row does not exist independent of `state.events` holding at least one such event,
for either boundary kind. This CR does NOT change that gating (CR-CRU-011 §S6 #3's
no-container-when-empty rule stays exactly as shipped). The fix works because the anchor-fetch's
merge (`anchorFetchRuns`, `app.js:3966-4003`) puts a genuinely linked event into `state.events`,
which makes `timelineRows` emit `cycle-span-open` on the NEXT render — the identical mechanism
CR-CRU-032 already relies on to mount `declared-marker` for a beyond-window completed cycle. No new
causal path is introduced; §S1's `data-cycle-id` addition only makes the row queryable once it
mounts by the SAME route.


### §S4 A cycle that genuinely has zero runs yet gets honest feedback, not silence

`anchorFetchRuns` (`app.js:3966-4003`): when the fetch returns `fetched.length === 0` AND
`body.cycle` is present (the cycle resolves server-side — not the "pruned" signal, which is
`body.cycle === undefined`), set feedback distinct from the pruned message: this cycle exists and
has ingested no runs yet. `state.anchorFeedback` becomes `{cycleId, kind}` (`kind: "pruned" |
"empty"`) instead of a bare cycleId; `AnchorFetchFeedback` (`app.js:2028-2035`) renders the message
matching `kind`. This branch was previously silent for a completed cycle too (a real but rare
pre-existing gap, not touched by this CR beyond adding the discriminator neither branch had); §S2
makes it common by extending the badge to active cycles, so it must not stay a dead end.

### §S5 Anchor-fetch already answers an active cycle correctly (regression pin, no server change)

No server code changes — `handleEventsList`'s `cycleId` branch (`src/v2.ts:3407-3419`) already
carries no status filter. A regression test pins this so a future change cannot narrow it to
terminal cycles only.

### Implementation note (2026-09-12, RED, cycle 422)

§S2's "both `CycleRow` and `LensCycleRow`" cannot be driven from ONE plan: `workflowLens`
(`app-logic.mjs:930-933`, CR-CRU-020 §S1.3) renders History for **closed** plans only, while the
Active panel (`app.js:4218`) renders **open** plans only. An active cycle lives in an open plan, so
it structurally cannot appear at both sites simultaneously. RED drove the same shared predicate
through both sites under the two plan statuses that actually reach each one — an OPEN plan for
`CycleRow`, and a plan CLOSED while one cycle is still `active` for `LensCycleRow` (a case
`LensCycleRow`'s own `expandable` predicate already contemplates). Both call sites remain genuinely
exercised; §S2's ACs below are satisfied by this reading.

Also noted by RED, not an AC (no requirement names it, so none is invented): `workflowLens` marks
an **inferred** cycle (no plan, no `id`) `active` whenever its latest run failed
(`app-logic.mjs:903`). Widening `CycleToRunsBadge`'s gate to `active` hands it a second class of
id-less rows whose `live` gate is already false — a pill that renders but does nothing, identical
to the pre-existing dead pill an inferred `done` cycle already reaches under CR-CRU-025. Pre-existing,
not worsened in kind, but doubled in surface. GREEN's call whether to additionally gate on `cycle.id
!== undefined`; no AC requires it.


## Acceptance criteria

**§S1**
- [ ] `CycleSpanOpenRow`'s rendered DOM node carries `data-cycle-id` equal to the cycle's numeric id,
      asserted against a real cycle activated via `cycle-activate`.

**§S2**
- [ ] With a plan holding one `active` cycle and one `pending` cycle: the active cycle's row (both in
      `CycleRow`/Active-workflow panel and `LensCycleRow`/Workflow History) renders a `→ Runs` badge
      (`data-testid="cycle-to-runs"`); the pending cycle's row renders none.
- [ ] A `done`/`skipped`/`failed` cycle keeps its badge unchanged (regression pin — the
      `cycleIsCompleted` branch is additive, not replaced).

**§S3**
- [ ] Given an active cycle whose linked run is NOT in the currently-loaded `state.events` (simulated
      by seeding the run directly via the server, bypassing the client poll) and the Runs tab is not
      yet showing it: clicking the active cycle's `→ Runs` badge locates
      `[data-testid="cycle-span-open"][data-cycle-id=<id>]`, `scrollIntoView`s it, and applies the
      10s locate-blink class — asserted end-to-end (e2e or a DOM-level test driving the real click
      handler), not by calling `revealDeclaredMarker` directly.
- [ ] The retry budget and single-anchor-fetch guard behave identically to the completed-cycle path:
      the anchor-fetch fires at most once per click (assert call count), and the in-window happy path
      (run already cached) fires zero extra fetches.

**§S4**
- [ ] An active cycle with genuinely zero linked runs: clicking its `→ Runs` badge sets
      `state.anchorFeedback` to a value whose `kind` is `"empty"` (not `"pruned"`), and
      `AnchorFetchFeedback` renders a distinct message naming that no runs have been recorded for
      this cycle yet — never the "pruned from the retained timeline" text.
- [ ] A genuinely pruned cycle (server returns no `cycle` field) still renders the existing pruned
      message verbatim — regression pin on CR-CRU-032 §S3's wording.
- [ ] `AnchorFetchFeedback`'s reactive binding is keyed off `state.anchorFeedback?.cycleId` +
      `.kind` (both read), asserted by triggering both feedback kinds in one test session and
      confirming the DOM text differs.

**§S5**
- [ ] `GET /api/v2/events?project=<key>&cycleId=<id>` against an `active` cycle's id returns that
      cycle's linked runs in `events` and its `PlanCycle` shape in `cycle`, asserted with the SAME
      shape-equality check used for a `done` cycle's id (one shared assertion helper, two statuses
      driven through it) — so a future change narrowing the route to terminal cycles fails this test
      before it fails a user.

**Integration**
- [ ] Both `CycleToRunsBadge` call sites (`CycleRow`, `LensCycleRow`) are driven by the SAME extended
      predicate — asserted by a single exported/shared boolean function (not two independently
      edited conditionals), so the two sites cannot drift out of sync again.

## Estimated size

S — one cycle. Three additive client-side changes (a DOM attribute, a widened render predicate reused
at two call sites, a reveal-target fallback) plus one feedback-message discriminator; no server
change, no new route, no new fetch mechanism (reuses `anchorFetchRuns`/`revealDeclaredMarker`
verbatim).

## Risk

- **Reused, not reinvented.** This CR adds zero new fetch/merge machinery — it only widens which
  cycles are offered the existing CR-CRU-032 path. The dominant risk is the two `CycleToRunsBadge`
  call sites drifting to different predicates again after this ships; the Integration AC exists
  specifically to prevent that.
- **`state.anchorFeedback`'s shape change** (bare cycleId → `{cycleId, kind}`) is a breaking change
  to that one reactive slot. Grepped: it is read only at `app.js:2029-2030` (`AnchorFetchFeedback`)
  and written only at `app.js:3992`/`4056` (`anchorFetchRuns`/`CycleToRunsBadge`) — three call sites,
  all touched by this CR, no fourth consumer exists.

## Non-goals

- Changing `OpenSpan`'s CR-CRU-011 §S6 #3 no-container-when-empty rendering — the Workflow pane's
  inline active-cycle view stays exactly as shipped; this CR adds a recovery *affordance* beside it,
  it does not change when the inline view itself renders.
- Fixing the pre-existing completed-cycle "empty and not pruned" silent no-op as a standalone
  defect — §S4 fixes it because §S2 makes it common, but no AC here re-litigates whether a
  completed, genuinely-run-less cycle should have surfaced this earlier.
- Changing the 5s poll interval, the retention default, or any server-side retention/rollup
  behaviour (PRD §4.7) — this CR is a client-side recovery-path gap, not a caching-policy change.
- Virtualizing or infinite-scrolling the Runs feed (already a CR-CRU-032 non-goal, unaffected here).
