# CR-CRU-129 — a release is a record, not an event

**Status:** PENDING
**Type:** fix
**Priority:** P1
**Depends on:** CR-CRU-074, CR-CRU-080, CR-CRU-081, CR-CRU-086, CR-CRU-091
**Labels:** fix, server, store, data-integrity
**Phase:** Wave 7 (0.3.0)
**Design reference:** CR-CRU-074 §S3 made releases first-class on the WIRE; this makes them first-class
in the STORE.

## Context

**Crucible lost its release history on 2026-09-13, during ordinary use.** Not to a migration, a crash
or an operator error — to its own retention policy, working as designed.

There is no `releases` table. There is no `milestones` table. The schema is `agents, events,
plan_cycles, plans, projects, queue_entries, rollups, runs`. A release is a ROW IN `events` with
`kind='milestone'` and `payload.type='release'`, and `GET …/releases` is a query over that table
(`src/store.ts:2730`). So the record of what a release shipped lives in the same buffer as test-run
telemetry.

`events` is capped. `enforceRetention` (`src/store.ts:3063`) trims each project to its `retention`
value, oldest first. This project's cap was **2000**. One day of ordinary TDD work — the RED, GREEN,
VERIFY and FIX ingests of a single CR — appended 165 events. The oldest 165 were evicted. Nine were
milestones. Four were the `release` records for **0.1.0, 0.1.1, 0.1.2 and 0.1.3** — every release
this project has ever shipped.

The consequences were immediate and were caught by the pre-merge gate, not by any alarm:

- `GET …/releases` answered `{"releases":[]}`.
- 52 landed queue rows became release-less, because a row's membership is derived from the release
  record's `crs` set.
- `tests/queue-release-membership-mandatory.test.ts` §S1 and
  `tests/queue-historical-membership.test.ts` §S3a both failed against the live board.

**The exemption list shows this was a decision, not an oversight.** Retention already exempts two
kinds:

```
src/store.ts:3065   a LIVE gate AWAITING its release … is EXEMPT from the count cap
src/store.ts:3073   a LIVE `release-proposal` is exempt on the same terms, and for a
                    stronger reason than the gate's. A pruned `release` is
                    rebuildable from its git tag (`repair-provenance`); a pruned
                    proposal is AUTHORED INTENT with no external source
```

A gate is exempt. A proposal is exempt. The release — the thing both of them exist to serve — is
not, on the argument that a git tag can rebuild it.

**That argument is measurably false, and the recovery proved it.** `release.sh backfill-releases`
re-recorded 4/4 releases from the tags, and the rebuild was LOSSY: `0.1.0` came back with **51 CRs
against the 60 the evicted record held**. A tag knows a label and a sha. It does not know which CRs
a release shipped — that is derived from `cr-merged` milestones, and five of THOSE were evicted in
the same sweep. The 60 were recovered only because a pre-upgrade `.db` snapshot happened to still
exist on disk. Without it, nine CRs' membership would be gone permanently.

## Scope

### §S1 Releases and merges are rows, not payloads in a ring buffer

A release becomes a first-class row with its own table and its own lifetime, holding what it already
carries on the wire: label, commit, `releasedAt`, `crs`, `packages`. The same applies to the
`cr-merged` milestone, for the same reason — it is the evidence a release's `crs` is DERIVED from, so
storing the derivation durably while leaving its inputs prunable moves the failure rather than fixing
it.

The migration reads existing `release` and `cr-merged` milestone events out of `events` and writes
them into the new tables. Events already evicted are gone; the migration recovers what is still
present and REPORTS what it could not place, rather than silently starting from whatever survives.

`GET …/releases`, the queue's membership derivation, `repairReleaseProvenance` and the roadmap read
the new table. Their wire shapes do not change — this is a storage fix, and no client is touched.

### §S2 The retention policy states what it may never evict

Retention keeps trimming telemetry: `test` and `compile` events are what the cap exists for. It may
not evict a STRUCTURAL fact. After §S1 the release and merge rows are outside `events` and so outside
the cap by construction; §S2 is the guard that keeps it that way — a test that fails if a
structural kind is ever added back into the prunable set, and the policy stated in one place rather
than as three exemptions discovered by reading `enforceRetention` top to bottom.

### §S3 The recovery path stops being lossy, and says so when it is

`backfill-releases` keeps working, but it may no longer quietly return fewer CRs than the record it
replaces. When a rebuild derives a SMALLER `crs` than the stored record, the write is refused and the
difference reported — CR-CRU-086 established exactly this rule for the repair path after that path
erased 58 CRs, and the replay path needs it for the same reason.

The `unplaceable` tally already printed by the ceremony gains the distinction that matters: a CR that
never landed anywhere, versus a CR whose landing evidence has been EVICTED. Those are different
facts and only the second is a data-loss report.

## Acceptance criteria

**§S1**
- [ ] `release` and `cr-merged` records survive a retention sweep that evicts every prunable event:
      a project at its cap, ingesting enough runs to roll the entire buffer, still answers
      `GET …/releases` with every release and every `crs` byte-identical.
- [ ] The migration moves existing release and cr-merged milestones out of `events` into the new
      tables, and reports a per-record result plus a tally; a re-run is idempotent and duplicates
      nothing.
- [ ] `GET …/releases`, the queue's membership derivation and the roadmap answer byte-identically
      before and after the migration, proved against a fixture holding all four of this project's
      releases.
- [ ] No client changes: the five clients' `milestone` surfaces and the wire shapes are untouched,
      asserted by the existing fleet surface tests.

**§S2**
- [ ] A structural kind can never be evicted: a test enumerates the kinds retention may trim and
      fails if a structural one is added to that set.
- [ ] Telemetry still prunes — a project past its cap sheds `test`/`compile` events exactly as
      today, so this CR does not silently disable retention.

**§S3**
- [ ] A `backfill-releases` replay that would write FEWER crs than the stored record is refused, the
      shrink is named (which release, which ids), and nothing is written — the CR-CRU-086 rule
      extended to the replay path.
- [ ] The unplaceable tally distinguishes "never landed" from "landing evidence evicted", and the
      second is reported as data loss.
- [ ] Re-running the ceremony against a complete store writes nothing and reports no shrink.

## Estimated size

M — a table, a migration, a read-path switch and a guard. The migration is the careful part: it
moves live production data, and this project's own store is the fixture that proves it.

## Risk

- **The migration moves the only copy of data already proven fragile.** It must be a copy-then-verify
  with the pre-migration snapshot retained, in the shape this repo already uses
  (`data/crucible.db.pre-upgrade-<ts>`) — which is the only reason the 60 CRs were recoverable at
  all this time.
- **Evicted history cannot be recovered by this CR.** Whatever is already gone from `events` stays
  gone; the migration recovers what remains and reports the rest. Raising a cap does not restore
  what a cap already dropped.
- **A cap that never trims structural rows grows without bound.** That is correct for this data —
  four releases in four months — but the growth must be stated rather than assumed.

## Non-goals

- Changing any client, any wire shape, or any `milestone` CLI surface.
- Retiring retention. Telemetry SHOULD be capped; this CR narrows what the cap may reach.
- Re-deriving membership for CRs whose `cr-merged` evidence is already evicted.
- The other milestone types (`stage-flip`, `gap-analysis`, `design-review`, `custom`). They are
  narration and prune correctly; only the two that carry derivable structure are lifted.
