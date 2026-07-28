# CR-CRU-052 — Projects can be created but never deleted; seeded fixtures leave permanent dead state

**Status:** PENDING
**Type:** feature (missing lifecycle primitive) + patch (test hygiene)
**Priority:** P1 — six of the nine projects on the live dog-food board are residue, and there is no
supported way to remove any of them
**Depends on:** CR-CRU-012 (projects manager — owns add/edit/archive), CR-CRU-032 (run deletion +
`allow_run_deletion`, the precedent for a guarded destructive route)
**Labels:** feature, server, api, projects, lifecycle, test-hygiene, dashboard
**Phase:** Wave 4
**Design reference:** CR-CRU-012 §S1b introduced archive/unarchive as the projects-manager
lifecycle. Delete was never specified — archive was treated as sufficient. Found 2026-07-28 when
the user challenged unfamiliar projects on the dashboard.

## Context
**User principle, verbatim (2026-07-28): *"Tests should always setup and tear down PERIOD. THEY
SHOULDN'T LEAVE DEAD STATE."*** That rule cannot currently be obeyed for projects, because no
teardown primitive exists.

`POST /api/v2/projects` creates a project. The only `DELETE` route on the server is
`/api/v2/events/<id>` (`src/v2.ts:1507`). `Store` has no project-removal method. So **a project,
once created, is permanent** — archive (CR-CRU-012 §S1b) hides it from the board but the row, its
events, its agents and its plans all persist forever.

**Live evidence — six of nine projects on the dog-food server are residue:**

| project | sut_root | created | events | state |
|---|---|---|---|---|
| Crucible v2 | `…/data_projects/crucible` | 15 Jul | 200 | real |
| Model B | `…/side_projects/model-b` | 20 Jul | 100 | real |
| Sandesh | `…/data_projects/sandesh` | 20 Jul | 38 | real |
| `Probe Project` | `/tmp/e2e` | 21 Jul 09:59:14 | 8 | **residue, ACTIVE** |
| `Probe` | `/tmp/e2e` | 21 Jul 09:59:57 | 8 | **residue, ACTIVE** |
| `dbg` | `/tmp/e2e` | 22 Jul | 1 | **residue, ACTIVE** |
| `smoke` | `/tmp` | 15 Jul | 1 | residue, archived |
| `verify-smoke` | `…/crucible` | 15 Jul | 0 | residue, archived |
| `verify-ratio-project` | *(empty)* | 15 Jul | 50 | residue, archived |

Three are still ACTIVE and therefore visible on the user's board.

**The e2e suite is NOT the cause — verified, and this matters for the fix.** `playwright.config.ts`
isolates properly: it `mkdtempSync`s a scratch cwd and runs the server on port 39_877 so every run
gets a fresh empty database. It never touches `data/crucible.db`. The `/tmp/e2e` sutRoot on the
three residue projects is the harness's literal (`tests/e2e/steps/harness.ts:15`) **copied into
ad-hoc API calls made against the live server** — one project is named `dbg`, and `Probe Project`
and `Probe` were created 43 seconds apart. Fixing the e2e suite alone would therefore fix nothing.

**But the harness carries the latent trap that made copying it dangerous.** `seedProject`
(`harness.ts:12`) creates a project and registers no cleanup — there is no `deleteProject` helper
and no `afterAll`. It is safe today only because the whole DB is thrown away, i.e. by an ambient
property of the config rather than by anything the harness itself guarantees. Point it at a shared
server and it leaks silently, which is precisely what happened by hand.

## Scope

### §S1 — `DELETE /api/v2/projects/<key>` with cascade
Add the missing lifecycle primitive: remove the project row and everything keyed to it — `events`,
`agents`, `plans`, `plan_cycles`, `rollups`. One transaction, mirroring the existing single-
transaction retention fold+delete. Return the deleted counts so a caller can assert the cascade
rather than assume it.

Follow CR-CRU-032's precedent for a guarded destructive route rather than inventing a new guard
style: that CR gated run deletion behind the per-project `allow_run_deletion` flag. Decide and
record the equivalent gate here — candidates: require the project be archived first (making delete
a deliberate two-step), or require an explicit confirmation field on the request body. **Do not
ship an unguarded cascade delete**; the dog-food database is the highest-value artifact in the
project and a mis-keyed call would take a real project with 200 events.

### §S2 — The harness tears down what it creates
`seedProject` must register cleanup so every seeded project is deleted at the end of the run, via
§S1. Teardown must run even when a scenario fails — a leak on the failure path is the one that
matters, since that is when someone is most likely to be pointing at a non-standard server.

This holds even though the scratch DB currently makes it moot. Relying on an ambient config
property is what made the harness copy-and-paste-dangerous; the helper should be safe on its own
terms.

### §S3 — The harness refuses a non-ephemeral target
`seedProject` must assert its target is the ephemeral e2e server and fail loudly otherwise, so the
copied-into-a-live-call mistake is impossible rather than merely discouraged. The port
(`39_877`) and the scratch cwd are both available to key off.

### §S4 — Purge the existing residue
The six residue projects and their events/agents/plans are removed via §S1 once it exists.
**This is destructive and operates on the live dog-food database — it requires its own explicit
user go, separately from approving this CR.** Record the exact keys and the row counts deleted.
The three real projects (Crucible v2, Model B, Sandesh) are not touched.

### §S5 — Correct the stale isolation comment
`playwright.config.ts`'s header states *"no CRUCIBLE_DB env var exists to do this more directly
(verified by reading src/server.ts: only CRUCIBLE_PORT is read from env)"*. CR-CRU-043 added
`CRUCIBLE_DB`, so that comment is now false. The cwd-based isolation still works and need not
change, but the comment must not send the next reader looking for a knob that now exists — or
worse, leave them believing isolation is impossible.

## Acceptance criteria
- [ ] `DELETE /api/v2/projects/<key>` removes the project and cascades to its events, agents,
      plans, plan_cycles and rollups — asserted by counting each table before and after.
- [ ] The cascade is one transaction: a mid-delete failure leaves NOTHING partially removed —
      asserted.
- [ ] The §S1 guard rejects an unguarded/unconfirmed delete — asserted, including that the project
      still exists afterwards.
- [ ] Deleting a nonexistent key is a definitive error, not a silent success — asserted.
- [ ] An e2e run seeds and then deletes its projects: the target DB holds zero seeded projects
      after the suite — asserted.
- [ ] Teardown also runs when a scenario FAILS — asserted with a deliberately failing scenario.
- [ ] `seedProject` against a non-ephemeral target fails loudly — asserted (§S3).
- [ ] `playwright.config.ts`'s comment no longer claims `CRUCIBLE_DB` does not exist (§S5).
- [ ] Full bun regression green AND full Python regression green.
- [ ] §S4 purge: performed only after separate explicit user approval; keys and deleted row counts
      recorded. The three real projects untouched — verified by name and key.

## Non-goals
- Changing archive/unarchive semantics (CR-CRU-012 §S1b). Archive stays the reversible "hide it"
  operation; delete is the irreversible one. Both exist.
- A dashboard delete control. This CR adds the API primitive and the test teardown that needs it;
  whether the projects manager exposes a delete button is a separate design decision.
- Retention/rollup policy (CR-CRU-032).
- The phantom AGENT residue — that is CR-CRU-044 §S5 (fabricated identity) plus orchestrator
  dispatch discipline, a different mechanism from project creation.

## Risk
- **§S1 is the most destructive route in the system** and it operates on a database holding the
  project's entire real history. The guard is not optional, and the AC requiring a rejected
  unguarded delete exists to prove it. A cascade keyed off a typo'd project key would be
  unrecoverable.
- Deleting a project deletes its plans, which are the CR-close-out record (`plans.cr` is
  CR-CRU-014's declared verbatim stable join key with a BINDING forward-compat contract on 0.1.0).
  Confirm no real close-out history can be reached by the §S4 purge before running it.
- §S3 could break a legitimate future harness that deliberately targets a non-default server.
  Prefer asserting "ephemeral" positively (scratch cwd / known e2e port) over blacklisting `:3849`.
