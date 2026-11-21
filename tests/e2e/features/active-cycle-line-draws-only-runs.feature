Feature: the active cycle's line and the Runs cue count only test runs
  A run is a test run. The active cycle's line in the Workflow tab's Now pane
  draws a chip for each test run linked to the cycle, and nothing else: a
  gate's pre-merge-gate milestone and a compile result linked to the same
  cycle are never drawn as runs, so they never read as a 0/0 chip. A cycle
  whose only linked event is a milestone has no runs to show, so it draws no
  open span at all. Once the cycle is done, the collapsed cue on its declared
  marker in the Runs tab counts the same test runs. An aborted run is still a
  run, and its chip says it was aborted instead of showing a ratio it never
  had.

  Every scenario drives the REAL server through the same API a client uses
  and reads the SPA's own DOM. Project, cr and agent names are namespaced
  "LINE …" to stay clear of the other features sharing the server.

  Scenario: an active cycle holding a test run, a pre-merge-gate milestone and a compile result draws only the test run on its line
    Given a project named "LINE Mixed Project" is registered
    And an online agent "line-runner" with message "active line runs" is registered on that project
    And a cycle plan is filed for cr "CR-LINE-E2E-1" with a cycle labelled "line mixed"
    And cycle 1 of that plan is activated
    And a pass(5/5) test run linked to that cycle is ingested for agent "line-runner"
    And a "pre-merge-gate" milestone linked to that cycle is posted by agent "line-runner"
    And a rustc compile result linked to that cycle is ingested for agent "line-runner"
    When I open the workspace for that project
    Then the active cycle's open span holds exactly one run chip, the test run's, reading "5/5"
    And no run chip on the page carries the milestone's or the compile result's id

  Scenario: an active cycle whose only linked event is a milestone draws no open span
    Given a project named "LINE Milestone Only Project" is registered
    And an online agent "line-gatekeeper" with message "active line milestone" is registered on that project
    And a cycle plan is filed for cr "CR-LINE-E2E-2" with a cycle labelled "line milestone only"
    And cycle 1 of that plan is activated
    And a "pre-merge-gate" milestone linked to that cycle is posted by agent "line-gatekeeper"
    When I open the workspace for that project
    Then the active cycle's row draws no open span while its milestone is on the board

  Scenario: once that cycle is done, collapsing its declared marker on the Runs tab counts only its test run
    Given a project named "LINE Done Project" is registered
    And an online agent "line-closer" with message "runs cue" is registered on that project
    And a cycle plan is filed for cr "CR-LINE-E2E-3" with a cycle labelled "line done"
    And cycle 1 of that plan is activated
    And a pass(5/5) test run linked to that cycle is ingested for agent "line-closer"
    And a "pre-merge-gate" milestone linked to that cycle is posted by agent "line-closer"
    And a rustc compile result linked to that cycle is ingested for agent "line-closer"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "11ec0de"
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    And I click the body of the declared marker for that cycle
    Then the declared marker for that cycle shows the collapsed cue "▸ 1 runs"

  Scenario: an aborted run on an active cycle reads as aborted on its chip, with no ratio
    Given a project named "LINE Aborted Project" is registered
    And an online agent "line-aborter" with message "active line abort" is registered on that project
    And a cycle plan is filed for cr "CR-LINE-E2E-4" with a cycle labelled "line aborted"
    And cycle 1 of that plan is activated
    And a run linked to that cycle is started for agent "line-aborter"
    And that run is aborted by agent "line-aborter" with reason "runner crashed before filing"
    When I open the workspace for that project
    Then the active cycle's open span holds exactly one run chip, for agent "line-aborter", reading "line-aborter aborted"
