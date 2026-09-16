# CR-CRU-074 — Crucible has never been told a release happened

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 013
- **Status**: PENDING (0.2.0)

## Problem

Three releases shipped on 2026-08-19 — `0.1.0`, `0.1.1`, `0.1.2`, all live on
PyPI and npm. The store holds **no record of any of them**. Verified:

```
MILESTONE_TYPES (src/v2.ts:1044) = {gap-analysis, design-review, stage-flip, custom, cr-merged}
                                                                    ↑ no "release"
every milestone in the live store: {"type":"cr-merged", …}
```

Crucible is told when a **CR merges** and never when a **release ships**. The
only trace of those three releases is free text inside each no-mistakes gate's
`intent` ("Ship Crucible 0.1.2 — a patch release fixing…").

That absence is now blocking three separate things:

1. **CR-CRU-073** (retire a finished release's gate events) has nothing to fire
   on. Its AC2 says the gates are retired "in the same transaction that records
   the completion" — there is no such transaction, and no structured gate →
   release link to retire them *by*. This is why the 0.1.0 ×2 and 0.1.2 gates are
   still rendering as current, a day after shipping.
2. **CR-CRU-014** (execution roadmap) has an AC requiring *"wave/**release
   boundary** divider rows"* and *"release boundaries"* as graph nodes. Waves
   "number continuously across releases" (§Phase), so `wave` cannot answer
   "which release?" — and `queue_entries(project_key, cr, title, wave,
   depends_on_json, size, …)` has no release column.
3. **CR-CRU-022** (roadmap analytics) specifies `boundaries:[{wave, label, ts?}]`
   with "release-boundary rows annotated" and a `release:{p50Ts, p80Ts}`
   forecast band. A release forecast with no release record is underivable.

So this is not plumbing for one CR. It is the missing foundation under two
already-specified features, and it was caught only because the maintainer asked
whether anything downstream planned the full workflow.

## Scope

### §S1 A release is a recorded event
`release` joins `MILESTONE_TYPES` (`src/v2.ts:1044`). **No schema change is
needed** — `Store.recordMilestoneEvent(projectKey, agentId, type, meta?:
{label?, commit?, context?})` (`src/store.ts:1580`) already persists both fields
as conditional spreads, so `label` carries the version and `commit` the tagged
sha. This is a one-line set change plus its tests, not a migration. Additive:
every existing milestone type keeps its exact behaviour, and the route's
validation error still enumerates the accepted set.

### §S2 The ceremony reports it
`scripts/release.sh` `cmd_finish` (lines 297-338) reports the release through
the repo client — never a bare `curl`. **Position is load-bearing:** the tag
exists after `git flow finish` (line 335) but is only PUBLISHED by
`git push origin master develop --tags` (line 337). Reporting between them would
let a failed push leave a recorded release that no remote has. So the report
fires **after the push succeeds**.

Two further rules the position implies:
- a reporting failure must **not** fail the release — by then the tag is pushed,
  so the ceremony warns naming the version and exits 0 rather than aborting
  something already shipped;
- `--dry-run` returns before both git commands (line 328), so it must report
  **nothing**; a dry run that records a release is a lie about the world.

### §S3 Reading releases back
`GET /api/v2/projects/<key>/releases` returns recorded releases newest-first
(version, commit, timestamp), so CR-CRU-014's boundary rows and CR-CRU-022's
forecast band have a source. Archived projects are excluded through the same
subquery `listAgents`/`listEvents`/`listOpenRuns` already use.

### §S4 Backfilling the three that already shipped
`0.1.0`, `0.1.1` and `0.1.2` are recorded retroactively from the git tags
(`git tag` + `git rev-list -1 <tag>` are the authority — never the gate's free
text), so the board is not permanently missing its own release history.

## Acceptance criteria

**AC1 — `release` is an accepted milestone type.** Posting one records an event
carrying the version and commit; posting an unknown type still 400s and still
lists the accepted set including `release`. Every pre-existing milestone type is
asserted unchanged.

**AC2 — the ceremony reports after the PUSH, and never blocks on it.** A release
run records exactly one release event for the version, after
`git push … --tags` succeeds — not merely after the tag is created locally, so a
failed push cannot leave a recorded release the remote never saw. With Crucible
unreachable the ceremony still completes, warns naming the version, and exits 0,
asserted with the server down. `--dry-run` records nothing at all, asserted
separately.

**AC3 — idempotent.** Re-reporting the same version records no duplicate; the
second attempt converges. Re-running the ceremony (or a retry after a warned
failure) cannot produce two rows for one version.

**AC4 — releases are readable.** `GET …/releases` returns them newest-first with
version, commit and timestamp; an archived project's releases are excluded; a
project with none returns an empty array, never 404.

**AC5 — the three shipped releases are backfilled.** After migration the store
holds `0.1.0`, `0.1.1`, `0.1.2` with the commits their tags point at, verified
against `git rev-list -1 <tag>` and not against any gate's `intent` text.

**AC6 — no version is invented.** The version comes from the tag (bare SemVer,
per `scripts/release.sh`), and a malformed or absent tag is a reported failure,
not a guessed value.

## Scope — non-goals

- **Not the gate retirement itself.** CR-CRU-073 consumes this signal; the
  retirement rule, the audit-preserving marker, and the duplicate-run collapse
  all stay there.
- No UI. CR-CRU-014 draws the boundary rows and CR-CRU-022 the forecast band;
  this CR only makes their data exist.
- No change to `queue_entries` or to how waves are numbered — a release is not a
  wave, and waves continue to number across releases.
- No release *scheduling* or target dates (CR-CRU-022 §S4 owns `targetDate?`).

## Notes

- Split out of CR-CRU-073 on 2026-08-20 at the maintainer's direction: the
  signal is independently useful, and 073 stays scoped to the stale gates it was
  filed for.
- The CR-CRU-071 dependency was dropped by this CR's own gap analysis: milestones
  already carry `label` + `commit`, so nothing here needs a schema change, and
  §S4's backfill is simply one `release` milestone posted per existing tag.
