# CR-CRU-048 — AXI `help[]` must be state-derived, and `cr-close` must refuse an incomplete plan

**Status:** COMPLETED — merged `1baf013` (2026-07-28)
**Type:** patch (AXI correctness — the self-describing contract)
**Priority:** P1 — the surface actively recommends closing a CR whose VERIFY has not run
**Depends on:** CR-CRU-011 (cycle plans), CR-CRU-024 (cycle activation guards), CR-CRU-030 (AXI-CLI compliance), CR-CRU-036 (the warn+withhold precedent)
**Labels:** patch, axi-compliance, client-fleet, server, workflow-integrity, 0.1.0-blocker
**Phase:** Wave 4
**Design reference:** the AXI manifesto (axi.md) — a self-explanatory surface that PREVENTS
orchestrator context loss. Found live on 2026-07-28 during CR-CRU-042: the orchestrator closed
C1, was told by `help[]` to `cr-close`, and moved to merge with **C2 = VERIFY still pending**.
The user caught it, not the tool. User direction: *"The AXI interface should be telling you and
you just have to follow."*

## Context
Two defects, one root cause — the workflow surface does not consult the state it already owns.

### Defect 1 — `help[]` is a static lookup, not derived from plan state
`clients/bun-crucible.py:1380` defines `_HELP_STEPS` as a fixed dict of "next-step suggestions".
After `cycle-done`, the envelope emits:

```
cycle-done: ok=True cycle=125 plan=49
  help[2]:
    cr-close --commit <sha>
    status
```

It says `cr-close` **unconditionally** — with no regard for whether the plan has further cycles.
Plan 49 still had cycle 126 (`C2 VERIFY`) pending. The correct hint was
`cycle-activate 126`. An orchestrator following the surface is walked directly into skipping
VERIFY, which is precisely the context loss the AXI model exists to prevent.

### Defect 2 — CORRECTED: the guard EXISTS; only its MESSAGE is deficient
**My original claim — "`cr-close` does not guard on an incomplete plan" — was WRONG.** I grepped
the CLIENT for a guard, found none, and concluded the system was unguarded without checking the
server. Verified 2026-07-28:

- `Store.closePlan()` (`src/store.ts:~1511`) filters cycles not in
  `Store.CYCLE_TERMINAL` (`:1170` = `done | skipped | failed`) and refuses with
  `cannot close plan <id>: non-terminal cycles: <ids>`, returning `openCycleIds`.
- `src/v2.ts:964` surfaces that as `{ openCycles, help: hints.nonTerminalCycles }`.
- It has shipped since CR-CRU-011 C1 (`e77d3b4`), and `tests/plans.test.ts` already pins both
  "pending blocks close" and "all-terminal closes".
- The `skipped`/`failed` precision I thought this CR needed to ADD is already correct.

Consequence worth stating: when the orchestrator nearly closed CR-CRU-042 with its VERIFY cycle
unrun, **the server would have refused**. The tool was safer than the CR claimed.

**What is genuinely missing is narrow — two message defects, both required by the ACs:**
1. The refusal names the blocking cycle's **id only**, never its **label** — `openCycles: [2]`
   tells an orchestrator nothing about what it forgot.
2. `hints.nonTerminalCycles` (`src/hints.ts:133`) suggests transitioning cycles or `GET`-ing to
   inspect them, but never names `POST …/plans/<planId>/abort` — the sanctioned route for closing
   out a plan with cycles that will not run.

So §S2 is a MESSAGE-QUALITY fix, not a new guard. Defect 1 (static `help[]`) is unaffected and
remains the substantive defect in this CR.

## Scope

### §S1 — Derive `help[]` from plan state
The next-step hint after a state-changing workflow verb must be computed from the plan, not
looked up in a table:
- `cycle-done` with cycles still pending → `cycle-activate <next-pending-id>`;
- `cycle-done` closing the LAST cycle → `cr-close --commit <sha>`;
- keep `status` as the always-available fallback.
Static entries in `_HELP_STEPS` that cannot be state-derived (e.g. `register` → `test`) stay as
they are — this is not a rewrite of the whole table, only of the hints that have state to consult.

### §S2 — improve the EXISTING server refusal (guard already correct)
**Gap-analysis 2026-07-28 answered the spec's open question. Decisions, with evidence:**

**The guard lives SERVER-side.** `PATCH …/plans/<planId>` (`src/v2.ts:895`) IS the CR close and
already validates there — status must be `closed`, `merge.commit` must be non-empty, an
already-closed plan → 400. Adding a cycle-state check to that route is authoritative for every
client and cannot be bypassed by an out-of-date vendored script. A client-only guard is strictly
weaker. The client then surfaces the refusal as an AXI error.

**Only `pending` and `active` block the close.** `CYCLE_STATUSES` (`src/v2.ts:677`) is
`pending | active | done | skipped | failed`. `skipped` and `failed` are legitimate TERMINAL
states — a plan carrying them must still close, or a failed cycle would strand the CR forever.
Guarding on "not done" would be wrong.

**No `--force` override — the sanctioned path already exists.** `handlePlanAbort` (`:1000`)
transitions the active cycle → `failed` and pending cycles → `skipped` behind a
`userApproved: true` gate. Deliberate abandonment is therefore already modelled; adding an
override flag would duplicate it with weaker semantics and give two ways to bypass one guard. The
refusal message should NAME this route as the remedy.

The refusal follows the CR-CRU-036 shape: `ok:false`, non-zero exit, human detail on stderr, the
machine envelope on stdout, and the message NAMES the blocking cycle ids and labels.

### §S3 — Apply fleet-wide
All five clients share this workflow surface. Whatever §S1/§S2 land must hold for
`bun`, `python`, `rust`, `mvn` and `arduino` alike — asserted per client, not just on `bun`.

## Acceptance criteria
- [ ] `cycle-done` on a plan with a later pending cycle returns `help[]` naming
      `cycle-activate <that cycle's id>` and NOT `cr-close` — asserted.
- [ ] `cycle-done` closing the final cycle returns `help[]` naming `cr-close --commit <sha>` —
      asserted, so the hint is genuinely conditional and not merely reworded.
- [ ] `cr-close` against a plan with a `pending` or `active` cycle **fails** (`ok:false`, non-zero
      exit) and the message NAMES the blocking cycle id(s) and label(s) — asserted. **This is the
      defect's regression test.**
- [ ] A plan whose remaining cycles are `skipped` or `failed` STILL CLOSES — asserted. Those are
      terminal states; guarding on "not done" would strand a CR with a failed cycle forever.
- [ ] The refusal is enforced by the SERVER (`PATCH …/plans/<planId>`), not only by the client —
      asserted against the endpoint, so a stale vendored client cannot bypass it.
- [ ] `cr-close` against a fully-closed plan still succeeds exactly as today — asserted, so the
      guard cannot be satisfied by breaking the happy path.
- [ ] Both behaviours asserted for all five clients (§S3).
- [ ] The CR-CRU-042 scenario replayed end-to-end: close cycle 1 of a 2-cycle plan, follow the
      emitted `help[]`, and confirm the path leads to activating VERIFY rather than to close-out.
- [ ] Full bun regression green AND full Python regression green (client change → both gates,
      per CR-CRU-045 §S3).

## Non-goals
- Redesigning `_HELP_STEPS` wholesale, or adding hints to verbs that have no state to derive from.
- Changing cycle activation guards (CR-CRU-024) or the auto-attach contract (CR-CRU-036).
- Enforcing that a plan MUST contain a VERIFY cycle — this CR makes the declared plan binding, it
  does not dictate plan shape.

## Deferred (found by C3 VERIFY, 2026-07-28 — pre-existing, not introduced here)
- **The cycle-not-found ERROR path still recommends `cr-close`.** When `_cycle_transition` cannot
  resolve the cycle to an open plan, `target` is `None`, `next_pending_cycle_id` returns `None`, and
  the envelope falls through to `["cr-close --commit <sha>", "status"]` — on a response where the
  transition never happened. Pre-existing (the old hardcoded ternary did the same unconditionally),
  and outside §S1's "plan resolved" scope, but it is the SAME defect class this CR fixes: a hint
  recommending an action the state does not support. Worth a follow-up.
- **No direct unit test of the pure helpers.** `next_pending_cycle_id` / `cycle_transition_help` are
  exercised only through the five per-client integration tests. Coverage is adequate, but a
  pure-function test would pin the several-pending and earlier-pending cases explicitly rather than
  by inference.

## Risk
- **A guard that is too strict blocks legitimate closes** (e.g. a plan whose final cycle was
  abandoned deliberately). Hence the explicit-override allowance in §S2 — but it must be opt-in,
  and its use should be visible in the envelope.
- The fix touches the close path used by every CR; the "fully-closed plan still closes" AC exists
  because a guard that breaks normal close-out is worse than the defect.
- Historical plans may contain cycles in states the guard does not anticipate — enumerate the
  actual status values in the schema rather than assuming `pending`/`active`/`done`.
