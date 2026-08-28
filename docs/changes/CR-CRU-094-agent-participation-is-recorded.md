# CR-CRU-094 — agent participation is recorded, not inferred

- **Type**: feature
- **Wave**: 6 (post-0.2.0) — **release membership is the user's call**; filed at the conservative
  default because 0.2.0 is mid-flight with CR-078 executing. Raised as critical by the user
  2026-08-28; move it into 0.2.0 on their word.
- **Depends on**: 056
- **Status**: PENDING (post-0.2.0) — filed 2026-08-28 on user direction

## Problem

Sub-agents **do** register and **do** attach their runs to a cycle. The mechanism works. What is
missing is any way to **see** that it worked, and any refusal when it does not — so a silent
regression in agent attachment would be invisible until the Workflow lens quietly showed a cycle
with no runs against it.

Verified against the running board 2026-08-28, mid-execution of CR-078 C1c:

**1. The binding is recorded on a row that the mandated procedure then deletes.**
`register --cycle <id>` stores the binding as `agents.bound_cycle_id` (`src/store.ts:1195`,
migration at `:857-858`). `sub-agent-procedure.md` requires *"Unregister as your LAST action"*, and
unregister **removes the row** — stated at `src/v2.ts:224`: *"a row past its prune window, or one
removed by unregister, is absent"*. So the moment an agent follows procedure correctly, the record
of which cycle it was bound to ceases to exist.

**2. `lifecycle` events preserve the agent and its role, but not its cycle.** Live sample:

```
{agentId: CR-CRU-078-C1c-RED,   role: RED,   action: registered}   context = None
{agentId: CR-CRU-078-C1c-RED,   role: RED,   action: unregistered} context = None
```

`role` and `action` survive; the binding does not. Consequence: an agent that registers bound and
produces **no runs** — a RED phase that fails to even reach its test command, the exact case worth
noticing — leaves **no trace whatsoever** that it was bound to a cycle.

**3. Attribution exists only inside a JSON blob, and only for runs.** A run's cycle lives at
`context.cycleId`, which is what `linkedRunsFor` filters on (`public/app.js:3217`:
`e.context?.cycleId === cycleId`). There is **no `cycle_id` column on `events`** (checked the whole
`CREATE TABLE`, `src/store.ts`) and **no top-level `cycleId` in the events projection**. A reader —
human or agent — cannot distinguish a bound run from an unbound one without unpacking the blob.
This CR's own filing was prompted by exactly that: the top-level read returns `None` for every
event, which looks identical to total attachment failure.

**4. An unbound ingest is accepted in silence.** The orchestrator's own regression gates
(`regression --agent vidushi`, no `--cycle`) ingest with `context.cycleId` absent and **no warning**.
The gate that qualifies a merge is therefore unattributable to the VERIFY cycle it qualified, and
nothing said so. `--cycle` is available on `regression`; nothing requires or encourages it.

**5. `lastRunCr` does not mean what it says.** `status` reports `lastRunCr`, which reads as "the CR
of the most recent run". It is computed as *"the `cr` of the plan with the LATEST `closedAt`"* —
the last CR to **merge** (`clients/_crucible_axi.py:448-454`). During CR-078's execution it reported
`CR-CRU-092`, the previously merged CR, while 078's runs were the newest on the board. The value is
correct for what it computes; the name misrepresents it, and it is the first field an orchestrator
reads when asking "is my work landing?".

Nothing here is a wrong write. Every item is an **observability** defect: the system does the right
thing and cannot prove it.

## Scope

### §S1 The cycle binding rides the run, as a column

`events` gains `cycle_id INTEGER` — additive, nullable — set at ingest from the caller's binding, on
the migration pattern CR-091 §S2 established (`tableExists` guard, PRAGMA-checked `ALTER TABLE` per
column, a `satisfiedBy` probe, `SCHEMA_VERSION` advancing by APPENDING a step to `MIGRATION_BODIES`
and never by editing a number).

`context.cycleId` is **not** removed and **not** duplicated as a second source of truth: the column
is the stored fact, and the existing `context` projection continues to carry it so
`linkedRunsFor` (`public/app.js:3211-3217`) keeps working byte-identically. This CR does not touch the
frontend's linking; it makes the stored fact addressable.

The projection gains a top-level `cycleId`, so a reader can tell a bound run from an unbound one
without unpacking a blob.

### §S2 Participation survives the agent

A `lifecycle` event records the cycle the agent was bound to, so the register/unregister pair is a
complete record of *who worked which cycle in which role* — recoverable after the agent row is gone,
and recoverable for an agent that produced no runs at all.

This is the half that makes the mandated unregister safe: the procedure is correct and stays
unchanged; what changes is that following it no longer destroys the evidence.

### §S3 An unbound ingest is reported, never silent

An ingest from a caller with no resolvable cycle binding and no explicit `context.cycleId` still
**succeeds** — it is not a refusal, because a genuinely project-scoped run (a fleet gate, an ad-hoc
probe) is legitimate. It carries a structured warning naming the absence, on the existing
`warnings[]` contract, so the envelope states plainly that this run is attributable to no cycle.

Warn-and-write, matching the severity ladder CR-091 §S5 established: the write is not the problem,
the silence is.

### §S4 `lastRunCr` says what it means

Renamed to state the fact it computes — the last CR to close/merge. The old key is a clean break,
not an alias: CR-CRU-059 §S0 set the precedent for a fleet-wide rename with no dual-key handling,
and a field whose name lies is worse than one that moves.

Whether the surface should ALSO report a genuine "most recent run's CR" is a separate question this
CR does not answer, because it needs §S1's column to be answerable at all.

## Acceptance criteria

- **AC1** — **the binding is on the run.** A run ingested by an agent registered with
  `--cycle <id>` has `events.cycle_id === <id>`, and the API projects a top-level `cycleId`. A
  fixture asserting only `context.cycleId` passes today and therefore proves nothing — the column is
  asserted directly.
- **AC2** — **the migration is additive and re-runnable.** A store written by the previous build
  opens, gains the column, loses no event, and the new step's `satisfiedBy` returns true afterwards.
  `SCHEMA_VERSION === MIGRATIONS.length` and has advanced by exactly one. A fresh store never runs
  the retrofit.
- **AC3** — **`linkedRunsFor` is unchanged in behaviour.** The frontend's existing
  `e.context?.cycleId === cycleId` filter returns the same runs before and after this CR, asserted
  against the same fixture. A change in what the Workflow lens shows fails this AC — the surface is
  not in scope.
- **AC4** — **participation survives the agent.** Register bound to cycle N, ingest nothing,
  unregister. The lifecycle record still names the agent, its role AND cycle N. Asserted with **zero
  runs**, because a run-derived answer would mask the gap this AC exists to close.
- **AC5** — **an unbound ingest warns and lands.** A `regression`/`test` ingest with no binding and
  no explicit `context.cycleId` returns `ok: true`, stores the run, and carries a structured
  `warnings[]` entry naming the missing attribution. Asserted in both directions: a BOUND ingest
  emits no such warning.
- **AC6** — **the orchestrator's own gate is attributable.** `regression --agent <orc> --cycle <id>`
  produces a run carrying that cycle; the same command without `--cycle` produces AC5's warning.
  This is the case that prompted the CR and it must be covered by a test, not by a convention.
- **AC7** — **the renamed status field.** `status` reports the last-closed CR under a name that says
  so, the old key is absent from the envelope, and its `--help` describes the fact it computes. A
  response carrying both keys fails this AC.
- **AC8** — **AXI conformance on every changed verb**, asserted by extending the two EXISTING
  harnesses (`tests/client/test_cr054_fleet_inventory.py` presence,
  `tests/client/test_client_fleet_envelope_census.py` envelope) rather than a parallel checker —
  the pattern CR-091 AC19 and CR-092 AC15 both follow.

## Estimated size

M — one additive column with its migration step, the ingest stamping, one projection field, a
lifecycle-record addition, one warning on an existing contract, and a field rename across the
client fleet.

## Risk

The rename (§S4) touches a field an orchestrator reads constantly, and a clean break means any
consumer reading the old key breaks loudly. That is the intent — CR-059's precedent — but the
consumers must be ENUMERATED before the rename, across `src/`, `clients/`, `public/` and `tests/`,
not assumed to be the one call site that is easy to find. Note that a search of
`public/app-logic.mjs` for any pattern silently returns nothing (the file holds literal NUL bytes,
registered separately in the queue notes), so the enumeration must not rely on a single grep.

Second risk: `context.cycleId` and `events.cycle_id` are two representations of one fact for as long
as both exist. §S1 keeps `context` authoritative for the frontend deliberately, so the column cannot
drift into a second source of truth — but a later CR that starts writing one without the other would
reintroduce exactly the ambiguity CR-091 removed from `seq`.

## Non-goals

- Changing `sub-agent-procedure.md`'s unregister-last rule — it is correct; this CR makes following
  it non-destructive.
- Rendering agent participation anywhere (the agent rail, the Workflow lens, a history view). This
  CR makes the fact recordable and addressable; drawing it is a separate CR with its own design.
- Refusing an unbound ingest. §S3 warns deliberately; a refusal would break legitimate
  project-scoped runs.
- Reconstructing attribution for runs already ingested. The historical events have no binding to
  recover, and inventing one would fabricate a record.
