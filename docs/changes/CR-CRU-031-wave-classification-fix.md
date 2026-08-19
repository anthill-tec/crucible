# CR-CRU-031 — Wave-classification fix: server wave-backfill + `plan-file --wave` + CR-021 correction

**Status:** COMPLETED (2026-07-18 — merged 406cff5; plan 12 closed; C1–C4; 856/856 · coverage 91.2%/90.4% · playwright 31/31 tier:e2e · tsc 0; status reconciled from live Crucible board 2026-07-20)
**Type:** patch
**Priority:** P1
**Depends on:** CR-CRU-011 (plans + wave state), CR-CRU-013 (surfaced the gap)
**Labels:** patch, server, classification, wave, dx
**Phase:** Wave 4 (0.1.0 — split out of CR-CRU-030, user-directed 2026-07-18)
**Design reference:** the CR-021 History mis-grouping (its plan filed with
`wave=null` because `WORKFLOW_WAVE` was unset — no `--wave` flag, no backfill
path), surfaced during CR-013. Pulled ahead of the fleet TOON migration
(CR-CRU-030) because it fixes a user-visible defect.

## Context
`plan-file` reads the wave only from `WORKFLOW_WAVE` env (no flag, no guard), so
a forgotten export silently files a wave-less plan — which the History lens
renders in a phantom unnumbered "HISTORY — WAVE" band, separate from its real
wave (CR-021). And once a plan is CLOSED there is no way to correct it: the plan
`PATCH …/plans/<id>` endpoint backfills only `orchestrator`, and only on OPEN
plans. This CR closes both the prevention gap and the remediation gap. The
broader fleet-wide TOON-AXI envelope + the `no-wave`/`no-cycle-id` AXI warnings
remain CR-CRU-030.

## Scope

### §S1 Server — `wave` one-field backfill on the plan PATCH
Extend `PATCH …/plans/<planId>` (`handlePlanClose`) so a body carrying `wave`
with NO `status` stamps the plan's wave — allowed on OPEN **and** CLOSED plans
(mirrors the existing one-field `orchestrator` backfill, but closed-plan-safe
since a merged plan's wave is exactly what needs correcting). `wave` coerces
number→decimal-string as the POST path already does; unknown plan → 404.
Rollups/events untouched.

### §S2 Client — `plan-backfill` verb
Add `plan-backfill --wave <n> [--cr <CR>]` to `bun-crucible.py`: resolves the
target plan (single plan, or `--cr` to disambiguate) and PATCHes its wave via
§S1. Prints the assigned wave. `--cr` unresolvable / no plan → non-zero + error.

### §S3 Client — explicit `--wave` on `plan-file`
`plan-file` gains a `--wave <n>` flag; resolution is `--wave` > `WORKFLOW_WAVE`
env. A `plan-file` with neither resolvable still files (no hard block) but is
the prevention lever so the orchestrator can pass wave explicitly.

### §S4 Data — backfill CR-CRU-021
Run `plan-backfill --wave 4 --cr CR-CRU-021` against the dog-food instance so
CR-021 folds into the single Wave-4 History band (removing the phantom
numberless "WAVE" group). This is a delivery step of the CR, verified by the e2e
/ a Chrome pass.

### §S5 History lens — defensive wave-less rendering (low priority)
The lens renders a genuinely wave-less plan under an explicit "unclassified"
label rather than a phantom numberless "WAVE" group — so a future gap degrades
legibly. In scope only if cheap; the §S1–§S4 prevention+backfill should make
wave-less plans not occur.

## Acceptance criteria
- [ ] `PATCH …/plans/<planId>` with `{wave:"4"}` (no `status`) on an OPEN plan → 200, `GET …/plans` shows `wave:"4"`; the SAME on a CLOSED plan → 200 and its wave updates (the orchestrator-backfill path currently 400s a closed plan — this must now succeed for `wave`); unknown planId → 404; `{wave:{}}` → 400 naming `wave`.
- [ ] `bun-crucible.py plan-backfill --wave 4 --cr CR-CRU-021` PATCHes plan 4's wave; re-fetch shows `wave:"4"`; a no-resolvable-target call → non-zero + error.
- [ ] `plan-file --wave 5` files a plan with `wave:"5"` regardless of `WORKFLOW_WAVE`; `--wave` overrides the env when both set.
- [ ] §S4: after the CR-021 backfill, `GET …/plans` shows CR-CRU-021 `wave:"4"`, and the History lens renders it inside the single Wave-4 band — no phantom numberless "WAVE" group (asserted via the workflow-lens test/e2e or a Chrome pass).
- [ ] §S5 (if built): a plan with `wave=null` renders under an explicit "unclassified" wave header, never a numberless "WAVE" band.

## Estimated size
S.

## Non-goals
The fleet-wide TOON-AXI envelope on the client verbs and the `no-wave`/
`no-cycle-id` AXI warnings (CR-CRU-030); changing the wave STATE machine or the
1024×640 viewport floor; a full History-lens redesign.
