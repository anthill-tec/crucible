Feature: An agent's card follows its streaming run batch by batch, whenever the page first reads the run

  While an agent's run streams, its card in the Project pane reads
  "running <done>/<total> · <current file>" with each batch's figures, from
  the run's opening to its close, and reads the agent's own line again once
  the run closes. As a client does, the agent registers again with a new
  message as its run opens. The card must follow every batch whether the
  run's first batch lands before the page first reads the open run or after
  it, and after the page is reloaded mid-run — without a reload of its own.

  Everything here is the real board: the agent registers through the
  register route, the run opens through the run-start route, its batches go
  to the stream route and it closes through the runs route — no live double.
  The page moves on the board's own throttled frames, so every wait is on
  the page, bounded by a few frame cadences.

  Scenario: The run's first batch lands before the page first reads the open run
    Given a project named "Card Follows Its Run Project" is registered
    And an online agent "card-follower" with message "between runs" is registered on that project
    And agent "card-follower" is the run's streaming agent
    When a run is started for agent "card-follower" on that project
    And an online agent "card-follower" with message "gated test run starting" is registered on that project
    And the run streams batch 1 of its test stream through the stream route
    And I open the workspace for that project
    Then the project pane's agent row for "card-follower" reads "running 2/4 · src/gap.test.ts" within 6 seconds
    And I mark the page so a reload would be detectable
    When the run streams batch 2 of its test stream through the stream route
    Then the project pane's agent row for "card-follower" reads "running 3/4 · src/resend.test.ts" within 6 seconds
    When the run streams batch 3 of its test stream through the stream route
    Then the project pane's agent row for "card-follower" reads "running 4/4 · src/close.test.ts" within 6 seconds
    When the run is closed through POST /api/v2/runs naming the crucible-events codec
    Then the agent row for "card-follower" reads the agent's own line the board serves, unmarked, within 6 seconds
    And the page was never reloaded

  Scenario: The run's first batch lands after the page first reads the open run
    Given a project named "Card Follows Its Run Project" is registered
    And an online agent "card-follower" with message "between runs" is registered on that project
    And agent "card-follower" is the run's streaming agent
    Given I open the workspace for that project
    And the agent row for "card-follower" reads the agent's own line the board serves, unmarked, within 6 seconds
    And I mark the page so a reload would be detectable
    When a run is started for agent "card-follower" on that project
    And an online agent "card-follower" with message "gated test run starting" is registered on that project
    Then the agent row for "card-follower" shows the agent streaming and reads "gated test run starting" within 6 seconds
    When the run streams batch 1 of its test stream through the stream route
    Then the project pane's agent row for "card-follower" reads "running 2/4 · src/gap.test.ts" within 6 seconds
    When the run streams batch 2 of its test stream through the stream route
    Then the project pane's agent row for "card-follower" reads "running 3/4 · src/resend.test.ts" within 6 seconds
    When the run streams batch 3 of its test stream through the stream route
    Then the project pane's agent row for "card-follower" reads "running 4/4 · src/close.test.ts" within 6 seconds
    When the run is closed through POST /api/v2/runs naming the crucible-events codec
    Then the agent row for "card-follower" reads the agent's own line the board serves, unmarked, within 6 seconds
    And the page was never reloaded

  Scenario: The page is reloaded mid-run and the card follows the rest of the run
    Given a project named "Card Follows Its Run Project" is registered
    And an online agent "card-follower" with message "between runs" is registered on that project
    And agent "card-follower" is the run's streaming agent
    Given I open the workspace for that project
    When a run is started for agent "card-follower" on that project
    And an online agent "card-follower" with message "gated test run starting" is registered on that project
    And the run streams batch 1 of its test stream through the stream route
    Then the project pane's agent row for "card-follower" reads "running 2/4 · src/gap.test.ts" within 6 seconds
    When I reload the page
    Then the project pane's agent row for "card-follower" reads "running 2/4 · src/gap.test.ts" within 6 seconds
    And I mark the page so a reload would be detectable
    When the run streams batch 2 of its test stream through the stream route
    Then the project pane's agent row for "card-follower" reads "running 3/4 · src/resend.test.ts" within 6 seconds
    When the run streams batch 3 of its test stream through the stream route
    Then the project pane's agent row for "card-follower" reads "running 4/4 · src/close.test.ts" within 6 seconds
    When the run is closed through POST /api/v2/runs naming the crucible-events codec
    Then the agent row for "card-follower" reads the agent's own line the board serves, unmarked, within 6 seconds
    And the page was never reloaded
