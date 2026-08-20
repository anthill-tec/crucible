# CR-CRU-073 — Finished releases keep showing their gate: no-mistakes events outlive their release

- **Type**: bugfix
- **Wave**: 5 (0.2.0)
- **Depends on**: 013 (and a release-completion signal — see Notes; NOT 017)
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

**AC1 — a gate event names the release it gated.** A gate carries the release it
belongs to, so "has this release finished?" is answerable without parsing the
free-text `intent`. Existing gate events (which carry no such field) are handled
by AC5, never orphaned.

**AC2 — finishing a release retires its gates.** When a release completes, every
gate event for that release stops appearing in the workflow view, in the same
transaction that records the completion. No second command, no manual cleanup,
and no dependence on subsequent event traffic.

**AC3 — an in-flight release keeps its gate.** A gate for a release that has not
finished stays fully visible regardless of how much other event traffic the
project sees — the pane must not be able to lose a *current* gate to the
retention cap. This is the converse defect and is asserted independently.

**AC4 — retired means gone from the view, and auditable.** Retirement removes
the gate from the workflow view but must not silently destroy the release record:
the outcome stays retrievable for audit (a released/superseded marker excluded
from the view, not an unconditional delete). A view query must not be able to
return a retired gate.

**AC5 — the three existing gate events are retired by this CR.** The 0.1.0 ×2
and 0.1.2 gates listed above belong to shipped releases and must be retired on
migration, not left as permanently-current strays. Migration is idempotent and
lossless (CR-CRU-071's chain, once it lands, is the mechanism).

**AC6 — duplicate runs of one release collapse.** Two gate runs for the same
release (as 0.1.0 has) render as that release's gate history, not as two
independent current gates.

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
