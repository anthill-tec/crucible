# CR-CRU-073 — Finished releases keep showing their gate: no-mistakes events outlive their release

- **Type**: bugfix
- **Wave**: 5 (0.2.0)
- **Depends on**: 013, 071 (migration chain for the `retired_at` marker), 074 (the release-completion signal)
- **Status**: PENDING (0.2.0)

## Problem

A no-mistakes gate event is written per release run and then persists
indefinitely. Measured on the live store on 2026-08-20, a day after the
releases finished:

```
evt-1787147319990-5   2026-08-19 19:18  no-mistakes  "Ship Crucible v2 0.1.0 — first public rel…"
evt-1787148416296-6   2026-08-19 19:36  no-mistakes  "Ship Crucible v2 0.1.0 — first public rel…"
evt-1787162398203-39  2026-08-19 23:29  no-mistakes  "Ship Crucible 0.1.2 — a patch release fix…"
```

All three releases are **shipped** — 0.1.0, 0.1.1 and 0.1.2 are on PyPI and npm
— yet the Workflow tab's no-mistakes pane still renders their gates as if they
were current. Two of them are for a release two versions old, and one is a
duplicate run of the same release.

`Store.appendGate` (`src/store.ts:1088-1106`) fixes `codec: "no-mistakes"` and
lets the event "flow through retention like any event". Retention is a
**per-project count cap** (`DEFAULT_RETENTION = 100`, oldest-first pruning), not
a lifecycle: a gate event only disappears once 100 newer events happen to push
it out, which is unrelated to whether its release finished. So the pane's
contents are governed by traffic volume rather than by release state, and a
finished release's gate can linger for days — or vanish mid-release if the
project is busy. Both directions are wrong.

## Design

A gate belongs to the release it gated. When that release finishes, the gate is
history and leaves the view.

Retention (a volume cap) is the wrong lever and is left alone; this is a
**lifecycle transition**, mirroring how a cycle leaves the active view when it is
done rather than when the store fills up.

## Acceptance criteria

**AC1 — a gate event names the release it gated, structurally.** The gate POST
(`POST /api/v2/gates`, today `{intent, outcome, steps, fixes?, push?, pr?}`)
gains an optional `version` (bare SemVer), captured at gate time from the
`release/X.Y.Z` branch the no-mistakes run executes on. It is stored as a first-
class field, never parsed back out of the free-text `intent`. A gate posted
without a version is still accepted (graceful degradation) and simply never
becomes retire-eligible. The three existing strays carry no `version` and are
handled by AC5, never orphaned.

**AC2 — finishing a release retires its gates, in the recording transaction
(design (a), chosen 2026-08-20).** `recordMilestoneEvent` for `type:"release"`
(CR-CRU-074) stamps a new `events.retired_at` on every gate whose `version`
equals the released version, INSIDE the same transaction that inserts the
release milestone. One atomic act, no second command, no dependence on later
event traffic. A release recorded when no matching gate exists yet still
succeeds — a gate that arrives afterward for an already-released version is
stamped retired on insert, so ordering cannot leak a stale gate.

**AC3 — an in-flight release keeps its gate (immune to the retention cap).**
A gate with `retired_at IS NULL` is EXEMPT from the per-project count cap
(`enforceRetention`, DEFAULT_RETENTION) — the same protection test/compile events
get by folding into rollups — so a busy project can never prune a live gate.
Once retired (AC2), a gate becomes retention-eligible like any other event.
Original AC3 intent follows:

**AC3 (restated) — an in-flight release keeps its gate.** A gate for a release that has not
finished stays fully visible regardless of how much other event traffic the
project sees — the pane must not be able to lose a *current* gate to the
retention cap. This is the converse defect and is asserted independently.

**AC4 — retired is a stored marker, excluded from the view, never deleted.**
`retired_at` (epoch ms, NULL = live) is the marker; the gate ROW is never
deleted. The workflow-pane gate query filters `retired_at IS NULL`, so a retired
gate cannot be returned to the view, while an audit read that explicitly asks for
retired gates still finds them intact. Asserted both ways: the pane query omits a
retired gate, and the row plus its full gate object still exist on a direct
fetch.

**AC5 — the three existing strays are retired by the migration that adds the
column.** The `retired_at` column is added as CR-CRU-071 chain **step 6 → 7**
(SCHEMA_VERSION derives to 7). Because the three pre-existing gates carry no
`version` to match a release against, that same migration stamps `retired_at` on
**every gate event that predates this column** — all of them are, by definition,
from releases that shipped before the feature existed (0.1.0 ×2, 0.1.2). The step
is idempotent and lossless: it only sets `retired_at` where NULL, moves no data,
and a re-open re-stamps nothing.

**AC6 — duplicate runs of one release collapse on `version`.** Two gate runs
sharing a `version` (as 0.1.0 has) are retired together by AC2's single stamp,
so the pane shows that release's gate history rather than two independent current
gates. For the pre-column strays this is subsumed by AC5 (all retired at once).

## Scope

Non-goals, explicitly:

- **Retention is unchanged.** No new caps, no per-codec retention, no change to
  `DEFAULT_RETENTION` or to the fold-then-prune rules for `test`/`compile`.
- No change to `POST /api/v2/gates`' accepted payload or to the no-mistakes
  ladder's step names (CR-CRU-013 §S1).
- No change to milestone events.
- The Workflow tab's layout is untouched — this changes which gates the pane is
  given, not how it draws them.

## Notes

- Raised 2026-08-20 by the maintainer: "once a release is finished it should be
  gone". Confirmed against the live store before filing — three stale gate
  events, all for shipped releases.
- Ordering (corrected 2026-08-20 by CR-CRU-017's gap analysis): this CR was
  filed depending on CR-CRU-017, on the assumption that its lifecycle work would
  supply the "release finished" signal. It does not — CR-CRU-017 delivers a RUN
  lifecycle (start / end / abort of a test run) and emits nothing about a
  release. Shipping 017 would not unblock this CR.
  The signal this needs is the RELEASE ceremony's completion — the point at
  which a tag is cut and published (`scripts/release.sh finish`, the
  `create-release` + publish workflows). CR-CRU-071's migration chain is still
  the mechanism for retiring the three existing strays (AC5).
