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

**Gap-analysis 2026-07-28 — WHERE the requirement lives is the whole difficulty. Read this before
implementing.**

**(a) `/agents/register` and `/agents/heartbeat` are the SAME handler.** `src/v2.ts:1471-1473`
routes both to `handleAgentTouch`. A naive "require `phase` in `handleAgentTouch`" therefore also
requires it on heartbeat — which `src/hints.ts:44` documents as a distinct idle-time verb
(*"an explicit POST … is only needed while idle"*). **Decide and record**: either split the two
paths so only `register` demands a phase, or require it on both and update the heartbeat contract
and hint. Do not leave it implicit.

**(b) `Store.touchAgent` IS THE INGEST PATH — do not put the requirement there.**
`touchAgent(projectKey, agentId, opts?)` (`src/store.ts:608`) is called with NO options from run
ingest at `src/store.ts:746` and `:779` (and the gate/milestone paths), because every ingest
implicitly refreshes liveness. Making `phase` mandatory at the STORE level breaks every ingest in
the fleet. The requirement belongs at the ROUTE boundary; `touchAgent`'s `phase` must stay optional.

**(c) An ingest touch must NEVER blank an existing phase.** `touchAgent` updates an existing row.
A run ingest carries no phase, so the update must PRESERVE the stored value rather than write null
over it — otherwise an agent registers as GREEN and is silently de-phased by its own first test
run, reproducing this CR's defect through a different door. **This needs its own AC.**

**(d) `phase` gets its OWN column, via the established migration pattern.** The `agents` table has
no phase column today (`project_key, agent_id, status, message, identity, first_seen, last_seen`).
`src/store.ts:358-431` already does `PRAGMA table_info(<table>)` + `ALTER TABLE … ADD COLUMN` in six
places — follow it; do not invent a migration mechanism. **Do NOT stuff `phase` into the existing
`identity` JSON blob**: identity is WHO the agent is, phase is WHAT it is doing, and a column stays
queryable where a JSON key does not.

### §S2 — The stored phase classifies the agent (UI)
The dashboard reads the **stored** phase for role tinting instead of parsing the agentId.
`phaseRole(agentId)` is retained ONLY as a fallback for historical records that carry no
stored phase (pre-CR-044 agents and runs must keep rendering as they do today — no
back-fill, no visual regression on existing history).

### §S3 — The client fleet sends the declared phase
All five clients (`bun`, `python`, `rust`, `mvn`, `arduino`) send `phase` in the register
payload. `--phase` becomes **required** (no `default="report"`) and enum-constrained
uniformly. A missing `--phase` fails argument parsing with the accepted values listed.

**Gap-analysis correction 2026-07-28 — the fleet's actual state, which is NOT what this section
originally described.** The Context above says *"`arduino-crucible.py` takes a free-text
`--phase PHASE` with no enum, while bun/mvn/python/rust constrain it."* Two of those four are
wrong, and one of them has no flag at all:

| client | `--phase` today | work required |
|---|---|---|
| bun `:1845` | `choices=[…]` enum, `default="report"` | drop the default → required |
| mvn `:1738` | `choices=[…]` enum | make required |
| python `:1405` | **free-text**, `default="report"` — NOT constrained | add the enum + drop the default |
| arduino `:1194` | free-text, no default | add the enum + make required |
| **rust `:2050`** | **NO `--phase` FLAG EXISTS** — the `register` subparser has none | **ADD the flag** entirely, enum-constrained and required |

So this is *add-for-one, constrain-two, tighten-two* — not "constrain arduino". rust is the one that
would be missed by a sweep that assumed the flag was merely unconstrained everywhere.

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
- ~~else `$WORKFLOW_ROLE`;~~ — **REMOVED by gap analysis, see below**
- else **hard stop** — `ok:false`, non-zero exit, a definitive AXI error naming how to supply
  it. Nothing is registered, so no phantom can reach the rail.

**⚠ Gap-analysis 2026-07-28 — `$WORKFLOW_ROLE` IS NOT AN IDENTITY, and keeping it in this chain
would mint a new phantom while fixing the old one.**

`WORKFLOW_ROLE` carries the TRACK LANE, not an agent name. That is pinned in three places:
- `docs/research/PRD-crucible-v2.md:291` — *"`WORKFLOW_ROLE` (mainline | track-n)"*
- `docs/research/DN-model-b-language.md:53` — *"a **numbered lane** (Track 1, 2, 3…; wire
  `track-<n>` = `WORKFLOW_ROLE`)"*
- `clients/_crucible_axi.py:71-73` and `:373-375` — both read it and emit it as **`ctx["track"]`**

So `--agent` → `$WORKFLOW_ROLE` → hard stop would register an agent literally named **`mainline`**
or **`track-2`**: a rail entry that is a LANE, not an agent. That is the same category error as
`bun-crucible` — an identity inferred from a string that means something else — merely with a
tidier-looking value, which §S5 already warns is the same defect (*"do not replace it with a nicer
default string"*).

It is also wrong for the case it was meant to serve. The orchestrator identity is **`vidushi`** —
pinned in PRD §307, the DN, and CR-CRU-021 — never `mainline`. A mainline run with
`WORKFLOW_ROLE=mainline` and no `--agent` would register the wrong identity, not a missing one,
which is harder to notice than a hard stop.

**Resolution taken (orchestrator, stated for reversal): drop `$WORKFLOW_ROLE` from the identity
chain entirely. `--agent` or hard stop.** This makes the rule STRICTER, which is the direction of
the user's own directive (*"must be DEFINED or the verb FAILS"*) — the removed branch was the one
loophole through which an undeclared identity could still reach the board. If a non-`--agent`
source is wanted later it needs a purpose-built identity variable, not the track lane; that is out
of scope here.

`WORKFLOW_ROLE`'s existing use as `context.track` is CORRECT and must not be touched.

Delete the `or "bun-crucible"` fallback outright. **Do not replace it with a nicer default string**
— a better-looking fabricated identity is the same defect. An agent that cannot say who it is has
no business appearing on the board.

**Gap-analysis 2026-07-28 — confirmed present in ALL FIVE clients, not "likely".** The sweep
`grep -rn 'or "[a-z]*-crucible"' clients/` returns exactly five hits, one per client:

| client | line | fallback |
|---|---|---|
| arduino | `:977` | `or "arduino-crucible"` |
| python | `:1193` | `or "python-crucible"` |
| mvn | `:1537` | `or "mvn-crucible"` |
| bun | `:1541` | `or "bun-crucible"` |
| rust | `:1866` | `or "rust-crucible"` |

(Note the bun line has drifted from the `:1530` cited above to `:1541` — CR-CRU-050's edits shifted
it. Locate by pattern, not by line number.)

All five are the same `_agent_id()` helper, independently copied rather than shared through
`_crucible_axi.py` — so there is no single place to fix, and a fix applied only to the shared module
would silently leave all five in place. The existing AC already greps all five, and is correct.

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
- [ ] **HARD STOP on an undefined identity** — a gate/milestone verb with no `--agent` exits
      NON-ZERO with `ok:false`, registers NOTHING, and the error names how to supply the id —
      asserted (§S5). No agent may appear on the rail from that path.
- [ ] **`WORKFLOW_ROLE` no longer supplies an identity** — the same verb with
      `WORKFLOW_ROLE=mainline` set and no `--agent` STILL hard-stops and registers nothing;
      no agent named `mainline` or `track-<n>` can reach the rail — asserted per client (§S5
      gap-analysis resolution).
- [ ] **`WORKFLOW_ROLE` still populates `context.track`** — unchanged behaviour, asserted, so the
      identity fix cannot silently break track attribution (`_crucible_axi.py:71-73`, `:373-375`).
- [ ] **An ingest does not de-phase an agent** — register with `--phase GREEN`, then ingest a run
      (which carries no phase), then read the agents API: phase is STILL `GREEN` — asserted
      (§S1(c)). This is the defect's second door.
- [ ] **`/agents/heartbeat` behaves per the §S1(a) decision** — asserted either way, and
      `src/hints.ts:44`'s heartbeat hint matches whatever was decided.
- [ ] **rust gains a `--phase` flag** — it has none today; omitting it fails argument parsing like
      the other four — asserted (§S3).
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
