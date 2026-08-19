Feature: CR-CRU-016 drill-in — run detail inside the Run Timeline pane
  BDD layer expression of CR-CRU-016 §S1 (docs/changes/CR-CRU-016-inpane-drill-in.md
  AC "BDD E2E: a drill-in.feature scenario set covering open-from-card,
  back-restores-scroll, cold-load, and project-pane-stays-visible"). The
  slide-over container, its scrim, and `app-slideover-right` are retired for
  run detail — the detail is a pane state of the active central pane while
  the Project pane stays mounted, visible, and live beside it. These
  scenarios exercise the already-implemented in-pane container (C1-C3) and
  are expected to PASS — that is the point.

  # §S1 tabs-hide + tab-in-header (user decisions 2026-07-16, gate review,
  # RE-TARGETED here per the CR's approved-modification list): while a
  # detail is open, `workspace-tabs` is ABSENT and the back chip's text
  # names the origin tab (`← runs` for the default Runs tab); closing
  # restores the tabs row with the same tab still selected. This first
  # scenario's "open-from-card" step set previously asserted the tabs row
  # stayed VISIBLE during the detail (the CR-007-era assumption) — flipped
  # to ABSENT + chip-text here, with a close+reopen check appended.
  Scenario: Clicking a run card swaps the workspace Runs pane to the in-pane run detail — feed gone, no scrim, chrome intact, tabs hidden, chip names the tab
    Given a project named "Open Card Project" is registered
    And a passing 1-test run is ingested for agent "agent-drillin-open" on that project
    When I open the workspace for that project
    # SANCTIONED RE-TARGET (CR-CRU-021 §S1): the workspace's default active
    # tab is now Workflow, not Runs — select Runs explicitly to view its
    # feed (was: relied on Runs being the cold-load default).
    And I click the "Runs" workspace tab
    And I click the event card for "agent-drillin-open"
    Then the run overlay is visible
    And the workspace Runs pane shows no event cards
    And the workspace header is visible
    And the workspace tabs row is not present
    And the back chip reads "← runs"
    And there is no run-overlay-scrim element anywhere
    And there is no app-slideover-right element anywhere
    When I click the "← runs" chip
    Then the workspace tabs row is visible
    And the "Runs" tab is selected

  Scenario: The ← runs chip closes the in-pane run detail and restores the workspace Runs pane's exact scroll position
    # Mirrors shell-storyboard.feature's Escape-restore scenario (CR-CRU-016
    # §S1/AC2) via the OTHER restore path — the back chip, which calls the
    # same closeDetail() as Escape. 8 runs give the feed real scroll runway
    # (see that scenario's note on Playwright actionability auto-scroll);
    # "agent-chip-mid" is seeded 5th of 8 so newest-first ordering lands it
    # mid-feed, already rendered at 240px.
    # RE-TARGETED (§S1 tabs-hide + tab-in-header, CR's approved-modification
    # list): the chip's text is now tab-keyed (`← runs` on the default Runs
    # tab) instead of the retired constant `← timeline` on the workspace.
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
    # SANCTIONED RE-TARGET (CR-CRU-021 §S1): default active tab is now
    # Workflow — select Runs explicitly before scrolling its pane.
    And I click the "Runs" workspace tab
    And I scroll the workspace Runs pane down by 240px
    And I click the event card for "agent-chip-mid" without letting Playwright re-scroll the pane
    Then the run overlay is visible
    When I click the "← runs" chip
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
    # SANCTIONED RE-TARGET (CR-CRU-021 §S1): default active tab is now
    # Workflow — select Runs explicitly to view its feed.
    And I click the "Runs" workspace tab
    And I click the event card for "agent-drillin-pane"
    Then the run overlay is visible
    And the project pane is visible
    And the project pane contains "Pane Visible Project"
    And the project pane's agent sub-row for "agent-drillin-pane" is visible and contains "⌁"
