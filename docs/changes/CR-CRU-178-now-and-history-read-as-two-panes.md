# CR-CRU-178 — Now and History read as two panes

**Type** fix (patch CR, after CR-CRU-177) · **Points** 2 (confirmed at gap analysis 2026-10-09) ·
**Wave** 7 (0.3.0) · **Depends on** CR-CRU-177 · **Status** PENDING — filed 2026-10-09 (user ruling)

## Problem

**Reported 2026-10-09 (user).** The Workflow tab's Now and History (CR-CRU-172 §S1, F22) read as one
continuous page with two small section titles; "panes" was the design, and nothing marks where one
ends and the other begins. A visual change to a shipped 0.3.0 feature, filed as a patch CR.

## Design (approved — implement to it)

Storyboard **F24** ("Now and History are two panes you can tell apart at a glance"), **option B,
APPROVED 2026-10-09**: one card holding both; Now on a raised band at the top (`--bg-2`) under its own
header bar (live dot · `NOW` · "what is running"); a hatched divider between them; History beneath
under its own header bar (clock glyph · `HISTORY` · "only what is past"), the bar pinned while
History's list scrolls. The header bars replace today's small `Now` / `History` titles. The frame
wins; agents raise disagreements.

## Steps

### §S1 — the split card

The Workflow tab's two panes render inside one bordered card per F24·B: Now's band (raised
background) with its header bar, the hatched divider, History's header bar and list. Behaviour is
unchanged (CR-CRU-176): Now grows with its content and never scrolls; History keeps its own scroll and
160 px floor; the Workflow pane scrolls as a whole when Now is taller. History's header bar stays in
view while its list scrolls (it sits outside History's scroll box, as today's title does).

**Settled at gap analysis (user rulings 2026-10-09):**
- **The live dot is lit only while something runs** — green and glowing when Now holds an open plan
  or a running gate (`runningGate`), dim grey when Now reads `Nothing running → Roadmap`.
- **On a phone the sub-tab rows are the titles**: no header bar and no divider; the selected pane
  shows in the card's styling (Now on the raised band).
- **The header bars keep today's title testids** (`workflow-now-title` / `workflow-history-title`)
  on the NAME element, whose text stays exactly `Now` / `History` (shown uppercase by style); the
  bar's one-line description is a sibling (`workflow-now-subtitle` / `workflow-history-subtitle`), so
  the existing title pins hold unchanged.

## Acceptance criteria

- [ ] At 1280×800 the Workflow tab shows one card whose Now band has a different background from
      History's area, a visible divider between them, and a header bar on each (`NOW` with the dot,
      `HISTORY` with the clock glyph, each with its line of text); the dot is lit while an open plan or
      a running gate is in Now and dim when nothing runs; History's header bar stays visible while its
      list scrolls; Now's text (e.g. `Nothing running → Roadmap`) is unchanged — asserted in a real
      browser by computed style and geometry, and the dot's two states on the page.
- [ ] At 390×844 the sub-tabs are the titles: no header bar, no divider; the selected pane shows in
      the card styling — asserted in a real browser.
- [ ] CR-CRU-176's layout rules hold (Now never scrolls, History ≥160 px with its own scroll, the pane
      scrolls as a whole) and the phone sub-tabs work as before — asserted by the existing scenarios.

## Gap analysis (2026-10-09)

**Baseline:** develop `d4f6eda` = CR-CRU-177's gated tree (bun 3320/0, python 2341/0; e2e 1147/0 at
its VERIFY). **Code:** `WorkflowPaneTitle(name)` (public/app.js) renders the `workflow-<name>-title`
divs above each box, off the phone band; the panes are `.app-workflow-panes` (styles.css, CR-CRU-172 /
176 rules). **Tests reading the titles:** tests/workflow-now-pane.test.ts (title text, placement
outside the boxes, counts), tests/workflow-history-release-tree.test.ts:944–945 (exact `Now` /
`History`), tests/e2e/steps/workflow-two-panes.steps.ts (no titles on the phone). With the name
element keeping its testid and text, none of them needs a re-pin; if one does, the agent stops and
asks. **Bounded surface:** the header bar is one line (name + a short description); the description
truncates at narrow widths, never wraps the bar. **Cost:** a style and markup change on one card plus
the dot's state — 2 holds.

### Cycles

1. Now and History read as two panes (§S1, AC1–AC3)
2. verify
