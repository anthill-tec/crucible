# CR-CRU-213 — a milestone is never drawn as a run

**Type** fix · **Points** 3 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(user-raised 2026-10-28 from the browser; user rulings: a patch CR into 0.4.0, sequenced next; the
rail's latest line is the newest run or compile result; re-scored 2 → 3 at gap analysis)

## Problem

Seen in the browser during CR-CRU-210's FIX cycle (765): while the cycle was active, its line in the
Workflow tab's Now pane showed a chip **`vidushi 0/0`** beside the gate's two real runs (`4145/4145`,
`4777/4777`). It was the gate's `pre-merge-gate` milestone (`evt-1793164976716-77`), posted under the
cycle because the orchestrator was bound to it. A milestone carries no run counts, so it read as an
empty run. It vanished once the cycle was done, because History builds a done cycle's runs through
`workflowLens` (`public/app-logic.mjs`), which keeps only `kind === "test"` events.

The cause is the active line's run list, `linkedRunsFor` (`public/app.js`): it keeps every event of the
cycle whose `kind` is not `lifecycle`, so milestones (and any non-run event stamped with the cycle)
become run chips through `OpenSpan` → `InlineRunEntry`, and compile results too. Every
`pre-merge-gate` since CR-CRU-188 has drawn one while its cycle was active. The same list feeds the Runs
timeline's collapsed cycle cue (`▸ N runs`), which counts them as runs.

The same defect shows on the project rail: after a `cr-close` it reads **"✓ green · 0/0 · just now"**.
Both readers of `project.lastEvent` — the workspace rail (`ProjectStatusLine`, `public/app.js`) and the
home cards (`projectRollupLabel`, `public/app-logic.mjs`) — format it as a run. The board fills it from
`store.newestEvent` (the projects list in `src/v2.ts`), which merges the events table (registrations
included), milestones and gates: so the rail reads "✓ green · 0/0" after a `cr-close` (the `cr-merged`
milestone), after any agent registers or unregisters, after a gate's milestone, and after a compile
result. `newestEvent` also decides the project's activity (`lastActivity`), which must keep counting
every event.

## Design (user rulings, 2026-10-28)

- **A run is a test run, as History already rules.** The active cycle's run list keeps only the cycle's
  `kind === "test"` events — the rule `workflowLens` applies — so milestones, gates, registrations and
  compile results are never chips, and the collapsed cue counts test runs.
- **The project's `lastEvent` is its newest test run or compile result.** The board's projects read
  takes it from a read of those two kinds only; milestones, gates and registrations never feed it.
  `newestEvent` stays as it is for the project's activity.
- **The latest line words a compile result as itself.** On the rail and the home cards, a test run reads
  as today (`✓ green · P/T` or `✗ F failed of T`); a compile result reads `✓ compiled` with no errors and
  `✗ N errors` (`✗ 1 error`) otherwise, each with its age. A project with neither reads "no runs yet".

## Acceptance criteria (draft — fixed at gap analysis)

The UI criteria are proved by BDD Playwright scenarios in the e2e suite (`tests/e2e/features/`, steps in
`tests/e2e/steps/`, reusing the workflow steps), not by a visual check (user ruling 2026-10-28: a
scenario checks the UI's output on every run, at no token cost). The e2e suite is outside the pre-merge
gate (DN open question 5), so this CR's cycles and its VERIFY run those scenarios through the bun
client's e2e verb themselves.

- [ ] **AC1 (BDD)** Scenario: an active cycle holding a passing test run, a `pre-merge-gate` milestone and
  a compile result shows exactly one run chip on its Now-pane line, reading the test run's ratio — no
  `0/0` chip.
- [ ] **AC2 (BDD)** Scenario: the Runs timeline's collapsed cue for that cycle reads `▸ 1 runs`.
- [ ] **AC3 (BDD)** Scenario: after a CR is closed and an agent registers (the newest events a
  `cr-merged` milestone and a registration), the project rail reads the newest test run's counts; after
  a newer compile result with errors, it reads `✗ N errors`, and with none, `✓ compiled`.
- [ ] **AC4** The projects read reports, as `lastEvent`, the newest test run or compile result — never a
  milestone, gate or registration — and `null` for a project holding neither (the rail and the cards
  then read "no runs yet"); the project's activity still counts every event (bun, against the board).
- [ ] **AC5** The home cards' line (`projectRollupLabel`) words a compile brief as `✓ compiled` /
  `✗ N errors` / `✗ 1 error` (bun unit).

## Non-goals

- What the Runs tab and its timeline show.

## Release notes

- The active cycle's line and the project rail show test runs only: a gate's milestone no longer appears
  as a `0/0` run, and a `cr-close` no longer turns the rail to "green · 0/0".
