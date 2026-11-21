# CR-CRU-213 — a milestone is never drawn as a run

**Type** fix · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** DONE — merged 2026-10-28 (plan 212, cycles 766–770, gate 8953/0: bun 4176/0, python 4777/0; e2e 121 passed); filed 2026-10-28
(user-raised 2026-10-28 from the browser; user rulings: a patch CR into 0.4.0, sequenced next; a run is a
test run; the status line reads the newest run or compile result, and words a compile result and an
aborted run as themselves; the collapsed cue counts test runs; UI criteria are BDD scenarios; re-scored
2 → 3 at gap analysis and 3 → 5 at the spec pre-review)

## Problem

Seen in the browser during CR-CRU-210's FIX cycle (765): while the cycle was active, its line in the
Workflow tab's Now pane showed a chip **`vidushi 0/0`** beside the gate's two real runs (`4145/4145`,
`4777/4777`). It was the gate's `pre-merge-gate` milestone (`evt-1793164976716-77`), stamped with the
cycle because the orchestrator was bound to it (`handleMilestones` → `resolveIngestAttach`). A milestone
carries no run counts, so its brief reads `0/0` (`eventBrief`, `src/v2.ts`). It vanished once the cycle
was done, because History builds a done cycle's runs through `workflowLens` (`public/app-logic.mjs`),
which keeps only `kind === "test"` events.

The active line's run list, `linkedRunsFor` (`public/app.js`), keeps every event of the cycle whose
`kind` is not `lifecycle`, so milestones and compile results become chips through `OpenSpan` →
`InlineRunEntry`. Every `pre-merge-gate` since CR-CRU-188 has drawn one while its cycle was active. The
same list feeds the Runs tab's collapsed cue on a done cycle's marker (`accordion-collapsed-cue`,
`▸ N runs`), which counts them as runs.

The same defect shows on the Project pane card's status line (`ProjectStatusLine`,
`data-testid="project-status-line"`, its text from `projectRollupLabel`): after a `cr-close` it reads
**"✓ green · 0/0 · just now"**. It formats `project.lastEvent`, which the projects read (`src/v2.ts`) takes
from `store.newestEvent` — a merge of the events table (registrations included), milestones and gates. So
the line reads `0/0` after a `cr-close` (the `cr-merged` milestone), after a fresh agent registers or
unregisters, after a gate's milestone, and after a compile result — against PRD §4.1, which already
rules that a `lifecycle` event "contributes nothing to rollups". Its colour is `app-ratio-fail` only when
`failed > 0`, so a compile result with errors (`failed: 0`) would read green. `newestEvent` also decides
the project's activity (`lastActivity`), which must keep counting every event.

An aborted run is stored as `kind: "test"` with no counts (`abortRun`, `src/store.ts`), so it too reads
`0/0` — on the status line and as an active-line chip.

## Design (user rulings, 2026-10-28)

- **A run is a test run, as History already rules.** `linkedRunsFor` keeps only the cycle's
  `kind === "test"` events (`workflowLens`'s rule). Milestones, gates, registrations and compile results
  are never chips. An active cycle whose only linked events are non-runs therefore draws no open span (it
  drew a `0/0` chip before); a running run beside a milestone shows only its running entry.
- **The collapsed cue counts test runs.** On a done cycle's marker in the Runs tab, `▸ N runs` counts the
  cycle's test runs. The collapse keeps hiding the cycle's test and compile cards as today — accepted:
  the cue counts runs, and the Runs feed is not changed.
- **An aborted run reads as aborted.** Its active-line chip reads `<agent> aborted` instead of a ratio.
- **The project's `lastEvent` is its newest test run or compile result** — the newest events row whose
  `kind` is not `lifecycle` (milestones and gates live in their own tables). It comes from one bounded
  read beside `newestEvent` (e.g. `Store.newestRun(projectKey)`: `ORDER BY timestamp DESC, rowid DESC
  LIMIT 1`, same scope — not archived, not retired), touching no suite, case or detail row. `newestEvent`
  stays as it is for `lastActivity`.
- **The status line words each kind as itself**, with its age:
  - a test run as today — `✓ green · P/T`, or `✗ F failed of T` (`app-ratio-fail`);
  - an aborted run — `⊘ aborted` (neither pass nor fail colour);
  - a compile result — `✓ compiled` (`app-ratio-pass`) with no errors, `✗ N errors` / `✗ 1 error`
    (`app-ratio-fail`) otherwise;
  - neither — "no runs yet".
  `projectRollupLabel` discriminates on `kind`; a brief with no `kind` keeps today's wording.
- **Docs.** PRD §4.2's "last event" reads "last run — the newest test run or compile result";
  `src/hints.ts`'s projects line follows. No storyboard frame depicts the compile or aborted wording.

## Steps

### §S1 — the board's last run is the newest test run or compile result

The bounded `newestRun` read and the projects read's `lastEvent`; `newestEvent` kept for activity; PRD
§4.2 and `src/hints.ts` follow (AC5).

### §S2 — the status line words each kind as itself

`projectRollupLabel` and `ProjectStatusLine`'s colour, and the formatter's types (AC3, AC4's status line,
AC6).

### §S3 — the active line and the cue count only test runs

`linkedRunsFor` keeps test runs; an aborted chip reads `aborted` (AC1, AC2, AC4's chip).

## Acceptance criteria

The UI criteria are proved by BDD Playwright scenarios in the e2e suite (`tests/e2e/features/`, steps in
`tests/e2e/steps/`), not by a visual check (user ruling 2026-10-28). The project declares them under
`test:e2e`, which is outside the pre-merge gate (DN open question 5), so this CR's cycles and its VERIFY
run them through the bun client's `e2e` verb, ingested under the `e2e` tier.

- [x] **AC1 (e2e)** Scenario: an active cycle holding a passing 5/5 test run, a `pre-merge-gate`
  milestone and a compile result (the harness's `ingestCompile` gains an optional `context`, additively)
  — the `open-span` holds exactly one `linked-run-row`, whose `data-run-id` is the test run's and which
  reads `5/5`; no row carries the milestone's or the compile's id. A second scenario: an active cycle
  holding only a milestone shows no `open-span`.
- [x] **AC2 (e2e)** Scenario: once that cycle is done, collapsing its declared marker on the Runs tab
  reads `▸ 1 runs` (reusing the cycle-run-navigation steps).
- [x] **AC3 (e2e)** Scenario, on the Project pane card's status line: after a `cr-merged` milestone and a
  fresh agent's registration, it reads `✓ green · 5/5 · just now`; after a rustc compile result with one
  error, `✗ 1 error · just now` with `app-ratio-fail`; after a warnings-only compile result,
  `✓ compiled · just now` with `app-ratio-pass`.
- [x] **AC4 (e2e)** Scenario: an aborted run on an active cycle reads `aborted` on its chip, and the
  status line reads `⊘ aborted`.
- [x] **AC5** The projects read reports, as `lastEvent`, the newest test run or compile result — never a
  milestone, gate or registration — and `null` for a project holding neither; same scope as today (an
  archived project's `lastEvent` stays `null` in the archived listing); the read is bounded (rows read do
  not grow with history) and touches no suite, case or detail row; `lastActivity` still counts every
  event (bun, against the board).
- [x] **AC6** `projectRollupLabel` words a compile brief `errors: 0, warnings: 3` as `✓ compiled · <age>`,
  `errors: 1` as `✗ 1 error · <age>`, `errors: 3` as `✗ 3 errors · <age>`, an aborted brief as
  `⊘ aborted · <age>`, and a brief with no `kind` as today; `ProjectStatusLine` gives a compile brief with
  errors `app-ratio-fail` and without `app-ratio-pass`, and an aborted brief neither (bun unit, in the
  storyboard-fidelity style). `ProjectRollupLike` in `public/app-logic.d.mts` and `tests/app-logic.d.ts`
  gains optional `kind`, `errors` and `status`.

**Tests re-targeted (sanctioned by this spec):** `event-briefs-stay-byte-identical-with-no-tree-or-raw-keys`
("a project whose newest event is a milestone … answers the milestone's literal brief") pins the newest
test run's brief instead; `projects-list-bounded-reads` takes its oracle's `lastEvent` from the newest
non-`lifecycle` events row and expects `kind: "test"` where it expected `"gate"`.

- *Recorded at merge.* Rulings in the cycles: an aborted run is a valid `lastEvent`, a registration or
  unregistration never; one helper (`projectStatus`) decides the status line's text and tone; "compiled"
  carries no warning count and an error line shows no warnings; one shared predicate (`isTestRun`) serves
  `workflowLens`, `linkedRunsFor` and `pairTransitions`; the aborted chip is muted, neither ratio colour.
  Sanctioned re-targets: `67dabc1`. Harness: `ingestCompile` takes an optional `context` (`feff870`).
  The test type mirror (`tests/app-logic.d.ts`) was written through `ctx_edit` after the pi-lens edit hook
  refused it as redefining exports — the mirror the finding required. Deferred: the e2e ingest counts
  Gherkin steps (1404) where Playwright counts tests (121) — the client's playwright decoding, not this
  CR's. Live after a board restart and a page reload.

## Non-goals

- The Runs timeline's cards and what a collapse hides — only the cue's count changes.
- The home page's empty state ("no runs yet" counting milestones as events) — a follow-up.

## Release notes

- The active cycle's line and the Project pane's status line show runs only: a gate's milestone no longer
  appears as a `0/0` run, and a `cr-close` or a registration no longer turns the status line to
  "green · 0/0". The status line words a compile result (`✓ compiled` / `✗ N errors`) and an aborted run
  (`⊘ aborted`) as themselves.
