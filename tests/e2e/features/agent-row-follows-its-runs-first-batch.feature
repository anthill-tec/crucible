Feature: An agent's row and its running card follow an open run's counts from the first batch

  While an agent's run streams, the board serves the open run without its
  live counts until the run's first stream batch lands, and with them from
  then on. A page that was already open when the run started must still
  follow the run from that first batch: the agent's row in the Project pane
  moves from the agent's message to "running <done>/<total> · <current
  file>", the Runs tab's running card turns into the live card with the
  counts, and neither needs a reload or a tab switch. The row reads the same
  line on every workspace tab.

  Everything here is the real board: the run opens through the run-start
  route, its batches go to the stream route, and the page moves on the
  board's own throttled live frames — no live double. A frame may lag a
  batch by up to the board's frame cadence, so every wait is on the page,
  bounded by a few cadences.

  Scenario: A page open on Roadmap before the run starts follows its first batch on the row, then on Runs a second run's first batch turns its card live and the row follows it
    Given a project named "First Batch Live Project" is registered
    And an online agent "first-batch-runner" with message "gated test run starting" is registered on that project
    And I open that project's board on the Roadmap tab
    When a run is started for agent "first-batch-runner" on that project
    Then the agent row for "first-batch-runner" shows the agent streaming and reads "gated test run starting" within 6 seconds
    And I mark the page so a reload would be detectable
    When that run's first stream batch lands for agent "first-batch-runner" with 2 of 6 tests done, the last in "src/first-run-b.test.ts"
    Then the project pane's agent row for "first-batch-runner" reads "running 2/6 · src/first-run-b.test.ts" within 6 seconds
    And the Roadmap tab is still the one on screen
    When I click the "Runs" workspace tab
    Then the project pane's agent row for "first-batch-runner" reads "running 2/6 · src/first-run-b.test.ts" within 6 seconds
    And that run's running card is live and reads "2/6" in "src/first-run-b.test.ts" within 6 seconds
    When a run is started for agent "first-batch-runner" on that project
    Then that run's running card is plain within 6 seconds
    When that run's first stream batch lands for agent "first-batch-runner" with 3 of 9 tests done, the last in "src/second-run-c.test.ts"
    Then that run's running card is live and reads "3/9" in "src/second-run-c.test.ts" within 6 seconds
    And the project pane's agent row for "first-batch-runner" reads "running 3/9 · src/second-run-c.test.ts" within 6 seconds
    And the page was never reloaded
    When I open that running card's live drill-in
    Then the URL is the live drill-in of that run in the workspace
