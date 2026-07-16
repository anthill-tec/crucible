# CR-CRU-011 — Cycle plans + workflow lens + agent runtimes

**Status:** COMPLETED (2026-07-16 — gap analysis (4 drifts applied) + C1 plan API + C2 lifecycle/runtimes + C3 Workflow tab + C4 lens/timeline + C5 BDD + C6 VERIFY (READY FOR CLOSE-OUT, zero blocking); final gates 559/559 unit · tsc 0 · 22/22 BDD · coverage 93.0%/93.0%; dog-fooded via its own plan 1 (the first plan ever filed); awaiting merge gate)
**Type:** feature
**Priority:** P1
**Depends on:** CR-CRU-007
**Labels:** ui, workflow, timeline, agents, api, plans
**Phase:** Wave 4 (after 007, BEFORE 008 — reordered round 15 so the fleet upgrade teaches plan verbs in one touch; user-scheduled INTO v0.1.0, round 11)
**Design reference:** board decision ledger "Terminology — Cycle / CR / Wave" (round 10), "Cycle plans" (rounds 14–15); PRD §4.11 transition-marker bullet

## Context
Round-10 terminology lock: a RED→GREEN pair is a **Cycle** (one step in a CR's
execution); **CR groups cycles; Wave groups CRs**. Rounds 14–15 upgraded the
model from INFERRED to DECLARED: the orchestrator **files the cycle plan**
(its todo list) with Crucible, activates cycles as it dispatches, and closes
them explicitly — **a cycle's span completes when the orchestrator confirms the
GREEN; the CR closes when the feature merges** (user-locked round 15). This CR
adds the plan API, the grouped **workflow lens**, and **agent runtimes** — and
closes the lifecycle gap found by the round-11 backwards audit. CR-008 then
encodes the plan verbs in the python/fleet clients for the agentic backend.

### Backwards audit of the agent API (2026-07-15 — what we have vs. the gap)
- HAVE: `firstSeen` persisted at registration/first-heartbeat → the execution
  clock start.
- HAVE: `lastSeen` bumped by every API call (implicit heartbeat); run events
  carry `timestamp` + `duration_ms` per run → latest-state time.
- GAP: `Store.removeAgent` (v1 + v2 unregister) hard-DELETEs the agents row —
  `firstSeen`/`lastSeen` are destroyed at the exact moment the runtime becomes
  final, and tombstone pruning (T3 / lazy prune) loses the crash path too. No
  unregister timestamp is recorded anywhere.

## Scope

### §S0 Cycle-plan API (server, additive — user-locked rounds 14–15)
- `POST /api/v2/projects/<key>/plans` `{cr, wave?, track?, cycles:[{label, kind?}, …]}` →
  201 `{planId, cr, status:"open", cycles:[{id, label, kind, status:"pending"}, …]}` —
  the server assigns **unique numeric cycle ids** (per project). `kind` ∈
  `red-green | verify | fix` (default `red-green`) — **all kinds follow
  IDENTICAL rules** (user-locked round 16): same filing, transitions, span
  semantics, orchestrator-confirmed close. One OPEN plan per `cr` (a second POST
  for the same open CR → 400 naming `cr`); appending cycles to an open plan:
  `POST …/plans/<planId>/cycles {label, kind?}` → new id.
- `PATCH …/plans/<planId>/cycles/<id>` `{status}` — transitions
  `pending → active → done | skipped | failed`, plus the ONE legal shortcut
  `pending → skipped` (C1 clarification: a never-started cycle can be
  cancelled outright — todo semantics; forcing activate-then-skip at plan
  close would be pure ceremony). `pending → done` and `pending → failed`
  remain illegal (both imply execution happened). `done` IS the orchestrator's
  confirmation — GREEN-confirm for `red-green`, report acceptance for `verify`,
  fix-batch-green for `fix` (the span-closing authority — a passing run alone
  never closes a cycle of any kind). Invalid transition → 400 naming both states.
- `PATCH …/plans/<planId>` `{status:"closed", merge?:{commit}}` — the CR close,
  issued on feature merge. Closing a plan with non-terminal cycles → 400 listing
  the open cycle ids (the orchestrator resolves them first).
- **Commit boundary (user-added during CR-007 execution):** `GET …/plans?cr=<cr>`
  responses on closed plans carry a derived read-only `commitBoundary`:
  `{mergeCommit, branch?, firstRunCommit?, lastRunCommit?, closedAt}` — branch
  and run commits derived from the linked runs' `context.git`. This ties
  execution history to the actual code: an orchestrator doing review/code
  analysis asks Crucible for a CR's boundary in one indexed query instead of
  scanning `git log` — then `git show <mergeCommit>` / `git diff
  <firstRunCommit>..<mergeCommit>` directly.
- Run linkage: agents attach `context.cycleId` (numeric) to run/compile ingests;
  the server stores it verbatim (tolerant: unknown ids are stored, surfaced as
  "unlinked" — graceful degradation is sacred; planless projects behave exactly
  as before, `context.cycle` string label stays the fallback).
- **Tracks (user-locked rounds 17+19):** a CR is always executed within a track.
  Tracks are **numbered lanes** (Track 1, 2, 3…; wire format `track-<n>`,
  matching the `WORKFLOW_ROLE` convention) — the highway model: CRs are
  the vehicles, and the mainline allocates lanes from the CRs' depends-on graph.
  In the Model-B multi-track combo, each track's operator registers its track
  with the CR — `track` (string) on the plan. In the single-orchestrator model
  `track` is simply ABSENT and everything works seamlessly (the implicit solo
  track — no required field, no UI noise). The lens sorts Track groups
  numerically.
- Plan mutations emit an SSE change event; plan state is queryable via
  `GET …/plans` (+ `?cr=`, `?track=`) and flows through retention as plan
  records, not test-run events (excluded from run rollups).
- **Forward-compat (round 24, binding):** `plans.cr` is stored VERBATIM — it is
  the stable join key for the 0.2.0 execution-roadmap queue table (CR-CRU-014).
  Nothing in this CR may treat "CRs with plans" as "the full CR list".

### §S0b Timeline plan integration (gap-analysis DRIFT-1 — PRD §4.11 + CR-007 §S2 commitments)
The RUNS timeline (home + workspace) consumes plans directly:
1. **Marker suppression:** runs linked via `context.cycleId` NEVER produce
   inferred (streak-heuristic) transition markers — the declared plan is the
   boundary authority (CR-007 §S2's "interim heuristic only" clause resolves
   here). Unlinked runs keep the heuristic unchanged.
2. **Declared markers inline:** a cycle transitioning to `done` renders a
   declared marker row on the timeline (same structural weight as the
   heuristic marker): `<kind glyph> Cycle done · <label> · <cr> · closed in
   <duration>` where duration = active→done span; the ACTIVE cycle renders as
   an open span header above its linked runs (PRD: "the timeline renders the
   plan inline — active cycle = open event span").
3. Planless projects: timeline byte-identical to pre-CR-011 (regression-guarded).

### §S1 Agent lifecycle events (server, additive)
Registration and unregistration append **lifecycle events** to the project's
event log (`kind: "lifecycle"`, `action: "registered" | "unregistered"`,
`agentId`, timestamp; unregister also snapshots `firstSeen` so runtime survives
row deletion). `removeAgent` behavior is otherwise unchanged (row still deleted;
`changed` semantics preserved). Lifecycle events flow through retention like any
event and are EXCLUDED from test-run rollup counts.

### §S2 Agent runtime computation + display
Runtime rule (user-specified): unregistered → `unregistered_ts − firstSeen`;
still live → `now − firstSeen` (ticking); never unregistered and no longer live
(tombstoned/pruned) → `last run timestamp − firstSeen`. Shown on: workspace
Project-pane agent sub-rows (live: ticking; tombstones: sealed), and cycle/CR
groups in the lens (§S3).
**Feed rendering (gap-analysis DRIFT-4):** lifecycle events do NOT render as
cards on the Runs timeline in 0.1.0 — they exist for runtime computation (and
the §S3 lens); rendering register/unregister rows at agent-per-cycle cadence
would be feed noise. (CR-CRU-013's workflow journal may surface them later.)

### §S3 Workflow tab (live view + history lens; round-22 arrangement)
The workspace gains a dedicated **Workflow tab** (`L.workspaceTabs` becomes
`Runs · Workflow · Coverage · Compile · BDD` — updating the CR-007 §S5 tab AC's
expected list from this CR onward, INCLUDING the CR-016-era tests that
enumerate tabs; the earlier Runs-tab `flat|workflow` toggle idea is
superseded). **CR-016 pane-state contracts bind to it (gap-analysis
DRIFT-3):** clicking a linked run in the active todo view or lens swaps the
WORKFLOW pane to the run detail per the one-rule (no tab switch), the tabs
row hides while that detail is open, and the back chip reads `← workflow`;
close restores the Workflow pane with tab `on` and exact scroll. Two
sections:
1. **Active workflow (live):** the current open plan(s) rendered as a
   **per-CR todo view** — cycles as todo rows with their statuses
   (pending / active ▶ / done ✓ / skipped / failed ✗), the ACTIVE cycle
   expanded to show its `context.cycleId`-linked runs live over SSE. Beside it,
   a **gate pane** placeholder (populated by CR-CRU-013's no-mistakes pane;
   until then it renders "gate reporting lands in CR-013").
2. **History lens:** the grouped lens below —
   **Wave → [Track] → CR → Cycle** hierarchy — the Track level
renders ONLY when a wave contains plans from more than one distinct track
(multi-track Model-B); otherwise it is omitted entirely (single-orchestrator
seamlessness, round 17). CR groups carry a track badge whenever `track` is
present. **Declared-plan first**:
where a §S0 plan exists, the tree IS the plan — todos with cycles as sub-items;
the ACTIVE cycle renders as an **open event span** collecting its runs
(`context.cycleId` linkage) live; `done` (orchestrator GREEN-confirm) closes the
span; the plan's `closed` (merge) seals the CR group with the merge commit.
**Inferred fallback** where no plan exists: Wave from `context.wave`, CR from
the agent stem, Cycle = the CR-007 §S2 marker pairing labeled by
`context.cycle`. Each group row shows rollups: cycles count (done/total for
plans), RED→GREEN durations, participating agents + runtimes, final regression
state. Runs lacking any linkage degrade gracefully into an "ungrouped" tail —
never hidden.
**Wave boundary (user semantics, round 20 — no new track surface, no new
API):** the wave is the synchronization boundary — all lanes pause when their
individual queues complete; the next wave launches after design reviews. The
lens INFERS wave state from plan states: `running` (≥1 open plan in the wave) →
`lanes complete · awaiting review` (every plan in the wave closed, and no later
wave has plans yet — the boundary pause made visible) → superseded (a newer
wave opened). Multi-track wave group headers carry per-lane completion chips
(`track-1 ✓ · track-2 2/3`). Tracks get NO dedicated surface — they are
transient allocation lanes within a wave; the conditional Track level + badges
is their whole UI.

## Acceptance criteria
- [x] §S0: `POST /plans {cr:"CR-X-1", cycles:[{label:"a"},{label:"b"}]}` → 201 with two distinct numeric ids, statuses `pending`, plan `open`; a second POST for `cr:"CR-X-1"` while open → 400 naming `cr`.
- [x] §S0: cycle transitions — `pending→active→done` succeed; `pending→done` (skipping active) → 400 naming both states; a GREEN run ingest linked via `context.cycleId` does NOT change the cycle's status (orchestrator-explicit close asserted).
- [x] §S0: kinds — cycles filed with `kind:"verify"` and `kind:"fix"` behave identically to `red-green` (same transition table, same span/run-linkage, asserted by running the transition AC parameterized over all three kinds); omitted `kind` defaults to `red-green`; `kind:"deploy"` → 400 naming `kind`.
- [x] §S0/§S3: tracks — two open plans in the same wave with `track:"track-1"` / `track:"track-2"` render a Track level between Wave and CR in the lens (both groups present, CR groups badged); a wave whose plans all lack `track` renders NO track level and is byte-identical to the pre-track lens output (single-orchestrator seamlessness); `GET /plans?track=track-2` returns only that track's plans.
- [x] §S3: wave boundary — with wave 1 plans all `closed` and no wave 2 plans, the wave-1 group header shows `lanes complete · awaiting review`; filing a wave-2 plan flips wave 1 out of the boundary state; while any wave-1 plan is open the header shows per-lane completion chips (fixture: track-1 closed, track-2 1-of-2 → `track-1 ✓ · track-2 1/2`). No wave API exists (state is inferred from plans only — grep asserts no wave route).
- [x] §S0: `PATCH /plans/<id> {status:"closed", merge:{commit:"abc1234"}}` with a non-terminal cycle → 400 listing its id; after all cycles are terminal it succeeds and `GET /plans?cr=CR-X-1` shows `closed` + the merge commit.
- [x] §S0 commit boundary: a closed plan whose linked runs carried `context.git {branch:"feat/x", commit:…}` returns `commitBoundary` with `mergeCommit:"abc1234"`, `branch:"feat/x"`, and `firstRunCommit`/`lastRunCommit` equal to the earliest/latest linked-run commits; a closed plan with NO linked git context returns `commitBoundary` with only `mergeCommit` + `closedAt` (absent fields omitted, not null).
- [x] §S0: a run ingested with an unknown `context.cycleId` is stored and surfaces as "unlinked" in the lens (never dropped, never 4xx); a planless project's ingest behavior is byte-identical to pre-CR-011 (regression-guarded).
- [x] `POST /api/v2/agents/register` then unregister appends two lifecycle events (`action:"registered"`, `action:"unregistered"`) visible via `GET /api/v2/events?project=…`; the unregistered event carries `firstSeen` and yields `runtime_ms = unregistered.timestamp − firstSeen` exactly.
- [x] Lifecycle events never alter test-run rollups: project rollup counts (runs, pass/fail) are identical before/after a register+unregister pair.
- [x] An agent that ingests runs and is then tombstone-pruned (no unregister): its runtime renders as `lastRunTimestamp − firstSeen` (AC fixture: register at t0, runs at t0+10s and t0+60s, prune → runtime 60s).
- [x] Workspace Project pane: a live agent row shows a ticking runtime (`firstSeen`-anchored); a tombstoned row shows a sealed runtime.
- [x] Workflow tab: `L.workspaceTabs` returns exactly `["Runs","Workflow","Coverage","Compile","BDD"(per type)]`; the tab's ACTIVE section renders the open plan as a per-CR todo view — cycle rows with status glyphs, the `active` cycle expanded with its `context.cycleId`-linked runs appearing live over SSE (no reload), and a gate-pane placeholder element present; the HISTORY section renders the plan tree — `done` cycles as closed spans; without a plan, a fixture with 2 waves × 2 CRs × 2 cycles renders the inferred tree with `context.cycle` labels; unlinked/context-less events land in an "ungrouped" tail (count asserted), never dropped.
- [x] §S0b timeline plan integration: with an open plan and a cycle `active`, ingesting fail(2/5) then pass(5/5) runs linked via `context.cycleId` renders NO inferred transition marker (the streak heuristic is suppressed for linked runs — count asserted zero) and the timeline shows the active cycle's open-span header above its linked runs; PATCHing the cycle `done` renders the declared marker row containing the cycle label, the cr, and the active→done duration; the same fail/pass pair WITHOUT cycleId still yields exactly one heuristic marker (fallback intact); a planless project's timeline output is unchanged (regression-guarded).
- [x] §S3 CR-016 binding: with the Workflow tab active and the plan's active cycle expanded, clicking a linked run swaps the WORKFLOW pane to the run detail (`workspace-tabs` absent, back chip text `← workflow`, no tab switch); closing restores the Workflow pane with its tab `on` and prior scroll; the tab-list assertions across CR-007/CR-016-era tests are updated to the five-tab list under this CR's sanctioned re-target.
- [x] §S1/§S2 feed exclusion: lifecycle events never render cards on the Runs timeline (fixture: register+unregister around two runs → exactly two `event-card`s); agent runtime values render per the §S2 rule on the pane rows.
- [x] BDD E2E (house style): `tests/e2e/features/workflow.feature` — scenarios: file a plan via API → activate cycle 1 → register agent → ingest fail/pass with `context.cycleId` → PATCH cycle done → close plan with merge commit → the lens shows the plan tree with the closed span, cycle label, merge commit, and the sealed agent runtime; plus a timeline scenario asserting suppression + the declared marker; results ingested `tier:"e2e"`.

## Gap analysis (2026-07-16, pre-RED — verdict SPEC_UPDATE_NEEDED, applied in this commit)
- DRIFT-1 (blocking): timeline plan integration (PRD §4.11:275 inline-plan
  rendering + CR-007 §S2 marker suppression for cycleId-linked runs) was
  absent — added as §S0b + AC.
- DRIFT-2: E2E AC named `workflow.e2e.ts` — superseded by the BDD house style
  (CR-007 C5b); now `workflow.feature` (sorts after shell-storyboard.feature,
  no ordering project needed; root fix remains CR-015 §S0).
- DRIFT-3: CR-016 pane-state contracts (one-rule, tabs-hide, `← workflow`
  chip) now bind to the Workflow tab; tab-list re-targets sanctioned.
- DRIFT-4: lifecycle-event feed rendering was undefined — excluded from the
  Runs feed in 0.1.0 (runtime computation + lens only), board-flagged for veto.
- Verified clean: `?project=` param matches ACs; `RunContext.cycleId` purely
  additive (cycle label exists, types.ts:86-96); agents.firstSeen/lastSeen
  present and removeAgent hard-deletes (store.ts:322 — the audit's gap is
  real); plans reuse store.onChange→SSE and pairTransitions stays the
  inferred fallback; plans/cycles are NEW tables independent of event
  retention (closed plans persist as the workflow record); no symbol
  removals; the "flat|workflow toggle" superseded idea was never built.

## Cycle plan
- C1: §S0 plan API — tables, routes, transitions, kinds, one-open-per-cr,
  commitBoundary, SSE, cycleId linkage (RED → GREEN).
- C2: §S1 lifecycle events + §S2 runtimes (server + pane rows + feed
  exclusion).
- C3: §S3 Workflow tab — active todo view + gate placeholder + CR-016
  bindings (tabs list update, one-rule, `← workflow`).
- C4: §S3 history lens (Wave → [Track] → CR → Cycle, inferred fallback,
  ungrouped tail, wave states) + §S0b timeline integration (suppression +
  declared markers/spans).
- C5: BDD workflow.feature + integration ACs sweep.
- C6: VERIFY → close-out (regression --coverage) → merge gate.

## Estimated size
L (grew with the §S0 plan API fold-in, round 15).

## Risk
Grouping heuristics on partial context — mitigated by the graceful "ungrouped"
tail rule (nothing is ever hidden by the lens).

## Non-goals
Cross-project workflow views; editing/annotating cycles from the UI; filter bar.
