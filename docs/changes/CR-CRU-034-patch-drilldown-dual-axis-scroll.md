# CR-CRU-034 — Patch: run-detail drill-down inherits CR-029 dual-axis operability

**Status:** COMPLETED (shipped 2026-07-21)
**Type:** patch
**Priority:** P1
**Depends on:** CR-CRU-029 (the regressed bounded dual-axis pane model), CR-CRU-007 (§S4 item 4 — the virtualized inner `tree-scroll` + its 60vh cap), CR-CRU-016 (§S2 footer-jump focus-model + the pane scroll-restore contract), CR-CRU-023 (§S1 pane horizontal-scroll floor)
**Labels:** patch, ui, responsive, a11y, regression
**Phase:** Wave 4 (0.1.0)
**Design reference:** CR-CRU-029 §S1 (the bounded, non-scrolling `.app-center` that
delegates BOTH axes to its `.app-pane-content` scroller — its chosen mechanism (a): the pane
owns both axes) + CR-CRU-007 §S4 item 4 (the virtualized per-suite `tree-scroll` this patch
re-sources) + user bug report 2026-07-21 (`crucible_drilldown.jpg`): a run detail with ≥2
failures traps the vertical scroll in a 60vh inner box, strands the failures-footer, and
leaves dead space below.

## Context

CR-CRU-029 §S1 fixed the narrow-viewport horizontal scroll by making each central pane a
**height-bounded, non-scrolling flex column** (`.app-center { display:flex; overflow:hidden }`)
that delegates both scroll axes to its `.app-pane-content` child (`flex:1 1 auto; min-height:0;
overflow-x:auto; overflow-y:auto`). That child (`[data-testid="pane-scroll"]`) now stretches to
fill the full bounded viewport height and is meant to own the vertical scroll.

The **run-detail drill-down body** was not carried onto that model. It still renders each suite's
leaves inside a pre-existing per-suite inner scroller `.app-tree-scroll { max-height: 60vh }`
(CR-CRU-007 §S4 item 4 virtualization). The two scroll models now conflict:

- **Cramped inner scroll.** Multiple tall failure boxes scroll inside the 60vh inner box while the
  outer `pane-scroll` never scrolls (its content is shorter than its stretched height). Measured on
  the live dog-food (`evt-1784604346437-44`, 2 failures): `.app-tree-scroll` `clientH 730` (=0.6·vh),
  `scrollH 1030`, scrolls 300 internally; `pane-scroll` `clientH 1084 == scrollH 1084` → `scrolls: 0`.
- **Dead space.** Because the inner box self-caps at 60vh, `pane-scroll` (flex-filled to the viewport)
  is taller than its content — ~290px of empty region renders below the failures-footer.
- **Hidden at the bottom.** On a viewport where `chrome + 60vh + footer > 100vh`, the footer and
  trailing failure content are pushed below the fold with no outer scroll to recover them — the
  vertical scroll "does not operate."
- **Footer/raw misbehave.** "▸ N more failures" runs `scrollIntoView` inside the cramped inner box,
  and "toggle raw output" appends into the dead-space flex layout.

Before CR-029, `.app-center` was itself the vertical scroller (`overflow-y:auto`), so a tall run
detail flowed at natural height and the outer scroll always rescued it. CR-029's e2e covered the
**feed** panes (which carry the CR-016 runway), not the **run-detail-with-multiple-failures**
surface, so this passed 37/37 green. This patch restores CR-029's guarantee — *both vertical and
horizontal scroll operable at all times in a narrow viewport* — for the run-detail drill-down,
**without** regressing the horizontal floor that CR-029 exists to protect.

## Scope

### §S1 — One bounded dual-axis scroller for the run-detail body (retire the 60vh trap)

The run detail's suite/failure body scrolls as **one bounded scroller that fills the pane** and owns
BOTH axes — **`[data-testid="pane-scroll"]` itself is that scroller** (CR-CRU-029 §S1 mechanism (a),
now realised for the drill-down), replacing the nested `.app-tree-scroll { max-height: 60vh }` inner
cap as the suite-leaf scroll surface. Consequences: multiple tall failures — **including several
auto-expanded failing suites** — use the **full pane height** (no cramped inner box); the
failures-footer + raw-output render as the **last content** of that scroller — reachable by scrolling,
never stranded above a fixed cap; **no dead space** below the content.

CR-CRU-007 §S4 item 4 virtualization continues, **re-sourced** off `pane-scroll`: its `scroll`
listener + `scrollTop` read move from the retired per-suite inner box to `pane-scroll`, and each
expanded suite's mounted-row window is computed relative to `pane-scroll`'s scroll position (the
`density.test.ts` §S4 item 4 assertions retarget onto the surviving scroller — RED owns the retarget,
preserving the mounted-rows-< 200-at-10k guarantee). This is the CR's central implementation decision,
settled here per CR-CRU-029 §S1's "mechanism is a gap-analysis decision" pattern.

**Surfaces (verified 2026-07-21):** `public/app.js` — `SuiteLeafList` (`[data-testid="tree-scroll"]`,
`.app-tree-scroll.app-leaf-list`, the `onscroll`→`suiteWindow` virtualization), `FailuresFooter`
(`[data-testid="failures-footer"]`) + `jumpToNextFailure` (`scrollIntoView` on `[data-testid="leaf-row"]`),
`RunDetail`/`RunDetailBody`/`TestBody` (`[data-testid="pane-scroll"]`, `.app-drillin-body`,
`.app-drillin-tree`). `public/styles.css:792-793` (`.app-tree-scroll { max-height: 60vh }`), `:239-243`
(`.app-center { overflow:hidden }`), `:254-257` (`.app-inpane > .app-pane-content { flex:1 1 auto; min-height:0 }`).

### §S2 — CR-029 horizontal contract preserved for the drill-down

The fix MUST keep CR-029's original guarantee **for the run-detail body**: at ≤1024×640 with content
wider than the pane (down to the 660px floor), the horizontal scroll affordance stays within the
viewport at TOP / MIDDLE / BOTTOM vertical scroll positions, and both axes operate at once. Whatever
element becomes the run-detail vertical scroller **owns overflow-x on the same bounded box** — the two
bars pin to one box's edges. The axes are never split across the pane and an inner tree box (that would
re-introduce the CR-029 bug *inside* the drill-down).

## Acceptance criteria

### §S1
- [ ] **Single scroller.** Opening a run detail with ≥2 failing leaves whose expanded boxes exceed the
  pane height renders NO suite-leaf scroll box capped at `max-height:60vh`; the run-detail body's
  vertical overflow is owned by one bounded scroller filling the pane. (Assert: no descendant of the
  run detail has computed `max-height` ≈ `60vh` with an independent `scrollTop` for the suite leaves;
  the owning scroller's `clientHeight` ≈ the pane content height.)
- [ ] **No dead space.** When content is taller than the pane the scroller's `scrollHeight` ≈ content
  height (footer inclusive) and scrolling reaches the footer; when content is shorter the footer sits
  at the natural content end with no empty region below it greater than the pane's padding. (Assert:
  no gap > pane padding between the footer's bottom and the last rendered content / pane bottom.)
- [ ] **Vertical scroll operable.** At 1024×640 with ≥2 tall failures, the run-detail body scrolls
  vertically to reveal the LAST failure and the footer (footer reachable/visible after scroll); the
  vertical scrollbar affordance is within the viewport.
- [ ] **Multi-suite.** A run with ≥2 **failing suites** (each auto-expanded per CR-CRU-007 §S4 item 1)
  scrolls as the SAME single bounded scroller — no per-suite 60vh box stacks; the last suite's last
  failure and the footer are reachable by one vertical scroll.
- [ ] **Footer jump.** "▸ N more failures" advances to + focus-opens the next failing leaf's box and
  scrolls that row into the SAME bounded scroller's viewport (CR-CRU-016 §S2 footer-jump focus-model,
  now on the unified scroller).
- [ ] **Raw toggle.** "toggle raw output" reveals/hides the raw `pre` within the same scroller with no
  layout jump into dead space; a subsequent footer jump still advances correctly.

### §S2
- [ ] **Horizontal affordance at any vertical position.** At ≤1024×640 with over-wide content, the
  horizontal scroll affordance's bounding box stays within the viewport at TOP, MIDDLE, and BOTTOM
  vertical scroll of the run detail (mirrors CR-CRU-029 §S1's AC, now on the drill-down body).
- [ ] **Both axes at once.** Driving a horizontal scroll after a vertical scroll (and vice-versa) both
  operate; neither bar leaves the viewport.
- [ ] **No regressions.** CR-CRU-023 §S1 pane-floor pins (660px child min-width, testids intact),
  CR-CRU-007 §S4 item 4 virtualization pins (`density.test.ts` §S4 item 4 — mounted rows < 200 at
  10k leaves, window keyed off the surviving scroller's `scrollTop`), CR-CRU-029 §S1/§S2 feed-pane
  pins + CR-CRU-016 scroll-restore all stay green.

## Estimated size

S — a focused scroll-model change in the run-detail body (retire the inner 60vh cap; the bounded pane
owns both axes; re-source virtualization) + one e2e feature (min viewport, ≥2 failures) + retarget of
any assertion scoped to the retired 60vh inner scroll.

## Risk / open questions

- The inner `.app-tree-scroll` currently owns overflow for CR-CRU-007 §S4 item 4 virtualization (its
  `onscroll` drives `suiteWindow`; `public/app.js` `SuiteLeafList`). Moving scroll ownership to the
  bounded pane must keep the virtualization window's `scrollTop` source consistent — point the window
  math at `pane-scroll` and offset each expanded suite. Mitigation: keep exactly ONE scroller for the
  run-detail body and source virtualization from it.
- The retarget is contained: `[data-testid="tree-scroll"]` has exactly ONE production render
  (`public/app.js:3192`) and THREE test assertions (`tests/density.test.ts:11,52,723`, the §S4 item 4
  virtualization scenario); **no e2e step references it**. RED owns the density.test retarget onto the
  unified scroller (stash-production → RED-retarget → restore → GREEN when a contract line moves),
  preserving every §S4 item 4 guarantee.

## Non-goals

- No change to the six feed panes' runway model (CR-CRU-029 §S1) or the right rail's own scroller.
- No change to the compile / gate drill-in bodies (they have no inner tree cap).
- No visual redesign of the failure box, failure digest, heat-strip, or status chips.
