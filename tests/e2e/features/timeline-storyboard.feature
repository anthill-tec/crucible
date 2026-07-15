Feature: CR-CRU-007 timeline — storyboard frames F2-F8
  Frame-mapped E2E (storyboard as contract, PRD §5) extending the CR-CRU-006
  harness: run cards, drill-in, density mode, compile cards, transition
  markers, coverage meter, and workspace nav. Converted from
  tests/e2e/timeline.e2e.ts (see the RED-agent report mapping table for the
  old-test → scenario mapping). Results are ingested with tier "e2e" by the
  orchestrator's ingest step, not by this suite.

  Scenario: F2 registering a project via API lights its projects-row badge live over SSE; active-first ordering holds against an older project
    Given an older project named "F2 Older" is registered with an online agent "agent-f2-older" (message "older project agent")
    When I open the home page
    Then a projects-row badge for "F2 Older" is visible
    When a project named "F2 New" is registered with an online agent "agent-f2-new" (message "new project agent")
    Then a projects-row badge for "F2 New" becomes visible within 2 seconds
    And the "F2 New" badge sorts before the "F2 Older" badge in the projects row

  Scenario: F3 ingesting a failing junit run via the API makes a red run card appear live with tier + codec badges
    Given a project named "F3 Project" is registered
    And I have opened the home page
    When a failing 3-case junit run (1 failing) is ingested for agent "agent-f3" at tier "unit"
    Then an event card for "agent-f3" becomes visible within 2 seconds
    And that card's icon reads "🧪"
    And that card's tier badge reads "unit"
    And that card's codec badge reads "junit"
    And that card's ratio pill contains "1" and "3"

  Scenario: F4 clicking a run card opens the drill-in; the failing test's failure.message is visible after expanding
    Given a project named "F4 Project" is registered
    And a failing 3-case junit run (1 failing) is ingested for agent "agent-f4" at tier "unit"
    When I open the home page
    And I click the event card for "agent-f4"
    Then the run overlay is visible
    When I expand the "Suite1" suite row in the overlay
    Then the overlay shows exactly 3 leaf rows
    When I click the single failing leaf row
    Then the failure box is visible and contains "boom"

  Scenario: F4½ a 60-test run with failures, switched to Density mode, renders the heat-strip
    Given a project named "F4.5 Project" is registered
    And a 60-test junit run with 3 failures is ingested for agent "agent-f4half" at tier "unit"
    When I open the run overlay directly at its cold URL
    Then the overlay has no heat-strip
    And the drill-in mode switch is visible with data-mode "Detail"
    When I click the drill-in mode switch
    Then the drill-in mode switch has data-mode "Density"
    And the heat-strip is visible with exactly 60 heat cells
    When I click the first failing heat cell
    Then a failure box is visible and contains "boom-60"

  Scenario: F5 a compile ingest renders a 🛠 card with diagnostics preview and never the string "0/"
    Given a project named "F5 Project" is registered
    And I have opened the home page
    When a rustc compile error report is ingested for agent "agent-f5"
    Then an event card for "agent-f5" becomes visible within 2 seconds
    And that card's icon reads "🛠"
    And that card's ratio pill contains "errors"
    And that card's diagnostics preview is visible and its first diagnostic line contains "src/lib.rs"
    And that card's text never contains "0/"

  Scenario: F6 fail-then-pass for the same agent stem renders the transition marker text matching RED 2/5 ➜ GREEN 5/5
    Given a project named "F6 Project" is registered
    And a fail(2/5) run is ingested for agent "CR-F6-1-RED"
    And a pass(5/5) run is ingested for agent "CR-F6-1-GREEN"
    When I open the home page
    Then the transition marker is visible and matches "RED 2/5 ➜ GREEN 5/5"

  Scenario: F7 a green regression run with coverage updates the workspace Project-pane coverage meter
    Given a project named "F7 Project" is registered with an online agent "agent-f7" (message "regression agent")
    And a green regression run with 50% coverage is ingested for agent "agent-f7"
    When I open the workspace for that project
    Then the project pane contains "50%"
    When a second green regression run with 90% coverage is ingested for agent "agent-f7"
    Then the project pane contains "90%" within 2 seconds
    And the project pane no longer contains "coverage 50%"

  Scenario: F8 clicking a projects-row badge lands on the workspace: no Agents tab, right Project pane with ⌁ agents, ← projects breadcrumb present
    Given a project named "F8 Project" is registered with an online agent "agent-f8" (message "workspace-bound agent")
    When I open the home page
    And I click the projects-row badge for "F8 Project"
    Then the URL path ends with that project's workspace path
    And the workspace header is visible and contains "← projects"
    And no workspace tab is labelled "Agents"
    And the project pane's agent sub-row for "agent-f8" is visible and contains "⌁"
