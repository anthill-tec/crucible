# CR-CRU-020 — Patch: workflow history view refinements

**Status:** COMPLETED (2026-07-16 — merged to develop 9ce9eba)

**Type:** patch
**Priority:** P2
**Depends on:** CR-CRU-011, CR-CRU-019
**Labels:** patch, ui, workflow, lens
**Phase:** Wave 4 (after 019, before 013)
**Design reference:** user live review 2026-07-16 (five numbered improvements, screenshot: crucible_workflow_history.jpg); board F13 frame

## Context
The CR-011 lens shipped per spec; the user's first live review of real
history data filed five usability refinements. New scope post-merge →
patch CR per the process rule.

## Scope

### §S1 History ordering + grouping refinements
1. **Latest first:** waves order newest-first; CR groups within a wave order
   newest-first (by plan close time, open plans by filing time).
2. **Collapsible CR groups:** a history CR entry renders COLLAPSED by default
   (header row: cr, cycles done/total, merge pill) and toggles its cycle list
   expanded/hidden on click.
3. **Executing CR excluded:** a CR with an OPEN plan renders ONLY in the
   ACTIVE section — the history lens shows exclusively closed (merged) plans;
   a plan's close moves its CR group from Active to History.
4. **Ungrouped listing REMOVED from Workflow (user-corrected at the gate
   review 2026-07-16 — the count-row compromise was a mis-reading of the
   original ask):** the Workflow view renders plan/cycle structure ONLY; no
   ungrouped run listing of any form. Unlinked runs remain fully visible on
   the Runs timeline (the never-hidden rule lives there).

### §S2 Cycle drill-down (history + active parity)
Cycle rows become interactive everywhere:
1. A history cycle row toggles its `context.cycleId`-linked run entries
   expanded/hidden on click. **Run entries render ONLY inside an expanded
   cycle's drill-down — NEVER at the CR-group level or anywhere else in the
   Workflow view (user defect report at the gate review: group-level
   GREEN/CLOSE rows rendered under the expanded group without any cycle
   toggle).**
2. A linked run entry drills into the run detail as a pane state of the
   WORKFLOW pane (CR-016 one-rule; back chip `← workflow`), returning to the
   Workflow view with scroll/tab state restored.
3. The ACTIVE section's active cycle rows get the identical toggle +
   drill-down behavior (parity with history).

## Acceptance criteria
- [x] §S1.1: a fixture with waves 3 and 4 (both closed) renders wave 4's group ABOVE wave 3's; within a wave, a CR closed later renders above one closed earlier.
- [x] §S1.2: a history CR group mounts with its cycle rows ABSENT from the DOM; clicking the group header renders them; a second click removes them (toggle asserted twice).
- [x] §S1.3: with plan A open and plan B closed, the history section contains exactly one CR group (B); PATCHing plan A closed moves A's group into history without reload (SSE/poll tick).
- [x] §S1.4 (corrected): the Workflow view contains NO ungrouped listing element and NO run entry outside an expanded cycle drill-down — with 5 unlinked runs present, `workflow-history` renders zero `linked-run-row`/run entries and no `ungrouped` element; the 5 runs remain on the Runs timeline (count asserted there).
- [x] §S2 group-level negative bound (user defect): expanding a CR group (group toggle ONLY, no cycle toggle) renders its cycle rows and ZERO run entries — a closed plan whose cycles have linked runs shows those runs only after the specific cycle's toggle is clicked (the stray GREEN/CLOSE-at-group-level scenario pinned as a regression).
- [x] §S2.1/§S2.2: clicking a history cycle row expands its linked-run entries; clicking a run entry swaps the Workflow pane to that run's detail (`workspace-tabs` absent, back chip `← workflow`); closing restores the Workflow view with the expanded state and scroll intact.
- [x] §S2.3: the ACTIVE section's active cycle supports the same expand toggle and run drill-down (asserted with the same technique as §S2.1/2).

## Estimated size
S.

## Risk
Expanded-state preservation across the CR-016 pane swap — the detail
open/close must not reset lens toggle state (same class of state-keeping the
one-rule already solved for tabs).

## Non-goals
Lens data-model changes; roadmap views (CR-014); milestone/gate rows (CR-013).
