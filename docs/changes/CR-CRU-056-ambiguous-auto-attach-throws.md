# CR-CRU-056 — Patch: ambiguous active-cycle auto-attach must throw, never guess

**Status:** PENDING
**Type:** patch (server correctness / board integrity)
**Priority:** P1 — a silent wrong-cycle attach corrupts the live Workflow board and is invisible until a human notices
**Depends on:** CR-CRU-036 (§S9 auto-attach), CR-CRU-024 (plan/cycle state machine + AXI invalid-action responses)
**Labels:** patch, server, plans, ingest, auto-attach, board-integrity
**Phase:** Wave 4
**Design reference:** user ruling 2026-08-01 — *"the server auto-attaching an agent to whatever
cycle is active itself is wrong — it should throw an exception."*

## Context
CR-CRU-036 §S9 replaced hand-passed `WORKFLOW_CYCLE_ID` with server-side auto-attach: a run
ingest with no explicit cycle context is attached to the project's active cycle. The
implementation silently PICKS one when **multiple open plans each have an active cycle**.

Observed live (2026-08-01): plans 54 (CR-CRU-046, cycle 141 active) and 55 (CR-CRU-055,
cycle 146 active) were simultaneously open with actives after an orchestrator sequencing
error; CR-055's agents' ingests silently attached to CR-046's cycle 141, polluting that
CR's workflow card with another CR's runs. The silent choice trusts exactly the
orchestrator state hygiene that had just failed. Ambiguity must be LOUD.

## Scope

### §S1 — Attach resolution: >1 active is a definitive error
Run-ingest auto-attach resolves against the project's OPEN plans:
- exactly **one** active cycle → attach (unchanged);
- **zero** active → warn + withhold (unchanged, CR-CRU-036 §S9);
- **more than one** active → **409 definitive AXI error**: the ingest is REFUSED and not
  stored; the error enumerates every active cycle as `{planId, cr, cycleId, label}`; the
  envelope's `help[]` names the concrete next actions (close/complete the stray cycle, or
  send explicit validated cycle context per CR-CRU-024 §S7).

### §S2 — Every auto-attach consumer, same rule
The same three-way resolution applies to every other path that auto-attaches to "the
active cycle" (gate snapshot ingest, milestones, any others — enumerate the full consumer
set at gap-analysis; none may silently pick).

### §S3 — Fleet surfaces the 409 as a definitive error
The clients must surface the refusal as a structured AXI error with a non-zero exit
(manifesto principle 8) — expected to be envelope pass-through with no client code change;
verify and pin with one test per surface actually exercised.

## Acceptance criteria
- [ ] With two open plans each holding an active cycle, a context-less run ingest returns
      409 `ok:false`, stores NO run, and the error enumerates both cycles with
      `{planId, cr, cycleId, label}` — asserted.
- [ ] `help[]` on that error is non-empty and names a concrete next action (CR-CRU-024
      help-quality convention) — asserted.
- [ ] Exactly one active cycle → attach still works; zero active → warn + withhold still
      works — regression-asserted.
- [ ] The §S2 consumer sweep is enumerated in the tests (each auto-attach path refuses on
      ambiguity) — asserted per consumer.
- [ ] Full bun regression green; Python gate green if any client file is touched
      (CR-CRU-045 §S3).

## Non-goals
- Designing the multi-track disambiguator: the 0.2.0 multi-track model legitimately runs
  parallel active cycles in one project, and will need track-scoped attach (explicit,
  validated context per lane). That is Wave-5 design work; this CR only makes today's
  ambiguity throw instead of guess.
- Any change to cycle activation rules or the CR-CRU-024 state machine.

## Risk
- A refused ingest drops run data if the caller ignores the error — mitigated by the
  definitive AXI error + non-zero exit (the run can be re-ingested once the state is
  fixed; that is the point).
- The §S2 consumer enumeration is the completeness risk — a missed auto-attach path keeps
  the silent-guess behaviour alive. Gap-analysis must grep every `_active_cycle` /
  attach-resolution call site, unfiltered.
