# CR-CRU-030 — Fleet-wide TOON-AXI compliance (all crucible clients)

**Status:** PENDING
**Type:** patch
**Priority:** P1
**Depends on:** CR-CRU-013 (§S7 bun-client TOON-AXI slice + `clients/toon.py` codec from C4 — the reference implementation this CR rolls out fleet-wide)
**Labels:** patch, fleet, tooling, axi, toon, dx
**Phase:** Wave 4 (0.1.0 — user-directed 2026-07-18)
**Design reference:** user direction 2026-07-18 ("we need all the crucible
clients to be migrated to returning TOON and be fully AXI compliant") +
the cycle-id orphan incident (5 CR-013 runs ingested with `cycleId=null`, and
the client's plain-text AXI output surfaced nothing — the orchestrator had no
signal it had forgotten `WORKFLOW_CYCLE_ID`).

## Context
The fleet clients (`bun`/`python`/`rust`/`mvn`/`arduino`-crucible.py — all
Python wrappers over different toolchains) print ad-hoc plain text from their
AXI verbs (`print(f"cycle-done: ok=True cycle=45 plan=11")`). That output is
not machine-parseable, does not surface the run context, and has no guard for a
missing cycle association — which is exactly how CR-013 dropped 5 runs onto
`cycleId=null` unnoticed. CR-013 §S7 lands the TOON-AXI contract for the **bun**
client as the reference. This CR migrates the **remaining four** clients to the
same contract and closes the residual AXI-compliance gaps, so every client
returns structured TOON and the fleet speaks one AXI dialect.

## Scope

### §S1 The TOON-AXI envelope (the standard)
Define ONE envelope schema, encoded via `clients/toon.py` (CR-013 C4), that
every AXI verb across every client returns on stdout:
```
axi:
  verb: <name>
  ok: <bool>
  <verb-specific result fields>          # e.g. cycle, plan, agent, run{passed,total}, cycles[]
  context?: { projectKey, agentId, cycleId, wave, cr, track, orchestrator }
  warnings?[]{code,detail}
```
Factor the envelope builder into the shared client code (the clients already
share lifecycle/`.env`/context helpers) so all five emit an identical shape.
Human-readable stderr lines may remain for interactive use; **stdout is the
TOON AXI channel**.

### §S2 Migrate the four remaining clients
Apply CR-013 §S7's bun pattern to `python-crucible.py`, `rust-crucible.py`,
`mvn-crucible.py`, `arduino-crucible.py`: every AXI verb (`register`,
`unregister`, `plan-file`, `cycle-activate`, `cycle-done`, `cr-close`, and the
test/regression/auto-ingest ingest result, plus each stack's typecheck/compile
gate) returns the §S1 envelope. The ingest-verb envelopes carry `context`
(cycleId included).

### §S3 Missing-cycle-id warning guard (all clients)
Every client's `--agent` ingest verbs emit a `no-cycle-id` warning (envelope
`warnings[]` + stderr) when `WORKFLOW_CYCLE_ID` is unset while the project's
open plan has an ACTIVE cycle, naming the active cycle id. (CR-013 §S7 lands it
for bun; this generalizes it.)

### §S4 Expose the append-cycle verb (client gap)
The server supports `POST …/plans/<planId>/cycles` (append a cycle to an open
plan) but NO client exposes it — CR-013 had to append cycle 51 via raw curl.
Add a `cycle-add <label>` verb to the shared client verb set (all five),
returning the §S1 envelope with the assigned id.

### §S5 Golden envelope fixtures + compat
A golden-TOON fixture per verb per client (round-trips through `toon.py`
decode). If any consumer still parses the old plain-text stdout, migrate it to
decode the envelope (or provide a `--format {toon,text}` shim with `toon` the
default). Grep the repo + `~/.claude/scripts` mirror for plain-text parsers of
client stdout and update them.

## Acceptance criteria
- [ ] A shared envelope builder emits the §S1 schema; `clients/toon.py` decodes every verb's stdout back to a dict with `verb` + `ok`.
- [ ] For EACH of `python`/`rust`/`mvn`/`arduino`-crucible.py: `register`, `unregister`, `plan-file`, `cycle-activate`, `cycle-done`, `cr-close`, `cycle-add`, and the ingest result print a `toon.py`-decodable envelope carrying `ok` + result fields (one assertion set per client).
- [ ] Ingest-verb envelopes include `context.cycleId` (value when `WORKFLOW_CYCLE_ID` set; explicit null when unset) for all five clients.
- [ ] `test --agent …` with `WORKFLOW_CYCLE_ID` unset + an active cycle → `no-cycle-id` warning (envelope + stderr) naming the active id, for all five clients; set → no warning.
- [ ] `cycle-add "<label>"` posts `POST …/plans/<planId>/cycles` and returns the assigned id in the envelope; appending to a CLOSED/absent plan → non-zero + an error envelope.
- [ ] `plan-file`'s assigned cycle ids stay machine-readable via the envelope (the "never guess ids" contract holds under TOON).
- [ ] Golden fixture per verb per client; the `~/.claude/scripts` mirror is re-synced from `clients/` (CR-008 source-of-truth rule).

## Estimated size
M–L (five clients × verb set, but mechanical once the bun reference + shared builder exist).

## Non-goals
Changing the server ingest contract or endpoints; the TOON wire format itself
(that's `@toon-format`, ported in CR-013 C4); no-mistakes gate mechanics
(CR-013 §S5); adding NEW verbs beyond `cycle-add`.
