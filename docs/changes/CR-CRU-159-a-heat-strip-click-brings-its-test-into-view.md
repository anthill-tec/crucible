# CR-CRU-159 — a heat-strip click brings its test into view

**Type** fix · **Points** 5 (planning game 3; re-set at gap analysis 2026-10-02) · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-09-27, gap analysis 2026-10-02

## Problem

**User defect (2026-09-27, with a screenshot of a 734-test e2e run):** clicking a cell of a run's
heat strip (the clickable state indicator above the tree) expands the corresponding test node, but
in a large run that node opens **outside the viewport**, so nothing visible happens.

**Found 2026-09-27:** the heat-cell handlers (`HeatCell` and `SynthHeatCell` in `RunDetailBody`,
`public/app.js`) move the suite's virtualisation window, open the failure group and set
`focusedLeaf`, but never scroll. The board already has the pattern elsewhere: the cycle ↔ runs
navigation and the roadmap drill-through (`revealDrillTarget`) call `scrollIntoView()` and then
`locateBlink` on their target.

## Gap analysis (2026-10-02)

**Baseline, measured 2026-10-02 14:36–14:37 on develop `6a73a67`:** the heat-strip, drill-in,
storyboard and Project-pane bun suites 90/0 (`density`, `drill-in`, `storyboard-fidelity`,
`project-pane-vitals-velocity-order`); the drill-in, density, scroll and responsive e2e scenarios
39/0 (chromium, chromium-mobile, chromium-tablet). The pre-merge gate does not run e2e, so this CR's
e2e evidence is the agents' own filed runs.

- **G1 — the heat strip exists only in Density.** `TestBody` mounts `HeatStrip` only when the
  presentation is Density (the regression and e2e tiers). The problem statement and F20 card c said
  "Detail and Density"; there is no heat strip in Detail to click. §S1 now says Density. F20 carries
  an amendment note.
- **G2 — a blink on the scrolled-to element is thrown away at once.** The run detail's body is ONE
  derivation (`body` in `detailBodyFor`) that rebuilds `TestBody` whenever `suiteWindow`,
  `suiteLeaves`, `focusedLeaf` or `openFeatures` changes. The scroll itself fires `handlePaneScroll`,
  which moves `suiteWindow` and, in a spec run, loads the scenarios scrolled into view
  (`loadScrolledScenarios`). So the element `locateBlink` marks is replaced within a frame of the
  scroll and the class goes with it. `revealCycleRow` and `revealDrillTarget` blink elements in panes
  that do not rebuild on scroll, which is why the pattern works there. The blink must therefore be
  **state**: a located key rendered as the shared `app-locate-blink` class by the row that carries
  the key, cleared after the same 10 s. (The whole-body rebuild on every scroll is also one of
  CR-CRU-158's hypotheses; this CR does not change it.)
- **G3 — the settled scroll already exists.** `jumpToNextFailure` (the footer's next-failure jump)
  defers its scroll until the render has settled (`scrollFocusedRowIntoView`, a bounded retry on real
  timers). The heat-cell reveal uses the same mechanism rather than a second one; the footer jump's
  behaviour and tests are unchanged.
- **G4 — in Density the window can miss the target.** `HeatCell` sets the suite's virtualisation
  window from the leaf's index in `leaves`, but in Density `SuiteLeafList` windows over the
  `digestFailures` entries, where each group of identical failures is one entry. With a group before
  the target, the entry index is smaller than the leaf index, and in a suite of more than
  `VIRT_WINDOW` (120) entries the target can fall outside the mounted rows, leaving nothing to scroll
  to. The window is set from the target's entry index.
- **G5 — a folded feature mounts nothing.** In a spec run, `SpecFeatures` mounts no scenarios of a
  folded feature, so a cell whose scenario sits in a folded feature has no node at all.
  `SynthHeatCell` loads the suite but never unfolds its feature. This is the screenshot's case: an
  all-green 734-test e2e run whose features, after the first, are folded.
- **G6 — what each cell reveals.** A cell of a loaded suite reveals its leaf row; a red synthetic
  cell reveals the suite's first failing leaf (which it already focuses); a green or pending
  synthetic cell reveals the suite's own row, now expanded. The suite row carries `data-suite-key`
  only in spec runs; every suite row gets it, so the reveal has one handle in both kinds of run.
- **G7 — only the pane's scroller moves.** `scrollIntoView` scrolls every scrollable ancestor, and
  the run detail mounts in two places (`RunDetail` in the home timeline and `WorkspaceRunDetail`).
  The reveal scrolls the `pane-scroll` that contains the clicked cell, and §S2 now has its own AC.
- **G8 — a node taller than the pane** (a long failure trace, an expanded suite) has its top brought
  just below the pinned header, as the footer jump does.
- **Cost.** 5 points, not 3: G2's stateful blink, G4's window fix, G5's feature unfold and an e2e
  fixture with a run large enough to need scrolling (a plain run with a digest group in a suite of
  more than 120 entries, and a spec run with folded features). No new module; no server change.

## Scope

### §S1 — the click reveals the node

In Density (the only presentation with a heat strip, G1), a heat-cell click first does what it does
today (moves the suite's window, opens a failure's group and focuses it, loads a folded suite) and
additionally, in a spec run, unfolds the feature holding the target (G5). It then scrolls the
`pane-scroll` that contains the cell so the target's top sits just below the pinned header, using
the footer jump's settled scroll (G3), and blinks the target for 10 s with the shared
`app-locate-blink` class, held as state so the rebuilds the scroll causes do not drop it (G2).

The target (G6): a loaded suite's cell → its leaf row; a red synthetic cell → the suite's first
failing leaf row; a green or pending synthetic cell → the suite's row, expanded. Every suite row
carries `data-suite-key`. The suite's window is set from the target's entry index in the list it
actually renders, digest groups included (G4). A target already fully visible is blinked and the
pane does not move.

### §S2 — the header stays put

The run-detail header stays pinned (CR-CRU-016 §S1); only the pane's scroller moves.

## Acceptance criteria

- [x] **AC1** — In a real browser, on a plain Density run large enough that the target is below the
      fold, clicking a loaded suite's cell (green, and red) leaves that leaf row inside the
      `pane-scroll`'s visible area, and the row carries `app-locate-blink`.
- [x] **AC2** — The same for a synthetic cell of a collapsed suite: a green cell reveals the suite's
      row, now expanded; a red cell reveals the suite's first failing leaf with its failure box.
- [x] **AC3** — In a spec run, a cell whose scenario sits in a folded feature unfolds that feature and
      reveals the scenario, in a real browser.
- [x] **AC4** — In a suite of more than 120 entries with a digest group before the target, the
      target's row is mounted and revealed (asserted on the rendered DOM and in a real browser).
- [x] **AC5** — The blink is still on the target after the scroll has settled and after any lazy
      loads it caused, and is gone 10 s after the click.
- [x] **AC6** — Clicking a cell whose target is already fully visible blinks it and leaves the
      pane's `scrollTop` unchanged.
- [x] **AC7** — Through every reveal, the run-detail header's position and the document's own scroll
      are unchanged; only the containing `pane-scroll` moves. Asserted in both mounts (home
      timeline and workspace).
- [x] **AC8** — The footer's next-failure jump and every existing heat-strip, drill-in and density
      test pass unchanged.
- [x] **AC9** — The behaviour matches storyboard **F20** (as amended 2026-10-02: Density only),
      checked in a real browser at VERIFY.

## Cycles

C1 plain runs — loaded and synthetic cells, the window fix, the stateful blink, no needless move,
header pinned (AC1, AC2, AC4–AC8): RED + GREEN. C2 spec runs — the feature unfold (AC3): RED + GREEN.
C3 VERIFY (AC9).
