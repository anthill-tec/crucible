# CR-CRU-030 — Fleet-wide TOON-AXI conversion + mandatory classification context (all crucible clients)

**Status:** PENDING
**Type:** patch
**Priority:** P1
**Depends on:** CR-CRU-013 (the bun-client TOON-AXI slice — Crucible cycle 51 — + `clients/toon.py` codec from C4 — the reference implementation this CR rolls out fleet-wide)
**Labels:** patch, fleet, tooling, axi, toon, classification, context-integrity, dx
**Phase:** Wave 4 (0.1.0 — user-directed 2026-07-18)
**Design reference:** user direction 2026-07-18 ("we need all the crucible
clients to be migrated to returning TOON and be fully AXI compliant") +
the cycle-id orphan incident (5 CR-013 runs ingested with `cycleId=null`, and
the client's plain-text AXI output surfaced nothing — the orchestrator had no
signal it had forgotten `WORKFLOW_CYCLE_ID`) + the wave-classification gap
(CR-CRU-021's plan was filed with `wave=null` because `WORKFLOW_WAVE` was
unset, mis-grouping it into a phantom unnumbered "HISTORY — WAVE" band separate
from Wave 4 — user 2026-07-18: "this essential information is mandatory for
Crucible to display classifications correctly"). Same defect family: an
essential classification value not attached, no guard, no visibility.

## Context
The fleet clients (`bun`/`python`/`rust`/`mvn`/`arduino`-crucible.py — all
Python wrappers over different toolchains) print ad-hoc plain text from their
AXI verbs (`print(f"cycle-done: ok=True cycle=45 plan=11")`). That output is
not machine-parseable, does not surface the run context, and has no guard for a
missing cycle association — which is exactly how CR-013 dropped 5 runs onto
`cycleId=null` unnoticed. CR-013's bun-client slice (cycle 51) lands the TOON-AXI contract for the **bun**
client as the reference. This CR migrates the **remaining four** clients to the
same contract and closes the residual AXI-compliance gaps, so every client
returns structured TOON and the fleet speaks one AXI dialect.

Crucially, the AXI envelope carries the **mandatory classification context** —
`wave`, `cycleId`, `cr`, `track` — that Crucible needs to classify what it
displays (History wave grouping, cycle-linked run spans, CR/track lanes). This
context is NOT optional decoration: when a client omits `wave` the History lens
mis-groups the CR (CR-021), and when it omits `cycleId` the run vanishes from
its cycle. So this CR makes the classification context REQUIRED in the envelope,
sourced from env (`WORKFLOW_WAVE`/`WORKFLOW_CYCLE_ID`/`WORKFLOW_ROLE`) OR
explicit flags, and WARNED when a plan/run that needs it is missing it — the
client is where the fleet guarantees Crucible receives complete classification
data.

## Scope

### §S1 The TOON-AXI envelope (the standard)
Define ONE envelope schema, encoded via `clients/toon.py` (CR-013 C4), that
every AXI verb across every client returns on stdout:
```
axi:
  verb: <name>
  ok: <bool>
  <verb-specific result fields>          # e.g. cycle, plan, agent, run{passed,total}, cycles[]
  context: { projectKey, agentId?, cycleId?, wave, cr, track?, orchestrator? }
  warnings[]{code,detail}
```
`context` is REQUIRED (not `context?`) on every verb that carries a
classification — `wave` and `cr` are mandatory for any plan/run-scoped verb;
`cycleId` is mandatory for cycle-scoped ingests; `track` when `WORKFLOW_ROLE`
is set. A field that would classify the record but resolves empty is emitted as
explicit null AND raises a `warnings[]` entry (§S3), never silently dropped —
because a dropped classification value is precisely what Crucible cannot detect.
Factor the envelope builder into the shared client code (the clients already
share lifecycle/`.env`/context helpers) so all five emit an identical shape.
Human-readable stderr lines may remain for interactive use; **stdout is the
TOON AXI channel**.

### §S2 Migrate the four remaining clients
Apply CR-013's bun-client pattern (cycle 51) to `python-crucible.py`, `rust-crucible.py`,
`mvn-crucible.py`, `arduino-crucible.py`: every AXI verb (`register`,
`unregister`, `plan-file`, `cycle-activate`, `cycle-done`, `cr-close`, and the
test/regression/auto-ingest ingest result, plus each stack's typecheck/compile
gate) returns the §S1 envelope. The ingest-verb envelopes carry `context`
(cycleId included).

### §S3 Missing mandatory-classification-context guard (all clients)
Every client warns (envelope `warnings[]` + stderr) when a mandatory
classification value is absent for the record it is writing:
- `no-cycle-id` — `--agent` ingest with `WORKFLOW_CYCLE_ID` unset while the open
  plan has an ACTIVE cycle, naming the active cycle id (CR-013's bun slice lands it for
  bun; generalize to all five).
- `no-wave` — `plan-file` (and any wave-scoped verb) with no wave resolvable
  from `--wave`/`WORKFLOW_WAVE`; the plan would be filed unclassified (the
  CR-021 defect). Name the CR being filed.
The guard fires BEFORE the write when possible, so the orchestrator can correct
the env/flag rather than produce an unclassified record.

### §S3b Explicit classification flags on `plan-file`
`plan-file` currently reads `wave` from `WORKFLOW_WAVE` env only (no flag), so
a forgotten export silently yields `wave=null` (CR-021). Add `--wave` (and keep
env as the default) so the orchestrator can pass it explicitly; the flag/env
resolution is shared across clients for every classification value.

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

### §S6 Remediation of already-mis-classified plans (backfill)
Prevention (§S1–§S3b) stops NEW unclassified records; the existing ones need
correcting. The `PATCH …/plans/<planId>` endpoint currently backfills only
`orchestrator`, and only on OPEN plans — there is no way to fix a CLOSED plan's
`wave` (which is why CR-021 stays mis-grouped). Extend the one-field-backfill
path to accept `wave` on OPEN **or** CLOSED plans, and expose it via a shared
client `plan-backfill --wave <n> [--cr <CR>]` verb (returning the §S1
envelope). Then backfill **CR-CRU-021 → wave 4** so the History lens folds it
into the single Wave-4 band. (Defensive, low priority: the History lens should
render a genuinely wave-less plan under an explicit "unclassified" label, not a
phantom numberless "WAVE" group — but with §S1–§S3b + this backfill, wave-less
plans should not occur.)

## Acceptance criteria
- [ ] A shared envelope builder emits the §S1 schema; `clients/toon.py` decodes every verb's stdout back to a dict with `verb` + `ok`.
- [ ] For EACH of `python`/`rust`/`mvn`/`arduino`-crucible.py: `register`, `unregister`, `plan-file`, `cycle-activate`, `cycle-done`, `cr-close`, `cycle-add`, and the ingest result print a `toon.py`-decodable envelope carrying `ok` + result fields (one assertion set per client).
- [ ] Ingest-verb envelopes include `context.cycleId` (value when `WORKFLOW_CYCLE_ID` set; explicit null when unset) for all five clients.
- [ ] `test --agent …` with `WORKFLOW_CYCLE_ID` unset + an active cycle → `no-cycle-id` warning (envelope + stderr) naming the active id, for all five clients; set → no warning.
- [ ] `cycle-add "<label>"` posts `POST …/plans/<planId>/cycles` and returns the assigned id in the envelope; appending to a CLOSED/absent plan → non-zero + an error envelope.
- [ ] `plan-file`'s assigned cycle ids stay machine-readable via the envelope (the "never guess ids" contract holds under TOON).
- [ ] `context` is REQUIRED in the envelope of every classification-carrying verb; `wave` + `cr` present on plan/run-scoped verbs, `cycleId` on cycle-scoped ingests, `track` when `WORKFLOW_ROLE` set — asserted per client.
- [ ] §S3 `no-wave`: `plan-file` with neither `--wave` nor `WORKFLOW_WAVE` emits a `no-wave` warning (envelope + stderr) naming the CR; with either supplied → the plan carries the wave and no warning. `--wave` overrides env.
- [ ] §S6 backfill: `plan-backfill --wave 4 --cr CR-CRU-021` sets the CLOSED plan's wave via `PATCH …/plans/<id>`; re-fetching `GET …/plans` shows `wave:"4"`, and the History lens renders CR-021 inside the single Wave-4 band (no phantom numberless "WAVE" group). A backfill with no resolvable target → non-zero + error envelope.
- [ ] Golden fixture per verb per client; the `~/.claude/scripts` mirror is re-synced from `clients/` (CR-008 source-of-truth rule).

## Estimated size
M–L (five clients × verb set, but mechanical once the bun reference + shared builder exist).

## Non-goals
Changing the server INGEST contract (`/api/v2/runs/*`, gate/milestone POST
bodies) — untouched; the only server change is the additive `wave` one-field
backfill on the existing plan PATCH (§S6). The TOON wire format itself (that's
`@toon-format`, ported in CR-013 C4); no-mistakes gate mechanics (CR-013 §S5);
adding NEW verbs beyond `cycle-add` and `plan-backfill`; a full History-lens
redesign (only the defensive "unclassified" label is in scope, and only if
cheap).
