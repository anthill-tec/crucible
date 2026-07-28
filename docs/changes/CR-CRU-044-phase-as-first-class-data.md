# CR-CRU-044 — Agent phase must be declared data, not an agentId naming convention

**Status:** PENDING
**Type:** patch (contract correctness — client fleet + server + UI)
**Priority:** P1 — 0.1.0 BLOCKER (promoted 2026-07-28). Misclassifies agents silently AND fabricates fictitious agent identities onto the dashboard (§S5) — unacceptable in a tool whose subject is agent observability
**Depends on:** CR-CRU-030 (fleet AXI-CLI compliance), CR-CRU-036 (register cycle guard)
**Labels:** patch, client-fleet, server, api, dashboard, axi-compliance, agent-lifecycle
**Phase:** Wave 4 (0.1.0 blocker)
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

### §S5 — An agent identity must never be fabricated from the script's own filename
**Found live 2026-07-28: a phantom agent named `bun-crucible` appeared in the dashboard's agent
rail on the dog-food project.**

`clients/bun-crucible.py:1530`:

```python
explicit = getattr(args, "agent", None)
if explicit:
    return explicit
return os.environ.get("WORKFLOW_ROLE") or "bun-crucible"
```

When a gate/milestone verb runs without `--agent` and `WORKFLOW_ROLE` is unset, the client invents
an agent identity equal to its own program name. The docstring is candid about why — *"these verbs
never assert on the id, but the server requires a non-empty agentId"* — i.e. a filler value chosen
to satisfy a required field.

The result is an entity in the agent rail that is not an agent. It has no phase, no lifecycle, and
no owner; it goes `online` then `stale` and sits there. That is the same failure this CR exists to
correct — identity inferred from a string instead of declared — and it actively misleads anyone
reading the board.

**Fix — HARD STOP (user directive 2026-07-28): the agent identity must be DEFINED or the verb
FAILS.** There is no fallback, no default, and no fabricated value:
- `--agent` explicit wins;
- else `$WORKFLOW_ROLE`;
- else **hard stop** — `ok:false`, non-zero exit, a definitive AXI error naming both ways to supply
  it. Nothing is registered, so no phantom can reach the rail.

Delete the `or "bun-crucible"` fallback outright. **Do not replace it with a nicer default string**
— a better-looking fabricated identity is the same defect. An agent that cannot say who it is has
no business appearing on the board.

Check the other four clients for the same pattern (`rust`, `mvn`, `arduino`, `python`) — the shared
`_crucible_axi.py` module makes a copied fallback likely.

**Second sighting 2026-07-28 (user screenshot, `crucible_spurious_agents.jpg`) — TWO phantoms on
the Crucible v2 card, and they are NOT the same defect.** The board showed `0/2 agents online`
with:

| rail entry | message | state |
|---|---|---|
| `bun-crucible` | *(none)* | died 40m ago |
| `probe` | "Starting RED phase" | died 22m ago |

`bun-crucible` is this section's defect exactly — nothing more to establish.

**`probe` is not — and it is NOT a product defect.** Investigated 2026-07-28 (user pressed for an
answer rather than waiting). The stored record settles it:

```
agent_id   = probe-tmp
identity   = {"displayName":"probe","source":"claude-md","repoPath":".../data_projects/crucible"}
message    = "Starting RED phase"
```

`probe` is a **displayName**, which is what the rail renders — the id is `probe-tmp`. An earlier
guess in this section that it was the sibling `Probe` PROJECT leaking across was WRONG; the
`repoPath` is this repo. It was a throwaway registration made by an orchestrator sub-agent while
probing client behaviour against the LIVE dog-food project instead of an ephemeral test server,
and never unregistered. That is dispatch hygiene, not a Crucible defect, and it needs no CR.

**The two phantoms therefore have different natures**, which matters for what this CR must fix:

| rail entry | id | identity | nature |
|---|---|---|---|
| `bun-crucible` | `bun-crucible` | `{}` — empty | **product defect** — the §S5 filename fallback |
| `probe` | `probe-tmp` | populated, real repoPath | operator error — a sub-agent's stray registration |

The empty `identity` on `bun-crucible` is itself corroboration: no displayName, no source, because
nothing ever declared it. §S5's hard stop is exactly right and its ACs stand unchanged.

Both linger because neither unregistered — the liveness threshold ages a row to stale/dead in the
UI while the row itself persists as `online`. **That is worth a look during this CR**: a registered
agent that never unregisters leaves a permanent rail entry, so the fabricated-identity fix removes
the cause but not the residue.

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
- [ ] **HARD STOP on an undefined identity** — a gate/milestone verb with no `--agent` and no
      `WORKFLOW_ROLE` exits NON-ZERO with `ok:false`, registers NOTHING, and the error names both
      ways to supply the id — asserted (§S5). No agent may appear on the rail from that path.
- [ ] No filename-derived fallback survives: `grep -rn 'or "\(bun\|python\|rust\|mvn\|arduino\)-crucible"' clients/`
      finds nothing — asserted.
- [ ] The same fallback pattern is absent from all five clients — asserted per client.
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
