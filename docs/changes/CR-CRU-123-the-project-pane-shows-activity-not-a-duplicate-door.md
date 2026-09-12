# CR-CRU-123 — the Project pane shows activity, not a duplicate door

**Status:** PENDING (0.2.0 — born mid-release, D4)
**Type:** feature
**Priority:** P3
**Depends on:** none
**Labels:** feature, ui, ux, project-pane
**Phase:** Wave 6 (0.2.0 — user-directed, live orchestrator session 2026-09-12)
**Design reference:** none — two UX findings raised live against the running board

## Context

Two user findings against the workspace Project pane (the right rail), raised 2026-09-12. Both are
about the pane's signal-to-noise: it carries no indication of the one thing happening most often,
and it carries a control that duplicates the tab strip beside it.

**1. An agent streaming test data is indistinguishable from an idle one.** `AgentRow`
(`public/app.js:621-660`) computes `busy = agent.liveness === "online" && agent.status === "busy"`
and renders a **static** red dot for it (`app.js:641`). Nothing on the row moves while that agent is
actually mid-run, so a pane full of registered agents reads the same whether work is flowing or
nothing is happening. The precise signal already exists client-side and needs no server work:
`state.openRuns` (runs opened via `/runs/start` and not yet settled — CR-CRU-017 §S3, served
additively on the events feed) carries `agentId`, which is exactly "this agent has a run in flight".
It is the same feed `RunningCard` (`app.js:937-943`) already reads to pulse a run card.

**2. The `🗺 roadmap` chip duplicates the tab strip.** `ProjectPane` renders a chip
(`app.js:2425-2432`, `data-testid="roadmap-chip"`) whose `onclick` is
`selectWorkspaceTab("Roadmap")` — the identical route the tab strip's own Roadmap tab performs, and
CR-CRU-079 §S1/AC2 pins the two as byte-identical pathnames on purpose. The chip predates
CR-CRU-076, which made **Roadmap the first tab in the strip**; once the destination became the
leftmost tab, a second door two inches away stopped earning its space. User ruling: remove it.

**Consumers of the chip, enumerated before proposing its removal (2026-09-12):**

| consumer | disposition |
|---|---|
| `public/app.js:2425-2432` | the chip itself — deleted |
| `tests/roadmap-pane.test.ts:249,259` | assert the chip exists — deleted with it |
| `tests/roadmap-pane.test.ts:349,393` | **click** the chip to drive CR-CRU-079's pathname/pushState assertions — RE-POINTED at the surviving tab-strip door, never deleted: the navigation contract they protect outlives the chip |
| `docs/changes/CR-CRU-079-*.md` | a SHIPPED CR's spec text. NOT edited (standing rule: an implemented CR is never rewritten); this CR's §S2 is the record of the removal instead |

## Scope

### §S1 An agent with a run in flight animates on its Project-pane row

`AgentRow` gains an activity indicator driven by `state.openRuns`: an agent is STREAMING when at
least one open run's `agentId` equals that row's agent id. While streaming, the row renders a
**new, visually distinct animation** — deliberately NOT the spinner CR-CRU-122 introduces (that one
means "a fetch you are waiting on"), and deliberately NOT `app-run-pulse` (`styles.css:1096-1100`,
the run card's own ember border-pulse), so an agent row never reads as a run card. The animation is
a data-flow treatment on the row itself (a travelling shimmer, or an animated flow glyph in the
row's existing `⌁` marker slot — implementation's choice within the pane's existing visual
language), with its own `@keyframes` rule and its own semantic class.

The existing static `busy` dot (`app.js:641`) is untouched: `status === "busy"` is a coarser
liveness fact and keeps its own rendering. This section adds a signal; it removes none.

**The lifecycle this rides on, verified in source 2026-09-12 (asked: does Crucible get a run-finished event, or only test counts?).** There IS a definitive end-of-run signal, and there are NO mid-run counts — so the animation needs no arithmetic over completed-vs-total:

- `POST /api/v2/runs/start` (`src/v2.ts:901`) opens the run and stores NO event — its own comment: *"a start is not an end"*. The open run is persisted in SQLite, so it survives a restart.
- Every ingest route takes an OPTIONAL `runId`; `resolveRunClose` (`src/v2.ts:939-981`) validates it and the SERVER's clock closes it, then `store.endRun(...)` fires AFTER the event write (`src/v2.ts:1020-1024`) — deliberately after, *"so a failed ingest leaves the run OPEN (and sweepable) rather than lost"*.
- What the UI observes is therefore the run LEAVING `listOpenRuns` in the SAME response that carries the new event (CR-CRU-017 §S3: one response carries both, so the two can never disagree).
- Ingest is a single POST of a COMPLETE report (JUnit XML, or a parsed summary+tree). The open-run record carries `runId`/`agentId`/`startedAt`/`context`/`meta` and no progress counts at all, so there is nothing partial to compare against a total.
- A hung or dead run cannot animate forever: `sweepOpenRuns` (`src/store.ts:2536`) settles stale open runs into aborted events and runs BEFORE every events and agents read (`src/v2.ts:697`, `:3473`). A stuck animation is therefore structurally impossible, not merely unlikely.

### §S2 The duplicate roadmap chip is removed from the Project pane

Delete the `roadmap-chip` button (`app.js:2425-2432`) and its CSS class if the class has no other
consumer. The Roadmap tab in the workspace tab strip is the surviving door and is unchanged — the
route, the pushState behavior and CR-CRU-079 §S1's pathname contract all stay exactly as they are,
reached through the tab.

## Acceptance criteria

**§S1**
- [ ] With one registered agent and one entry in `state.openRuns` whose `agentId` matches it, that
      agent's `[data-testid="agent-row"]` carries the new activity class; with `openRuns` empty, it
      does not.
- [ ] The animation has its own `@keyframes` rule in `styles.css`, referenced by its own class, and
      is NEITHER `app-spin` (CR-CRU-122's spinner) NOR `app-run-pulse` — asserted by name so the
      three signals cannot collapse into one.
- [ ] With TWO registered agents and an open run for only ONE of them, exactly one row carries the
      activity class — asserted by counting, so a fix that animates the whole list fails.
- [ ] When the open run settles (the same tick the event enters `state.events` and leaves
      `state.openRuns`, per CR-CRU-017 §S3), the animation stops — driven by re-rendering the real
      state transition, not by a timer.
- [ ] The existing static `busy` dot still renders for `status === "busy"` regardless of whether the
      agent is streaming — regression pin, the two signals are independent.
- [ ] A tombstoned agent never renders the activity animation even if a stale open run names it.

**§S2**
- [ ] `[data-testid="roadmap-chip"]` renders nowhere in the workspace Project pane.
- [ ] The workspace tab strip's Roadmap tab still routes to `/p/<key>/roadmap` with pushState, and
      the tab still FOLLOWS the route on Back/Forward — CR-CRU-079 §S1's existing assertions, now
      driven through the tab door, passing unchanged.
- [ ] The two tests that previously clicked the chip (`tests/roadmap-pane.test.ts:349,393`) assert
      the SAME pathname/pushState contract through the tab-strip door — re-pointed, not deleted, and
      their assertions not weakened.
- [ ] A grep for `roadmap-chip` and `app-roadmap-chip` returns hits only in shipped CR docs (the
      historical record), never in `public/` or `tests/`.

## Estimated size

S — one cycle. One new CSS animation plus a derived per-row predicate, and one deletion with two
tests re-pointed.

## Risk

- **§S1's trigger is a client-side join** between `state.agents` and `state.openRuns` on `agentId`.
  The two slices arrive in ONE response (CR-CRU-017 §S3's deliberate design: "one response carries
  both", so they can never disagree about a run), so no staleness window is introduced.
- **§S2 removes a public testid.** Consumers are enumerated above; the only behavioural consumers
  are two navigation tests whose contract survives through the tab door.

## Non-goals

- Changing `RunningCard`'s `app-run-pulse` or CR-CRU-122's spinner — three distinct signals, each
  keeping its own meaning and its own animation.
- Changing the static `busy` dot's meaning, the liveness dot palette, or any liveness threshold.
- Any server change: `openRuns` is already served on the events feed.
- Editing `docs/changes/CR-CRU-079-*.md` — a shipped CR is never rewritten; this CR is the record.
- Adding an activity indicator anywhere other than the Project pane's agent rows (the home projects
  row keeps its existing liveness dot).
