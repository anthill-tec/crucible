Feature: CR-CRU-013 gate + milestone events — E2E round trip (AC150)
  BDD layer expression of CR-CRU-013 AC150: "E2E: tests/e2e/gates.e2e.ts —
  file plan → milestone gap-analysis → close cycles + plan → ingest gate via
  API → workspace timeline shows the milestone entry AND the boundary card,
  home shows the compact gate entry but no milestone, `gated` wave header +
  populated gate pane; results ingested tier:e2e" (docs/changes/
  CR-CRU-013-gate-events.md line 150). C1 (server: gate/milestone event-kind
  family), C2 (timeline gate-card/drill-in/scoping), C3 (contextual gate
  widget + §S6 wave `gated` state) are LIVE on this branch — this feature is
  the AC's end-to-end round trip, driven against the REAL served SPA + REAL
  server, house style (Gherkin + playwright-bdd, not a bespoke .e2e.ts file
  — see tests/e2e/features/workflow.feature for the precedent this mirrors).

  This feature sorts alphabetically AFTER shell-storyboard.feature
  ("workflow-gates" > "shell-storyboard"), so its F1 empty-DB precondition
  already holds by the time this scenario seeds data into the shared
  server/db instance (same discipline as workflow.feature's own header
  note). Every project/cr name below is namespaced "GT " / "CR-GT-…" to stay
  clear of the other features sharing that instance. Results are ingested
  with tier "e2e" by the orchestrator's ingest step, not by this suite.

  Scenario: AC150 filing a plan, posting a gap-analysis milestone, closing its cycle + the plan, then ingesting a passed gate renders the workspace milestone entry + boundary gate card, the home compact gate entry with zero milestones, the gated wave header, and a populated Workflow-tab gate pane
    Given a project named "GT Wave Project" is registered
    And a cycle plan is filed for cr "CR-GT-1" with a cycle labelled "c1 red-green" in wave "5"
    And cycle 1 of that plan is activated
    And a gap-analysis milestone "CR-GT-1 gap-analysis" is posted for that cr in wave "5"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "gt00001"
    And a passed no-mistakes gate is ingested via the API for wave "5" with push commit "gtaabbc"
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then the workspace Runs pane shows a milestone entry with label "CR-GT-1 gap-analysis" and CR badge "CR-GT-1"
    And the workspace Runs pane shows a gate card with outcome "passed" and pushed commit "gtaabbc"
    When I click the "Workflow" workspace tab
    Then the wave header for wave "5" reads "gated"
    And the Workflow tab's gate pane is populated with the outcome banner and at least one step row
    When I open the home page
    Then the home timeline shows a compact gate entry with outcome "passed" and pushed commit "gtaabbc"
    And the home timeline shows zero milestone entries
