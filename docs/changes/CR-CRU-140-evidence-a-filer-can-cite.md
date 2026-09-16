# CR-CRU-140 — evidence a filer can cite

**Type** fix · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING

## Problem

An agent files a test run and cannot afterwards name what it filed. An orchestrator checking that
agent's work cannot list what a cycle carries. Both had to read `data/crucible.db` by hand, and one
of them then published a false accusation from the wrong table.

Three things combine, none of them individually dramatic:

- **The ingest response carries no identifier.** A filing agent is told `ok=True` and nothing else,
  so it cannot cite its own evidence in a report, and it cannot distinguish "recorded" from
  "answered by something".
- **No route lists what a cycle recorded.** `GET /api/v2/cycles/<id>` and
  `GET /api/v2/projects/<key>/runs` both answer `unknown route`; the v2 help enumerates projects,
  agent registration and health. The board renders a cycle's runs in its UI, so the data is
  reachable — it simply is not addressable.
- **The table named `runs` is not where runs land.** A JUnit ingest writes an `events` row of
  `kind='test'`. `runs` holds an OPEN/STREAMING row (`run_state`, `settled_at`, `abort_reason`,
  `event_id`). So the obvious query — `select … from runs where cycleId = <id>` — answers "no
  evidence" for a cycle whose evidence was recorded correctly.

**What it cost, measured 2026-09-16 during CR-CRU-139 C2.** The user asked twice why a live cycle's
rail looked empty. On the second occasion the orchestrator queried `runs`, got zero for cycle 475,
and told both the user and the agent that the agent's ingests had gone to a temp database. The agent
disproved it by reading the `events` table: all of its runs had been on the dev board the whole
time. The orchestrator's verification method was wrong, and nothing in the product could have told
it so — an `ok=True` with no id, no listing route, and a table whose name means something else.

That is the shape of an observability defect: the system was RIGHT, every actor was acting in good
faith, and the only available check reported the opposite.

## Scope

### §S1 An ingest answers with the identifier of what it recorded

The ingest response names the row it wrote, so a filer can quote it and a reader can find it.

### §S2 A cycle's recorded evidence is addressable

One route answers "what has been recorded against this cycle", returning the `test` events with
their tier, stack, counts and agent. It is what the UI already renders, exposed where a script and
an orchestrator can read it.

### §S3 The naming stops lying

`runs` holding streaming rows while ingested results live in `events` is a trap for exactly the
reader who is trying to do the right thing. Either the ingest surface speaks of `runs` consistently
or the tables say what they hold — decided when the CR is specified, not here.

## Acceptance criteria

- [ ] An ingest response carries the identifier of the row it recorded, and fetching that
      identifier returns that row.
- [ ] One documented route answers what a cycle has recorded — agent, tier, stack, counts per
      recorded run — and its answer matches what the board's own UI shows for that cycle.
- [ ] A reader who follows the obvious path from "an agent filed a run" to "show me that run" never
      lands on an empty answer for evidence that exists: the false-negative this CR was cut for
      cannot be reproduced.
- [ ] The tier a run is filed under is visible in that answer, so a suite recorded at the wrong tier
      is detectable without reading the database.

## Non-goals

- Changing what an ingest STORES. The evidence is already correct; only its addressability is not.
- A new dashboard view. The UI already renders this; the gap is the API and the naming.
