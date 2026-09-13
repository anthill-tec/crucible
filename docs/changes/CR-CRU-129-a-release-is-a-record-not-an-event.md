# CR-CRU-129 — a milestone is a record, not an event

**Status:** PENDING
**Type:** fix
**Priority:** P1
**Depends on:** CR-CRU-074, CR-CRU-080, CR-CRU-081, CR-CRU-086, CR-CRU-091
**Labels:** fix, server, store, data-integrity
**Phase:** Wave 6 (0.2.0)
**Design reference:** CR-CRU-074 §S3 made releases first-class on the WIRE; this makes the whole
milestone kind first-class in the STORE.

## Context

**Crucible lost its release history on 2026-09-13, during ordinary use.** Not to a migration, a crash
or an operator error — to its own retention policy, working as designed.

There is no `releases` table and no `milestones` table. The schema is `agents, events, plan_cycles,
plans, projects, queue_entries, rollups, runs`. A release is a ROW IN `events` with `kind='milestone'`
and `payload.type='release'`, and `GET …/releases` is a query over that table (`src/store.ts:2747`).
So the record of what a release shipped lives in the same buffer as test-run telemetry.

`events` is capped. `enforceRetention` (`src/store.ts:3063`) trims each project to its `retention`
value, oldest first. This project's cap was **2000**. One day of ordinary TDD work — the RED, GREEN,
VERIFY and FIX ingests of a single CR — appended 165 events. The oldest 165 were evicted. Nine were
milestones. Four were the `release` records for **0.1.0, 0.1.1, 0.1.2 and 0.1.3** — every release this
project has ever shipped. Four more were the `cr-merged` records for **CR-CRU-077, 078, 091 and 092**,
and one was a `release-proposal`.

The consequences were caught by the pre-merge gate, not by any alarm: `GET …/releases` answered
`{"releases":[]}`; 52 landed queue rows became release-less, because a row's membership is derived
from the release record's `crs` set; and two live-board invariants failed
(`tests/queue-release-membership-mandatory.test.ts` §S1,
`tests/queue-historical-membership.test.ts` §S3a).

**The recovery proved the design's own escape hatch is lossy.** `release.sh backfill-releases`
re-recorded 4/4 releases from the git tags, and `0.1.0` came back with **51 CRs against the 60 the
evicted record held** — because the `cr-merged` milestones the derivation reads had been evicted in
the same sweep. A tag knows a label and a sha; it does not know which CRs a release shipped. The 60
were recovered only because a pre-upgrade `.db` snapshot happened to still be on disk.

**The category is the defect.** A test run is an event: numerous, disposable, and exactly what a
capped buffer is for — 1,957 of this project's 2,013 rows are `test`, `lifecycle` or `compile`. A
milestone is not. It is a record of something that happened once and stays true: a release, a merge,
a proposal, a stage flip. Storing records in the telemetry buffer means the project's history is
evicted by its own activity, and the more work it does the faster it forgets.

Retention already carries two exemptions — a live gate (`src/store.ts:3072`) and a live
release-proposal (`:3079`) — with a comment arguing a pruned release is *"rebuildable from its git
tag"*. Extending that predicate to cover releases was considered and REJECTED: it encodes "a
milestone is an event we choose not to evict", leaves every read recency-ordered over a table
dominated by test rows, and today measurably disproved the rebuildability it rests on.

## Scope

### §S1 Milestones become records

The whole `milestone` kind leaves `events` for its own table. `MILESTONE_TYPES`
(`src/v2.ts:1165-1172`) holds six: `gap-analysis`, `design-review`, `stage-flip`, `custom`,
`cr-merged`, `release`. A SEVENTH record kind sits beside them — `release-proposal`, which is not a
`POST …/milestones` type at all: it is written through `POST …/release-proposals` by
`recordReleaseProposal` (`src/store.ts:2322`) and carries `targetAt`. It is a milestone row in
`events` all the same, and CR-CRU-091 already exempted the live ones from the cap, so it moves with
them.

Not two types, and not "the important ones": the distinction that matters is record versus
telemetry, and all seven are on the record side of it. Implementations read the vocabulary from the
server rather than from this list — the spec states it to be checkable, not to be copied. Each row keeps what it
carries today — type, label, commit, `releasedAt`, `crs`, `packages`, `context`, `retired_at` — and
gains a lifetime that no ingest volume can end.

`gate` is lifted on the same terms. It is already half-exempt (`LIVE_GATE`, `:3072`) precisely
because it is a record; the exemption is the existing code conceding the point one kind at a time.

`events` keeps `test`, `compile` and `lifecycle` — the numerous kinds the cap exists for.

The migration reads existing milestone and gate rows out of `events` into the new tables, reports a
per-record result and a tally, and is idempotent. Events already evicted are gone: the migration
recovers what is present and NAMES what it cannot, rather than silently starting from the survivors.

### §S2 Retention has nothing structural left to reach

After §S1 the cap governs `test`, `compile` and `lifecycle` only, and the two exemption predicates
become unreachable — `LIVE_PROPOSAL` can never match, because no milestone remains in the table it
queries. They are removed rather than left as dead SQL that implies a protection the schema now
provides.

The guard that replaces them is a test: retention may only ever reach kinds on a named disposable
list, and adding a structural kind to that list fails.

**And the cap itself stops being a constant in source.** `DEFAULT_RETENTION = 100`
(`src/store.ts:688`) is a magic number compiled into the store, standing in whenever a project
declares no cap. A limit is CONFIGURATION: the per-project value already is (`projects.retention`,
`ProjectPatch.retention`), and the fallback must resolve from the same place rather than from a
literal a reader has to go find. The tests that prove S2 therefore assert the BEHAVIOUR at whatever
cap the fixture configured and pin no number, because a test that hardcodes the limit it checks
freezes the same defect from the other side.

### §S3 Every read moves with the data

The consumers, enumerated so none is discovered by its absence:

| consumer | site |
|---|---|
| `listReleases` | `src/store.ts:2747` |
| `listReleaseProposals` | `src/store.ts:2787` |
| queue status derivation (release `crs` → `COMPLETED_UNTRACKED`) | `src/store.ts:4046-4076`, `:4463`, `:4476` |
| `repairReleaseProvenance` | `src/store.ts` (CR-CRU-081 §S3 operator) |
| `GET …/releases`, `GET …/release-proposals`, the roadmap strip | `src/v2.ts` |
| gate reads and the gate pane | `src/v2.ts`, `public/` |
| `cr_merged_crs` + `cmd_queue` | `clients/_crucible_axi.py:1692`, `:1702` |
| `deriveCommitBoundary` — a gate's `context` contributes to a plan's boundary | `src/store.ts` |
| `getEvent` / `GET …/events/<id>` — the audit read for a moved record | `src/store.ts`, `src/v2.ts:3751` |

Wire shapes do not change. One CLIENT read does, and must: `cr_merged_crs` does not query
`cr-merged` — it SCANS the newest `QUEUE_EVENTS_LIMIT = 5000` events
(`clients/_crucible_axi.py:1674`) because `GET /api/v2/events` accepts only a `limit`
(`src/v2.ts:3748`), and filters client-side. Its comment claims 5,000 is *"far above any real
project's milestone count"*, but the window counts ALL events: at 2,013 rows it works by luck, and
1,957 of those rows are telemetry.

The constant is **DELETED, not resized.** Raising it is the same defect with a bigger number, and a
bounded window over unbounded content cannot be fixed by choosing a larger bound. Once milestones
are records the read is a query by type, so there is no window to size and no new limit to declare.

One question §S3 must ANSWER rather than inherit: what `GET /api/v2/events` serves once milestone
and gate rows leave `events`. The board's pane feed is `listEvents`, which today returns milestones
and gates and excludes retired gates, so "wire shapes do not change" is a requirement on that feed,
not an observation about it. `getEvent(id)` / `GET /api/v2/events/<id>` MUST keep answering for a
moved record either way — the store's own contract already promises it (`listReleaseProposals`:
a consumed proposal "stays auditable through `getEvent`").

### §S4 The replay may not quietly shrink what it replaces

`backfill-releases` keeps working, but a rebuild that derives a SMALLER `crs` than the stored record
is refused and the difference reported. CR-CRU-086 established exactly this rule for the repair path
after that path erased 58 CRs; today the REPLAY path did the same thing (60 → 51) because the rule
was never extended to it.

The ceremony's `unplaceable` tally gains the distinction that matters: a CR that never landed
anywhere, versus a CR whose landing evidence was EVICTED. Only the second is data loss, and today's
run reported 15 unplaceable without saying which kind they were.

## Acceptance criteria

**§S1**
- [ ] Every milestone type and `gate` survives a retention sweep that evicts every disposable event:
      a project at its cap, ingesting enough runs to roll the whole buffer, still answers
      `GET …/releases`, `GET …/release-proposals` and its gate reads with every record and every
      `crs` byte-identical.
- [ ] The migration moves existing milestone and gate rows out of `events`; it reports a per-record
      result plus a tally, and a re-run writes nothing and duplicates nothing.
- [ ] The migration NAMES what it could not recover rather than reporting success over survivors.
- [ ] `GET …/releases`, `GET …/release-proposals`, the queue's derived statuses and the roadmap
      answer byte-identically before and after, proved against a fixture holding all four of this
      project's releases and all 45 of its `cr-merged` records.

**§S2**
- [ ] Retention reaches only `test`, `compile` and `lifecycle`; a test enumerates that disposable set
      and FAILS if a structural kind is added to it.
- [ ] Telemetry still prunes: a project past its cap sheds test events exactly as today, so this CR
      does not silently disable retention.
- [ ] `LIVE_GATE` and `LIVE_PROPOSAL` are removed, and no read depends on them.
- [ ] No retention limit is a literal in source: `DEFAULT_RETENTION` is gone and the fallback
      resolves from configuration. Asserted by CONSTRUCTION - a test scans the retention path for a
      numeric literal standing in for a cap and fails on one, so the next author cannot quietly
      reintroduce it.
- [ ] The S2 tests pin no cap VALUE: they configure a cap through the project surface and derive
      every expected count from what they read back, so the suite still passes when a project's
      configured cap changes.

**§S3**
- [ ] Each consumer in the §S3 table reads the new tables — asserted per site, not as one aggregate
      "the reads were updated".
- [ ] `cr_merged_crs` QUERIES milestones by type instead of scanning newest-N events;
      `QUEUE_EVENTS_LIMIT` is DELETED, not raised, and no replacement scan depth is introduced.
- [ ] Mutation: a project holding more disposable events than the old 5,000 window still returns
      every `cr-merged` id — the case that silently failed before.
- [ ] No other client surface changes: the five clients' `milestone` help and wire shapes are
      unchanged, asserted by the existing fleet surface tests.

**§S4**
- [ ] A replay that would write FEWER crs than the stored record is refused, names the release and
      the missing ids, and writes nothing.
- [ ] The unplaceable tally distinguishes "never landed" from "landing evidence evicted".
- [ ] Re-running the ceremony against a complete store writes nothing and reports no shrink.

**Superseded tests**
- [ ] Tests asserting behaviour this CR ABOLISHES are DELETED, not re-pinned to the new text: the
      gate's post-retirement prunability (`tests/gate-retirement.test.ts` AC3) and the
      live-versus-consumed proposal distinction (`tests/roadmap-registration-routes.test.ts` AC22).
      Each deletion names the superseded AC so the hole is explained rather than found.
- [ ] Tests whose CLAIM survives keep it and change only their technique — a record never folds into
      a rollup (`tests/gate-milestone-server.test.ts:420`, `:575`) stays asserted, and its re-seeded
      form still proves the fold ran for a telemetry row.
- [ ] Conservation across the migration is asserted TOTAL, over a table list including `milestones`
      and `gates` (`tests/run-lifecycle.test.ts:670`, `tests/store-migration.test.ts` AC2).
- [ ] No test pins a cap literal after this CR, including the one that rode
      `DEFAULT_RETENTION = 100` (`tests/events.test.ts:275`).

**Close-out**
- [ ] Retention returns from its 200,000 stopgap to a considered cap for the disposable kinds, and
      the value is stated in the close-out rather than left at whatever stopped the bleeding.
- [ ] One re-baseline of both stacks after the migration runs against the live board — the migration,
      the restored `0.1.0` provenance and the four re-posted `cr-merged` records are all live facts
      the two board-invariant suites census.

## Estimated size

M — two tables, a migration, the enumerated read moves, one client read, and the replay guard. The
migration is the careful part: it moves live production data, and this project's own store is the
fixture that proves it.

## Risk

- **The migration moves the only copy of data already proven fragile.** Copy-then-verify with the
  pre-migration snapshot retained in the shape this repo already uses
  (`data/crucible.db.pre-upgrade-<ts>`) — the only reason today's 60 CRs were recoverable.
- **Evicted history cannot be recovered by this CR.** What is gone from `events` stays gone; four
  `cr-merged` records were re-posted by hand from a backup, and that option existed only by luck.
- **A structural table never prunes.** Correct for this data — 4 releases and 45 merges in four
  months — but the growth must be stated rather than assumed.
- **Lifting `gate` beside the milestones widens the blast radius** past the incident that prompted
  the CR. It is included because `LIVE_GATE` already concedes a gate is a record; if the migration
  proves riskier than the parity is worth, the gate half is the seam to defer.

## Non-goals

- Changing any wire shape, any `milestone` CLI surface, or any client other than the `cr_merged_crs`
  read §S3 names.
- Retiring retention. Telemetry SHOULD be capped; this CR narrows what the cap may reach.
- Re-deriving membership for CRs whose `cr-merged` evidence is already evicted.
- Reworking `plans`, `plan_cycles` or `queue_entries` — those are already records in their own tables,
  which is the shape this CR gives the milestones.
- The other hardcoded limits the audit found outside this CR's paths: `TOON_MAX_BYTES = 64 * 1024`
  (`src/v2.ts:155`), `TRUNCATE_LIMIT = 200` (`clients/_crucible_axi.py:500`) and
  `ROADMAP_LIST_LIMIT = 20` (`clients/_crucible_axi.py:3484`). Same defect class — a limit compiled
  into source instead of configured — but they govern envelope sizing and list display, not
  retention, and folding three more surfaces into a data migration is how a migration goes wrong.
  Recorded as a candidate CR rather than absorbed here.
