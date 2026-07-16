# CR-CRU-019 — Patch: workflow-review tweak accumulator

**Status:** IN_PROGRESS (2026-07-16 — scope froze at CR-CRU-011's merge
(5b913bf) with §P1 as the sole item; user-directed kickoff WITH a Crucible
plan filed from the start; branch feature/CR-CRU-019)
**Type:** patch
**Priority:** P2
**Depends on:** CR-CRU-011 (declared spans must exist)
**Labels:** patch, timeline, client, linkage
**Phase:** Wave 4 (immediately after 011, before 008)

## Context
Per the patch-CR process rule (locked 2026-07-16): scope arriving while a CR
executes goes into a patch CR instead of growing the executing CR inline.
This is the accumulator for tweaks filed during CR-CRU-011's execution.

## Scope

### §P1 Cycle-boundary placement (user-filed 2026-07-16, screenshot: full-suite gate run lands outside its cycle)
**Finding:** the C1 GREEN cycle's marker rendered between the targeted
`24/24` pass and the later full-suite `524/524` gate run — the gate run sits
visually outside the cycle that produced it.
**Investigation verdict (orchestrator, data-confirmed):** neither a Crucible
defect nor an agent-reporting defect. The streak heuristic (CR-007 §S2,
user-locked: marker at the FIRST pass closing a maximal failing streak)
behaved exactly as specified; every run carried `context: none`, so no
linkage existed. The heuristic cannot attribute post-boundary passes to a
cycle — only declared linkage can.
**Fix (prescribed): pull the minimal linkage last-mile forward from
CR-CRU-008 so dog-fooding gets declared cycles the moment 011 merges:**
1. Server (additive): the v1 shim `/api/ingest/parsed` passes an optional
   `context{}` through verbatim (today it forwards only `tier` — confirmed
   in CR-011 C1; the v2 paths already carry context).
2. Client (`bun-crucible.py`, hotfix-tier change formalized later by 008):
   `test`/`regression` attach `context.cycleId` from `WORKFLOW_CYCLE_ID`,
   `context.cycle` from `WORKFLOW_CYCLE`, and `context.git
   {branch, commit}` from a cheap `git rev-parse` when inside a repo.
3. Orchestrator procedure: file a §S0 plan per CR, export
   `WORKFLOW_CYCLE_ID` to dispatched agents — the screenshot scenario then
   renders as ONE declared span containing the failing streak, the targeted
   pass, AND the full-suite gate run, with the inferred marker suppressed
   (§S0b).
**Alternative recorded, not recommended:** amend the streak heuristic to
place the marker after the LAST consecutive same-stem pass — changes locked
semantics and still guesses; declared linkage is the honest fix.

#### Acceptance criteria (§P1)
- [ ] `POST /api/ingest/parsed` with `context:{cycleId: 3, cycle:"x",
  git:{branch:"b",commit:"c"}}` stores the context verbatim on the event
  (asserted via the events listing); omitted context unchanged.
- [ ] `bun-crucible.py test` and `regression` with `WORKFLOW_CYCLE_ID=3
  WORKFLOW_CYCLE="checkpoint persistence"` set attach
  `context.cycleId === 3` + `context.cycle` (and `context.git` inside a
  repo); unset env → no context keys (byte-identical payload).
- [ ] Dog-food proof: with an open plan, an active cycle, and linked RED →
  targeted-GREEN → full-suite runs, the timeline renders the declared span
  containing ALL THREE runs and NO inferred marker (the screenshot scenario,
  fixed).

## Gap analysis (2026-07-16, pre-RED — verdict READY)
The three §P1 seams verified against HEAD (develop 5b913bf): server
`handleIngestParsed` reads `tier` but not `context` (server.ts:139-145 area);
client `_ingest_parsed(…, tier=None)` has no context param
(bun-crucible.py:301); `RunContext.cycleId` exists from 011 C1
(types.ts:98). Spec is code-accurate; no drifts.

## Cycle plan
- C1 (red-green): §P1 — server context passthrough + client env linkage
  (WORKFLOW_CYCLE_ID / WORKFLOW_CYCLE / git) + the dog-food proof AC.
- C2 (verify): VERIFY + close-out + merge gate.

## Estimated size
S (scope frozen at §P1).

## Non-goals
The full CR-008 fleet upgrade (plan verbs, narration, other stacks); heuristic
semantic changes.
