Feature: CR-CRU-031 §S4 — the wave backfill folds a wave-less plan into its correct History wave band
  BDD layer expression of CR-CRU-031 §S4 / AC4: "after the CR-021 backfill,
  GET …/plans shows CR-CRU-021 wave:"4", and the History lens renders it
  inside the single Wave-4 band — no phantom numberless "WAVE" group"
  (docs/changes/CR-CRU-031-wave-classification-fix.md). This feature pins
  the GENERAL mechanism the CR-021 data-backfill exercises: file a
  wave-less plan alongside a wave-N plan on the SAME project → close both
  → the History lens renders them in two SEPARATE bands (a phantom
  unnumbered one and the real Wave-N one) → PATCH the wave-less plan's
  wave via the §S1 endpoint (`PATCH …/plans/<id>` {wave:"<n>"}, live since
  C1, commit 23de932) → the two bands fold into the single Wave-N band,
  the phantom band gone. §S1 (server backfill, C1) and §S2/§S3 (client
  plan-backfill verb + plan-file --wave, C2) are already GREEN; this is
  the end-to-end round trip through the REAL served SPA + REAL server —
  house style (Gherkin + playwright-bdd), mirroring
  tests/e2e/features/workflow-gates.feature's AC150 round trip.

  This feature sorts alphabetically BEFORE workflow.feature/
  workflow-gates.feature/workspace-*.feature ("wave-backfill" < "workflow"
  since 'a' < 'o') but AFTER shell-storyboard.feature ("shell" < "wave"),
  so its F1 empty-DB precondition already holds. The History lens scopes
  plans to the CURRENT project (CR-CRU-026 §S1/§S2), so this scenario's own
  project is unaffected by any other feature's plans sharing the same
  server/db instance. Every project/cr name below is namespaced "WB " /
  "CR-WB-…" to stay clear of the other features. Results are ingested with
  tier "e2e" by the orchestrator's ingest step, not by this suite.

  Scenario: AC4 a wave-less plan and a wave-42 plan render as two separate History bands; backfilling the wave-less plan's wave via the §S1 PATCH endpoint folds it into the single wave-42 band
    Given a project named "WB Wave Backfill Project" is registered
    And a cycle plan with no wave is filed for cr "CR-WB-1" with a cycle labelled "c1 red-green"
    And the wave-less plan's cycle 1 is activated
    And the wave-less plan's cycle 1 is marked done
    And the wave-less plan is closed with merge commit "wbaaa01"
    And a cycle plan is filed for cr "CR-WB-2" with a cycle labelled "c1 red-green" in wave "42"
    And cycle 1 of that plan is activated
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "wbaaa02"
    When I open the workspace for that project
    Then the history lens shows a phantom unnumbered wave band holding "CR-WB-1", separate from the wave "42" band holding "CR-WB-2"
    When the wave-less plan's wave is backfilled to "42" via the plans PATCH endpoint
    And I open the workspace for that project
    Then the history lens shows a single wave "42" band holding both "CR-WB-1" and "CR-WB-2"
    And the history lens shows no phantom unnumbered wave band
