# CR-CRU-275: a multi-track project's waves always show their track

**Status:** PENDING.

- **Filed** 2026-11-24 on a CReq from Parti. The user took it into 0.5.0 wave 9, right after CR-CRU-269, with Parti's
  optional no-track warning included.
- **Revised** 2026-11-25 after the gap analysis and the user's rulings Q1–Q4.

**Type:** feature
**Points:** 5 (re-scored from 3 by ruling Q4)
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** ui, roadmap, lanes
**Design reference:**

- CR-CRU-085, the wave's track lanes:
  - §S3/AC2: one track, no lane chrome;
  - AC7: the lanes and the table column go together;
  - AC9: the untracked node;
  - AC18a: the loose group.
- CR-CRU-108: `declaredTracks` in `src/store.ts`, and §S3/AC7 with its non-goal.
- CR-CRU-096 AC14/AC15 and CR-CRU-109, the wave box's width budget.
- `docs/research/DN-model-b-language.md` §4.
- `.lavish/crucible-workflow-flowchart.html` §4 and §7.

## Problem

The roadmap decides a wave's lanes from that wave alone.

- `focusedReleaseView` in `public/app-logic.mjs` lanes a wave only when its own live CRs declare more than one track.
- A wave whose CRs all sit on one track is drawn as a flat list, with no track label.
- That is the same look as a solo project's implicit solo lane.

In a project that runs several tracks, such a wave reads as Mainline's own work, and Mainline never develops.

- Parti runs four tracks, and its owner read its single-track waves that way.
- As a workaround, Parti merged those waves into neighbouring ones.
- Yet a wave may rightly hold one track: a release's opening chain, or a closing hygiene CR.

A CR that declares no track in such a project falls to Mainline, and the roadmap gives no sign of it. `next` with
`--track` never serves an untracked CR: `resolveNext` matches the CR's track against the one asked for.

## Behaviour

### S1: a multi-track project lanes every wave

A project is **multi-track** when `declaredTracks` (`src/store.ts`) counts more than one track over its whole queue.

- The whole queue means every row, in every release, whatever its status or lifecycle: COMPLETED, VOID and SUPERSEDED
  rows count too. That is the same count `next` uses for "this project declares more than one lane" (ruling Q1).
- A project that once ran two tracks and now runs one stays multi-track. `next` still asks it for `--track`, so its
  lanes tell the truth.

**One rule.** The roadmap uses that count only. In the browser, `focusedReleaseView` derives the project's track list
from the `entries` it already receives: the whole queue that `GET …/queue` returns. It uses `distinctLabels`, the
mirror of `declaredTracks` pinned by CR-CRU-108's parity test.

- No server change is made, and no new state is kept.

**In a multi-track project:**

- Every wave box publishes a lane for each track its own live members declare.
- A wave with one declared track publishes one lane. Its body draws the lane grid with that track's label, and its
  header reads `· 1 track`.
- A wave with two or more tracks keeps `· N tracks`.
- A wave whose live members declare no track publishes no lanes, and its header has no track count. Each of its drawn
  rows carries S3's marker.

**The table column.** Zone 3's `track` column follows the same rule (ruling Q3). It shows in a multi-track project
even when the focused release's members declare one track, so CR-CRU-085's "lanes and column appear together" still
holds. A focused release whose members declare no track has no lanes, so it shows no column either (user ruling,
2026-11-25).

### S2: a solo project is unchanged

A project whose queue declares one track or none is unchanged.

- A wave publishes lanes only when its own CRs declare more than one track. Since the project has at most one, that
  never happens.
- The table column, too, shows only when its release declares more than one track.
- So CR-CRU-085's AC2/AC6 (flat list, no lane chrome) and AC9 (the untracked node's arrangement) hold for it unchanged.

### S3: a CR with no track is flagged in a multi-track project

In a multi-track project, every drawn row whose CR declares no track and is not merged carries a `no track` marker.

**Where it appears:**

- the rows of a wave's `soloRows`, outside the lane grid;
- the rows of a wave with no declared track (S1);
- the rows of the loose group (`wave: null`), which is still never laned (CR-CRU-085 AC18a).

**The marker:**

- markup: `span[data-testid="roadmap-node-no-track"].app-flow-node-no-track`;
- text: `no track`;
- `title`: exactly `no track — this CR falls to Mainline until it is given one`.

It has the same shape as the roadmap's existing row warning, `roadmap-order-warning`.

- It is a sibling of the node's annotation, never inside it (CR-CRU-096 AC14).
- It has no click handler of its own: a click on it selects its row, as a click elsewhere on the node does
  (CR-CRU-096 AC15).

**Width (ruling Q2).** On an untracked row, the marker takes the place of the annotation's `deps …` part.

- The row keeps its `next` marker when it has one.
- Its dependencies stay listed in zone 3's table.
- A solo project's rows never carry the marker, and keep their `deps` annotation.

### S4: the wave box's width budgets

At the 1130 px surface, measured in Chromium:

- An unlaned wave box keeps its budget of about 300 px (CR-CRU-096 AC20, CR-CRU-109).
- A laned wave box has a budget of 360 px (ruling Q2). Laning adds a 54 px label column and a 5 px gap.

## Acceptance criteria

The **fixtures** below are queues built in the test:

- **MULTI:** declares `track-1` and `track-2`.
- **ONE:** declares only `track-1`, with and without untracked CRs.
- **NONE:** declares no track.

**AC1 (S1).** In MULTI, a wave whose live members all declare `track-1`:

- publishes `lanes` of exactly one entry, `{ track: "track-1", rows: <all the wave's drawn rows> }`;
- has an empty `soloRows`.

**AC2 (S1).** Rendered through `app.js`, AC1's wave shows:

- `[data-testid="roadmap-wave-lanes"]` with one lane labelled `track-1` that holds all its rows;
- a header reading `Wave <n> · 1 track`.

**AC3 (S1).** In MULTI, a wave whose members declare `track-1` and `track-2`:

- publishes two lanes;
- its header reads `· 2 tracks`.

**AC4 (S2).** Under ONE and NONE:

- every wave box has `lanes` `[]`;
- the DOM has no `[data-testid="roadmap-wave-lanes"]`;
- no wave header carries a track count.

**AC5 (S3).** In MULTI:

- (a) Each untracked, non-merged drawn row carries exactly one `span[data-testid="roadmap-node-no-track"]`:
  - in a laned wave's `soloRows`;
  - in a wave with no declared track;
  - in the loose group, which publishes `lanes: []`.
  - Its text is `no track`, and its `title` is the exact string in S3.
- (b) A tracked row has no marker, and neither has a merged untracked row.
- (c) The marker is not a descendant of `[data-testid="roadmap-node-annotation"]`. An untracked row's annotation
  carries no `deps` text, and it keeps `next` when the row is the next CR.
- (d) A click dispatched on the marker selects its row (`data-selected="true"`).

**AC6 (S2, S3).** Under ONE and NONE:

- no `[data-testid="roadmap-node-no-track"]` is drawn;
- an untracked row keeps its `deps` annotation.

**AC7 (S1, Q1).** A project whose second track appears in one of these places is still multi-track, so a single-track
wave in the focused release is laned as in AC1:

- (a) only on a member of another release;
- (b) only on a COMPLETED row;
- (c) only on a VOID row.

The project track list that `focusedReleaseView` uses equals `declaredTracks` over the same rows. This extends
CR-CRU-108's AC6 parity test.

**AC8 (wiring).** The test mounts through `app.js`, with the `GET …/queue` stub serving AC7(a)'s entries.

- With those entries, the single-track wave renders one lane.
- With the other release's member removed from the stubbed payload, it renders none.

This proves the path `refetchRoadmap` → `RoadmapPanel` → `focusedReleaseView` → `RoadmapFlowWave`/`RoadmapFlowNode`.

**AC9 (S1).** In MULTI, a wave whose live members declare no track:

- publishes `lanes: []`;
- has a header with no track count;
- marks every drawn row as AC5 says.

**AC10 (S4, Chromium).** At the 1130 px surface:

- **Laned box:** a one-lane box whose row carries `next` and four declared dependencies measures at most 360 px.
- **Unlaned box:** a box of a wave with no declared track, whose untracked row carries `next` and the marker, measures
  at most 300 px.
- Each assertion message reports the measured width.

**AC11 (S1, Q3).** Zone 3's `track` column:

- In MULTI with a single-track focused release, the column shows.
- In MULTI with a focused release that declares no track, it does not show.
- Under ONE and NONE, it does not show.

**AC12 (reviewed, not tested).** The docs are amended:

- DN §4 gains the clause that "`track` absent = implicit solo lane, no UI noise" governs a project with one track or
  none.
- The `.lavish` artifact's §4 and §7 rows state the project-level rule and the 360 px laned box.
- The `RoadmapFlowWave` comment "Never singular" and the `FocusedReleaseWave.lanes` doc in
  `public/app-logic.d.mts` are rewritten.
- The CHANGELOG says what a multi-track project's roadmap now shows.

## What this supersedes

CR-CRU-085 and CR-CRU-108 are shipped and are not edited; this section records the change.

- **CR-CRU-085 §S3/AC2** ("one track → no lane chrome") now holds for a solo project only.
- **CR-CRU-085 AC7** still holds: lanes and the table column appear together. Both now follow the project rule.
- **CR-CRU-085 AC9.** The untracked node's byte identity now holds modulo S3's marker and its dropped `deps` text, in a
  multi-track project. It holds unchanged in a solo project.
- **CR-CRU-108 §S3/AC7 and its non-goal** ("the scopes are deliberate"). Zone 2's lanes and zone 3's column now read
  the project-level list. Zone 2's release-level `tracks` field stays published for its parity test.
- **The tests** that pin these guarantees change with them:
  - `tests/integration/roadmap-track-lanes.test.ts`: the CR-CRU-108 AC7 case and the CR-CRU-085 AC9 byte-identity
    case;
  - `tests/integration/roadmap-visual-grammar.test.ts`: its populated `QUEUE` gets one track, so its unlaned-budget
    premise holds.

## Non-goals

- No change to the server, `next`, `queue` or any client. The warning is on the roadmap only.
- No change to how a track is stored or normalised (`normalizeTrack`). A legacy stored value counts as written, as
  `next` counts it.
- The loose group stays unlaned.
- Zone 3's open-plan lane badge (`multiTrack = openPlans.length > 1`) answers a different question, which plans run
  now, and stays as it is.
- The Workflow tab's History lens keeps its per-wave rule.

## Tests

| Module | Change | Tier | Covers |
|---|---|---|---|
| `tests/unit/roadmap-project-track-lanes.test.ts` | new | unit: pure `focusedReleaseView`, no DOM | AC1, AC3, AC4, AC5(a/b), AC7, AC9, as data |
| `tests/unit/app-logic.test.ts` | extend CR-CRU-108's AC6 parity test | unit | AC7's parity arm |
| `tests/integration/roadmap-track-lanes.test.ts` | add; rewrite the two superseded cases | integration: happy-dom running `app.js` with a stubbed fetch | AC2, AC3, AC4, AC5, AC6, AC8, AC9, AC11, as DOM |
| `tests/integration/roadmap-visual-grammar.test.ts` | fixture gets one track; two measurement boards added | integration: Chromium | AC10 |
| `roadmap-release-focus` and `roadmap-wave-drops-dead-crs` (integration) | re-run; change only if they fail for this CR's reason | integration | regression |

There are no e2e tests: no server or wire change is made.
