Feature: CR-CRU-159 C1 a heat-strip click brings its test into view — plain runs
  BDD layer expression of CR-CRU-159 §S1/§S2 (docs/changes/CR-CRU-159-a-heat-strip-click-brings-its-test-into-view.md)
  for THIS CYCLE's scope only (C1 — plain, non-spec runs, Density
  presentation): AC1 (a loaded suite's cell scrolls + blinks its leaf row),
  AC2 (a synthetic cell of a collapsed suite reveals + blinks the suite's own
  row, or its first failing leaf), AC4 (a digest group before the target in a
  >120-entry suite still mounts the target — real-browser half of AC4's own
  "asserted on the rendered DOM and in a real browser"), AC5/AC6 (the blink
  class, and no needless pane move when the target is already visible) and
  AC7 (only the pane's own scroller moves — the run-detail header's position
  and the document's own scroll are unchanged — asserted in BOTH mounts:
  home's RunDetail and the workspace's WorkspaceRunDetail). C2 (AC3, the
  spec-run feature unfold) is the NEXT cycle and is deliberately not
  exercised by anything here.

  Today (RED, measured against the current `HeatCell`/`SynthHeatCell`
  handlers in `public/app.js`), a heat-cell click moves the suite's
  virtualisation window, opens a failure's group and focuses it, but never
  calls `scrollIntoView` and never adds the shared `app-locate-blink` class
  (`locateBlink` in public/app.js) — every scenario below is expected to fail
  for exactly that missing reveal, not for a harness/import defect.

  Scenario: A loaded suite's passing heat cell, below the fold, scrolls its leaf row into the pane's visible area and blinks it — header pinned, document unscrolled
    Given a project named "Heat Reveal Green Project" is registered
    And a Density run is ingested for agent "agent-heat-green" with suite "BigSuite" holding 200 leaves, a passing leaf "leaf-green-target" at position 100 and a failing leaf "leaf-red-target" at position 150
    When I open the run overlay directly at its cold URL
    And I expand the "BigSuite" suite row in the overlay
    And I note the header's position and the document's scroll
    And I click the heat cell titled "BigSuite › leaf-green-target"
    Then the leaf row for "leaf-green-target" is scrolled within the pane-scroll's visible area
    And the leaf row for "leaf-green-target" carries the locate-blink class
    And the run-detail header's position and the document's scroll are unchanged

  Scenario: A loaded suite's failing heat cell, below the fold, scrolls its leaf row into the pane's visible area and blinks it
    Given a project named "Heat Reveal Red Project" is registered
    And a Density run is ingested for agent "agent-heat-red" with suite "BigSuite" holding 200 leaves, a passing leaf "leaf-green-target" at position 100 and a failing leaf "leaf-red-target" at position 150
    When I open the run overlay directly at its cold URL
    And I expand the "BigSuite" suite row in the overlay
    And I click the heat cell titled "BigSuite › leaf-red-target"
    Then the leaf row for "leaf-red-target" is scrolled within the pane-scroll's visible area
    And the leaf row for "leaf-red-target" carries the locate-blink class

  Scenario: A green synthetic cell of a collapsed suite reveals and blinks the suite's own row, now expanded, and the row carries data-suite-key
    Given a project named "Heat Reveal Synth Green Project" is registered
    And a Density run is ingested for agent "agent-heat-synth-green" with a collapsed all-pass suite "SynthGreenSuite" and a collapsed suite "SynthRedSuite" with a failing leaf "synth-red-leaf"
    When I open the run overlay directly at its cold URL
    And I click the passing synthetic heat cell for suite "SynthGreenSuite"
    Then the suite row for "SynthGreenSuite" is expanded and carries the locate-blink class
    And the suite row for "SynthGreenSuite" carries a data-suite-key attribute

  Scenario: A red synthetic cell of a collapsed suite reveals the suite's first failing leaf, scrolled into view, blinking, with its failure box visible
    Given a project named "Heat Reveal Synth Red Project" is registered
    And a Density run is ingested for agent "agent-heat-synth-red" with a collapsed all-pass suite "SynthGreenSuite" and a collapsed suite "SynthRedSuite" with a failing leaf "synth-red-leaf"
    When I open the run overlay directly at its cold URL
    And I click the failing synthetic heat cell for suite "SynthRedSuite"
    Then the leaf row for "synth-red-leaf" is scrolled within the pane-scroll's visible area
    And the leaf row for "synth-red-leaf" carries the locate-blink class
    And a failure box is visible and contains "synth-red-leaf-failure"

  Scenario: A digest group of 70 identical failures before the target in a 271-leaf suite still mounts and reveals the target's row
    Given a project named "Heat Reveal Window Fix Project" is registered
    And a Density run is ingested for agent "agent-heat-window" with suite "WindowFixSuite" holding a 70-leaf digest group before target leaf "window-fix-target", followed by 200 more leaves
    When I open the run overlay directly at its cold URL
    And I expand the "WindowFixSuite" suite row in the overlay
    And I click the heat cell titled "WindowFixSuite › window-fix-target"
    Then the leaf row for "window-fix-target" is mounted in the overlay
    And the leaf row for "window-fix-target" carries the locate-blink class

  Scenario: Clicking a cell whose target is already fully visible blinks it and leaves the pane's scrollTop unchanged
    Given a project named "Heat Reveal Already Visible Project" is registered
    And a Density run is ingested for agent "agent-heat-visible" with a fully-visible 2-leaf suite "SmallSuite" and leaf "small-visible-leaf"
    When I open the run overlay directly at its cold URL
    And I expand the "SmallSuite" suite row in the overlay
    And I note the pane-scroll's scrollTop
    And I click the heat cell titled "SmallSuite › small-visible-leaf"
    Then the leaf row for "small-visible-leaf" carries the locate-blink class
    And the pane-scroll's scrollTop is unchanged from when it was noted

  Scenario: In the workspace mount, a below-the-fold heat-cell reveal scrolls only the pane — the header stays pinned and the document's own scroll is unchanged
    Given a project named "Heat Reveal Workspace Project" is registered
    And a Density run is ingested for agent "agent-heat-workspace" with suite "BigSuite" holding 200 leaves, a passing leaf "leaf-green-target" at position 100 and a failing leaf "leaf-red-target" at position 150
    When I open the run overlay directly at its cold URL under the workspace
    And I expand the "BigSuite" suite row in the overlay
    And I note the header's position and the document's scroll
    And I click the heat cell titled "BigSuite › leaf-green-target"
    Then the leaf row for "leaf-green-target" is scrolled within the pane-scroll's visible area
    And the leaf row for "leaf-green-target" carries the locate-blink class
    And the run-detail header's position and the document's scroll are unchanged
