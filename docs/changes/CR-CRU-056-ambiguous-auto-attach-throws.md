# CR-CRU-056 — Agent registration binds its cycle EXPLICITLY; server-side auto-attach guessing is DELETED

**Status:** PENDING
**Type:** patch (workflow-model correction: server + client fleet)
**Priority:** P0 — user escalation 2026-08-01; the board's integrity currently depends on orchestrator hygiene the system does not enforce
**Depends on:** CR-CRU-036 (§S9 auto-attach — deleted here), CR-CRU-024 (state machine + §S7 cycle-reference validation), CR-CRU-044 (phase as registration data)
**Labels:** patch, server, client-fleet, plans, registration, board-integrity
**Phase:** Wave 4
**Design reference:** user rulings 2026-08-01 (two, same day). First: ambiguity must throw, never
guess. Second, superseding in scope: *"fix the damn agent registration"* — throwing on ambiguity
still leaves the server guessing in the "unambiguous" case, and registration itself remains a
free-floating act. Registration is the binding act.

## Context
The attach model has swung between two failure modes. CR-CRU-036 removed hand-passed
`WORKFLOW_CYCLE_ID` (per-run env — forgotten var → orphaned runs) in favour of server-side
auto-attach ("the project's active cycle"). Observed live 2026-08-01: with two open plans each
holding an active cycle (141 + 146, an orchestrator sequencing error), the server silently picked
141 and another CR's runs polluted CR-CRU-046's workflow card. The silent pick trusts exactly the
orchestrator state hygiene that failed; and even single-active auto-attach is still a GUESS — the
server inferring intent the dispatch never declared.

The synthesis that kills both failure modes: **the ORCHESTRATOR declares the cycle ONCE, at agent
registration; the server validates it; every subsequent ingest rides the validated binding.** A
forgotten binding fails loudly AT REGISTRATION (not as a silently orphaned or mis-attached run
later), and a wrong-but-active binding is at least explicit, visible, and attributable.

## Scope

### §S1 — `register` takes a cycle binding, validated
`POST /api/v2/agents/register` accepts `cycleId`. The server validates: the cycle exists, belongs
to an OPEN plan of this project, and is ACTIVE — otherwise 409 definitive AXI error naming the
actual state (unknown / pending / done / closed-plan), with concrete `help[]` (CR-CRU-024
help-quality convention). The binding is stored on the agent row.

### §S2 — TDD phases MUST register bound
`RED | GREEN | FIX | VERIFY` registrations REQUIRE `cycleId` — an implementation agent with no
workflow home is refused (409 + help). `ORCHESTRATOR` and `report` may register unbound.

### §S3 — Ingest attaches by binding; auto-attach is DELETED
A bound agent's run ingest attaches to ITS registered cycle, re-validated live: if that cycle is
no longer active (done/plan closed), the ingest gets a 409 definitive error — it never spills
into another cycle. CR-CRU-036 §S9's resolve-the-active-cycle attachment is deleted; no code path
answers "which cycle is active" for attachment purposes (sweep-asserted). Unbound agents' runs
attach ONLY via explicit per-ingest `context.cycleId` (validated per CR-CRU-024 §S7); otherwise
they are stored cycle-less with the existing warning in the envelope.

### §S2b — ONLY a registered agent communicates with the server — orchestrators included (user ruling 2026-08-01)
Every MUTATING v2 surface — plan-file, cycle-activate, cycle-done, cycle-add, cr-close,
checkpoint, stop, abort, milestone, gate ingest, run/compile ingest — carries the calling
`agentId` and is REFUSED (409, definitive AXI error) unless that id is a LIVE REGISTERED agent.
There are no anonymous verbs and no orchestrator exemption: plan verbs require a registered
`ORCHESTRATOR`-phase agent (the fleet's plan verbs stop taking a free-text `--orchestrator`
label and instead require the registered `--agent` id). Observed live 2026-08-01:
`cycle-activate`/`cycle-done` succeeded while the orchestrator's own registration had been
pruned — the server took workflow-mutating commands from an agent it did not know.

Read surfaces (dashboard GETs, the CR-CRU-035 hook-safe `status` contract) remain open —
requiring registration there would break the ambient-read contract. Flagged for explicit user
confirmation at gap-analysis in case "all communication" is meant to include reads.

### §S3b — Ingest ONLY from registered agents; implicit agent-creation retired (user ruling 2026-08-01, second)
Run/compile/gate ingest carrying an `agentId` with **no live registered row** is REFUSED — 409
definitive AXI error, run not stored, `help[]` = register first (with phase, and cycle binding
where §S2 requires it). The v1 "ingest-as-implicit-heartbeat" behaviour survives ONLY as a
heartbeat: an ingest from a REGISTERED agent still refreshes `lastSeen`; it never CREATES or
resurrects an agent row. Observed live 2026-08-01: a pruned `vidushi` row was silently
re-materialised by a bare ingest at 09:45 with no registration, no phase validation, no
declaration of intent — the server accepted a run from an agent it did not know. The server is
the discipline boundary: unregistered posters are thrown out with the appropriate exception, not
welcomed in.

### §S4 — Fleet: `--cycle` on register
The shared register path (`_crucible_axi.py`) and all five clients gain `--cycle`; dispatch
briefs supply it. Client-surface change → standing Model-B intimation. The orchestrator's own
gate runs register bound to the VERIFY/regression cycle (no special casing).

### §S5 — Multi-track becomes safe by construction (forward note, no extra work)
With attachment always explicit and validated, parallel active cycles in one project stop being
an ambiguity hazard — each track's agents bind their own cycle. This CR is the enabler the 0.2.0
multi-track wave was missing; no additional disambiguator design is needed there.

## Acceptance criteria
- [ ] RED/GREEN/FIX/VERIFY registration without `cycleId` → 409 `ok:false`, non-empty `help[]` —
      asserted per phase.
- [ ] Registration bound to a pending / done / unknown cycle or a closed plan → 409 naming the
      actual state — asserted per state.
- [ ] A bound agent's ingest attaches to its registered cycle even when ANOTHER plan's cycle is
      also active — asserted (the 2026-08-01 failure scenario, inverted).
- [ ] A bound agent's ingest AFTER its cycle is done → 409, run not stored, no spill — asserted.
- [ ] No attachment code path resolves "the active cycle": the §S9 attach helpers are gone —
      grep/sweep-asserted.
- [ ] Ingest with an agentId that has NO live registered row → 409 `ok:false`, run NOT stored,
      `help[]` names registration as the next action — asserted (run, compile and gate-snapshot
      surfaces each).
- [ ] Ingest from an agent AFTER its unregister or prune → same 409; the agent row is NOT
      re-created — asserted (the 2026-08-01 `vidushi` resurrection scenario).
- [ ] A registered agent's ingest still refreshes `lastSeen` (implicit heartbeat preserved for
      known agents) — regression-asserted.
- [ ] Every mutating verb (plan-file, cycle-activate, cycle-done, cycle-add, cr-close,
      checkpoint, stop, abort, milestone, gate ingest) from an unregistered caller → 409, state
      unchanged — asserted per verb (§S2b).
- [ ] The fleet's plan verbs send the registered `--agent` id (free-text `--orchestrator` label
      retired); an orchestrator must register (phase `ORCHESTRATOR`) before filing/activating —
      asserted.
- [ ] All five clients + `_crucible_axi.py` send `--cycle` through to the wire; `register --help`
      documents it — asserted.
- [ ] ORCHESTRATOR/report unbound registration still works; explicit per-ingest `context.cycleId`
      still validates per CR-CRU-024 §S7 — regression-asserted.
- [ ] Full bun regression green AND full Python regression green (client change → both gates,
      CR-CRU-045 §S3).

## Non-goals
- Phase persistence on events (CR-CRU-057).
- Authenticating/authorizing agent identity (who may register at all) — out of scope; this CR
  makes every binding explicit and validated, not authenticated.

## Risk
- **Coordinated fleet + server + test-harness change** — every existing test that registers a
  TDD-phase agent must supply a binding; the RED sweep must enumerate registration sites the way
  CR-CRU-044 did (six callers) plus every test fixture that registers.
- The orchestrator dispatch flow changes (briefs must carry the cycle id) — process memo rides
  the CR close-out.
