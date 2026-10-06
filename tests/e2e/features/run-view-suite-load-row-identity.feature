Feature: Expanding one suite in a large run does not rebuild the other suites' DOM
  The run view's drill-in body (RunDetailBody, public/app.js) reads the whole
  suiteLeaves map synchronously inside TestBody and HeatStrip. Writing that
  state for ONE suite (loadSuite, reached from a suite-row click, a synthetic
  heat-cell click, or a scroll-triggered fetch — all three write the same
  state) today reruns the entire body derivation and replaces every suite's
  row and heat cell, loaded or not — measured directly on a real run view:
  2-3 of every 6 suite loads replaced the OTHER suites' rows. Every scenario
  below tags each rendered suite-row and heat-cell element with a unique
  marker before triggering one suite's load, then asserts every element
  OUTSIDE that suite still carries its marker — the same DOM node, not a
  rebuilt lookalike — while the loaded suite's own synthetic heat cells are
  explicitly expected to turn into real, per-leaf cells.

  Scenario: Expanding one collapsed suite in a 734+-test run across many suites leaves every other suite row and heat cell untouched
    Given a project named "Suite Load Row Identity Project" is registered
    And an e2e run of at least 734 tests across many suites is ingested for agent "agent-suite-load-row-identity"
    When I open the run overlay directly at its cold URL
    And I tag every suite row and heat cell with a unique identity marker
    And I expand the "Suite-35" suite row in the overlay
    Then every suite row other than "Suite-35" still has its identity marker
    And every heat cell outside the "Suite-35" suite still has its identity marker
    And the "Suite-35" suite's own heat cells have been replaced with real per-leaf cells
