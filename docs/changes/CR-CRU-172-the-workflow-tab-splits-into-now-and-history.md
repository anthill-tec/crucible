# CR-CRU-172 — the Workflow tab splits into Now and History

**Type** feature · **Points** 5 (provisional, 2026-10-08; set at gap analysis) · **Wave** 7 (0.3.0) · **Depends on** none ·
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

### §S1 — two panes

The Workflow tab has two panes, **Now** and **History**, each scrolling on its own, so the running
work never scrolls away. On a phone they are two sub-tabs (F22, phone card).

### §S2 — Now shows what is running, and only that

- **A CR is running** (an open plan): its plan and cycles, as the active section shows them today
  (F13).
- **A release's workflow is running** (no wave and no CR active; a gate in flight): the active
  no-mistakes run in **F21's gate view** — *Gate · release X · no-mistakes*, run id, branch, head,
  the step ladder live, and the decisions as each respond lands (user note, 2026-10-07).
- **Nothing running:** the single line `Nothing running → Roadmap` (user ruling 2026-10-07: no
  other text).

### §S3 — the bare gate card is retired

The `GATE · no-mistakes passed · pushed →` card is removed from the Workflow tab. A running gate
is in Now (§S2); a sealed gate belongs to its release in History (CR-CRU-173). Until CR-CRU-173
lands, History is today's wave list, in its own pane.

## Acceptance criteria

- [ ] The Workflow tab renders Now and History as two panes that scroll independently (desktop),
      and as two sub-tabs on a phone, asserted in a real browser.
- [ ] Now shows the open plan's cycles when a CR is running; the in-flight gate in F21's gate view,
      naming its release, when a release's workflow is running; and exactly `Nothing running →
      Roadmap` (the arrow linking to the Roadmap tab) when nothing runs — each asserted on the page
      with fixed fixtures.
- [ ] The bare gate card no longer renders anywhere on the Workflow tab.
