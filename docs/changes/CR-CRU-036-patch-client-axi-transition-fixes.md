# CR-CRU-036 — Patch: client TOON-AXI transition fixes (§S9 server-active-cycle + CR-008 test retarget + fleet coverage-uniformity)

**Status:** PENDING — **owned by Crucible** (client scripts + their tests).
**Type:** patch
**Priority:** P1 (next — restores the CR-008 TS suite to green after the CR-030 merge-gate exception)
**Depends on:** CR-CRU-030 (the fleet TOON-AXI migration this patch completes the transition for)
**Labels:** patch, fleet, tooling, axi, toon, context-integrity, coverage, dx
**Phase:** Wave 4 (0.1.0)

## Context
CR-CRU-030 migrated all five clients to the shared TOON-AXI envelope and merged
to develop on 2026-07-21 **under an explicit, user-authorized merge-gate
exception**: the pre-merge gate had **34 failing CR-008 TS integration tests**
(`tests/clients-*.test.ts`). Those failures are NOT regressions in the delivered
behavior — they are the **transition** from the interim cycle-attach contract to
the intended one, deferred to this patch.

CR-030 shipped §S9 in an **interim** form: `WORKFLOW_CYCLE_ID` was retained as an
explicit override and a missing active cycle was a **hard error**. That contract
was wrong — hand-passing `WORKFLOW_CYCLE_ID` is exactly the fragile pattern that
repeatedly orphaned runs (`cycleId=NONE`), and it was only ever a temporary fix.
This patch lands the **decided** §S9 contract (the client resolves the active
cycle from the server; `WORKFLOW_CYCLE_ID` removed; no-active-cycle warns and
withholds) and retargets the CR-008 tests to it, restoring the suite to green.

It also closes the **fleet coverage-uniformity gap** surfaced at CR-030 close-out:
`rust`/`mvn`/`arduino`-crucible.py lack the `pre-merge-gate` and
`regression --coverage` endpoints that `bun`/`python` expose — but every client
must present the SAME complete AXI endpoint set (only the backend toolchain
command differs).

## Scope

### §S1 §S9 corrected — auto-attach resolves the active cycle from the server
Replace the interim §S9. The `register` and ingest verbs
(`test`/`regression`/`auto-ingest`) resolve the cycle to attach to **FROM THE
SERVER**: the client resolves the open plan and reads its cycles via
`GET /api/v2/projects/<key>/plans`, then attaches the run to the plan's single
`status:"active"` cycle (CR-024 keeps exactly one). Attachment is automatic from
`cycle-activate` alone — the orchestrator's activation is the **only** input.

- **`WORKFLOW_CYCLE_ID` is REMOVED** from all five clients + `_crucible_axi.py`.
  No client reads the env var; the server's active cycle is the single source of
  truth. `resolve_active_cycle_id(plans)` stays the pure resolver.
- **No active cycle** — an open plan exists but the server query yields no
  `status:"active"` cycle (all terminal / none activated) — the client **WARNS
  and WITHHOLDS**:
  - emits `warnings[]` `{code:"no-active-cycle", detail:"activate a cycle first"}`
    **+ stderr**, surfaced to both the agent and the orchestrator,
  - does **NOT** post the run — no `cycleId=NONE` orphan is ever created,
  - exits **non-zero** so the agent/orchestrator act (activate a cycle, re-run).
- **Tolerant** case preserved: no open plan at all (lightweight project) or a
  plans-fetch failure (infra / non-UUID key) → the guard proceeds silently, does
  NOT withhold. Warn+withhold fires ONLY when the server definitively reports an
  open plan with no active cycle.

This restores §S3's warning posture (a warning, not a hard error) while
eliminating the orphan: **warn + withhold**, never warn-and-orphan, never
hard-crash.

### §S2 Retarget the CR-008 TS integration suite to the corrected contract
The 34 failing tests (`tests/clients-python-arduino-crucible.test.ts`,
`clients-rust-mvn-crucible.test.ts`, `clients-bun-crucible.test.ts`,
`clients-narration.test.ts`) must:
- **Seed an active cycle on the test server** (project → `plan-file` →
  `cycle-activate`) and assert register/ingest **auto-attach** — the ingested
  run's `context.cycleId` equals the seeded active cycle id.
- Assert the **no-active-cycle** path warns + withholds (no run posted, non-zero
  exit) with an open plan and no active cycle.
- Use **no `WORKFLOW_CYCLE_ID`** anywhere; assert setting it changes nothing.
- Remove any test made redundant by the Python unit suite
  (`tests/client/test_*.py`) — the TS suite covers the real-server integration
  path only.

### §S3 Fleet coverage-uniformity — every client exposes the full endpoint set
`rust`/`mvn`/`arduino`-crucible.py gain the endpoints they currently lack so all
five clients expose the SAME AXI surface (only the backend command differs):
- `pre-merge-gate` — the streaming no-mistakes/gate run (§S8 semantics).
- `regression --coverage` — full-suite regression with coverage, TOON-AXI result.
- Install/require `coverage.py` where the Python-driven stacks need it; fix the
  `coverage/` directory shadow of `python -m coverage` (dir on path shadows the
  module).

## Acceptance criteria
- [ ] No client reads `WORKFLOW_CYCLE_ID`; `grep` across `clients/` finds zero
      env reads of it. Setting it in the environment does not change attachment.
- [ ] For all five clients: with a seeded open plan + active cycle, `register`
      and each ingest verb auto-attach — asserted `context.cycleId` == active id.
- [ ] For all five clients: with an open plan and NO active cycle, ingest/register
      emit `warnings[]` `no-active-cycle` (+ stderr), post NO run (no `cycleId=NONE`
      row created), and exit non-zero.
- [ ] Tolerant path: no open plan / plans-fetch failure → the verb proceeds, no
      withhold, no `no-active-cycle` warning.
- [ ] The CR-008 TS integration suite (`tests/clients-*.test.ts`) is GREEN under
      the real server, seeding cycles server-side (no `WORKFLOW_CYCLE_ID`).
- [ ] The full pre-merge gate (tsc → suite + coverage) is GREEN.
- [ ] `rust`/`mvn`/`arduino`-crucible.py expose `pre-merge-gate` and
      `regression --coverage`, returning the §S1 TOON-AXI envelope, asserted per
      client; `coverage.py` present; the `coverage/` dir shadow is resolved.

## Notes
- Multi-stack coverage rendered as the MEDIAN of all sub-coverage runs (scaled)
  is a **separate** coverage-DISPLAY concern (server/dashboard, user Lavish note
  2026-07-21) tracked as its own follow-up patch CR for 0.1.0 — not in this
  client-transition patch. Captured in the storyboard COVERAGE TREND block.
- Orchestration consequence: with `WORKFLOW_CYCLE_ID` gone, the orchestrator's
  only cycle input is `cycle-activate` — phase agents auto-attach; the
  orchestrator stops hand-passing the env var entirely.
- **On merge — PING Model-B** (`Mainline - ModelB`, Sandesh): per their reply
  (msg 1331, 2026-07-21, commit bf56613) they deferred their client-bundle +
  hook-template sync until the final contract lands here, and asked to be
  notified on the 036 merge so they run that single sync.
