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
  spec-run feature unfold) ADDS its own scenarios at the end of this file,
  appended rather than exercised inline above — the C1 scenarios above are
  unchanged and, per CR-CRU-159 C1 (commits f14138f/9fef70d), now pass.

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

  # ── The spec-run feature unfold ─────────────────────────────────────────
  #
  # Scope: a playwright-bdd run streamed to the board in the scenario shape —
  # a feature is a suite, a scenario its leaf carrying its steps — whose
  # specification view groups its scenarios under feature headings. A loaded
  # scenario's heat cell reveals that scenario's row; a synthetic cell of a
  # suite not yet loaded loads it and reveals its first failing scenario's row
  # when red, else its first scenario's row. A folded feature mounts none of
  # its scenarios, so each reveal first opens the feature holding its target.
  # "Kept Open Feature" in each scenario below is a SEPARATE, already-open
  # feature (a failing feature opens on mount), carried through to its own
  # "is open" assertion so a reveal that re-derives every feature's open
  # state from scratch (dropping every OTHER open feature) is caught too.

  Scenario: A loaded scenario's heat cell, in a feature folded again by hand after it auto-loaded, unfolds that feature and scrolls + blinks its passing scenario's row — the already-open feature stays open
    Given a project named "Heat Reveal Spec Refold Green Project" is registered
    And a spec run is streamed for agent "agent-heat-spec-refold-green" with a failing feature "Kept Open Feature" kept open and a failing feature "Refold Target Feature" holding a passing scenario "spec-refold-green-calm" and a failing scenario "spec-refold-green-breaks" whose step "spec-refold-green-then" breaks
    When I open the run overlay directly at its cold URL
    And I fold the feature "Refold Target Feature"
    And I click the heat cell of the scenario "spec-refold-green-calm"
    Then the scenario row "spec-refold-green-calm" is scrolled within the pane-scroll's visible area
    And the scenario row "spec-refold-green-calm" carries the locate-blink class
    And exactly one row in the overlay carries the locate-blink class
    And the feature "Refold Target Feature" is open
    And the feature "Kept Open Feature" is open

  Scenario: A loaded scenario's heat cell, in a feature folded again by hand after it auto-loaded, unfolds that feature and reveals the failing scenario's row with its failing step's failure box
    Given a project named "Heat Reveal Spec Refold Red Project" is registered
    And a spec run is streamed for agent "agent-heat-spec-refold-red" with a failing feature "Kept Open Feature" kept open and a failing feature "Refold Target Feature" holding a passing scenario "spec-refold-red-calm" and a failing scenario "spec-refold-red-breaks" whose step "spec-refold-red-then" breaks
    When I open the run overlay directly at its cold URL
    And I fold the feature "Refold Target Feature"
    And I click the heat cell of the scenario "spec-refold-red-breaks"
    Then the scenario row "spec-refold-red-breaks" is scrolled within the pane-scroll's visible area
    And the scenario row "spec-refold-red-breaks" carries the locate-blink class
    And exactly one row in the overlay carries the locate-blink class
    And the leaf row for "spec-refold-red-then" has a failure box containing "spec-refold-red-then-failure"
    And the feature "Refold Target Feature" is open
    And the feature "Kept Open Feature" is open

  Scenario: A green synthetic cell of a not-yet-loaded scenario in an all-green feature below the fold unfolds that feature and reveals its first scenario's row
    Given a project named "Heat Reveal Spec Synth Green Project" is registered
    And a spec run is streamed for agent "agent-heat-spec-synth-green" with a failing feature "Kept Open Feature" kept open, 24 folded filler features, and an all-green feature "Deep Green Feature" below the fold holding scenarios "its calm target scenario" and "its second calm scenario"
    When I open the run overlay directly at its cold URL
    And the feature "Deep Green Feature" is folded
    And I click a passing synthetic heat cell of the feature "Deep Green Feature"
    Then the scenario row "its calm target scenario" is scrolled within the pane-scroll's visible area
    And the scenario row "its calm target scenario" carries the locate-blink class
    And the scenario row "its second calm scenario" does not carry the locate-blink class
    And exactly one row in the overlay carries the locate-blink class
    And the feature "Deep Green Feature" is open
    And the feature "Kept Open Feature" is open
