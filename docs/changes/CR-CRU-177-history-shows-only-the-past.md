# CR-CRU-177 — History shows only the past

**Type** fix (patch CR, after CR-CRU-173) · **Points** 3 (provisional, 2026-10-09; set at gap analysis) ·
**Wave** 7 (0.3.0) · **Depends on** CR-CRU-173 · **Status** PENDING — filed 2026-10-09 (user ruling)

## Problem

**Reported 2026-10-09 (user, once History was populated on the dev board).** CR-CRU-173 lists every
release that holds work, future ones included: 0.4.0 appears as `planned` with its queued wave 8, and
a release in progress lists its CRs that have not started (`no plan filed`). That pollutes the
history read (`GET /api/v2/projects/<key>/history`) and the pane: **History shows what is past.**
This revises the 2026-10-09 ruling written into CR-CRU-173 ("future releases are listed as
planned"); filed as a patch CR per the workflow rule (`new-scope-mid-cr-is-a-patch-cr`), so CR-CRU-173
merges as built and verified.

## Design (approved — implement to it)

Storyboard **F22** (History pane), amended by this CR at gap analysis: the `release 0.4.0 · planned`
row added 2026-10-09 is removed; the open release's wave line reads as F22 originally drew it
(`wave 7 · 30 merged · 1 pending`). The frame wins; agents raise disagreements.

## Steps

### §S1 — a release is history once one of its CRs is completed

`/history` lists a release only when at least one of its CRs is completed (merged: a closed plan with
a merge commit, or named by a shipped release record). A release with none — today 0.4.0 — is not
listed, and the `planned` state is withdrawn. The other rules of CR-CRU-173 stand (one row per
release; work falls into the release that succeeds it on the timeline; withdrawn planless CRs belong
to no release; gate runs and verification as built).

### §S2 — a listed release shows only its completed work

Within a listed release, a wave lists only its completed CRs (and their cycles); a wave with none is
not listed. Each wave line carries the count of that release's CRs in the wave that are not yet
completed, as F22 draws it (`· 1 pending`), with no rows for them. The running CR stays in Now; pending
work stays on the Roadmap. `crCount` on the release row counts completed CRs; the pending count rides
beside it.

## Acceptance criteria

- [ ] `/history` omits a release with no completed CR (a release holding only queued or in-flight
      CRs) and never answers `planned`; a release with one completed CR is listed — asserted on the
      server with fixed fixtures.
- [ ] A listed release's waves carry only completed CRs plus a pending count; a wave whose CRs are
      all pending is not listed; the page draws `wave <n> · <m> merged · <p> pending` and no rows for
      pending CRs — asserted on the server and on the page.
- [ ] On a copy of the dev store: 0.4.0 is absent; 0.3.0 is listed with its merged CRs only and a
      pending count; 0.2.2, 0.2.0, 0.2.1 and 0.1.x unchanged from CR-CRU-173 — asserted by VERIFY.
