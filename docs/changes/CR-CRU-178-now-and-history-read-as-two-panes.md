# CR-CRU-178 — Now and History read as two panes

**Type** fix (patch CR, after CR-CRU-177) · **Points** 2 (provisional, 2026-10-09; set at gap analysis) ·
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
view while its list scrolls. On a phone the sub-tabs remain the toggles (F15d) and the selected pane
shows in the same card styling, without the divider.

## Acceptance criteria

- [ ] At 1280×800 the Workflow tab shows one card whose Now band has a different background from
      History's area, a visible divider between them, and a header bar on each (`NOW` with the live
      dot, `HISTORY` with the clock glyph, each with its line of text); History's header bar stays
      visible while its list scrolls; Now's text (e.g. `Nothing running → Roadmap`) is unchanged —
      asserted in a real browser by computed style and geometry.
- [ ] CR-CRU-176's layout rules hold (Now never scrolls, History ≥160 px with its own scroll, the pane
      scrolls as a whole) and the phone sub-tabs work as before — asserted by the existing scenarios.
