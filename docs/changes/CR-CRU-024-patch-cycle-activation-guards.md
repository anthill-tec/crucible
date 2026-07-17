# CR-CRU-024 — Patch: plan-cycle activation guards + AXI invalid-action responses

**Status:** PENDING
**Type:** patch
**Priority:** P2
**Depends on:** CR-CRU-011
**Labels:** patch, api, workflow, axi
**Phase:** Wave 4 (after 013, before 009 — user-scheduled 2026-07-17; CR-008's
plan verbs ship first and adopt the guards when this lands)
**Design reference:** user ruling 2026-07-17 ("Crucible should warn and not
proceed if it receives request to start a cycle out of order. Use AXI
principles to respond for all invalid actions") — provoked by two live
incidents: cycles 16+18 running active simultaneously (2026-07-16) and the
plan-7 cycle-2-before-1 mis-activation (2026-07-17), both unstopped because
the legal-transition table validates per-cycle transitions only.

## Context
The cycle transition table has no cross-cycle rules: activating cycle N while
an earlier sibling is pending, or while another cycle is active, succeeds
silently. Both invalid shapes have now occurred in real operation. Per the
AXI principle already embedded in this codebase (hints.ts — errors teach the
agent the fix), refusals must carry actionable `help[]`.

## Scope

### §S1 Out-of-order activation guard (refuse, don't proceed)
`PATCH …/cycles/<id> {status:"active"}` on a cycle with an EARLIER sibling
(lower cycle id in the same plan) still `pending` → **400**. The AXI response
names the violation and the legal paths:
`error: "out-of-order activation: cycle <earlier> is still pending"` +
`help[]` listing (a) activate cycle `<earlier>` first, or (b) transition it
`pending→skipped` if it will not run, then retry. No force/bypass flag —
order integrity is absolute; the skip verb IS the sanctioned swap mechanism.

### §S2 Single-active enforcement
Activating any cycle while another cycle in the SAME plan is `active` →
**400**: `error: "cycle <n> is already active"` + `help[]` naming the active
cycle and the confirm path (transition it to a terminal state first). One
active cycle per plan, mechanically guaranteed (the user rule of 2026-07-16).

### §S3 Mid-execution plan mutation — sanctioned forms only (user ruling 2026-07-17)
"Updating while executing is discouraged" — but two mutation forms are
SANCTIONED so real-world scope arrivals have a legal path, and the guards
hold across them all:
1. **INSERT a cycle at a position:** `POST …/plans/<planId>/cycles` gains an
   optional `before: <cycleId>` — the new cycle lands immediately before that
   sibling. Constraint: the insertion point must be AFTER the active cycle
   (inserting a pending cycle before the active one would instantly violate
   the order invariant) — violating inserts → 400 + AXI help naming the
   active cycle. Plain append (no `before`) stays as-is.
2. **EDIT a cycle's label:** `PATCH …/cycles/<id> {label}` — legal ONLY while
   the cycle is `pending`. The ACTIVE cycle is LOCKED (400: "the active
   cycle is locked — confirm or fail it first"); terminal cycles are HISTORY
   and immutable (400: "done/skipped/failed cycles are immutable history").
3. The §S1/§S2 guards recompute against the CURRENT sibling order — appended
   and inserted cycles obey the same out-of-order refusal; there is no
   mutation path that bypasses activation ordering.

### §S4 AXI-ify every plan/cycle invalid-action response
Every 4xx from the plans/cycles routes carries `help[]` hints per hints.ts
conventions — including the existing bare refusals: illegal transitions
(e.g. `active -> pending` gains "cycles never retreat; append a new cycle for
rework"), PATCH on a closed plan, unknown plan/cycle ids, malformed cycle
input, duplicate open plan per cr. Response SHAPES stay otherwise unchanged
(additive `help` only) — no client breakage.

### §S5 Emergency-stop timer checkpoint (user ruling 2026-07-17)
An emergency stop during execution pings Crucible so the attention timer
resumes from the exact setpoint (no lost ≤60s window):
1. **Checkpoint verb:** `POST /api/v2/projects/<key>/plans/<planId>/checkpoint`
   — folds the current epoch of the plan's ACTIVE cycle into
   `active_ms_accumulated` immediately and re-anchors (no-op `changed:false`
   when no cycle is active). One verb per plan, not per cycle — the caller
   shouldn't need the cycle id mid-emergency.
2. **Graceful-signal checkpoint:** the server itself checkpoints EVERY active
   cycle (all plans, all projects) on SIGTERM/SIGINT before exit — an orderly
   stop never loses timer state even without the ping; only a hard power cut
   falls back to the ≤60s read-cadence tolerance (CR-023 §S3).
3. **Project stop:** `POST /api/v2/projects/<key>/stop` — the project-level
   graceful pause Crucible itself can use: checkpoints EVERY active cycle's
   timer across the project's open plans (the §S5.1 fold, project-wide) and
   persists any other restart-relevant state this verb later grows to own
   (it is the designated extension point). Distinct from archive (stop hides
   nothing). Returns `{ok, checkpointed: <n>}`.
4. Fleet + orchestrator wiring is CR-008 scope (`checkpoint`/`stop` verbs;
   the /shutdown emergency flow calls them) — noted there at its gap
   analysis.

### §S6 Workflow abort — user-approval-gated (user ruling 2026-07-17)
Crucible allows aborting an active workflow (an OPEN plan), but the API
actively discourages it:
1. `POST …/plans/<planId>/abort` WITHOUT `userApproved: true` in the body →
   **409** with a strongly discouraging AXI response: the error states that
   aborting discards a declared workflow and REQUIRES explicit user approval;
   `help[]` instructs the orchestrator to present the abort to the user and
   retry with `userApproved: true` ONLY after the user approves. Nothing
   changes state.
2. WITH `userApproved: true` → the abort executes: the ACTIVE cycle →
   `failed` (abort noted), all PENDING cycles → `skipped`, the plan status →
   `aborted` (new terminal plan state, additive alongside open|closed).
   Aborted plans render in the history lens with an `aborted` state (never
   a merge pill); rollups/derived statuses treat aborted like closed-without-
   merge (CR-014's derived PENDING logic: an aborted plan means the CR can
   file a NEW plan — the one-open-plan-per-cr rule sees aborted as not-open).
3. The timer state is checkpointed as part of the abort (sealed values stay
   honest).

## Acceptance criteria
- [ ] With cycles A(pending), B(pending): activating B → 400 whose `error` contains `out-of-order` and names A; `help[]` mentions both the activate-first and the `skipped` paths; B remains `pending` (no partial state).
- [ ] After `A → skipped`, activating B → 200 (the sanctioned swap works).
- [ ] With A(active): activating B → 400 whose `error` names A as active; `help[]` mentions transitioning A to a terminal state; after `A → done`, activating B → 200.
- [ ] Sequential happy path unchanged: activate A → done A → activate B → done B all succeed (regression guard over the whole legal table).
- [ ] Every 4xx from plans/cycles routes carries a non-empty `help` array (sweep-asserted across: illegal transition, closed-plan PATCH, unknown planId, unknown cycleId, malformed cycle input, duplicate open plan) — each help text names a concrete next action.
- [ ] The orchestrator's own mis-activation replay: plan with cycles 1..5, POST activate on cycle 2 → 400 (the plan-7 incident becomes impossible).
- [ ] §S3 insert: `POST …/cycles {label, before: <pendingId>}` lands the cycle immediately before that sibling (order asserted via GET); `before` pointing at the ACTIVE cycle or any earlier sibling → 400 + help naming the active cycle; plain append unchanged; an inserted cycle obeys §S1 (activating it before its new earlier pending sibling → 400).
- [ ] §S3 edit: `PATCH …/cycles/<id> {label:"new"}` on a PENDING cycle → 200 + label round-trips; on the ACTIVE cycle → 400 ("locked"); on a done/skipped/failed cycle → 400 ("immutable history"); label+status in one body → 400 (one mutation per call, named in help).
- [ ] §S5 checkpoint verb: with an active cycle at 3 injected minutes since the last durable write, `POST …/plans/<planId>/checkpoint` → 200 `{ok:true, changed:true}`; an immediate store-reopen resumes `activeMs` at the checkpointed value EXACTLY (no cadence-window loss); with no active cycle → 200 `{changed:false}`; unknown plan → 404 + help.
- [ ] §S5 signal checkpoint: sending SIGTERM to a test-spawned server process with an active mid-epoch cycle persists the epoch before exit — a fresh store over the same DB resumes the exact value (subprocess-based test; if the harness cannot spawn a signal-able server process, pin the shutdown hook function directly and SAY so).
- [ ] §S5 project stop: with two open plans each holding an active mid-epoch cycle, `POST …/projects/<key>/stop` → 200 `{ok:true, checkpointed:2}`; store-reopen resumes both exactly; no active cycles → `{checkpointed:0}`.
- [ ] §S6 abort unapproved: `POST …/plans/<id>/abort` (no flag) → 409; `error` states user approval is required; `help[]` instructs presenting to the user + retrying with `userApproved:true`; plan/cycles unchanged.
- [ ] §S6 abort approved: with `{userApproved:true}` — active cycle → `failed`, pending cycles → `skipped`, plan → `aborted`; the history lens renders the group with an `aborted` state and NO merge pill; filing a new plan for the same cr afterwards succeeds (aborted ≠ open); the aborted cycle's timer sealed at its checkpointed value.

## Estimated size
S (grew from XS with §S3 mutation, §S5 checkpoints/stop, §S6 abort —
re-estimate at gap analysis).

## Non-goals
Cross-PLAN concurrency rules (multi-track lanes legitimately run parallel
plans); client-side changes (CR-008 consumes the guarded API as-is);
retroactive validation of historical plans.
