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
`/api/v2/events/<id>` (`src/v2.ts:1887` — re-derived at gap analysis; the original `:1507` had
drifted). `Store` has no project-removal method (confirmed by unfiltered grep, zero hits). So **a project,
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

**🚨 CORRECTED 2026-08-03 — this paragraph was WRONG, and the error mattered.** It previously read
*"The e2e suite is NOT the cause — verified … `playwright.config.ts` isolates properly … so every
run gets a fresh empty database."* Only half of that is true. The config isolates by pointing the
server's cwd at a `mkdtempSync` scratch dir, and it genuinely never touches `data/crucible.db`.
But **CR-CRU-043 changed `resolveDbPath` underneath it** (`src/server.ts:47-66`): with no
`CRUCIBLE_DB` set and no `<cwd>/data/crucible.db` present — which is precisely what a scratch cwd
guarantees — resolution falls through to rule 4, `~/.local/share/crucible/crucible.db`.

**So every default e2e run since CR-043 has been writing to a persistent USER-LEVEL database.**
Measured 2026-08-03: `~/.local/share/crucible/crucible.db` holds **79 projects and 259 events**,
every one with sutRoot `/tmp/e2e` — `F2 Project`, `F9 Project`, `Layout Project`, `Esc Project`
and so on, the feature fixtures accumulated across every run. Its WAL had been written minutes
before the measurement.

Two consequences. First, the e2e suite **is** a residue generator, contrary to the original claim —
the same defect class this CR exists to close, hiding one directory over. Second, this explains the
"3 pre-existing e2e failures" carried as a release-gate item: on the default DB the suite fails far
more widely (`F1 fresh forge — empty state` cannot pass against 79 accumulated projects), and the
failures are residue artefacts rather than product defects.

The original observation still stands for the LIVE board: the six residue projects on
`data/crucible.db` came from the harness's `/tmp/e2e` literal (`tests/e2e/steps/harness.ts:15`)
**copied into ad-hoc API calls against the live server** — one was named `dbg`, and `Probe Project`
/ `Probe` were created 43 seconds apart. Fixing the e2e suite alone would not have fixed THOSE.
But it was never true that the suite left nothing behind.

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

**GUARD DECIDED at gap analysis (2026-08-03) — it is a DOUBLE gate, not a choice of one.**
The spec previously offered "archived-first OR a confirmation field" as alternatives. Reading the
precedent settled it: `handleEventDelete` (`src/v2.ts:1756-1766`, CR-CRU-032) already gates the
*less* destructive single-event route with TWO checks — per-project `allowRunDeletion !== true`
→ **403**, then `body.userApproved !== true` → **409**. Shipping one gate on the most destructive
route in the system while a lesser one carries two would be indefensible.

The gate for project deletion is therefore:
1. **The project MUST be archived** (`archived_at IS NOT NULL`) → else **403**. This reuses
   CR-CRU-012 §S1b's existing state rather than adding a flag, and makes deletion a deliberate
   two-step: hide it, live without it, then remove it.
2. **`userApproved: true` on the request body** → else **409**, mirroring CR-032's field name
   exactly so the fleet learns one confirmation idiom, not two.

Both rejections must leave the project and every cascaded row untouched. **Do not ship an
unguarded cascade delete**; the dog-food database is the highest-value artifact in the project and
a mis-keyed call would take a real project with 200 events.

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

### §S4 — Purge the existing residue — ✅ DONE 2026-07-28 (user-approved, ahead of §S1)
**Executed before §S1 existed**, by direct SQL in one transaction, on explicit user approval
(*"Approved, purge all the residue projects and phantom agents"*). Recorded here because the AC
requires the keys and row counts be captured.

Backup taken first: `crucible-pre-purge.db` (9 projects / 406 events, 5.5 MB) via `sqlite3
.backup`, so the operation is reversible.

**Guard used, in-transaction:** the delete set was `residue MINUS any project holding a plan` —
plans are the CR close-out record (`plans.cr` is CR-CRU-014's binding join key), so a target
carrying one would have been silently spared and revealed by the post-check rather than destroyed.
Pre-flight confirmed all six held **0 plans, 0 cycles, 0 rollups, 0 agents** — only events.

| project | key | events deleted |
|---|---|---|
| `smoke` | `019f6223-b8c2-7000-893f-15d8db15417a` | 1 |
| `verify-smoke` | `d11a16bb-4d0a-4a1a-a4f4-ade225e63b86` | 0 |
| `verify-ratio-project` | `019f62c2-dc6f-7000-ac01-3ff0ed794b5a` | 50 |
| `Probe Project` | `e8a8999c-b1c7-4703-85e4-fe0aa9d99526` | 8 |
| `Probe` | `56b99e40-823f-4eb3-8212-65d6eb37039f` | 8 |
| `dbg` | `e9fd8df6-5488-4f4e-8d7d-204e124be9dd` | 1 |

Plus the two phantom AGENTS on the real Crucible v2 project: `bun-crucible` (CR-CRU-044 §S5
fabricated identity, `identity {}`) and `probe-tmp` (a sub-agent's stray registration,
`displayName "probe"`).

**Totals: 6 projects, 68 events, 2 agents. 0 plans, 0 cycles, 0 rollups.**

Verified after: 3 projects remain with counts unchanged (Crucible v2 200 events/35 plans, Model B
100/15, Sandesh 38/1); **zero orphan rows** across `events`/`agents`/`plans`/`plan_cycles`/
`rollups`; live server `/api/health` reports `{projects:3, agents:1, events:338}` (the one agent
being the then-running VERIFY agent).

**§S1 is still required.** This purge was a one-off manual repair, not a capability — the product
still has no supported way to delete a project, so the next accidental project is equally
permanent, and §S2's harness teardown still has nothing to call.

### §S6 — Record the new primitive in the DN (added at gap analysis)
`docs/research/DN-crucible-api-reconstruction.md:206-214` states v2's posture as *"an immutable
audit log with per-project, double-gated single-event deletion (`DELETE /api/v2/events/<id>`)"*.
A cascading project delete is a materially larger hole in that posture, and the DN — which is
ACTIVE and normative — does not contemplate it. Record the primitive there: what it removes, that
it is double-gated (archived + `userApproved`), and that archive remains the reversible operation.

This exists because CR-CRU-053 just spent an entire CR removing a false claim from that same DN.
Shipping a new destructive capability without updating the design authority would recreate the
defect one document over, in the same week.

### §S5 — Make the isolation REAL, then correct the comment
**Expanded 2026-08-03 after the measurement above.** The original §S5 asked only to fix a false
comment. The comment turns out to be false in a way that points straight at the bug: it claims
*"no `CRUCIBLE_DB` env var exists to do this more directly"*, and the reason isolation is broken is
that nothing sets `CRUCIBLE_DB`. CR-CRU-043 added exactly the knob the comment says is missing.

So: set `CRUCIBLE_DB` explicitly in `playwright.config.ts`'s `webServer.env` to a per-run scratch
path (or `:memory:`), so the e2e server can no longer resolve to the user-level database no matter
what the cwd contains. Then correct the comment to describe what it now does. Asserting isolation
positively is the same discipline §S3 applies to the harness: do not rely on an ambient property
(cwd) when an explicit one (`CRUCIBLE_DB`) is available.

### §S5c — RATIFIED scope addition: the SECOND leak site
GREEN found that fixing `playwright.config.ts` alone leaves §S5's AC measurably false.
`tests/e2e/steps/backend-liveness.steps.ts`'s `spawnServer` (feature F10) starts its OWN server
with `cwd: scratchCwd` and no `CRUCIBLE_DB` — the identical defect, firing twice per run (boot +
restart). A `/proc/<pid>/environ` watcher named it directly: `CRUCIBLE_DB=` empty, cwd scratch.

**Ratified by the orchestrator 2026-08-03.** A CR that claims to close this leak while leaving it
open in a second spawner would be the exact defect class the CR exists to close. The change is an
env addition plus comments; no assertion moved. It also makes F10's kill/restart pair share one
store BY CONSTRUCTION — previously that held only by accident, because the shared user-level DB
happened to persist across both.

### §S5b — Correct the stale isolation comment
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
      (Verified at gap analysis: `CRUCIBLE_DB` IS read — `src/server.ts:52`, CR-CRU-043.)
- [ ] Deleting a NON-ARCHIVED project is refused with 403 and the project survives — asserted.
- [ ] Deleting an archived project WITHOUT `userApproved: true` is refused with 409 and the project
      survives — asserted.
- [ ] The DN records the new primitive and its double gate (§S6) — asserted by reading it.
- [ ] `playwright.config.ts` sets `CRUCIBLE_DB` explicitly, so a default e2e run CANNOT resolve to
      `~/.local/share/crucible/crucible.db` — asserted (§S5).
- [ ] `backend-liveness.steps.ts`'s own spawned server likewise sets `CRUCIBLE_DB` (§S5c) —
      otherwise the AC above is false in practice.
- [ ] Leak closure proven BEHAVIOURALLY: the user-level DB's mtime/size are unchanged across a full
      e2e run (`stat` only — the file is never opened), while the e2e server is confirmed running
      on the scratch path.
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
