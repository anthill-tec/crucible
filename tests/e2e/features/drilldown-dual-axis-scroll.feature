Feature: CR-CRU-034 §S1+§S2 — the run-detail drill-down inherits CR-029's dual-axis operability
  BDD layer expression of CR-CRU-034's acceptance criteria
  (docs/changes/CR-CRU-034-patch-drilldown-dual-axis-scroll.md): CR-CRU-029
  §S1 made every central pane a height-bounded, non-scrolling flex column
  that delegates BOTH scroll axes to its `[data-testid="pane-scroll"]`
  child — but that e2e suite only exercised the six FEED panes, never a run
  detail with multiple failures. The run-detail body still nests each
  suite's failing leaves inside a PRE-EXISTING per-suite inner scroller
  (`.app-tree-scroll { max-height: 60vh }`, CR-CRU-007 §S4 item 4
  virtualization), which traps the vertical scroll, strands the
  failures-footer, and leaves dead space below it (user bug report
  2026-07-21, `crucible_drilldown.jpg`).

  §S1 wants the run-detail body to retire that 60vh inner cap entirely and
  let `pane-scroll` itself own BOTH axes for the run-detail body too — the
  suite-leaf virtualization (CR-CRU-007 §S4 item 4) re-sources onto
  `pane-scroll`'s own scroll position instead. §S2 wants the CR-CRU-029
  horizontal-scroll-affordance guarantee preserved for this same body.

  Sorts alphabetically right after drill-in.feature ("drill-in" <
  "drilldown" — the hyphen sorts before any letter) and therefore, like
  drill-in.feature and cycle-run-navigation.feature, BEFORE
  shell-storyboard.feature's F1 "truly empty DB" precondition — so this
  feature is pinned to its own `chromium-drilldown-dual-axis-scroll`
  Playwright project (see playwright.config.ts), which `dependencies` on
  the default `chromium` project the same way the other two do. Every
  project/agent name below is namespaced "DDA …" to stay clear of other
  features sharing the webServer/DB instance. Results are ingested with
  tier "e2e" by the orchestrator's ingest step, not by this suite.

  Fixture note: every failing leaf below carries a long (60-line) trace so
  its rendered failure-box is reliably taller than the 60vh cap (384px at
  this suite's fixed 640px viewport height) regardless of exact
  chrome/header pixel budgets.

  Scenario: §S1 a run detail with ONE suite holding several tall failing leaves scrolls as a single bounded scroller — no inner 60vh trap, no dead space, footer and last failure reachable, jump and raw toggle keep working
    Given the viewport is 1024x640
    And a project named "DDA Single Suite Project" is registered
    And a failing run with 3 tall failing leaves in one suite is ingested for agent "dda-single-suite"
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    And I click the event card for "dda-single-suite"
    Then the run overlay is visible
    And no suite-leaf scroll box in the run detail acts as an independent ~60vh scroller
    And there is no dead space below the failures footer within the pane-scroll element
    When I scroll the pane-scroll element to its maximum
    Then the last failing leaf's row is fully within the pane-scroll element's visible box
    And the failures footer is fully within the pane-scroll element's visible box
    When I click the failure-jump chip
    Then the focused failing leaf's failure box is fully within the pane-scroll element's visible box
    When I click the raw-toggle chip
    Then there is no dead space below the failures footer within the pane-scroll element
    When I click the failure-jump chip
    Then clicking the failure-jump chip again advances to a different failing leaf

  Scenario: §S1 Multi-suite — a run detail with 3 auto-expanded failing suites scrolls as the SAME single bounded scroller, no per-suite 60vh box stacks
    Given the viewport is 1024x640
    And a project named "DDA Multi Suite Project" is registered
    And a failing run with 3 failing suites, each with a tall failure, is ingested for agent "dda-multi-suite"
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    And I click the event card for "dda-multi-suite"
    Then the run overlay is visible
    And each of the 3 failing suites in the run detail is auto-expanded
    And no suite-leaf scroll box in the run detail acts as an independent ~60vh scroller
    When I scroll the pane-scroll element to its maximum
    Then the failures footer is fully within the pane-scroll element's visible box

  # §S2 — CR-CRU-029's own horizontal-affordance contract, now exercised
  # against the run-detail body specifically (its own e2e never covered
  # this surface). 800×640 mirrors CR-023/CR-029's own established
  # floor-forcing viewport (`.app-pane-content > * { min-width: 660px }`
  # overflows below ~687px of available pane width — no long-label trick
  # needed). The pane-scroll.steps.ts steps below are reused UNCHANGED: the
  # run detail renders inside the SAME `workspace-runs` / `pane-scroll`
  # testid pair as the Runs feed (WorkspaceRunDetail in public/app.js).
  Scenario: §S2 the horizontal scroll affordance on the run-detail body stays within the viewport at the top, middle, and bottom of its vertical scroll range, and both axes stay operable at once
    Given the viewport is 800x640
    And a project named "DDA Horizontal Project" is registered
    And a failing run with 3 tall failing leaves in one suite is ingested for agent "dda-horizontal"
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    And I click the event card for "dda-horizontal"
    Then the run overlay is visible
    And the pane-scroll element's bounding box stays within the viewport when the workspace Runs pane is scrolled to the top
    And the pane-scroll element's bounding box stays within the viewport when the workspace Runs pane is scrolled to the middle
    And the pane-scroll element's bounding box stays within the viewport when the workspace Runs pane is scrolled to the bottom
    And driving a horizontal scroll on the pane-scroll element after that still moves its scrollLeft
