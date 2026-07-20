Feature: CR-CRU-025 cycle ↔ run-boundary navigation — bidirectional, with locate blink, and the Run Timeline accordion
  BDD layer expression of CR-CRU-025's AC "E2E: full round-trip — Workflow
  cycle → Runs boundary → back via the boundary → Workflow with blink
  present; scroll positions asserted (`scrollIntoView` effect on the pane,
  not the page)" (docs/changes/CR-CRU-025-cycle-run-boundary-navigation.md).
  §S1 (cycle row → Runs boundary), §S2 (the inverse `⚑ Cycle` badge) and §S2b
  (the Run Timeline accordion) are already GREEN at the unit level; this is
  the end-to-end round trip through the REAL served SPA + REAL server —
  house style (Gherkin + playwright-bdd), mirroring
  tests/e2e/features/wave-backfill.feature's and
  tests/e2e/features/workflow-gates.feature's AC150 round trip.

  This feature file's name sorts alphabetically BEFORE shell-storyboard.feature
  ("cycle" < "shell"), which would break that feature's F1 "truly empty DB"
  precondition if it ran in plain file order — so, exactly like
  drill-in.feature, it is forced into its own Playwright project that runs
  strictly AFTER the main `chromium` project (`dependencies: ["chromium"]`,
  see playwright.config.ts's project-dependencies comment). Every
  project/cr/agent name below is namespaced "CRB …" / "CR-CRB-…" to stay
  clear of the other features sharing that server/db instance. Results are
  ingested with tier "e2e" by the orchestrator's ingest step, not by this
  suite.

  Scenario: §S1 clicking a HISTORY done cycle row's "→ Runs" badge lands on the Runs tab with its declared boundary scrolled into view and blinking, fading after 10s
    Given a project named "CRB Forward Project" is registered
    And a cycle plan is filed for cr "CR-CRB-1" with a cycle labelled "c1 nav"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-crb1-red"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-crb1-green"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "crb00001"
    And 20 filler passing runs are ingested on that project
    When I open the workspace for that project
    And I expand the cr group for "CR-CRB-1"
    And I click the cycle-to-runs badge for cycle "c1 nav" in the cr group for "CR-CRB-1"
    Then the "Runs" tab is selected
    And the declared marker for that cycle is scrolled into view within the Runs pane and blinking
    And the declared marker for that cycle loses its blink class within 11 seconds

  Scenario: §S2 clicking a declared boundary's "⚑ Cycle" badge switches to Workflow, auto-expands the collapsed CR group, and blinks the exact history cycle row (never a second indicator on re-click)
    Given a project named "CRB Backward Project" is registered
    And a cycle plan is filed for cr "CR-CRB-2" with a cycle labelled "c1 auto"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-crb2-red"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-crb2-green"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "crb00002"
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    And I click the "⚑ Cycle" badge on the declared marker for that cycle
    Then the "Workflow" tab is selected
    And the cr group for "CR-CRB-2" is auto-expanded showing its cycle rows
    And the history cycle row for that cycle is scrolled into view and blinking
    When I click the "Runs" workspace tab
    And I click the "⚑ Cycle" badge on the declared marker for that cycle
    Then the "Workflow" tab is selected
    And the history cycle row for that cycle is scrolled into view and blinking
    And exactly one element blinks across the workspace

  Scenario: §S2b the Run Timeline accordion — a declared marker's body click hides its linked run cards behind a collapsed cue, and a second click restores them
    Given a project named "CRB Accordion Project" is registered
    And a cycle plan is filed for cr "CR-CRB-3" with a cycle labelled "c1 acc"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-crb3-red"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-crb3-green"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "crb00003"
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then an event card for "agent-crb3-red" becomes visible within 2 seconds
    And an event card for "agent-crb3-green" becomes visible within 2 seconds
    When I click the body of the declared marker for that cycle
    Then the event card for "agent-crb3-red" is not present in the workspace Runs pane
    And the event card for "agent-crb3-green" is not present in the workspace Runs pane
    And the declared marker for that cycle shows the collapsed cue "▸ 2 runs"
    When I click the body of the declared marker for that cycle
    Then an event card for "agent-crb3-red" becomes visible within 2 seconds
    And an event card for "agent-crb3-green" becomes visible within 2 seconds
    And the declared marker for that cycle no longer shows a collapsed cue
