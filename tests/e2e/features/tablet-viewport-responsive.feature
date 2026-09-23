Feature: CR-CRU-018 §S1/§S3 — tablet-band responsive layout
  BDD layer expression of CR-CRU-018's tablet-profile acceptance criteria
  (docs/changes/CR-CRU-018-responsive-mobile.md), governed by
  docs/research/DN-crucible-responsive-model.md. Tablet band: viewport
  width 641-1024px (DN decision 1). Decision 2: tablet keeps the content
  column and stacks the Project pane BENEATH it, full width — the ONE
  layout axis that changes for this band.

  Runs under the dedicated `chromium-tablet` Playwright project (a
  touch-enabled 820x1180 viewport, playwright.config.ts), matched to THIS
  file only via `testMatch`. Carries `grepInvert: /@empty-db/` per the CR's
  ordering note, so shell-storyboard.feature's F1 empty-DB precondition is
  never re-run by this project.

  RED phase — expected to fail against current production: the workspace
  body is a fixed two-column CSS grid at every width
  (`.app-workspace-body { grid-template-columns: minmax(0, 2.6fr)
  minmax(260px, 1fr); }`, public/styles.css) with zero `@media` rules
  anywhere, so the Project pane never stacks beneath the content at any
  viewport and the 660px floor never lifts below 1025px.

  Every project/agent name below is namespaced "TAB …" to stay clear of
  other features sharing the webServer/DB instance. Results are ingested
  with tier "e2e" by the orchestrator's ingest step, not by this suite.

  Scenario: AC1 — no page-level horizontal scroll at the tablet profile, home and workspace alike
    Given a project named "TAB Overflow Project" is registered
    And an online agent "tab-overflow-agent" with message "building" is registered on that project
    When I open the home page
    Then the page body does not scroll horizontally
    And the main content region is visible at a usable width
    When I open the workspace for that project
    Then the page body does not scroll horizontally
    And the main content region is visible at a usable width
    When I click the "Runs" workspace tab
    Then the page body does not scroll horizontally
    And the main content region is visible at a usable width

  Scenario: AC7 — the project band relocates to stack beneath the content column, full width, and never disappears
    Given a project named "TAB Band Project" is registered
    And an online agent "tab-band-agent" with message "building the widget" is registered on that project
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then the project pane is visible
    And the project pane sits BENEATH the main content column, not beside it
    And the project pane spans at least 90% of the workspace width
    And the project pane shows the project name, the live-agent count, and the health dot

  Scenario: AC6 — the 660px pane-content floor is absent on the tablet profile
    Given a project named "TAB Floor Project" is registered
    And 3 filler passing runs are ingested on that project
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then the workspace Runs pane's content child does NOT carry the 660px min-width floor
