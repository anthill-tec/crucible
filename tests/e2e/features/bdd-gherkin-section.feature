Feature: the BDD section renders an ingested run's Gherkin
  CR-CRU-015 §S3's Chromium-tier acceptance criterion: "A Chromium-tier test
  drives the tab against a real ingested run and asserts the rendered Gherkin
  — feature title, scenario titles, ordered step text and per-step outcomes —
  at the storyboard compliance bar, not a smoke check."

  This scenario drives the REAL server through the same route a wrapped client
  uses (POST /api/v2/runs with `codec: "playwright"`, so the SERVER's own
  registry codec decodes the report — §S2's ruling) and then asserts the SPA's
  own DOM on the BDD tab. Nothing is stubbed into the page: the Gherkin this
  scenario reads back is the Gherkin the server stored.

  The project is seeded as `frontend` deliberately — `workspaceTabs`
  (public/app-logic.mjs) disables the BDD tab on every other project type, so
  a default-typed fixture could never reach this surface. That gate is asserted
  from the other side in tests/bdd-section.test.ts.

  Scenario: a frontend project's BDD tab shows the feature, its scenarios, their ordered steps and each step's own outcome
    Given a frontend project named "BDD Gherkin Section" is registered
    And an online agent "bdd-section-e2e" with message "gherkin run" is registered on that project
    And a playwright BDD run is ingested for agent "bdd-section-e2e" on that project
    When I open the workspace for that project
    And I click the "BDD" workspace tab
    Then the BDD section shows the feature "Gherkin Rendering Feature"
    And the BDD section shows the scenarios in order "a passing scenario renders every step | a failing scenario stops at the broken step"
    And the steps of "a passing scenario renders every step" read in order "Given the board has a frontend project | When a BDD run is ingested for it | And the run carries its Gherkin steps | Then the BDD section renders them in order"
    And every step of "a passing scenario renders every step" reports outcome "pass"
    And the steps of "a failing scenario stops at the broken step" read in order "Given the board has a frontend project | When the specification breaks"
    And the steps of "a failing scenario stops at the broken step" report outcomes "pass | fail"
    And the step "When the specification breaks" of "a failing scenario stops at the broken step" carries the failure message "expect(received).toBe(expected) — the step never rendered"
    And no other step in the BDD section carries a failure
    And the BDD section shows no run cards and no ratio pills
