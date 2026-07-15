# CR-CRU-011 — Workflow lens: Wave → CR → Cycle grouping + agent runtimes

**Status:** PENDING
**Type:** feature
**Priority:** P1
**Depends on:** CR-CRU-007, CR-CRU-008
**Labels:** ui, workflow, timeline, agents, api
**Phase:** Wave 4 (after 007/008, before 009 — user-scheduled INTO v0.1.0, board round 11, 2026-07-15)
**Design reference:** board decision ledger "Terminology — Cycle / CR / Wave" (round 10) + register row "Workflow lens" (rescheduled round 11); PRD §4.11 transition-marker bullet

## Context
Round-10 terminology lock: a RED→GREEN pair is a **Cycle** (one step in a CR's
execution); **CR groups cycles; Wave groups CRs**. Crucible shows the
implementation workflow, not just test runs. CR-007 renders labeled cycle markers
(`context.cycle`) + wave/CR badges; CR-008 makes the fleet clients send
`context.cycle`. This CR adds the grouped **workflow lens** over the same data,
plus **agent runtimes** — and closes the lifecycle gap found by the round-11
backwards audit of the agent API.

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

### §S3 Workflow lens view
A grouped lens over the workspace Runs timeline (toggle in the Runs tab header:
`flat | workflow`): **Wave → CR → Cycle** hierarchy. Wave from `context.wave`;
CR from the agent stem (fallback) or `context` when richer; Cycle = the CR-007
§S2 marker pairing, labeled by `context.cycle`. Each group row shows rollups:
cycles count, RED→GREEN durations, participating agents + runtimes, final
regression state. Runs lacking context degrade gracefully into an "ungrouped"
tail — never hidden.

## Acceptance criteria
- [ ] `POST /api/v2/agents/register` then unregister appends two lifecycle events (`action:"registered"`, `action:"unregistered"`) visible via `GET /api/v2/events?project=…`; the unregistered event carries `firstSeen` and yields `runtime_ms = unregistered.timestamp − firstSeen` exactly.
- [ ] Lifecycle events never alter test-run rollups: project rollup counts (runs, pass/fail) are identical before/after a register+unregister pair.
- [ ] An agent that ingests runs and is then tombstone-pruned (no unregister): its runtime renders as `lastRunTimestamp − firstSeen` (AC fixture: register at t0, runs at t0+10s and t0+60s, prune → runtime 60s).
- [ ] Workspace Project pane: a live agent row shows a ticking runtime (`firstSeen`-anchored); a tombstoned row shows a sealed runtime.
- [ ] Runs-tab toggle `flat | workflow`: workflow mode groups events Wave → CR → Cycle; a fixture with 2 waves × 2 CRs × 2 cycles renders exactly that tree with cycle labels from `context.cycle`; context-less events land in an "ungrouped" tail (count asserted), never dropped.
- [ ] E2E: `tests/e2e/workflow.e2e.ts` — register → ingest fail/pass with `context.{wave, cycle}` → unregister via API; the lens shows the Wave → CR → Cycle group with the cycle label and the sealed agent runtime; results ingested `tier:"e2e"`.

## Estimated size
M.

## Risk
Grouping heuristics on partial context — mitigated by the graceful "ungrouped"
tail rule (nothing is ever hidden by the lens).

## Non-goals
Cross-project workflow views; editing/annotating cycles from the UI; filter bar.
