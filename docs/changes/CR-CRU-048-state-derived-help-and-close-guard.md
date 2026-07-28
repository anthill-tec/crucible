# CR-CRU-048 — AXI `help[]` must be state-derived, and `cr-close` must refuse an incomplete plan

**Status:** PENDING
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

### Defect 2 — `cr-close` does not guard on an incomplete plan
There is no pending-cycle check anywhere in the close path. `cr-close` will close a plan whose
cycles are still `pending`/`active`, transitioning the CR's TRACKING STATE to COMPLETED while a
declared cycle never ran. Close-out is defined as "transition the tracking state via the stack's
finish/close tool" — so a CR can be recorded COMPLETED with its VERIFY unexecuted, and nothing
anywhere says otherwise. That is a silent workflow-integrity failure, worse than a loud one.

CR-CRU-036 already established the correct shape for exactly this class of problem: when the
state is wrong for the verb, **warn + withhold** with a definitive AXI error rather than
proceeding.

## Scope

### §S1 — Derive `help[]` from plan state
The next-step hint after a state-changing workflow verb must be computed from the plan, not
looked up in a table:
- `cycle-done` with cycles still pending → `cycle-activate <next-pending-id>`;
- `cycle-done` closing the LAST cycle → `cr-close --commit <sha>`;
- keep `status` as the always-available fallback.
Static entries in `_HELP_STEPS` that cannot be state-derived (e.g. `register` → `test`) stay as
they are — this is not a rewrite of the whole table, only of the hints that have state to consult.

### §S2 — `cr-close` refuses an incomplete plan
`cr-close` must REFUSE when the target plan has any cycle not in a done state, emitting a
definitive AXI error that NAMES the offending cycles (id + label) and the remedy. Follow the
CR-CRU-036 warn+withhold pattern: `ok:false`, non-zero exit, human detail on stderr, the machine
envelope on stdout. An explicit override flag MAY be provided for the genuine exception case, but
it must be explicit — never the default path.

**Decide and record where the guard lives.** The SERVER owns plan state, so a server-side refusal
is authoritative for every client and cannot be bypassed by an out-of-date script; the client
then surfaces it. A client-only guard is weaker. Justify the choice in the CR's implementation
notes rather than defaulting to whichever is easier.

### §S3 — Apply fleet-wide
All five clients share this workflow surface. Whatever §S1/§S2 land must hold for
`bun`, `python`, `rust`, `mvn` and `arduino` alike — asserted per client, not just on `bun`.

## Acceptance criteria
- [ ] `cycle-done` on a plan with a later pending cycle returns `help[]` naming
      `cycle-activate <that cycle's id>` and NOT `cr-close` — asserted.
- [ ] `cycle-done` closing the final cycle returns `help[]` naming `cr-close --commit <sha>` —
      asserted, so the hint is genuinely conditional and not merely reworded.
- [ ] `cr-close` against a plan with a pending or active cycle **fails** (`ok:false`, non-zero
      exit) and the message NAMES the blocking cycle id(s) and label(s) — asserted. **This is the
      defect's regression test.**
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

## Risk
- **A guard that is too strict blocks legitimate closes** (e.g. a plan whose final cycle was
  abandoned deliberately). Hence the explicit-override allowance in §S2 — but it must be opt-in,
  and its use should be visible in the envelope.
- The fix touches the close path used by every CR; the "fully-closed plan still closes" AC exists
  because a guard that breaks normal close-out is worse than the defect.
- Historical plans may contain cycles in states the guard does not anticipate — enumerate the
  actual status values in the schema rather than assuming `pending`/`active`/`done`.
