Feature: History lists releases, each holding its release workflow and then its waves
  BDD layer expression of CR-CRU-173 §S1/AC1/AC2 (page half)
  (docs/changes/CR-CRU-173-history-is-told-by-release.md), governed by
  storyboard F22 (.lavish/crucible-v2-design.html, "Workflow in two panes —
  Now, and a History of releases, each holding the waves that led up to
  it"). Driven against the REAL served SPA + REAL server (house style),
  reusing seeding.steps.ts's project step, roadmap-graph.steps.ts's
  orchestrator/release-proposal/cr-plan steps, workflow.steps.ts's/
  gates.steps.ts's plan-filing/transition/close/gate steps and
  navigation.steps.ts's "I open the workspace for that project" wherever
  they already say exactly what's needed; only the ship-milestone step and
  the release-tree assertions are new here.

  Today `[data-testid="workflow-history"]` renders `workflowLens`'s waves
  directly at its own top level and never fetches
  `/api/v2/projects/<key>/history` at all — every assertion below naming
  `[data-testid="history-release"]` has no code path producing it yet.

  Every project/cr name below is namespaced "WHRT " / "CR-WHRT-…" to stay
  clear of the other features sharing this instance. Results are ingested
  with tier "e2e" by the orchestrator's ingest step, not by this suite.

  Scenario: at the desktop band, History lists the shipped release, opens to its gate run and wave, and → gate opens the run drill-in
    Given the viewport is 1280x800
    And a project named "WHRT Desktop Project" is registered
    And an orchestrator "whrt-orch-1" is registered on that project
    And a release "0.2.0" is proposed for that project
    And a cr-plan declaring cr "CR-WHRT-1" titled "WHRT history tree CR" into wave "6" of release "0.2.0" is posted for that project
    And a cycle plan is filed for cr "CR-WHRT-1" with a cycle labelled "c1" in wave "6"
    And cycle 1 of that plan is activated
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "whrt0001"
    And a passed no-mistakes gate is ingested via the API for wave "6" with push commit "whrt0001"
    And release "0.2.0" is shipped with commit "whrt0002" naming cr "CR-WHRT-1"
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the history release tree lists releases in order "0.2.0"
    And the release "0.2.0" row is open and reads state "shipped"
    And the release "0.2.0" row shows exactly 1 gate run, the newest reading outcome "passed"
    And the release "0.2.0" row's wave "6" holds cr "CR-WHRT-1"
    When I click that gate run's "→ gate" link
    Then the run drill-in opens for that gate's event

  Scenario: at the phone band, the release rows are the toggles — the newest release starts open, an older one starts folded until tapped
    Given the viewport is 390x844
    And a project named "WHRT Phone Project" is registered
    And an orchestrator "whrt-orch-2" is registered on that project
    And a release "0.3.0" is proposed for that project
    And a release "0.4.0" is proposed for that project
    And a cr-plan declaring cr "CR-WHRT-P1" titled "WHRT phone older CR" into wave "8" of release "0.3.0" is posted for that project
    And a cr-plan declaring cr "CR-WHRT-P2" titled "WHRT phone newest CR" into wave "9" of release "0.4.0" is posted for that project
    And a cycle plan is filed for cr "CR-WHRT-P1" with a cycle labelled "c1" in wave "8"
    And cycle 1 of that plan is activated
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "whrtp001"
    And a cycle plan is filed for cr "CR-WHRT-P2" with a cycle labelled "c1" in wave "9"
    And cycle 1 of that plan is activated
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "whrtp002"
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    And I select the "History" sub-tab
    Then the release "0.4.0" row is open and the release "0.3.0" row is folded
    And the release "0.4.0" row's wave "9" holds cr "CR-WHRT-P2"
    When I tap the release "0.3.0" row's toggle
    Then the release "0.3.0" row is open
    And the release "0.3.0" row's wave "8" holds cr "CR-WHRT-P1"
