# CR-CRU-140 — evidence a filer can cite

**Type** hotfix · **Wave** 7 (0.2.2) · **Depends on** — · **Status** PENDING

## Problem

An orchestrator asked "what has this cycle recorded?", could not find the answer, hand-queried
`data/crucible.db`, read the wrong table, and published a false accusation against an agent that had
filed correctly.

**This CR was originally filed on three premises. Gap analysis measured them 2026-09-17 and two are
FALSE — the product already does what they claimed it did not.** They are recorded here rather than
quietly deleted, because the correction is the finding:

| Original premise | Measured |
|---|---|
| "The ingest response carries no identifier" | **FALSE.** `runResponse` (`src/v2.ts`) answers `{ok, changed, event: <id>, run, verdict, …}` on every ingest route. Every agent in this release quoted those ids back. |
| "No route lists what a cycle recorded" | **FALSE.** `GET /api/v2/events?project=<key>&cycleId=<id>` returns exactly that cycle's linked runs plus its declared boundary as `cycle` — built by CR-CRU-032 §S1, `src/v2.ts:3611-3632` via `store.listEventsForCycle`. |
| "The table named `runs` is not where runs land" | **TRUE.** A JUnit ingest writes an `events` row of `kind='test'`; `runs` holds the OPEN/STREAMING row (`run_state`, `settled_at`, `abort_reason`, `event_id`). |

So the data was addressable and the identifier was returned. **The defect is that neither is
FINDABLE, and that the table names actively mislead the reader who goes looking.** Measured:

- The v2 root's own `help[]` enumerates exactly four routes — create project, list projects, register
  an agent, health. The events route is not among them, and neither is the `cycleId` query that
  makes it answer this question.
- `cycleId=` appears in **no** file under `docs/` and in **no** client help hint (`grep`, 2026-09-17).
- So the discoverable surface points a reader at `runs`, whose NAME is the one thing in the system
  that promises to hold runs, and which holds something else.

That is the whole cost: the orchestrator's verification method was wrong, every actor was acting in
good faith, and the only path the product actually advertised led to the wrong table.

## Scope

### §S1 — the route that answers "what did this cycle record" says so where a reader looks

The existing route is unchanged — no new route, no new response field. What changes is that it stops
being undiscoverable:

- the v2 root `help[]` names it, including the `cycleId` query, alongside the four it already lists;
- the ingest routes' own `help[]` name it too, so the reply that hands back `event: <id>` also says
  how to read that evidence back;
- `docs/RUNBOOK.md` documents it in the same place it documents the rest of the read surface.

A reader who follows the product's own hints must arrive at the route that answers the question,
rather than at the database.

### §S2 — the naming stops misleading

`runs` holding streaming rows while ingested results live in `events` is a trap set for exactly the
reader trying to do the right thing. This CR does **not** rename a shipped table — a migration is
out of proportion to a naming complaint, and CR-CRU-129's eviction history is a standing warning
about moving this data. Instead the trap is closed where it is cheap and honest: the schema states,
at each of the two tables, what it holds and what the other holds, so a reader who opens the
database — as this orchestrator did — is told within one screen that `runs` is not where runs land.

The vocabulary question (whether the ingest surface should speak of `runs` consistently, or the
tables be renamed) is deliberately **left open** and belongs to its own CR against the PRD, not to a
hotfix.

### §S3 — a route that advertises a read must be visible to it

Found by VERIFY, not by design: §S1 makes all five event-id-returning routes advertise
`GET /api/v2/events?project=&cycleId=`, and for `POST /api/v2/milestones` that advertisement is
false in the ordinary case. `handleMilestones` takes its context from `eventContext(body)` alone,
so a milestone filed by a registered, cycle-BOUND agent is stored with no cycle and does not appear
in the read its own reply names. Measured both ways: without an explicit body `context` the
advertised read answers `events: []`; with `context: {cycleId}` the same milestone is returned.

`/runs` and `/gates` already resolve the binding through `resolveIngestAttach(...)` and store
`attach.context`; `/milestones` never calls it. So this is not a new mechanism — it is CR-CRU-094's
own contract ("the server stamps that binding onto every ingest you post") left unimplemented on one
of the three stamped surfaces. The milestone route adopts the same call its two siblings use.

An explicit body `context` keeps winning where one is supplied, exactly as on the sibling routes —
this adds the binding as the fallback, it does not override a caller who stated a cycle.

## Acceptance criteria

**§S1**
- [ ] `GET /api/v2` 's `help[]` names the cycle-evidence route including its `cycleId` query, and a
      test asserts it — enumerated from the route table rather than a retyped literal, so a route
      added later is not silently unhinted.
- [ ] Every ingest route that returns `event: <id>` also returns a `help[]` entry naming how to read
      that evidence back, asserted for each such route (not just one).
- [ ] `docs/RUNBOOK.md` documents the route and its `cycleId` query beside the rest of the read
      surface, and a test asserts the documented path matches the route the server actually serves
      (CR-CRU-134's derivation rule — the doc may not retype what the code declares).
- [ ] A reader following ONLY the product's own output — an ingest reply, then the hints in it — can
      reach that cycle's recorded runs. Asserted end to end: ingest a run, take the returned id and
      the returned hint, call what the hint names, and find that id in the answer.

**§S2**
- [ ] The schema states at `runs` what it holds (the open/streaming row) and that ingested results
      live in `events`; and at `events` the converse. Asserted against the shipped schema text, so a
      future table change cannot drop the warning silently.
- [ ] No table is renamed and no migration is introduced by this CR — asserted by the migration
      count/schema version being unchanged.

**§S3**
- [ ] A milestone filed by a cycle-BOUND agent with NO explicit body `context` is returned by the
      read its own reply advertises — asserted end to end: register bound, post the milestone, take
      the hint from the reply, follow it, find that event id. This is the case that measured
      `events: []` before the fix.
- [ ] An explicit body `context` still wins over the binding on `/milestones`, matching `/runs` and
      `/gates` — asserted, not assumed.
- [ ] `/milestones` resolves its attachment through the SAME `resolveIngestAttach(...)` seam its two
      sibling stamped surfaces use; a second, parallel resolution path is a defect, not an
      implementation choice.
- [ ] Every route that advertises the evidence read is visible to it — asserted for all five, so the
      next route to return an `event` id cannot advertise a read it is absent from.

## Estimated size

Small. Help-hint entries, a RUNBOOK section, two schema comments, and the tests that hold them. No
new route, no new response field, no migration.

## Risk

- **A hint that drifts is worse than no hint**, which is why every AC above derives from the route
  table or the schema text rather than retyping a path. The failure this CR fixes was caused by
  documentation-by-absence; documentation-by-stale-copy would replace it with a subtler version.

## Non-goals

- Renaming `runs`/`events`, or any migration. Left open for its own CR against the PRD.
- Adding a route, or changing what an ingest stores — **with ONE carve-out, forced by VERIFY and
  recorded rather than waved through**: `POST /api/v2/milestones` must honour the agent's cycle
  binding the way `/runs` and `/gates` already do (§S3). That does change what a milestone ingest
  stores. It is in scope because §S1 makes that route advertise a read, and VERIFY measured the
  advertised read returning `events: []` for the ordinary bound-agent milestone — so without it this
  CR would ship a hint that lies, which its own Risk section calls worse than no hint. Every other
  ingest's stored shape is untouched.
- Changing the board UI. It already renders this data correctly.
