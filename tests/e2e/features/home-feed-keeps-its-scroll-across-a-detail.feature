Feature: The home feed keeps its exact scroll position across a run's detail

  The home timeline draws its run cards and rows through the same rendering
  as a project's Runs tab, so the rows that skip their off-screen work there
  skip it here too. Closing a run's detail opened from home still returns the
  home feed at exactly the scroll position it was left at. Runs are ingested
  through the parsed runs route of the real board.

  Scenario: The ← timeline chip closes a run's detail opened from home and restores the home feed's exact scroll position
    Given a project named "HFS Home Feed Scroll Project" is registered
    And a passing 1-test run is ingested for agent "hfs-agent-0" on that project
    And a passing 1-test run is ingested for agent "hfs-agent-1" on that project
    And a passing 1-test run is ingested for agent "hfs-agent-2" on that project
    And a passing 1-test run is ingested for agent "hfs-agent-3" on that project
    And a passing 1-test run is ingested for agent "hfs-agent-mid" on that project
    And a passing 1-test run is ingested for agent "hfs-agent-5" on that project
    And a passing 1-test run is ingested for agent "hfs-agent-6" on that project
    And a passing 1-test run is ingested for agent "hfs-agent-7" on that project
    And a passing 1-test run is ingested for agent "hfs-agent-8" on that project
    And a passing 1-test run is ingested for agent "hfs-agent-9" on that project
    When I open the home page
    And I scroll the home feed down by 240px
    And I click the event card for "hfs-agent-mid" without letting Playwright re-scroll the pane
    Then the run overlay is visible
    When I click the home detail's "← timeline" back chip
    Then the run overlay and its scrim are gone
    And the home feed's scrollTop is 240
