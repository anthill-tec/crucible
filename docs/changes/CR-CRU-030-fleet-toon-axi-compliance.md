# CR-CRU-030 — Fleet-wide TOON-AXI conversion + mandatory classification context (all crucible clients)

**Status:** PENDING — **owned by Crucible** (the server-side API + envelope contract live here). Briefly descoped to Model B on 2026-07-20, then re-owned the same day (user decision): the crucible-client work stays with Crucible because it holds the server-side API and requirements. **Model B is the requesting consumer**, tracking these deliverables as external dependencies of its Wave 4 (`worktree-flow.py` AXI migration + `contracts/` specs + `~/.claude` docs stay on Model B's side). Coordinated over Sandesh with `Mainline - ModelB` (Model B Crucible project key `019f7eb8-8cad-7000-9838-854eca8e7c20`). Bun-client TOON-AXI slice already shipped here (CR-CRU-013 cycle 51 + `clients/toon.py` codec); the wave-classification defect it surfaced was fixed under CR-CRU-031.
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

**Split (2026-07-18):** the wave-classification FIX — server `wave` backfill,
`plan-file --wave`, and the CR-021 correction — is pulled out to **CR-CRU-031**
(lands first). This CR is now CLIENT-ONLY (no server change).

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

### §S6 Expose the plan/status READ verb (client gap — required all along)
The server exposes `GET /api/v2/projects/<key>/plans` (the full queue: every
plan with its `cr`, `wave`, `status`, `cycles[]` + per-cycle status, merge
commit, `closedAt`) but NO client surfaces it — it survives only as the private
`_open_plans` helper used internally for cycle resolution. So an orchestrator
cannot READ the board through the client at all; the only read paths today are
the dashboard UI or raw `curl` (surfaced 2026-07-20 — identifying the last-run
CR / queue status was done with hand-rolled `curl` + throwaway scripts, exactly
what the client exists to replace). Add a READ verb to the shared client verb
set (all five clients) — `status` (alias `plans`), no `--agent` — that GETs the
plans and returns a §S1 TOON-AXI envelope: the queue as a `plans[]` table (`cr`,
`wave`, `status`, active-cycle id/label, `mergeCommit`) plus a `lastRunCr`
convenience field (the plan with the latest `closedAt`). Read-only; this is the
read half of the client interface, the counterpart to the write/lifecycle verbs.

### §S7 Fleet wiring for the CR-024 server verbs (re-pointed from CR-008)
CR-CRU-024 adds three server verbs — `checkpoint` (`POST …/plans/<id>/checkpoint`),
project `stop` (`POST …/projects/<key>/stop`), and `abort`
(`POST …/plans/<id>/abort`, `userApproved`-gated). Their fleet CLIENT verbs were
originally slated for CR-008, which shipped and merged before these verbs
existed; re-pointed here at CR-024 gap analysis (2026-07-20). Add
`checkpoint` / `stop` / `abort` verbs to the shared client verb set (all five
clients), each returning the §S1 TOON-AXI envelope; the orchestrator's
`/shutdown` emergency flow calls `checkpoint`/`stop`. `abort` carries
`--user-approved` (maps to the body's `userApproved:true`) so the discouraging
409 path stays reachable by default.

### §S8 Gate client verbs — `gate-run` streaming is the AXI standard, `gate-report` discouraged
The no-mistakes gate has two client verbs: `gate-run` (the axi PROXY — polls
`axi status` while the run is in flight, POSTs throttled INTERIM gate snapshots,
then seals a FINAL gate) and `gate-report` (a one-shot POST of a single sealed
gate). The streaming path is **already built end-to-end and works** — verified
2026-07-21: interim POSTs → server gate events → the `gate-pane` widget renders
the latest-by-timestamp event (`app.js`, `gates.reduce(max timestamp)`), so
interim snapshots live-update the single card. A gate that appears "in one shot
at the end" (observed on Model-B's Workflow tab) was posted via `gate-report`,
**not** a Crucible defect. As part of the fleet AXI migration, make `gate-run`
the STANDARD and DISCOURAGE `gate-report`: on every client, `gate-report` emits a
`prefer-gate-run` warning (envelope `warnings[]` + stderr) naming `gate-run` as
the expected streaming use; `gate-report` stays available only where no `axi`
proxy exists. Both gate verbs return the §S1 envelope like every other verb.
**Post-migration action (close-out):** when this CR merges and the fleet is
migrated, notify Model-B (via Sandesh) that the expected gate use case is
**streaming** (`gate-run`), not `gate-report`.

### §S9 Auto-attach ingests to the ACTIVE cycle (no hand-passed `WORKFLOW_CYCLE_ID`)
The ingest verbs (`test`/`regression`/`auto-ingest`) resolve the cycle to attach
to FROM THE SERVER, not solely from the `WORKFLOW_CYCLE_ID` env var. When the env
var is unset, the client resolves the open plan (existing `_open_plans` path) and
reads its cycles via the existing `GET /api/v2/projects/<key>/plans`, then attaches
the run to the plan's single **`status:"active"`** cycle (the CR-024 guard keeps
exactly one). So attachment becomes automatic from `cycle-activate` alone — the
orchestrator's activation is the only input; `WORKFLOW_CYCLE_ID` is demoted to an
optional explicit override. **No active cycle** (all cycles terminal, or none
activated → the query yields none) is a **HARD ERROR** on `register`/ingest
("no active cycle — activate one first"), never a silent orphan. This SUPERSEDES
§S3's soft `no-cycle-id` warning for the cycle-attach case: the client now attaches
(active present) or errors (none), instead of warning-and-proceeding-orphaned.
Rationale: manual `WORKFLOW_CYCLE_ID` passing repeatedly orphaned runs
(`cycleId=NONE`); making the client read the active cycle the orchestrator already
sets removes the whole failure mode. Applies to all five clients.

## Acceptance criteria
- [ ] A shared envelope builder emits the §S1 schema; `clients/toon.py` decodes every verb's stdout back to a dict with `verb` + `ok`.
- [ ] For EACH of `python`/`rust`/`mvn`/`arduino`-crucible.py: `register`, `unregister`, `plan-file`, `cycle-activate`, `cycle-done`, `cr-close`, `cycle-add`, and the ingest result print a `toon.py`-decodable envelope carrying `ok` + result fields (one assertion set per client).
- [ ] Ingest-verb envelopes include `context.cycleId` (value when `WORKFLOW_CYCLE_ID` set; explicit null when unset) for all five clients.
- [ ] §S9: `test`/`regression`/`auto-ingest` with `WORKFLOW_CYCLE_ID` unset AUTO-ATTACHES the run to the open plan's `status:"active"` cycle — assert the ingested run's `context.cycleId` equals the active cycle id, for all five clients; with NO active cycle, `register`/ingest HARD-ERRORS (`ok:false` + "no active cycle", non-zero exit) and never orphans (`cycleId=NONE`); an explicit `WORKFLOW_CYCLE_ID` still overrides the auto-resolution.
- [ ] `cycle-add "<label>"` posts `POST …/plans/<planId>/cycles` and returns the assigned id in the envelope; appending to a CLOSED/absent plan → non-zero + an error envelope.
- [ ] `plan-file`'s assigned cycle ids stay machine-readable via the envelope (the "never guess ids" contract holds under TOON).
- [ ] `context` is REQUIRED in the envelope of every classification-carrying verb; `wave` + `cr` present on plan/run-scoped verbs, `cycleId` on cycle-scoped ingests, `track` when `WORKFLOW_ROLE` set — asserted per client.
- [ ] §S3 `no-wave`: `plan-file` with neither `--wave` nor `WORKFLOW_WAVE` emits a `no-wave` warning (envelope + stderr) naming the CR; with either supplied → the plan carries the wave and no warning. `--wave` overrides env.
- [ ] §S6 read verb: `status` (alias `plans`, no `--agent`) GETs `…/plans` and returns a `toon.py`-decodable envelope with the queue table (`cr`, `wave`, `status`, active cycle, `mergeCommit`) plus a `lastRunCr` field (the plan with the latest `closedAt`), for all five clients; a project with no plans → an empty-queue envelope (`ok:true`), not an error.
- [ ] §S7 re-pointed verbs: `checkpoint`, `stop`, `abort` (`--user-approved`) exist on all five clients, each POSTing the CR-024 server route and returning a `toon.py`-decodable envelope; `abort` without `--user-approved` surfaces the server's discouraging 409 (envelope `ok:false` + help), with it executes.
- [ ] §S8 gate verbs: `gate-run` and `gate-report` return the §S1 envelope on all five clients; `gate-report` additionally emits a `prefer-gate-run` warning (envelope `warnings[]` + stderr) naming `gate-run` as the streaming standard; `gate-run` emits no such warning and POSTs ≥1 interim snapshot before the final sealed gate (asserted per client).
- [ ] Golden fixture per verb per client; the `~/.claude/scripts` mirror is re-synced from `clients/` (CR-008 source-of-truth rule).

## Estimated size
M–L (five clients × verb set, but mechanical once the bun reference + shared builder exist).

## Non-goals
Changing the server INGEST contract (`/api/v2/runs/*`, gate/milestone POST
bodies) — untouched; this CR is CLIENT-ONLY (the `wave` backfill is CR-CRU-031).
The TOON wire format itself (that's
`@toon-format`, ported in CR-013 C4); no-mistakes gate MECHANICS — the server
gate model + the `gate-pane` UI rendering (CR-013 §S4/§S5) — are untouched (only
the CLIENT gate verbs `gate-run`/`gate-report` are standardized, per §S8);
adding NEW verbs beyond `cycle-add`, the §S6 `status`/`plans` read verb, and the §S7 re-pointed `checkpoint`/`stop`/`abort` verbs; a full History-lens
redesign (only the defensive "unclassified" label is in scope, and only if
cheap).
