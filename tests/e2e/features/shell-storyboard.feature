Feature: CR-CRU-006 shell — storyboard frames
  Storyboard as contract (PRD §5): the Mission Control shell — home page,
  workspace, and nav — driven end to end against a real served SPA and a
  real server instance. Converted from tests/e2e/shell.e2e.ts (see the
  RED-agent report mapping table for the old-test → scenario mapping).

  Scenario: F1 fresh forge — empty state
    Given a fresh, empty Crucible database
    When I open the home page
    Then the health pill is visible and shows a live-green dot
    And the timeline shows the empty-state text "no projects registered — register a project to light the forge"

  Scenario: F2 a registered project lights its projects-row badge on home (zero agent rows by design)
    Given a project named "F2 Project" is registered
    And an online agent "agent-f2" with message "building the widget" is registered on that project
    When I open the home page
    Then a projects-row badge for "F2 Project" is visible and contains "backend"
    And home renders 0 agent rows anywhere

  Scenario: F9 liveness dots render on the workspace Project pane's agent sub-rows
    Given a project named "F9 Project" is registered
    And an online agent "agent-f9" with message "still working" is registered on that project
    When I open the workspace for that project
    Then the project pane is visible
    And the agent sub-row for "agent-f9" is visible with exactly one liveness dot classed g, y, or r
    And any tombstoned agent sub-row shows the "⚰" glyph, "died" text, and opacity 0.45

  Scenario: Layout AC (final form, round 6/7 lock) — home = title bar + projects row + full-width timeline; workspace = full-width tabs row + [content | Project pane], no left rail
    Given a fresh, empty Crucible database
    When I open the home page
    Then there is no ".app-rail" element anywhere on the page
    And the timeline spans more than 90% of the main content width
    When a project named "Layout Project" is registered
    And I open the workspace for that project
    Then the workspace header is visible
    And the workspace tabs row is visible and is not nested inside a rail
    And the tabs row sits directly beneath the workspace header
    And the tabs row spans more than 90% of the workspace width
    And there is no ".app-rail" element anywhere inside the workspace
    And the Project pane sits to the right of the main content column with no left rail

  Scenario: F2b SSE pushes a new project's badge onto the projects-row without reload
    Given I have opened the home page with the health pill visible
    When a project named "F2b Project" is registered
    And an online agent "sse-agent" with message "hot off the stream" is registered on that project
    Then a projects-row badge for "F2b Project" becomes visible within 2 seconds without reloading

  Scenario: nav Esc closes the in-pane run detail and restores the workspace Runs pane's exact scroll position (CR-CRU-016 §S1/AC2 re-target)
    # 8 runs give the feed real scroll runway: with only one card the whole
    # feed sits inside the pane's unscrolled viewport, so scrolling 240px
    # pushes the sole clickable card OUT of view and Playwright's click
    # actionability auto-scrolls the pane back toward 0 before dispatching
    # the click — a false RED unrelated to the production scroll-restore
    # contract. With 8 runs, "agent-esc-mid" (seeded 5th of 8, so newest-
    # first ordering lands it mid-feed) is already rendered — the click
    # below dispatches a native DOM click (not a synthetic Playwright
    # mouse click) so the pane's scrollTop is never touched by the test
    # harness itself, and the detail opens with the pane still genuinely
    # at 240 — the contract this scenario exists to pin.
    Given a project named "Esc Project" is registered
    And a passing 1-test run is ingested for agent "agent-esc-0" on that project
    And a passing 1-test run is ingested for agent "agent-esc-1" on that project
    And a passing 1-test run is ingested for agent "agent-esc-2" on that project
    And a passing 1-test run is ingested for agent "agent-esc-3" on that project
    And a passing 1-test run is ingested for agent "agent-esc-mid" on that project
    And a passing 1-test run is ingested for agent "agent-esc-5" on that project
    And a passing 1-test run is ingested for agent "agent-esc-6" on that project
    And a passing 1-test run is ingested for agent "agent-esc-7" on that project
    When I open the workspace for that project
    # SANCTIONED RE-TARGET (CR-CRU-021 §S1): the workspace's default active
    # tab is now Workflow, not Runs — select Runs explicitly before scrolling
    # its pane (was: relied on Runs being the cold-load default).
    And I click the "Runs" workspace tab
    And I scroll the workspace Runs pane down by 240px
    And I click the event card for "agent-esc-mid" without letting Playwright re-scroll the pane
    Then the run overlay is visible
    When I press Escape
    Then the run overlay and its scrim are gone
    And the URL path is the workspace path with no run-overlay suffix
    And the workspace is visible
    And the workspace Runs pane's scrollTop is 240
