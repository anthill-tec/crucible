Feature: The Runs tab stays responsive while a run streams over a long settled history

  A project with thousands of settled runs keeps every one of them on its Runs
  timeline. While a run opens and streams on that tab, each read the board
  answers must touch only what is live: the running card and the agent's card
  in the Project pane follow the batch, the timeline of settled runs is left
  alone, and no main-thread task the page runs from the read that opens the
  run through its last batch takes longer than 250 ms. Once the run closes,
  its card heads the timeline and the running card is gone; the longest task
  of the read that closes the run is measured and reported, not bounded.

  Everything here is the real board: the history is ingested through the
  parsed runs route, the project's own retention is set through the project
  route so the page reads all of it, the run opens through the run-start
  route, its batches go to the stream route and it closes through the runs
  route. The page moves on the board's own throttled frames, so every wait is
  on the page, bounded by a few frame cadences. The main thread is watched
  through the browser's own long-task entries. The watch starts before the run
  opens, once the main thread has gone a second without a long task after the
  history was drawn, and runs to the last batch; a second watch covers the
  close.

  Scenario: A run opens and streams five batches over 2,500 settled runs and no main-thread task takes longer than 250 ms
    Given a project named "Responsive Runs Project" is registered
    And that project keeps its newest 5000 runs
    And 2500 settled runs are ingested on that project through the parsed runs route
    And an online agent "steady-streamer" with message "between runs" is registered on that project
    And agent "steady-streamer" is the run's streaming agent
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then the Runs timeline shows 2500 settled run cards within 30 seconds
    And the page's main thread has been quiet for 1000 ms within 30 seconds
    When I start watching the page's main-thread tasks
    And a run is started for agent "steady-streamer" on that project
    Then the running card for "steady-streamer" is on the Runs tab within 10 seconds
    When the run streams batch 1 of its five-batch stream through the stream route
    Then the running card for "steady-streamer" reads "1/5" in "src/batch-1.test.ts" within 10 seconds
    And the project pane's agent row for "steady-streamer" reads "running 1/5 · src/batch-1.test.ts" within 10 seconds
    When the run streams batch 2 of its five-batch stream through the stream route
    Then the running card for "steady-streamer" reads "2/5" in "src/batch-2.test.ts" within 10 seconds
    And the project pane's agent row for "steady-streamer" reads "running 2/5 · src/batch-2.test.ts" within 10 seconds
    When the run streams batch 3 of its five-batch stream through the stream route
    Then the running card for "steady-streamer" reads "3/5" in "src/batch-3.test.ts" within 10 seconds
    And the project pane's agent row for "steady-streamer" reads "running 3/5 · src/batch-3.test.ts" within 10 seconds
    When the run streams batch 4 of its five-batch stream through the stream route
    Then the running card for "steady-streamer" reads "4/5" in "src/batch-4.test.ts" within 10 seconds
    And the project pane's agent row for "steady-streamer" reads "running 4/5 · src/batch-4.test.ts" within 10 seconds
    When the run streams batch 5 of its five-batch stream through the stream route
    Then the running card for "steady-streamer" reads "5/5" in "src/batch-5.test.ts" within 10 seconds
    And the project pane's agent row for "steady-streamer" reads "running 5/5 · src/batch-5.test.ts" within 10 seconds
    And no main-thread task the page ran from the run's opening through its last batch took longer than 250 ms
    When I start watching the page's main-thread tasks
    And the run is closed through POST /api/v2/runs naming the crucible-events codec
    Then the closed run's card heads the Runs timeline of 2501 settled run cards and no running card is left within 10 seconds
    And the longest main-thread task the page ran while the run closed is reported
