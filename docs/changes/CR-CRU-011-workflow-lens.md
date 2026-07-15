# CR-CRU-011 — Cycle plans + workflow lens + agent runtimes

**Status:** PENDING
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
  `pending → active → done | skipped | failed`. `done` IS the orchestrator's
  confirmation — GREEN-confirm for `red-green`, report acceptance for `verify`,
  fix-batch-green for `fix` (the span-closing authority — a passing run alone
  never closes a cycle of any kind). Invalid transition → 400 naming both states.
- `PATCH …/plans/<planId>` `{status:"closed", merge?:{commit}}` — the CR close,
  issued on feature merge. Closing a plan with non-terminal cycles → 400 listing
  the open cycle ids (the orchestrator resolves them first).
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

### §S3 Workflow tab (live view + history lens; round-22 arrangement)
The workspace gains a dedicated **Workflow tab** (`L.workspaceTabs` becomes
`Runs · Workflow · Coverage · Compile · BDD` — updating the CR-007 §S5 tab AC's
expected list from this CR onward; the earlier Runs-tab `flat|workflow` toggle
idea is superseded). Two sections:
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
- [ ] §S0: `POST /plans {cr:"CR-X-1", cycles:[{label:"a"},{label:"b"}]}` → 201 with two distinct numeric ids, statuses `pending`, plan `open`; a second POST for `cr:"CR-X-1"` while open → 400 naming `cr`.
- [ ] §S0: cycle transitions — `pending→active→done` succeed; `pending→done` (skipping active) → 400 naming both states; a GREEN run ingest linked via `context.cycleId` does NOT change the cycle's status (orchestrator-explicit close asserted).
- [ ] §S0: kinds — cycles filed with `kind:"verify"` and `kind:"fix"` behave identically to `red-green` (same transition table, same span/run-linkage, asserted by running the transition AC parameterized over all three kinds); omitted `kind` defaults to `red-green`; `kind:"deploy"` → 400 naming `kind`.
- [ ] §S0/§S3: tracks — two open plans in the same wave with `track:"track-1"` / `track:"track-2"` render a Track level between Wave and CR in the lens (both groups present, CR groups badged); a wave whose plans all lack `track` renders NO track level and is byte-identical to the pre-track lens output (single-orchestrator seamlessness); `GET /plans?track=track-2` returns only that track's plans.
- [ ] §S3: wave boundary — with wave 1 plans all `closed` and no wave 2 plans, the wave-1 group header shows `lanes complete · awaiting review`; filing a wave-2 plan flips wave 1 out of the boundary state; while any wave-1 plan is open the header shows per-lane completion chips (fixture: track-1 closed, track-2 1-of-2 → `track-1 ✓ · track-2 1/2`). No wave API exists (state is inferred from plans only — grep asserts no wave route).
- [ ] §S0: `PATCH /plans/<id> {status:"closed", merge:{commit:"abc1234"}}` with a non-terminal cycle → 400 listing its id; after all cycles are terminal it succeeds and `GET /plans?cr=CR-X-1` shows `closed` + the merge commit.
- [ ] §S0: a run ingested with an unknown `context.cycleId` is stored and surfaces as "unlinked" in the lens (never dropped, never 4xx); a planless project's ingest behavior is byte-identical to pre-CR-011 (regression-guarded).
- [ ] `POST /api/v2/agents/register` then unregister appends two lifecycle events (`action:"registered"`, `action:"unregistered"`) visible via `GET /api/v2/events?project=…`; the unregistered event carries `firstSeen` and yields `runtime_ms = unregistered.timestamp − firstSeen` exactly.
- [ ] Lifecycle events never alter test-run rollups: project rollup counts (runs, pass/fail) are identical before/after a register+unregister pair.
- [ ] An agent that ingests runs and is then tombstone-pruned (no unregister): its runtime renders as `lastRunTimestamp − firstSeen` (AC fixture: register at t0, runs at t0+10s and t0+60s, prune → runtime 60s).
- [ ] Workspace Project pane: a live agent row shows a ticking runtime (`firstSeen`-anchored); a tombstoned row shows a sealed runtime.
- [ ] Workflow tab: `L.workspaceTabs` returns exactly `["Runs","Workflow","Coverage","Compile","BDD"(per type)]`; the tab's ACTIVE section renders the open plan as a per-CR todo view — cycle rows with status glyphs, the `active` cycle expanded with its `context.cycleId`-linked runs appearing live over SSE (no reload), and a gate-pane placeholder element present; the HISTORY section renders the plan tree — `done` cycles as closed spans; without a plan, a fixture with 2 waves × 2 CRs × 2 cycles renders the inferred tree with `context.cycle` labels; unlinked/context-less events land in an "ungrouped" tail (count asserted), never dropped.
- [ ] E2E: `tests/e2e/workflow.e2e.ts` — file a plan via API → activate cycle 1 → register agent → ingest fail/pass with `context.cycleId` → PATCH cycle done → close plan with merge commit → the lens shows the plan tree with the closed span, cycle label, merge commit, and the sealed agent runtime; results ingested `tier:"e2e"`.

## Estimated size
L (grew with the §S0 plan API fold-in, round 15).

## Risk
Grouping heuristics on partial context — mitigated by the graceful "ungrouped"
tail rule (nothing is ever hidden by the lens).

## Non-goals
Cross-project workflow views; editing/annotating cycles from the UI; filter bar.
