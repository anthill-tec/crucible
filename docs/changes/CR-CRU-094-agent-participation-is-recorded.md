# CR-CRU-094 — agent participation is recorded, not inferred

- **Type**: feature
- **Wave**: 5 (0.2.0) — **moved into the 0.2.0 horizon by user direction 2026-08-28.** Filed the
  same day at the conservative post-0.2.0 default because 0.2.0 was mid-flight with CR-078
  executing; the user raised it as critical and, once CR-078 landed, moved it in. Release
  membership is the user's call and this records theirs.
- **Depends on**: 056 — **COMPLETED** (wave 4, plan closed, merged at `5844a91`), so this CR is
  dependency-clear and schedulable immediately.
- **Status**: PENDING (0.2.0) — filed 2026-08-28 on user direction, moved into 0.2.0 the same day —
  **gap-analysed 2026-09-07** against `develop`@`35cf967`, baseline measured (131 bun / 0 fail across
  nine suites, 190 python + 9 subtests / 0 fail across five): all three of §S1–§S3's premises
  re-verified TRUE, five of seven code citations re-pinned to SYMBOLS after drift, the
  `context.cycleId` consumer set corrected from one to FOUR, §S4's rename surface measured NUL-safe
  as smaller than the Risk feared, and §S3 re-timed to PRE-FLIGHT by user ruling.

> **Lineage: this completes CR-056, it does not correct it.** CR-CRU-056 is
> *"Agent registration binds its cycle EXPLICITLY; server-side auto-attach guessing is DELETED"* —
> it made the binding explicit and stored it on `agents.bound_cycle_id`, replacing a server-side
> guess that was worse. Every `register --agent X --role RED --cycle N` in every dispatch brief is
> its contract. What it did not do was make that binding DURABLE past the agent's lifetime, because
> the mandated `unregister` had not yet been recognised as destroying the row that carried it. So
> "depends on 056" here is a lineage, not plumbing: 056 created the explicit binding, and this CR
> makes it survive.

## Problem

Sub-agents **do** register and **do** attach their runs to a cycle. The mechanism works. What is
missing is any way to **see** that it worked, and any refusal when it does not — so a silent
regression in agent attachment would be invisible until the Workflow lens quietly showed a cycle
with no runs against it.

Verified against the running board 2026-08-28, mid-execution of CR-078 C1c:

**1. The binding is recorded on a row that the mandated procedure then deletes.**
`register --cycle <id>` stores the binding as `agents.bound_cycle_id` — written in `Store.touchAgent`
(the INSERT and the UPDATE both carry it) and retrofitted by **migration body #4**, whose description
names its lineage (`"agents: CR-059 phase->role RENAME, CR-044 role, CR-056 bound_cycle_id"`). It
reaches any reader as `boundCycleId` via `Store.toAgent`, key ABSENT when unbound.
`sub-agent-procedure.md` requires *"Unregister as your LAST action"*, and unregister **removes the
row** — stated in the agent-route doc block: *"a row past its prune window, or one removed by
unregister, is absent"*. So the moment an agent follows procedure correctly, the record of which
cycle it was bound to ceases to exist.
*(Re-cited by SYMBOL 2026-09-07: the filed line numbers `store.ts:1195`, `:857-858` and `v2.ts:224`
had all drifted — `1195` is now WAL journal logic. Symbols, never lines.)*

**2. `lifecycle` events preserve the agent and its role, but not its cycle.** Live sample:

```
{agentId: CR-CRU-078-C1c-RED,   role: RED,   action: registered}   context = None
{agentId: CR-CRU-078-C1c-RED,   role: RED,   action: unregistered} context = None
```

`role` and `action` survive; the binding does not. Consequence: an agent that registers bound and
produces **no runs** — a RED phase that fails to even reach its test command, the exact case worth
noticing — leaves **no trace whatsoever** that it was bound to a cycle.

**3. Attribution exists only inside a JSON blob, and only for runs.** A run's cycle lives at
`context.cycleId`, which is what `linkedRunsFor` filters on (`public/app.js` —
`e.context?.cycleId === cycleId`) **and three more consumers the filing missed**, enumerated in §S1.
There is **no `cycle_id` column on `events`** (re-checked 2026-09-07 against the whole
`CREATE TABLE IF NOT EXISTS events` in `createBaseTables`) and **no top-level `cycleId` in
`eventBrief`**. A reader —
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
and never by editing a number — the constant is DERIVED, `SCHEMA_VERSION = MIGRATIONS.length`).
Measured 2026-09-07: `MIGRATION_BODIES` holds eight bodies, so this is **body #9** and
`SCHEMA_VERSION` goes **8 → 9**.

**One seam, already built.** Every stamped ingest resolves its attachment in exactly one function,
`resolveIngestAttach`, whose last line returns `{ ...roleAttach, context: { ...context, cycleId: bound } }`.
That single return is where the column is set; there is no second write site to keep in step, and
GREEN must not create one.

`context.cycleId` is **not** removed and **not** duplicated as a second source of truth: the column
is the stored fact, and the existing `context` projection continues to carry it so **all four**
existing consumers keep working byte-identically —

1. `public/app.js` — `linkedRunsFor`, `runningRunsFor`, and the `runFeed` card filter;
2. `public/app-logic.mjs` — a composite-key cycle index: `planCycleIndexKey(plan, cycleId)` builds
   `` `${projectKey}\x00${cycleId}` `` with a bare-id fallback for legacy undeclared plans,
   `planCycleLookupKey(index, event)` resolves an event against it, and two more sites read
   `e.context?.cycleId` / `run.context?.cycleId`. **These are invisible to every pattern search** —
   the five literal NUL bytes that make the file "binary" ARE this key's separator, so the
   enumeration was done by reading the bytes in Python, not by grep;
3. `public/app-logic.d.mts` — the declarations for the above;
4. `src/store.ts` — `listEventsForCycle`, which parses `context.cycleId` out of JSON server-side and
   is the one consumer §S1's column could later turn into a real `WHERE` clause.

This CR does not touch any of them; it makes the stored fact addressable.

The projection gains a top-level `cycleId`, so a reader can tell a bound run from an unbound one
without unpacking a blob. **The key is ABSENT when the run carries no cycle** — never `null` —
matching the additive convention `eventBrief` already uses for `action`, `firstSeen`, `role`, `gate`
and `version`. Measured 2026-09-07: the live `events[]` array is ALREADY heterogeneous across kinds
(a milestone carries `type`/`label`/`commit`, a test carries `codec`/`coverageLines`/`startedAt`, a
lifecycle carries `action`/`firstSeen`), so TOON's uniform-table form does not apply to it today and
an absent key costs the wire nothing.

### §S2 Participation survives the agent

A `lifecycle` event records the cycle the agent was bound to, so the register/unregister pair is a
complete record of *who worked which cycle in which role* — recoverable after the agent row is gone,
and recoverable for an agent that produced no runs at all.

This is the half that makes the mandated unregister safe: the procedure is correct and stays
unchanged; what changes is that following it no longer destroys the evidence.

**Two routes destroy the record, not one — added 2026-08-28.** Item 1 above is `unregister`
deleting the row. The second is **pruning by silence**, and it was observed three times in one
session: `vidushi` registered as `ORCHESTRATOR`, dispatched a cycle that ran 30m41s, and on return
`cycle-done` and `cycle-activate` both refused with 409. Liveness is derived from silence
(`Store.livenessOf`): `online → stale → tombstoned → pruned` as `now - lastSeen` crosses each
threshold. Sub-agents heartbeat ~every 2 min and comply; **an orchestrator waiting on a dispatch
emits nothing**, because it has no work to report, so a single long cycle prunes it.

This section already covers both, and that is the point of stating it: a `lifecycle` event carrying
the cycle is recoverable after the row is gone **however** it went — deleted deliberately or pruned
for silence. No extra scope; the second route is why the first is not a special case.

**What this is NOT — checked, and the code is already right.** It is tempting to also demand that
the 409 distinguish "pruned after silence" from "never registered". It already declines to guess and
names all three causes: `src/hints.ts:325` reads *"has no live registration in this project (never
registered, unregistered, or pruned) — nothing was stored or changed"*, and the recovery it offers
is the correct one for each. A draft of this CR asserted the refusal "gives the wrong first
instruction"; that was false and is recorded here so it is not re-filed. The three 409s were
operational friction — re-register and continue — not a diagnostic failure.

### §S3 A missing attribution is reported BEFORE the run, never after it in silence

**Re-timed 2026-09-07 by user ruling.** The filing put the warning on the ingest RESPONSE. The
ruling moves it to **pre-flight — emitted when the run starts, while `--cycle` can still be
supplied.** The reason is the convention's own words: `no_wave_warning` and `no_title_warning` each
name a remedy verb (`plan-backfill --cr <cr> --wave <n>`) "so the omission is actionable", and
**there is no run-level cycle backfill verb** — `plan-backfill` backfills a plan's wave, nothing
backfills a stored run's attribution. A post-hoc warning on a 9-minute gate names no remedy anyone
will take; the same warning before the suite starts does.

An ingest from a caller with no resolvable cycle binding and no explicit `context.cycleId` still
**succeeds** — it is not a refusal, because a genuinely project-scoped run (a fleet gate, an ad-hoc
probe) is legitimate, and the PRD makes it first-class: *"ORCHESTRATOR and report agents may register
unbound"* (locked 2026-08-01).

**Mechanism, all of it already on the wire.** The binding is readable before the run:
`Store.toAgent` projects `boundCycleId` (absent when unbound) and `handleAgentsList` spreads it, so
`GET /api/v2/agents?project=<key>` answers "am I bound?" with no new endpoint — verified live
2026-09-07. Pre-flight is therefore: `--cycle` supplied → nothing to warn about; else read the
binding; absent → warn. Two constraints, both load-bearing:

- **Best-effort, never blocking.** A failed or slow lookup produces NO warning and NEVER prevents
  the run. A test suite must not become unrunnable because attribution could not be computed.
- **Both channels.** The line prints to stderr at start (the shape `gate_identity_skipped_line`
  already uses to tell an operator why something did not happen) AND the same `{code, detail}` entry
  rides the final envelope's `warnings[]`. Stderr alone is invisible to a scripted reader, and
  Problem 4 above is precisely about the envelope not saying so.

**Which verbs.** Every verb that can ingest: `test`, `regression`, `pre-merge-gate`, `auto-ingest`,
and `check` (which ingests type errors on failure). Note the fleet's existing `--cycle` coverage is
asymmetric — bun has it on `test`/`regression`/`pre-merge-gate`, arduino on four verbs, python/mvn/
rust on `regression`/`pre-merge-gate` only, and NO client has it on `check` or `auto-ingest`.
**Closing that asymmetry is explicitly NOT in this CR** (see Non-goals); the pre-flight warning is
what tells a caller on those verbs that attribution is missing.

Warn-and-write, matching the severity ladder CR-091 §S5 established: the write is not the problem,
the silence is.

**Considered and NOT taken (recorded so it is not re-litigated):** narrowing the warning to fire
only when the project HAS an active cycle. The argument for it is that an unbound TDD ingest is
structurally impossible — `handleAgentTouch` 409s a `RED|GREEN|FIX|VERIFY` registration with no
`cycleId` — so the warning can only ever fire on the PRD-permitted ORCHESTRATOR/report case, i.e. on
correct behaviour. The ruling chose re-timing instead: a pre-flight warning is a prompt, not a
verdict, and a prompt on a legitimate run is acceptable where a permanent post-hoc complaint was
not.

### §S4 `lastRunCr` says what it means

Renamed to state the fact it computes — the last CR to close/merge. The old key is a clean break,
not an alias: CR-CRU-059 §S0 set the precedent for a fleet-wide rename with no dual-key handling
(verified 2026-09-07 — *"accepts `role` only; no `phase` alias, no dual-key handling, no deprecation
path"*), and a field whose name lies is worse than one that moves.

**Surface measured 2026-09-07, NUL-safe** (every `public/` file read as bytes in Python, because the
Risk below is real): `lastRunCr` occurs **ZERO times in `src/`** and **ZERO times in `public/`**. It
is client-side only — computed by `last_run_cr` in the shared module and never emitted by the
server — so the rename needs **no migration and no wire change**. The real surface is four places:
the shared module (5 sites), the five clients' help/docstrings (2 each), `clients/STATUS-CONTRACT.md`
(3), and the tests (8 assertions across 6 files).

**Two carve-outs, stated so nobody "completes" the rename by breaking a rule.**
`docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md` and
`docs/changes/CR-CRU-035-ambient-context-session-hooks.md` both contain the old key in their spec
prose. Both are SHIPPED, and the standing rule (recorded from CR-CRU-099 cycle 322 VERIFY) is that
an AC may not require editing a shipped CR — so this CR **does not touch them**; this section is the
record instead, exactly as CR-CRU-109 §S1 recorded its supersessions. Second: an INSTALLED copy of
the fleet lives under `.venv/lib/python3.12/site-packages/crucible_axi/` and is already older than
the repo's; it is refreshed by reinstall, never by hand.

Whether the surface should ALSO report a genuine "most recent run's CR" is a separate question this
CR does not answer, because it needs §S1's column to be answerable at all.

## Acceptance criteria

- **AC1** — **the binding is on the run.** A run ingested by an agent registered with
  `--cycle <id>` has `events.cycle_id === <id>`, and the API projects a top-level `cycleId`. The key
  is **ABSENT** (never `null`) on a run with no cycle, matching `eventBrief`'s existing additive
  convention. A fixture asserting only `context.cycleId` passes today and therefore proves nothing —
  the column is asserted directly, and the stamp is asserted at the ONE seam
  (`resolveIngestAttach`'s return), not at a second write site.
- **AC2** — **the migration is additive and re-runnable.** A store written by the previous build
  opens, gains the column, **loses no event row**, and the new step's `satisfiedBy` returns true
  afterwards. `SCHEMA_VERSION` advances by exactly one (8 → 9) by APPENDING a body, never by editing
  the derived constant. *Scope note 2026-09-07: the generic half of this is ALREADY enforced for
  every future migration by `tests/store-migration.test.ts` — CR-CRU-071's "AC1 — a freshly opened
  store is stamped with SCHEMA_VERSION and structurally matches it" and "AC3 — MIGRATIONS is a
  contiguous ordered chain ending at SCHEMA_VERSION" — so this AC is discharged by CITING those and
  adding only the one thing they do not cover: row preservation across the retrofit, for which that
  suite already ships `snapshotLiveStore` / `copyOfRealStore` / `rowCounts`. Do not rebuild the
  harness.*
- **AC3** — **every existing `context.cycleId` consumer is unchanged in behaviour.** Asserted
  against the same fixture, before and after, for **all four** (§S1's list): `public/app.js`'s
  `linkedRunsFor` / `runningRunsFor` / `runFeed` filter, `public/app-logic.mjs`'s composite-key
  index (`planCycleIndexKey` / `planCycleLookupKey` and its two sibling reads — reached by reading
  bytes, since no pattern search sees that file), the `app-logic.d.mts` declarations, and
  `Store.listEventsForCycle`. A change in what the Workflow lens shows fails this AC — the surface
  is not in scope. *An AC naming one call site cannot detect a change in the other three; the filing
  named one.*
- **AC4** — **participation survives the agent.** Register bound to cycle N, ingest nothing,
  unregister. The lifecycle record still names the agent, its role AND cycle N. Asserted with **zero
  runs**, because a run-derived answer would mask the gap this AC exists to close.
- **AC5** — **a missing attribution is announced BEFORE the run, and the run still lands.** With no
  binding, no `--cycle` and no explicit `context.cycleId`: the client emits the structured
  `{code, detail}` warning at PRE-FLIGHT — on stderr as the run starts AND in the final envelope's
  `warnings[]` — and the ingest still returns `ok: true` with the run stored. Asserted in both
  directions: a BOUND caller (registered `--cycle N`, no flag) emits **no** such warning, which is
  the assertion that forces pre-flight to READ the binding (`GET /api/v2/agents` → `boundCycleId`)
  rather than infer it from the absence of a local `--cycle` flag. A flag-derived implementation
  passes AC6 and fails this direction. Asserted also: a lookup that fails or times out produces no
  warning and does not prevent the run.
- **AC6** — **the orchestrator's own gate is attributable.** `regression --agent <orc> --cycle <id>`
  produces a run carrying that cycle; the same command without `--cycle` produces AC5's pre-flight
  warning. This is the case that prompted the CR and it must be covered by a test, not by a
  convention. *Live evidence 2026-09-07: the `pre-merge-gate` run that qualified CR-CRU-109's merge
  is stored as `agentId: vidushi, tier: regression, passed: 2156` with **no `context` key at all**.*
- **AC7** — **the renamed status field.** `status` reports the last-closed CR under a name that says
  so, the old key is absent from the envelope, and its `--help` describes the fact it computes. A
  response carrying both keys fails this AC. The rename covers the four surfaces §S4 measured — the
  shared module, the five clients' help/docstrings, `clients/STATUS-CONTRACT.md`, and the 8 test
  assertions — and **must not touch** CR-CRU-030 or CR-CRU-035, which are shipped (§S4's carve-out).
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
consumers must be ENUMERATED before the rename, not assumed to be the one call site that is easy to
find. **Enumeration DONE 2026-09-07** and recorded in §S4: `src/` and `public/` hold zero
occurrences, so the surface is four places, not four trees. The enumeration was performed by reading
every `public/` file as BYTES in Python, because a search of `public/app-logic.mjs` for any pattern
silently returns nothing (the file holds five literal NUL bytes, registered separately in the queue
notes) — and that hazard was not hypothetical: the same technique is what found the SIX
`context.cycleId` consumers in that file which §S1 had missed and AC3 had under-asserted.

Second risk: `context.cycleId` and `events.cycle_id` are two representations of one fact for as long
as both exist. §S1 keeps `context` authoritative for the frontend deliberately, so the column cannot
drift into a second source of truth — but a later CR that starts writing one without the other would
reintroduce exactly the ambiguity CR-091 removed from `seq`. The mitigation is structural rather
than documentary: there is exactly ONE write seam (`resolveIngestAttach`'s return), and AC1 asserts
the stamp there.

## Non-goals

- Changing `sub-agent-procedure.md`'s unregister-last rule — it is correct; this CR makes following
  it non-destructive.
- Rendering agent participation anywhere (the agent rail, the Workflow lens, a history view). This
  CR makes the fact recordable and addressable; drawing it is a separate CR with its own design.
- Refusing an unbound ingest. §S3 warns deliberately; a refusal would break legitimate
  project-scoped runs.
- Reconstructing attribution for runs already ingested. The historical events have no binding to
  recover, and inventing one would fabricate a record.
- **Closing the fleet's `--cycle` asymmetry** (added 2026-09-07 by the gap analysis). Measured:
  `--cycle` exists on bun's `test`/`regression`/`pre-merge-gate`, arduino's four run verbs, and
  python/mvn/rust's `regression`/`pre-merge-gate` only — and on NO client's `check` or `auto-ingest`.
  Making that uniform is a fleet-parity patch CR (the CR-CRU-075 family), not this one. §S3's
  pre-flight warning is what tells a caller on an unflagged verb that its run will be
  unattributable; it does not give them a flag to fix it with.
- **Editing CR-CRU-030 or CR-CRU-035** to remove the old `lastRunCr` key. Both are shipped; §S4's
  carve-out records the rename instead.

## Gap analysis — 2026-09-07 (orchestrator, pre-branch)

Run against `develop`@`35cf967`. **Verdict: SPEC_UPDATE_NEEDED → applied in this commit.** No
prerequisite CR, no PRD violation, no blocked design.

**Baseline, measured (02:20–02:21 UTC):** `store-migration` 16/0 · `agent-cycle-binding` 19/0 ·
`agent-lifecycle` 8/0 · `event-role-stamping` 11/0 · `v2-runs-events` 19/0 · `events` 17/0 ·
`ingest-no-implicit-agents` 11/0 · `agent-role` 13/0 · `run-lifecycle` 17/0 — **131 bun / 0 fail**.
`test_bun_crucible_status` 8 · `test_crucible_axi_shared` 59 · `test_cr054_fleet_inventory` 46+5 ·
`test_client_fleet_envelope_census` 65 · `test_cr017_client_lifecycle` 12+4 — **190 python + 9
subtests / 0 fail**. Re-measured after the CR-CRU-109 merge, its board writes and a server restart.

**Premises re-verified TRUE:** no `cycle_id` on `events`; no top-level `cycleId` in `eventBrief`;
`recordLifecycleEvent` carries `role` but no cycle; the unbound-ingest branch of
`resolveIngestAttach` returns silently. The CR is still needed, unchanged in intent.

**Eight findings, all applied above:** (1) five of seven citations stale → re-cited by symbol;
(2) AC3 named one of FOUR `context.cycleId` consumers, six of them grep-invisible in
`app-logic.mjs`; (3) §S3's warning fired only on PRD-permitted behaviour with no remedy verb →
user ruling, re-timed to pre-flight; (4) ingest verbs under-named and fleet `--cycle` asymmetric →
enumerated, parity made a non-goal; (5) rename surface measured smaller than the Risk feared, but
two SHIPPED CRs hold the old key → carve-out; (6) AC2 duplicated CR-071's generic migration ACs →
cite, don't rebuild; (7) all three sections' seams already exist (`resolveIngestAttach`'s return,
the two `recordLifecycleEvent` call sites, `GET /api/v2/agents`'s `boundCycleId`) → named, so GREEN
cannot invent a second source of truth; (8) top-level `cycleId` absent-vs-null was unspecified →
ABSENT, with the live `events[]` heterogeneity measured to prove the wire cost is nil.

**Bounded-surface check (Dimension 3):** no pixel/row/column budget in scope. The one bounded
surface is the TOON envelope, and it was measured rather than assumed — `events[]` is already
non-uniform across kinds, so an additive optional key changes no encoding.

**Cost check (Dimension 7):** AC4 is nearly free (the unregister route already holds the agent row
and passes `firstSeen`/`role` from it under CR-057's survives-deletion contract). AC1 is one
migration body plus one line at one seam. AC2 shrinks to a row-preservation assertion on an existing
harness. AC5/AC6 grew slightly with the pre-flight ruling — a read the wire already serves, best-
effort and non-blocking. Nothing here demands machinery out of proportion to what it protects.
