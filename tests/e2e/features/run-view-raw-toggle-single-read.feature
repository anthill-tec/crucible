Feature: The run view's raw toggle shows only when raw output exists, and reads it exactly once

  CR-CRU-167 §S2 — ?depth=suites and ?suite= no longer carry the run's raw
  output (they carry rawBytes, its length, instead); the run view must now
  decide whether to show the raw toggle from rawBytes, and fetch the raw
  text itself with the full read (GET /api/v2/events/<id>, no query) the
  first time the toggle is opened — never on a suite load. A run with NO
  raw output must show no toggle at all, and never issue that full read.

  Scenario: A run with captured raw output shows the toggle and reads it exactly once as suites load around it; a run with no raw output shows neither
    Given a project named "Raw Toggle Network Project" is registered
    And an e2e run with captured raw output across two suites is ingested for agent "agent-raw-toggle-present"
    And I start recording the run's event requests
    When I open the run overlay directly at its cold URL
    Then the run overlay shows a raw toggle
    And no full read of the run has been requested
    When I expand the "RawNet-Suite1" suite row in the overlay
    Then no full read of the run has been requested
    When I click the raw-toggle chip
    Then exactly one full read of the run has been requested
    And the raw toggle reveals the captured raw output text
    When I expand the "RawNet-Suite2" suite row in the overlay
    Then exactly one full read of the run has been requested
    When an e2e run with no raw output is ingested for agent "agent-raw-toggle-absent"
    And I start recording the run's event requests
    And I open the run overlay directly at its cold URL
    Then the run overlay shows no raw toggle
    And no full read of the run has been requested
