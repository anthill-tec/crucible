# CR-CRU-177 — History shows only the past

**Type** fix (patch CR, after CR-CRU-173) · **Points** 3 (confirmed at gap analysis 2026-10-09) ·
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

Storyboard **F22** (History pane), amended 2026-10-09 at filing (user request): the `release 0.4.0 ·
planned` row is removed; History's caption reads "only what is past: a release appears once one of
its CRs is completed"; the open release's row reads `30 CRs completed · 1 pending` and its wave line
`wave 7 · 30 merged · 1 pending`, with rows for completed CRs only. The frame wins; agents raise
disagreements.

## Steps

### §S1 — a release is history once it shipped or one of its CRs is completed

`/history` lists a release only when it has shipped (its record carries a ship date) or at least one
of its CRs is completed (merged: a closed plan with a merge commit, or named by a shipped release
record) — user ruling at gap analysis 2026-10-09: a shipped release is past even when its record
names no CRs (0.1.1). An unshipped release with nothing completed — today 0.4.0 — is not listed, and
the `planned` state is withdrawn. The other rules of CR-CRU-173 stand (one row per
release; work falls into the release that succeeds it on the timeline; withdrawn planless CRs belong
to no release; gate runs and verification as built).

### §S2 — a listed release shows only its completed work

Within a listed release, a wave lists only its completed CRs (and their cycles); a wave with none is
not listed. Each wave line carries the count of that release's CRs in the wave that are not yet
completed, as F22 draws it (`· 1 pending`), with no rows for them. The running CR stays in Now; pending
work stays on the Roadmap. On the wire: `crCount` (release row) and each wave's `crs` hold completed
CRs only; the release row and each wave gain `pendingCount` (0 when none). The page draws the release
row `<n> CRs completed · <p> pending` (the pending part omitted at 0) and the wave line
`wave <w> · <m> merged · <p> pending` (likewise).

## Acceptance criteria

- [ ] `/history` omits an unshipped release with no completed CR (only queued or in-flight CRs) and
      never answers `planned`; a release with one completed CR is listed, and a shipped release with no
      CRs is listed — asserted on the server with fixed fixtures.
- [ ] A listed release's waves carry only completed CRs plus a pending count; a wave whose CRs are
      all pending is not listed; the page draws `wave <n> · <m> merged · <p> pending` and no rows for
      pending CRs — asserted on the server and on the page.
- [ ] On a copy of the dev store: 0.4.0 is absent; 0.3.0 is listed with its merged CRs only (33 at
      gap analysis; more as 0.3.0 merges) and a pending count (CR-CRU-175 and this CR at gap analysis);
      0.2.2, 0.2.0, 0.2.1 and 0.1.x (0.1.1 with 0 CRs included) unchanged from CR-CRU-173 — asserted
      by VERIFY.

## Gap analysis (2026-10-09)

**Baseline:** develop `52d5731` = CR-CRU-173's gated tree (bun 3313/0, python 2341/0 at its gate; e2e
1123/0 at its last full run) — the merge added no other change.

**Real data, through the route on a store copy (15 ms):** 0.4.0 planned 3 (all pending: 151/152/153);
0.3.0 in progress 35 (33 merged; pending 175, 177); 0.2.2 ship not recorded 4 (all merged); 0.2.1 1;
0.2.0 70 (3 gate runs); 0.1.3 1; 0.1.2 1; **0.1.1 0 CRs, shipped**; 0.1.0 60.

| # | Dim | Finding | Fix | Blocking |
|---|---|---|---|---|
| DRIFT-1 | 1 | "≥1 completed CR" would drop 0.1.1 (shipped, record names no CRs) | shipped also counts (user ruling) | Yes |
| DRIFT-2 | 2 | The wire has no pending count; `crCount`/`crs` mix pending CRs in | `pendingCount` on release and wave; `crs` completed only | Yes |
| DRIFT-3 | 3 | The page draws pending CRs as `· no plan filed` rows (`LensCrGroup`, `source === "unplanned"`) | those rows go; counts on the lines | No |
| DRIFT-4 | 3 | History opens the first release in wire order (0.4.0 today) | resolved: 0.4.0 is no longer listed, so 0.3.0 opens | No |
| DRIFT-5 | 7 | Cost: a filter, two counts, the page lines, re-pins — 3 holds | — | — |

**Consumed:** `projectHistory`/`historyRow` (state + listing), `merged` set, `HistoryRelease` /
`historyReleaseSummary`, the wave line, `LensCrGroup`. **Removed:** the `planned` state; the page's
`no plan filed` rendering *in History* (the Roadmap's own unplanned rows are untouched —
`tests/plans.test.ts`, `roadmap-graph.feature` read those).

### Tests this CR knowingly re-pins (approved in advance; the user's ruling reverses them)

- `tests/history-by-release-read.test.ts`: the `planned`-state tests (a queued-only release IS listed
  as `planned`) flip to "is not listed"; tests counting pending CRs in `crCount`/`crs` count completed
  only, with `pendingCount` asserted beside.
- `tests/workflow-history-release-tree.test.ts` and its e2e feature/steps: any row or text for a
  pending CR in History, or for a planned release, flips to its absence plus the count.
Anything else: stop and ask.

### Cycles

1. History shows only the past (§S1, §S2)
2. verify
