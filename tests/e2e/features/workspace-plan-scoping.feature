Feature: CR-CRU-026 §S0 equivalence — cold-load vs navigation parity, and the dead blank-view/foreign-data faces
  BDD layer expression of CR-CRU-026's E2E acceptance criteria: "Blank-view
  face: navigating home → the project's OWN workspace with `state.plans`
  empty and NO SSE frame delivered renders the plan content anyway (the
  navigation fetch alone suffices)"; "from the seeded active project's
  workspace, click a fixture project's badge → Workflow tab shows that
  project's empty state, not the seeded project's plans; navigate back →
  the seeded project's plans return"; and "§S0 no-hidden-state
  equivalence: for BOTH home and workspace, the set of rendered marker
  testids is identical between (a) cold load and (b) arrival via any
  navigation sequence" (docs/changes/CR-CRU-026-patch-workspace-plan-scoping.md).

  Production for this CR shipped in commits 2c169d7 (C1 — §S1 scope-aware
  plans lifecycle: synchronous clear + immediate scoped refetch on
  navigation; §S2 render guard) and daf8505 (C2 — §S3.2 additive
  `GET /api/v2/plans` for home, §S3.4 vestige cleanout of the heuristic
  marker on plan-backed projects). These scenarios PIN that already-shipped
  behavior end-to-end: they are expected to PASS on first run — the RED
  value is that the pins themselves did not exist yet, not that the
  behavior is unimplemented.

  This feature seeds projects via the API, so it must sort alphabetically
  AFTER shell-storyboard.feature ("w" > "s") the way workflow.feature and
  workspace-manager.feature already do — and, within the "workspace-"
  prefix, AFTER workspace-manager.feature ("workspace-p" > "workspace-m"),
  so every earlier feature's seeding has already landed in the shared
  server/db instance by the time these scenarios run. Every project/cr/
  agent name below is namespaced "WS …" to stay clear of the other
  features sharing that instance. Results are ingested with tier "e2e" by
  the orchestrator's ingest step, not by this suite.

  NOTE: §S3.4's planless-heuristic clause (a project with NO plan still
  gets the classic CR-007 heuristic marker, byte-identically) is already
  pinned by workflow.feature's "F13 an unlinked RED/GREEN control pair on a
  PLANLESS project still gets the classic heuristic marker
  (§S3.4 capability-conditional)" scenario (commit 7f2ca3a) — not
  duplicated here.

  Scenario: Blank-view face is dead — clicking a plan-backed project's badge from home renders its plan content with no ingest/SSE activity between navigation and assertion
    Given a project named "WS Blank View Project" is registered
    And a cycle plan is filed for cr "CR-WS-1" with a cycle labelled "c1 red-green"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-ws1"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-ws1"
    And cycle 1 of that plan is marked done
    When I open the home page
    And I click the projects-row badge for "WS Blank View Project"
    Then the Workflow tab shows the cr root for "CR-WS-1" within 2 seconds
    And the Workflow tab shows a done cycle row for "c1 red-green" within 2 seconds

  Scenario: Foreign-data face is dead — navigating home then into an empty project's workspace shows the CR-011 empty state, never the previous project's plans
    Given a project named "WS Plan Backed Project" is registered
    And a cycle plan is filed for cr "CR-WS-2" with a cycle labelled "c1 red-green"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-ws2"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-ws2"
    And a project named "WS Empty Project" is registered
    When I open the home page
    And I click the projects-row badge for "WS Plan Backed Project"
    Then the Workflow tab shows the cr root for "CR-WS-2" within 2 seconds
    When I navigate home via the ← projects chip
    And I click the projects-row badge for "WS Empty Project"
    Then the Workflow tab shows the CR-011 empty state with none of the previous project's plan content

  Scenario: §S0 equivalence — the home timeline's marker vocabulary is identical between cold load and a home→workspace→home in-app round-trip
    Given a project named "WS Equivalence Project" is registered
    And a cycle plan is filed for cr "CR-WS-3" with a cycle labelled "c1 red-green"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-ws3"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-ws3"
    And cycle 1 of that plan is marked done
    When I open the home page
    Then the declared marker for "c1 red-green" on "CR-WS-3" is visible in the home timeline within 2 seconds
    And I record the home timeline's marker vocabulary counts as the cold-load baseline
    When I click the projects-row badge for "WS Equivalence Project"
    And I click the "Runs" workspace tab
    Then the declared marker for "c1 red-green" on "CR-WS-3" becomes visible within 2 seconds
    And the workspace Runs pane shows no transition marker
    When I navigate home via the ← projects chip
    Then the home timeline's marker vocabulary counts match the recorded cold-load baseline within 2 seconds
