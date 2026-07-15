Feature: CR-CRU-016 drill-in — run detail inside the Run Timeline pane
  BDD layer expression of CR-CRU-016 §S1 (docs/changes/CR-CRU-016-inpane-drill-in.md
  AC "BDD E2E: a drill-in.feature scenario set covering open-from-card,
  back-restores-scroll, cold-load, and project-pane-stays-visible"). The
  slide-over container, its scrim, and `app-slideover-right` are retired for
  run detail — the detail is a pane state of the active central pane while
  the Project pane stays mounted, visible, and live beside it. These
  scenarios exercise the already-implemented in-pane container (C1-C3) and
  are expected to PASS — that is the point.

  Scenario: Clicking a run card swaps the workspace Runs pane to the in-pane run detail — feed gone, no scrim, chrome intact
    Given a project named "Open Card Project" is registered
    And a passing 1-test run is ingested for agent "agent-drillin-open" on that project
    When I open the workspace for that project
    And I click the event card for "agent-drillin-open"
    Then the run overlay is visible
    And the workspace Runs pane shows no event cards
    And the workspace header is visible
    And the workspace tabs row is visible
    And there is no run-overlay-scrim element anywhere
    And there is no app-slideover-right element anywhere

  Scenario: The ← timeline chip closes the in-pane run detail and restores the workspace Runs pane's exact scroll position
    # Mirrors shell-storyboard.feature's Escape-restore scenario (CR-CRU-016
    # §S1/AC2) via the OTHER restore path — the `← timeline` back chip,
    # which calls the same closeDetail() as Escape. 8 runs give the feed
    # real scroll runway (see that scenario's note on Playwright
    # actionability auto-scroll); "agent-chip-mid" is seeded 5th of 8 so
    # newest-first ordering lands it mid-feed, already rendered at 240px.
    Given a project named "Chip Restore Project" is registered
    And a passing 1-test run is ingested for agent "agent-chip-0" on that project
    And a passing 1-test run is ingested for agent "agent-chip-1" on that project
    And a passing 1-test run is ingested for agent "agent-chip-2" on that project
    And a passing 1-test run is ingested for agent "agent-chip-3" on that project
    And a passing 1-test run is ingested for agent "agent-chip-mid" on that project
    And a passing 1-test run is ingested for agent "agent-chip-5" on that project
    And a passing 1-test run is ingested for agent "agent-chip-6" on that project
    And a passing 1-test run is ingested for agent "agent-chip-7" on that project
    When I open the workspace for that project
    And I scroll the workspace Runs pane down by 240px
    And I click the event card for "agent-chip-mid" without letting Playwright re-scroll the pane
    Then the run overlay is visible
    When I click the "← timeline" chip
    Then the run overlay and its scrim are gone
    And the URL path is the workspace path with no run-overlay suffix
    And the workspace is visible
    And the workspace Runs pane's scrollTop is 240

  Scenario: Cold-loading the workspace run URL renders the in-pane detail with the Project pane present
    Given a project named "Cold Load Project" is registered with an online agent "agent-drillin-cold" (message "cold load agent")
    And a passing 1-test run is ingested for agent "agent-drillin-cold" on that project
    When I open the run overlay directly at its cold URL under the workspace
    Then the run overlay is visible and contains the event id
    And the project pane is visible

  Scenario: With the run detail open, the Project pane stays visible showing the project card and agent rows
    Given a project named "Pane Visible Project" is registered with an online agent "agent-drillin-pane" (message "pane stays visible agent")
    And a passing 1-test run is ingested for agent "agent-drillin-pane" on that project
    When I open the workspace for that project
    And I click the event card for "agent-drillin-pane"
    Then the run overlay is visible
    And the project pane is visible
    And the project pane contains "Pane Visible Project"
    And the project pane's agent sub-row for "agent-drillin-pane" is visible and contains "⌁"
