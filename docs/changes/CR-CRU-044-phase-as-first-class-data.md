# CR-CRU-044 — Agent phase must be declared data, not an agentId naming convention

**Status:** PENDING
**Type:** patch (contract correctness — client fleet + server + UI)
**Priority:** P2 — misclassifies agents silently; not a 0.1.0 release blocker
**Depends on:** CR-CRU-030 (fleet AXI-CLI compliance), CR-CRU-036 (register cycle guard)
**Labels:** patch, client-fleet, server, api, dashboard, axi-compliance, agent-lifecycle
**Phase:** Wave 4
**Design reference:** the AXI manifesto (axi.md) — self-explanatory surfaces that prevent
orchestrator context loss. Found in CR-CRU-041 C1 (2026-07-28) when correctly-registered
agents rendered unphased; user direction the same day: *"the server should require the phase
tag, basically the enumeration, and ensure that is used to classify the agent."*

## Context
An agent's phase (RED / GREEN / FIX / VERIFY / ORCHESTRATOR) is currently **not data**. It is
inferred from the shape of the agentId string, and the `--phase` flag that appears to declare
it is inert.

Verified:
- **`--phase` never leaves the client.** In `clients/bun-crucible.py`, `cmd_register` uses
  `args.phase` in exactly one place — `args.message or f"Starting {args.phase} phase"` — to
  compose a status *message*. `_register_agent()` has no phase parameter, and the POST payload
  carries only `agentId, projectKey, status, message, identity{displayName, source}`. The flag
  defaults to `"report"` and is otherwise discarded.
- **The server models no phase at all.** There is no `phase` field anywhere in `src/*.ts`.
- **The UI reconstructs it by string-matching the agentId.** `public/app.js:709` calls
  `L.phaseRole(e.agentId)`; the contract asserted in `tests/phase-role.test.ts:16` is a
  `-RED`/`-GREEN`/`-FIX` **suffix** (else a `verify` name segment, else `null`).
- **Consequence:** an agent registered as `CR-CRU-041-C1-GREEN-bun` — declaring
  `--phase GREEN` explicitly — renders **roleless**, because the id does not *end* in
  `-GREEN`. The declaration is ignored; the label decides. Nothing warns.
- **The defect is fleet-wide.** `cmd_register` is duplicated across all five clients, and the
  surface is inconsistent: `arduino-crucible.py` takes a free-text `--phase PHASE` with no
  enum, while bun/mvn/python/rust constrain it.

Classifying agents by naming convention makes a documented, constrained flag a decoration and
turns a stack suffix into silent data loss.

## Scope

### §S1 — `phase` becomes a required, enumerated field on agent registration (server)
The agent-registration API requires a `phase` field constrained to the enumeration
`RED | GREEN | FIX | VERIFY | ORCHESTRATOR | report`. A missing or out-of-enum value is
rejected with a definitive AXI error naming the accepted values. The phase is persisted on
the agent record and returned by the agents API.

### §S2 — The stored phase classifies the agent (UI)
The dashboard reads the **stored** phase for role tinting instead of parsing the agentId.
`phaseRole(agentId)` is retained ONLY as a fallback for historical records that carry no
stored phase (pre-CR-044 agents and runs must keep rendering as they do today — no
back-fill, no visual regression on existing history).

### §S3 — The client fleet sends the declared phase
All five clients (`bun`, `python`, `rust`, `mvn`, `arduino`) send `phase` in the register
payload. `--phase` becomes **required** (no `default="report"`) and enum-constrained
uniformly — `arduino-crucible.py`'s free-text `--phase PHASE` is brought onto the same enum.
A missing `--phase` fails argument parsing with the accepted values listed.

### §S4 — The agentId stops being a phase channel
With phase declared, the id no longer needs to encode it. Document in the client `--help`
and the STATUS-CONTRACT that phase comes from `--phase`, and that the agentId is a free-form
identifier. Any remaining id-shape guidance must not be load-bearing for classification.

## Acceptance criteria
- [ ] Registering with no `phase` is REJECTED by the server with an AXI error naming the
      accepted enumeration — asserted.
- [ ] Registering with an out-of-enum phase (e.g. `"banana"`) is REJECTED the same way —
      asserted.
- [ ] A registered agent's phase round-trips: register with `--phase GREEN` → the agents API
      returns `phase: "GREEN"` — asserted.
- [ ] **The declaration beats the label:** an agent registered as
      `CR-CRU-041-C1-GREEN-bun` with `--phase GREEN` classifies as GREEN — and one named
      `...-GREEN` registered with `--phase RED` classifies as **RED** — asserted. This is the
      defect's regression test.
- [ ] Each of the five clients sends `phase` in its register payload — asserted per client.
- [ ] Omitting `--phase` fails argument parsing on every client, listing the enum —
      asserted per client (including `arduino`, whose free-text flag is now constrained).
- [ ] Historical records with no stored phase still render via the `phaseRole` fallback —
      existing `tests/phase-role.test.ts` stays green, unmodified.
- [ ] Full bun + Python regression green.

## Non-goals
- Back-filling a phase onto existing agent/run records — history keeps rendering through the
  §S2 fallback. (User decision 2026-07-28: no revert or re-run of CR-041 C1's agents.)
- Changing the RED/GREEN/FIX/VERIFY colour semantics or the tintable-icon contract.
- Any change to cycle auto-attach (CR-CRU-036) or the register cycle guard.
- Renaming existing agents or enforcing an agentId pattern — §S4 explicitly removes the id
  from the classification path rather than validating it.

## Risk
- **Required-field change is breaking for the fleet.** The clients and the server must land
  together, or in-flight agents fail to register. Sequence the server to accept-and-require
  in the same change set as the client sends, and run the full fleet regression before merge.
- The `~/.claude/scripts` mirror carries stale client copies that will not send `phase`;
  agents must use the in-repo `clients/` copies (already the standing rule). Model B is
  retiring that mirror through their own installer pipeline.
