# CR-CRU-172 — the Workflow tab splits into Now and History

**Type** feature · **Points** 13 (re-scored 5 → 8 at gap analysis, 8 → 13 for §S5's migration, both 2026-10-08, user rulings) · **Wave** 7 (0.3.0) · **Depends on** none ·
**Status** PENDING — filed 2026-10-08 (user ruling: 0.3.0, after CR-CRU-171)

## Problem

**Reported 2026-10-07 (user, with a screenshot):** the Workflow tab opens on a bare card —
`GATE · no-mistakes passed · pushed →` — that names no release, no run, no step and no time, and
History below it lists every wave of every release, all expanded, so the running work and the past
share one long scroll. Storyboard **F22** (approved 2026-10-08) is the design; this CR is its first
half: the two panes and what Now shows. The second half — History told by release — is
CR-CRU-173.

## Design (approved — implement to it)

The approved design is storyboard **F22** in `.lavish/crucible-v2-design.html` (frame head
`F22 · Workflow in two panes — Now, and a History of releases…`, APPROVED 2026-10-08), with **F21**
(the gate view Now shows for a running release workflow) and **F13**/**F15d** (today's active section
and the phone row rule) as the frames it builds on. The storyboard is local to this checkout
(gitignored), so every RED, GREEN and VERIFY agent reads it there and matches it: pane layout, the
exact empty-state text `Nothing running → Roadmap`, and the phone sub-tabs. Where this spec and F22
disagree, F22 wins and the disagreement is raised with the orchestrator.

## Steps

### §S0 — a gate on the board says which run it is, and which release

**Gap analysis 2026-10-08 (DRIFT-1, DRIFT-2; user rulings).** No client ever sends the no-mistakes
run id: CR-CRU-162's G5 was wired on the server only (the store lifts `gate.run.id` to the event's
`runId`), but the shared `gate_from_axi` (`clients/_crucible_axi.py`) builds `{intent, outcome,
steps, inFlight?, push?}` and nothing else, so on the real board no gate carries a run id, branch or
head, and no recorded decision ever joins its gate. And an in-flight snapshot carries no release:
`stream_axi_ladder` leaves `version` off for a retention reason (`LIVE_GATE`) that CR-CRU-129
removed.

- `gate_from_axi` adds `run: {id, branch, head}` to EVERY gate it builds — interim and seal — from
  the snapshot's own `run.id`, `run.branch`, `run.head` (each key omitted when the snapshot lacks it,
  never invented). It is the one builder `gate-run` and `gate-respond` (`drive_axi_run`) use, so all
  five clients send it.
- The interim POST carries the `--release` the run was started with, exactly as the seal does
  (`post_gate(..., release)`); the stale retention comments in `stream_axi_ladder` and
  `drive_axi_run` go. A delivered release then retires its interim snapshots with its seal
  (`stampGatesRetired`).

### §S1 — two panes

The Workflow tab has two panes, **Now** (above) and **History** (below), each scrolling on its own,
so the running work never scrolls away; Now takes the height its content needs up to half the pane,
then scrolls. On a phone they are two sub-tabs, Now and History, styled as F15d's toggles (F22, phone
card); Now is selected on entry. On desktop each pane carries its title, `Now` and `History`, above
its own scrolling box, as F22 draws them (user ruling 2026-10-08); on a phone the sub-tab rows are the
titles.

### §S2 — Now shows what is running, and only that

**What "running" means (DRIFT-3).** A CR is running when the project has an open plan. A release's
workflow is running when the project's NEWEST gate event (in the page's events read) is marked
`inFlight` — not when ANY gate is: every interim snapshot of a finished run stays on the board (this
board holds ten from 0.2.0's gate, sealed by a later event), so "any in-flight gate" is true forever
once a gate has run. The same one selector decides CR-CRU-174's landing tab (`landingTab`), which
today uses "any" — fixed here, so Now and the landing never disagree.

- **A CR is running:** its plan and cycles, as the active section shows them today (F13).
- **A release's workflow is running:** the running gate in **F21's gate view** — the header
  `Gate · release <X> · no-mistakes` (the snapshot's `version`; `release` omitted when it has none),
  the line `run <id> · branch <b> · head <h>` (each part omitted when absent), the step ladder as the
  snapshots land, and the run's recorded decisions, read again whenever a newer snapshot of the run
  lands. An in-flight gate has pushed nothing, so it shows no `pushed …` line (today's body prints
  `pushed  →` with nothing in it).
- **Both** (user ruling 2026-10-08): the plan first, then the gate. Nothing running is hidden.
- **Nothing running:** the single line `Nothing running → Roadmap`, where `→ Roadmap` selects the
  Roadmap tab (user ruling 2026-10-07: no other text). It replaces `no open plan — file one via POST
  /api/v2/projects/<key>/plans`.

### §S3 — the bare gate card is retired

The sealed-gate widget (`boundaryGate` → `GateWidget`, the `GATE · no-mistakes passed · pushed →`
card the user reported) no longer renders on the Workflow tab: a running gate is in Now (§S2), a
sealed one belongs to its release in History (CR-CRU-173). This reverses CR-CRU-117 §S1's rule for
this zone (an in-flight gate was never shown; a sealed one was) — F22 is the approved design. Until
CR-CRU-173 lands, History is today's wave list, in its own pane. The run drill-in (F8½) keeps its
gate body; it gains the §S2 run line and drops the empty push line the same way, as it is the same
`gateBodyContent`.

### §S4 — the design documents say so

PRD-crucible-v2 (the "Gate events + Workflow tab" paragraph: "live section … beside the no-mistakes
gate pane; … history lens below") and DN-model-b-language (the "Cycle / plan (live)" row) are
amended to Now / History per F22.

### §S5 — a sealed run leaves no running snapshot behind

**Found in cycle 620 (user ruling 2026-10-08).** On this board Now showed a gate `checks-passed · in
flight` from 0.2.0's run of 2026-09-16. That run's seal carried `version` 0.2.0 and was retired when
0.2.0 shipped (`stampGatesRetired`), and the board's reads leave retired gates out; but its ten
running snapshots carried no release (DRIFT-2), so nothing retired them, and the newest gate the page
sees is a running one. §S0 stops new snapshots being orphaned; this repairs the ones already stored.

A declared store migration (schema v20, the CR-CRU-071 mechanism, with its pre-upgrade backup)
retires every gate that is marked `inFlight`, carries no `version`, and has a LATER gate in the same
project (retired or not) — a snapshot superseded by a later gate is not a run in progress. Idempotent;
nothing is deleted; a snapshot with no later gate (a run genuinely still going) is left alone.

## Acceptance criteria

- [ ] **AC1 — gate identity.** A gate posted by `gate-run` or `gate-respond` carries `gate.run`
      with the snapshot's id, branch and head (interim and seal), and every interim POST carries the
      run's `--release` as `version` — asserted through the shared builder AND per client (each of
      bun, python, mvn, rust, arduino) against a recording board; the server answers that gate's
      `runId`, and a decision recorded for the run is returned with it (`GET /api/v2/events/<id>`).
      A snapshot without `run.branch`/`run.head` posts the gate without those keys.
- [ ] **AC2 — two panes.** The Workflow tab renders Now above History, each scrolling on its own,
      Now no taller than half the pane (desktop, 1280×800, with a plan of many cycles), and on a phone
      (390×844) two sub-tabs where Now is selected on entry and History shows the wave list — asserted
      in a real browser. On desktop the titles `Now` and `History` sit above their boxes, outside
      them (Now's own text stays exactly what AC3 pins).
- [ ] **AC3 — what Now shows**, each on the page with fixed fixtures: an open plan → its cycles; the
      newest gate in flight → F21's gate view naming its release, run id, branch and head, its step
      ladder, its recorded decisions, and no push line; an open plan AND a running gate → both, plan
      first; nothing running → exactly `Nothing running → Roadmap`, and clicking `→ Roadmap` selects
      the Roadmap tab.
- [ ] **AC4 — "running" is the newest gate.** A project whose in-flight snapshots are followed by
      a seal of the same run is NOT running: Now reads `Nothing running → Roadmap` and the project
      lands on the Roadmap (CR-CRU-174's rule); with the seal absent it is running and lands on
      Workflow — asserted on the page with fixed fixtures.
- [ ] **AC5 — the bare card is gone.** With every plan closed and a sealed gate on the board, the
      Workflow tab renders no gate widget and no `gate-pane`; the run drill-in of that gate still
      renders its body, with the run line and the push line — asserted on the page.
- [ ] **AC7 — the orphans are retired.** Opening a v19 store whose project holds in-flight,
      version-less snapshots followed by a later (retired) seal migrates it to v20 with those
      snapshots retired and every other gate untouched (a version-less in-flight snapshot with no
      later gate stays live; a versioned one is untouched); a second open changes nothing; the backup
      is written — asserted on a fixture store. On a plain copy of this board's store, after the
      migration Now reads `Nothing running → Roadmap` and the Crucible project lands on the Roadmap
      when no plan is open — asserted in VERIFY.
- [ ] **AC6 — documents.** PRD-crucible-v2 and DN-model-b-language describe the Workflow tab as Now
      and History per F22 — asserted by reading the amended paragraphs (no "beside the no-mistakes
      gate pane" remains).

## Gap analysis (2026-10-08)

**Baseline** (develop `f8fcaea`, 13:38–13:55, unfiled): bun 3230/1, e2e 93/0 scenarios, python
2315/0. The one bun failure is `tests/plan-scoping.test.ts` "a change delivered via the poll
fallback … refreshes the routed project's plan data" at 5722 ms — a timing flake under full-suite
load: 8/8 three times in isolation, and 0 failures in CR-CRU-174's gate run 25 minutes earlier. Not
this CR's; RED notes whether it recurs.

| # | Dim | Finding | Fix | Blocking |
|---|---|---|---|---|
| DRIFT-1 | 3 | No client sends `gate.run` — CR-CRU-162 G5 is server-only; real gates have no run id, decisions never join, F21's run line has no data | §S0, AC1 (user: fix here) | Yes |
| DRIFT-2 | 3 | Interim snapshots carry no release; the retention reason was removed by CR-CRU-129 | §S0, AC1 (user: stamp interims) | Yes |
| DRIFT-3 | 3 | "Gate in flight" = ANY in-flight snapshot (CR-CRU-174 `landingTab`) is true forever after any gate; this board holds ten sealed-over snapshots | §S2, AC4 — newest gate | Yes |
| DRIFT-4 | 2 | §S3 named a "card"; the code is `boundaryGate`/`GateWidget` showing SEALED gates and excluding in-flight ones (CR-CRU-117) — F22 inverts it | §S3 named, reversal stated | No |
| DRIFT-5 | 2 | An in-flight gate body prints `pushed  →` with nothing pushed | §S2, AC3/AC5 | No |
| DRIFT-6 | 1 | Plan open AND gate running unspecified | §S2 both, plan first (user) | No |
| DRIFT-7 | 1 | PRD + DN-model-b-language still say "beside the gate pane … history below" | §S4, AC6 | No |
| DRIFT-8 | 3 | Bounded surface: Now's height was unstated, so a long plan could push History off screen | §S1 half-pane cap, AC2 | No |
| DRIFT-9 | 7 | Cost: 5 → 8 for DRIFT-1/2/3 and ~20 re-pinned test files | user: 8 | — |

**Dimension 4 (consumed as-is):** `WorkflowActive` (F13 plan view), `gateBodyContent` + `GateDecisions`
(F21), `gateWidgetDecisions` (decision read per gate id — keyed by the NEWEST snapshot's id, so a new
snapshot re-reads), `scopedGateEvents`, `post_gate(..., release)`, the store's `gateRunId` lift and
`withGateDecisions`, `stampGatesRetired`, `selectWorkspaceTab`. Nothing new on the wire; no schema
change. **Dimension 5/6:** `boundaryGate` and `WorkflowPrimary` are removed; their consumers are the
page and these tests only (`tests/workflow-gate-widget.test.ts`, `tests/gate-decision-trail.test.ts`,
`tests/gate-card-in-flight.test.ts`, `tests/workflow-history-gate-decision-summary.test.ts`,
`tests/e2e/steps/pane-mount.ts`, `tests/client/test_a_run_in_flight_streams_its_ladder.py` comments).

### Tests this CR knowingly re-pins (approved in advance; each keeps its meaning)

- **The empty text** `no open plan — file one via POST …` → `Nothing running → Roadmap`:
  `workflow-gate-widget`, `workflow-history-refinements`, `workflow-lens`, `workflow-tab`,
  `wave-single-active`, `bdd-section`, `coverage-click`, `plan-scoping`, `project-landing-pane`,
  `roadmap-first-tab`, `storyboard-fidelity`, `workflow-primary-tab` (`tests/*.test.ts`), and
  `tests/e2e/features/project-landing-pane.feature`, `tests/e2e/steps/workspace-plan-scoping.steps.ts`.
  (`src/hints.ts` and the `tests/client` hits are the CLIENT's own "no open plan" wording — untouched.)
- **The sealed-gate widget is gone, the running gate is in Now** (CR-CRU-117 §S1 reversed by F22):
  `tests/workflow-gate-widget.test.ts`, `tests/gate-decision-trail.test.ts` (its Workflow-pane half;
  the drill-in half stands), `tests/workflow-tab.test.ts`, `tests/e2e/steps/gates.steps.ts` +
  `workflow-gates.feature` AC150 ("a populated Workflow-tab gate pane").
- **The interim snapshot is release-stamped:** `tests/client/test_a_run_in_flight_streams_its_ladder.py`
  `test_the_interim_gate_carries_no_version_key` flips to "carries the run's release". The server
  round-trip tests that POST an interim without `version` (`gate-in-flight-round-trip`,
  `workflow-lens` L1254) test what the server does with what it is sent and stand unchanged.
- **The push line:** any drill-in test pinning `pushed  →` on an in-flight gate.

**Inverse blast radius:** no CR-shaped literal is added under `src/`, `public/` or `clients/` (pins
830 / 514 / 884); GREEN re-records no citation head unless a pin moves, and then once, at the end of
the cycle that moved it.

### Cycles

1. a gate on the board says which run it is, and which release (§S0, AC1)
2. Now shows what is running, and nothing else (§S2, §S3, AC3–AC5)
3. the Workflow tab is two panes, and two sub-tabs on a phone, and the design documents say so (§S1, §S4, AC2, AC6)
4. verify
5. a sealed run leaves no running snapshot behind, and each pane carries its title (§S5, §S1 titles, AC7, AC2) — added after cycle 620, run before verify
