Feature: CR-CRU-011 workflow — cycle plans, the Workflow tab, and timeline plan integration
  BDD layer expression of CR-CRU-011's AC "BDD E2E (house style):
  tests/e2e/features/workflow.feature — scenarios: file a plan via API →
  activate cycle 1 → register agent → ingest fail/pass with
  context.cycleId → PATCH cycle done → close plan with merge commit → the
  lens shows the plan tree with the closed span, cycle label, merge
  commit, and the sealed agent runtime; plus a timeline scenario asserting
  suppression + the declared marker" (docs/changes/CR-CRU-011-workflow-lens.md).
  Storyboard frame F13 (Workflow tab). This feature sorts alphabetically
  AFTER shell-storyboard.feature ("w" > "s"), so its F1 empty-DB
  precondition already holds by the time these scenarios seed data into
  the shared server/db instance. Every project/cr/agent name below is
  namespaced "WF …" to stay clear of the other features sharing that
  instance. Results are ingested with tier "e2e" by the orchestrator's
  ingest step, not by this suite.

  Scenario: F13 filing a plan, running its cycle to done, and closing the plan with a merge commit renders the closed plan tree in the Workflow tab's history lens
    Given a project named "WF Lifecycle Project" is registered
    And a cycle plan is filed for cr "CR-WF-1" with a cycle labelled "c1 red-green"
    And cycle 1 of that plan is activated
    And an online agent "agent-wf1" with message "filing the plan" is registered on that project
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-wf1"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-wf1"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "abc1234"
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the history lens shows a cr group for "CR-WF-1" with rollup "1/1"
    And the cr group for "CR-WF-1" shows a merge-commit pill reading "merged @ abc1234"
    And the cr group for "CR-WF-1" shows the runtime for agent "agent-wf1"
    When I expand the cr group for "CR-WF-1"
    And I expand cycle "c1 red-green" in the cr group for "CR-WF-1"
    Then the cr group for "CR-WF-1" shows cycle "c1 red-green" as a closed span containing the linked run for agent "agent-wf1"

  Scenario: F13 the Runs timeline suppresses the heuristic marker for plan-linked runs and renders the active-cycle span, then the declared marker once the cycle is done; an unlinked control pair still gets the classic heuristic marker
    Given a project named "WF Timeline Project" is registered
    And a cycle plan is filed for cr "CR-WF-2" with a cycle labelled "c1 red-green"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-wf2"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-wf2"
    When I open the workspace for that project
    Then the workspace Runs pane shows no transition marker
    And the workspace Runs pane shows the active cycle span for "c1 red-green" on "CR-WF-2"
    When a fail(2/5) run is ingested for agent "CR-WF2-CTRL-RED"
    And a pass(5/5) run is ingested for agent "CR-WF2-CTRL-GREEN"
    Then exactly one transition marker becomes visible within 2 seconds in the workspace Runs pane
    When cycle 1 of that plan is marked done
    Then the declared marker for "c1 red-green" on "CR-WF-2" becomes visible within 2 seconds
    And the workspace Runs pane shows no cycle-span-open element

  Scenario: F13 with an open plan and an active cycle, the Workflow tab's active section shows the per-CR todo, and expanding the active cycle row reveals its linked run
    Given a project named "WF Active Project" is registered
    And a cycle plan is filed for cr "CR-WF-3" with a cycle labelled "c1 red-green"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-wf3"
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    And I expand the active cycle row for "c1 red-green"
    Then the workflow active section shows a cycle row for "c1 red-green" expanded with the linked run for agent "agent-wf3"
