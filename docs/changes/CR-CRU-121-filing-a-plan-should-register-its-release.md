# CR-CRU-121 — filing a plan should register its release

**Status:** PENDING (0.2.0 — born mid-release, D4)
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-091 (roadmap registration), CR-CRU-118 (release-membership mandate),
CR-CRU-011 (cycle plans)
**Labels:** feature, server, roadmap, dry
**Phase:** Wave 6 (0.2.0 — user-directed, live orchestrator session 2026-09-12)
**Design reference:** CR-CRU-118 §S1 (the per-CR "door" that is "already shut" at `handleCrPlan`/
`handleWaveSequence` — this CR closes the same door at a third surface CR-118 never enumerated)

## Context

Found live 2026-09-12: an orchestrator ran `plan-file --cr CR-CRU-120 --wave 6` to open a cycle plan,
then dispatched and ran a full RED phase against it — 14 minutes of active work before the user asked
why the roadmap didn't show it. It didn't, because `plan-file` never touches the queue.

**The duplication, read from both routes.** `handlePlanFile` (`src/v2.ts:1375-1443`) and `handleCrPlan`
(`src/v2.ts:2750-2833`) both accept `cr`, `title`, `wave` — and validate and store them **completely
independently**, in different tables (`plans` vs `queue_entries`), with zero cross-reference:

- `handlePlanFile` reads the queue only to REFUSE a wave conflict (`store.waveScopeRefusal`,
  CR-CRU-116), never to confirm the CR itself is registered there. `title`/`wave` are optional;
  `release` is not accepted at all.
- `handleCrPlan` requires `cr`, `release`, `wave`, `title` (all mandatory), runs `declareMembership`
  (release must name a live proposal or a recorded release's own history) and
  `refuseDependencyCycle`, then calls `store.upsertQueueEntry`.

**CR-CRU-118's own fact #4** states "the per-CR door is already shut" — meaning `handleCrPlan` and
`handleWaveSequence` already refuse an absent release. That census never considered `handlePlanFile`,
because CR-118 was framed entirely around the QUEUE's release membership, and `handlePlanFile` writes
a different table. The result: a plan can go fully active — RED, GREEN, VERIFY all running — while its
CR has no queue entry at all, invisible on every roadmap surface, exactly as CR-CRU-120 demonstrated.

**User ruling (2026-09-12):** unify by composition — `plan-file` gains an optional `release`, and when
given, internally performs the SAME queue write `cr-plan` performs, atomically with the plan file.
`cr-plan` remains a standalone verb for queue-only registration with no cycle plan (the historical
62-row backfill this session ran is exactly that case: shipped CRs, no execution to track, queue
membership only).

**Surfaces:** `handlePlanFile` (`src/v2.ts:1375-1443`), `store.filePlan` (`src/store.ts:3143-3197`),
`store.upsertQueueEntry` (`src/store.ts`, already exists, used unmodified), `declareMembership`/
`refuseDependencyCycle`/`liveProposalLabels`/`recordedReleaseClaiming` (already exist, used
unmodified) — all in `src/v2.ts`; `cmd_plan_file` in `clients/_crucible_axi.py` plus the five
clients' `plan-file` wrappers.

## Scope

### §S1 `plan-file` composes `cr-plan`'s queue write when `release` is given

`handlePlanFile` gains an optional `release: string` body field. **Absent `release`: behavior is
byte-identical to today** — no queue read beyond the existing `waveScopeRefusal` check, no queue
write, fully backward compatible with every existing caller (including this session's own
`plan-file` calls for CR-CRU-117/118/119/120, none of which passed `release`).

**Present `release`:** `wave` and `title` become required (mirroring `cr-plan`'s own requiredness —
a release without a wave or a title is not a valid roadmap declaration). Before any write:
1. Run `declareMembership(liveProposalLabels(store, key), {release, cr}, undefined,
   recordedReleaseClaiming(store, key))` — the identical call `handleCrPlan` makes. A failure
   refuses the WHOLE request (`fail` shape unchanged from `cr-plan`'s own).
2. Run `refuseDependencyCycle(store.listQueue(key), [cr])` — identical to `handleCrPlan`. A failure
   refuses the whole request.
3. Run the EXISTING `waveScopeRefusal` check `handlePlanFile` already performs (CR-CRU-116) — unchanged
   position, still before any write.

Only when all three checks pass: call `store.upsertQueueEntry(key, {cr, release, wave, title})` and
`store.filePlan(key, {...})`, wrapped in ONE `this.db.transaction()` (a new combined store method, or
the two existing calls sequenced inside a manually-opened transaction — implementation's choice) so a
post-validation failure in either write leaves NEITHER behind. The response carries the union of both
routes' fields: `planId`, `cr`, `status`, `cycles`, `wave`, `track` (plan-file's existing fields) PLUS
`converged` and `entry` (cr-plan's existing fields), present exactly when `release` was given.

### §S2 The client fleet gains `--release` on `plan-file`

All five stack clients' `plan-file` subcommand accepts an optional `--release`, added via the ONE
shared registrar line in `clients/_crucible_axi.py` (the same architecture CR-CRU-118 §S5 used for its
own fleet-wide flag additions — one line reaching five clients).

### §S3 `cr-plan` is unaffected

No change to `handleCrPlan`, `cmd_cr_plan`, or any client's `cr-plan` wrapper. It remains the correct,
standalone verb for queue-only registration — a shipped CR being backfilled into release history, a
re-sequencing, or any declaration that must NOT open an execution cycle.

## Acceptance criteria

**§S1**
- [ ] `POST …/plans` with `release`, `wave`, `title` all present, for a `cr` with no existing queue
      entry: the plan is filed (`planId`, `cr`, `status: "open"`, `cycles`) AND a subsequent
      `GET …/queue` shows that `cr`'s entry with the posted `release`/`wave`/`title` — asserted by
      reading the queue back, not by trusting the POST response alone.
- [ ] The same call also returns `converged` and `entry` (the queue row), present in the response body
      alongside the plan fields, in the SAME shape `cr-plan`'s own response carries them.
- [ ] `release` present, `wave` OR `title` absent: refused 400 naming the missing field (same message
      text `handleCrPlan` uses for the same absence), and NEITHER the queue NOR the plan is written —
      asserted by reading both tables back afterward.
- [ ] `release` present but names no live proposal and no recorded release claims this `cr`: refused
      with the exact `declareMembership` failure shape `cr-plan` returns for the identical input, and
      nothing is written.
- [ ] `release`/`wave`/`title` present but the `cr` would create a dependency cycle in the queue:
      refused with the exact `refuseDependencyCycle` shape `cr-plan` returns, and nothing is written.
- [ ] `release` ABSENT: request/response and stored state are byte-identical to pre-CR-121 behavior —
      regression pin, driven with the exact fixture CR-CRU-117/118/119/120 used (`cr`, `title`,
      `cycles`, `wave`, no `release`).
- [ ] Atomicity: seed an OPEN plan for a `cr` first (so `store.filePlan` will refuse
      "an open plan already exists"), then POST `plan-file` for the SAME `cr` with valid
      `release`/`wave`/`title` that would otherwise pass every queue-side check — the request is
      refused (plan-file's existing duplicate-open-plan error), and the queue is read back UNCHANGED
      (no orphaned queue write from the half that would have succeeded).

**§S2**
- [ ] A fleet census (CR-CRU-075's pattern) asserts all 5 stack clients' `plan-file` subcommand
      accepts `--release`, added at the ONE shared registrar call site — not five independent edits.
- [ ] At least one client (python, end-to-end) drives `plan-file --release <v> --wave <n> --title <t>
      --cycle <c> --agent <id>` against a real server and confirms via a follow-up `queue` call that
      the CR is registered with the posted release.

**§S3**
- [ ] `cr-plan`'s existing test suite is unaffected — regression pin, re-run without modification.
- [ ] A `cr-plan` call for a CR with NO open plan (the historical-backfill shape) still succeeds
      exactly as today, confirming the standalone path remains fully functional.

## Estimated size

S — one cycle. The route composes three already-existing functions
(`declareMembership`/`refuseDependencyCycle`/`upsertQueueEntry`) unmodified, plus one transaction
wrapper and one client flag reaching five clients via the shared registrar.

## Risk

- **Transaction correctness is the one real risk.** `store.filePlan` today has no internal
  `this.db.transaction()` wrapper around its own plan-insert + N-cycle-inserts sequence. Wrapping the
  NEW combined call (queue upsert + filePlan) in one outer transaction covers both existing and new
  cross-table risk; the atomicity AC above is the test that proves it, not an assumption.
- **Backward compatibility is the explicit design constraint**, not an incidental property: `release`
  absent must be provably byte-identical to today, verified by re-running this session's own
  CR-117/118/119/120 `plan-file` fixtures unmodified.

## Non-goals

- Retiring `cr-plan` as a standalone verb, or changing its route/behavior in any way.
- Requiring `release` on `plan-file` — explicitly rejected in favor of additive backward
  compatibility (D4's "a CR can be born mid-release" pattern needs a plan without immediate roadmap
  placement to remain possible).
- Touching the bulk `queue-file` route — already deprecated (CR-CRU-118 §S3), unrelated surface.
- Retroactively backfilling CR-CRU-120's own already-open plan — it was fixed manually this session
  via a direct `cr-plan` call; this CR only prevents the recurrence going forward.
