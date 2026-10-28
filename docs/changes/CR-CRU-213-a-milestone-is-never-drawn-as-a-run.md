# CR-CRU-213 — a milestone is never drawn as a run

**Type** fix · **Points** 2 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(user-raised 2026-10-28 from the browser; user ruling: a patch CR into 0.4.0, sequenced next; gap analysis
pending)

## Problem

Seen in the browser during CR-CRU-210's FIX cycle (765): while the cycle was active, its line in the
Workflow tab's Now pane showed a chip **`vidushi 0/0`** beside the gate's two real runs (`4145/4145`,
`4777/4777`). It was the gate's `pre-merge-gate` milestone (`evt-1793164976716-77`), posted under the
cycle because the orchestrator was bound to it. A milestone carries no run counts, so it read as an
empty run. It vanished once the cycle was done, because History draws a done cycle's runs from the
plan's own run list.

The cause is the active line's run list, `linkedRunsFor` (`public/app.js`): it keeps every event of the
cycle whose `kind` is not `lifecycle`, so milestones (and any non-run event stamped with the cycle)
become run chips through `OpenSpan` → `InlineRunEntry`. Every `pre-merge-gate` since CR-CRU-188 has drawn
one while its cycle was active.

The same defect shows on the project rail: after a `cr-close` it reads **"✓ green · 0/0 · just now"**.
`projectRollupLabel` (`public/app-logic.mjs`) formats `project.lastEvent`, which the board fills from
`store.newestEvent` (`src/v2.ts`, the projects list) — the newest event of any kind, here the
`cr-merged` milestone.

## Design (proposed — to be settled at gap analysis)

- **Only a test run is drawn as a run.** The active cycle's line keeps only the cycle's test runs
  (`kind: test`); milestones, gates and lifecycle records are never chips.
- **The project's `lastEvent` is its newest test run** — the board's projects read stops counting
  milestones (and lifecycle records) as the last run, so the rail's line states real counts.

Open for the gap analysis: whether compile results (also stamped with the cycle) get a chip of their
own or none; and every other surface that reads `newestEvent` or filters by "not lifecycle".

## Acceptance criteria (draft — fixed at gap analysis)

- [ ] **AC1** An active cycle holding a test run and a `pre-merge-gate` milestone draws one run chip,
  the test run's (DOM).
- [ ] **AC2** A project whose newest event is a milestone reports, as `lastEvent` on the projects read,
  its newest test run; the rail reads that run's counts.
- [ ] **AC3** A project with no test run reports no `lastEvent` (the rail reads "no runs yet"), even when
  it holds milestones.

## Non-goals

- What the Runs tab and its timeline show.

## Release notes

- The active cycle's line and the project rail show test runs only: a gate's milestone no longer appears
  as a `0/0` run, and a `cr-close` no longer turns the rail to "green · 0/0".
