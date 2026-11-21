Feature: the project card's status line words its last run as what it was
  The Project pane card's status line reads the project's newest test run or
  compile result, and words each as itself: a test run as its ratio, a compile
  result by its error count, and an aborted run as aborted. A milestone or an
  agent's registration is never a run, so neither moves the line.

  Every scenario drives the REAL server through the same API a client uses
  and reads the SPA's own DOM; the line updates live, so each assertion waits
  for the text rather than sleeping. Project and cr names are namespaced
  "STAT …" to stay clear of the other features sharing the server.

  Scenario: a merged CR's milestone and a fresh agent's registration leave the status line on the last test run
    Given a project named "STAT Merged Project" is registered
    And an online agent "stat-runner" with message "status line runs" is registered on that project
    And a cycle plan is filed for cr "CR-STAT-E2E-1" with a cycle labelled "stat merged"
    And cycle 1 of that plan is activated
    And a pass(5/5) run linked to that cycle is ingested for agent "stat-runner"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "5a7c0de"
    And a "cr-merged" milestone for that cr is posted by agent "stat-runner"
    And a fresh agent "stat-newcomer" registers on that project
    When I open the workspace for that project
    Then the project status line reads "✓ green · 5/5 · just now"
    And the project status line carries the "app-ratio-pass" class and not the "app-ratio-fail" class

  Scenario: a compile result turns the status line to its error count, then to compiled once a build is clean
    Given a project named "STAT Compile Project" is registered
    And an online agent "stat-builder" with message "status line builds" is registered on that project
    And a cycle plan is filed for cr "CR-STAT-E2E-2" with a cycle labelled "stat compile"
    And cycle 1 of that plan is activated
    And a pass(5/5) run linked to that cycle is ingested for agent "stat-builder"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "c0ffee1"
    And a "cr-merged" milestone for that cr is posted by agent "stat-builder"
    And a fresh agent "stat-latecomer" registers on that project
    When I open the workspace for that project
    Then the project status line reads "✓ green · 5/5 · just now"
    When a rustc compile result with exactly one error is ingested for agent "stat-builder"
    Then the project status line reads "✗ 1 error · just now"
    And the project status line carries the "app-ratio-fail" class and not the "app-ratio-pass" class
    When a rustc compile result with warnings and no errors is ingested for agent "stat-builder"
    Then the project status line reads "✓ compiled · just now"
    And the project status line carries the "app-ratio-pass" class and not the "app-ratio-fail" class

  Scenario: an aborted run on an active cycle reads as aborted on the status line, in neither the pass nor the fail colour
    Given a project named "STAT Aborted Project" is registered
    And an online agent "stat-aborter" with message "status line abort" is registered on that project
    And a cycle plan is filed for cr "CR-STAT-E2E-3" with a cycle labelled "stat aborted"
    And cycle 1 of that plan is activated
    And a run linked to that cycle is started for agent "stat-aborter"
    And that run is aborted by agent "stat-aborter" with reason "runner crashed before filing"
    When I open the workspace for that project
    Then the project status line reads "⊘ aborted · just now"
    And the project status line carries neither the "app-ratio-pass" nor the "app-ratio-fail" class
