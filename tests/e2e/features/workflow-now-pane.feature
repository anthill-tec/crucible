Feature: the Workflow tab's Now pane shows exactly what is running, and nothing else
  BDD layer expression of CR-CRU-172 §S2/AC3: an open plan shows its cycles
  (today's F13 active section); the project's NEWEST gate event, while still
  in flight, shows F21's gate view naming its release and run id; with
  nothing running at all, Now reads the single line
  "Nothing running → Roadmap", whose link selects the Roadmap tab. Driven
  against the REAL served SPA + REAL server, house style (Gherkin +
  playwright-bdd, not a bespoke .e2e.ts file).

  Reuses seeding.steps.ts's project step, navigation.steps.ts's "I open the
  workspace for that project", drillin.steps.ts's "the {string} tab is
  selected", project-landing-pane.steps.ts's roadmap/workflow pane
  visibility steps, and workflow.steps.ts's plan-filing / cycle-transition /
  tab-click steps wherever they already say exactly what's needed; only the
  in-flight-gate posting step, the gate-view content assertion, the
  "Nothing running" text assertion and its link click are new here.

  This file's POSITION governs nothing: shell-storyboard.feature's F1 states
  its empty-DB precondition with its own `@empty-db` tag, in the
  `chromium-empty-db` project every other project depends on (see
  playwright.config.ts's ordering comment).
  Every project/cr name below is namespaced "NOWE2E " / "CR-NOWE2E-…" to
  stay clear of the other features sharing that instance. Results are
  ingested with tier "e2e" by the orchestrator's ingest step, not by this
  suite.

  Scenario: a project with nothing running, then an open plan, then a running release gate — Now shows exactly one of the three, and only that
    Given a project named "NOWE2E Project" is registered
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the Workflow tab reads exactly "Nothing running → Roadmap"
    And the workflow pane is not visible

    When I click the "→ Roadmap" link in the Workflow tab
    Then the "Roadmap" tab is selected

    When a cycle plan is filed for cr "CR-NOWE2E-1" with a cycle labelled "nowe2e cycle"
    And cycle 1 of that plan is activated
    And I open the workspace for that project
    Then the "Workflow" tab is selected
    And the workflow pane is visible
    And the roadmap pane is not visible

    When cycle 1 of that plan is marked done
    And the plan is closed with merge commit "nowe2e01"
    And an in-flight no-mistakes gate is ingested via the API for release "9.9.9" with run id "run-nowe2e-1"
    And I open the workspace for that project
    Then the "Workflow" tab is selected
    And the workflow pane is not visible
    And the Workflow tab's gate view names release "9.9.9" and run "run-nowe2e-1"
