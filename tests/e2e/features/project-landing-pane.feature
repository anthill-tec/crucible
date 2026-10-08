Feature: a project with nothing running opens on the Roadmap
  BDD layer expression of the landing-tab rule: opening a project lands on
  the Roadmap tab when it has no open plan and no gate in flight, and on the
  Workflow tab when it has either.

  This file's POSITION governs nothing: shell-storyboard.feature's F1 states
  its empty-DB precondition with its own `@empty-db` tag, in the
  `chromium-empty-db` project every other project depends on (see
  playwright.config.ts's ordering comment).
  Every project/cr name below is namespaced "LAND …" to stay clear of the
  other features sharing the webServer/DB instance. Results are ingested
  with tier "e2e" by the orchestrator's ingest step, not by this suite.

  Scenario: a project with nothing running opens on the Roadmap
    Given a project named "LAND Idle Project" is registered
    When I open the workspace for that project
    Then the "Roadmap" tab is selected
    And the roadmap pane is visible
    And the workflow pane is not visible

  Scenario: a project with an open plan and an active cycle opens on Workflow
    Given a project named "LAND Busy Project" is registered
    And a cycle plan is filed for cr "CR-LAND-E2E-1" with a cycle labelled "e2e busy"
    And cycle 1 of that plan is activated
    When I open the workspace for that project
    Then the "Workflow" tab is selected
    And the workflow pane is visible
    And the roadmap pane is not visible
