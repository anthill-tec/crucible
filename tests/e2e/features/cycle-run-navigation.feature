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
  after the main `chromium` project — it `dependencies` on the
  `chromium-empty-db` project that holds that precondition and is declared
  after `chromium` (see playwright.config.ts's ordering comment). Every
  project/cr/agent name below is namespaced "CRB …" / "CR-CRB-…" to stay
  clear of the other features sharing that server/db instance. Results are
  ingested with tier "e2e" by the orchestrator's ingest step, not by this
  suite.

  Scenario: §S1 clicking a HISTORY done cycle row's "→ Runs" badge lands on the Runs tab with its declared boundary scrolled into view and blinking, fading after 10s
    Given a project named "CRB Forward Project" is registered
    And an orchestrator "crb-orch-1" is registered on that project
    And a release "0.173.637" is proposed for that project
    And a cycle plan is filed for cr "CR-CRB-1" with a cycle labelled "c1 nav"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-crb1-red"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-crb1-green"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "crb00001"
    And 20 filler passing runs are ingested on that project
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    And I expand the cr group for "CR-CRB-1"
    And I click the cycle-to-runs badge for cycle "c1 nav" in the cr group for "CR-CRB-1"
    Then the "Runs" tab is selected
    And the declared marker for that cycle is scrolled into view within the Runs pane and blinking
    And the declared marker for that cycle loses its blink class within 11 seconds

  Scenario: §S2 clicking a declared boundary's "⚑ Cycle" badge switches to Workflow, auto-expands the collapsed CR group, and blinks the exact history cycle row (never a second indicator on re-click)
    Given a project named "CRB Backward Project" is registered
    And an orchestrator "crb-orch-2" is registered on that project
    And a release "0.173.637" is proposed for that project
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

  Scenario: clicking "⚑ Cycle" on a closed cycle whose release and wave History draws folded opens the release, the wave and the cr group, and lands on the blinking cycle row
    Given the viewport is 1280x800
    And a project named "CRB Folded History Project" is registered
    And an orchestrator "crb-orch-6" is registered on that project
    And a release "0.3.0" is proposed for that project
    And a release "0.4.0" is proposed for that project
    And a cr-plan declaring cr "CR-CRB-6A" titled "CRB folded older CR" into wave "8" of release "0.3.0" is posted for that project
    And a cr-plan declaring cr "CR-CRB-6B" titled "CRB newer CR" into wave "9" of release "0.4.0" is posted for that project
    And a cycle plan is filed for cr "CR-CRB-6A" with a cycle labelled "c1 folded" in wave "8"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-crb6-red"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-crb6-green"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "crb00006"
    And a newer cr "CR-CRB-6B" is planned, worked and closed in wave "9" with merge commit "crb00007"
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the release "0.4.0" row is open and the release "0.3.0" row is folded
    When I click the "Runs" workspace tab
    And I click the "⚑ Cycle" badge on the declared marker for that cycle
    Then the "Workflow" tab is selected
    And the release "0.3.0" row is open
    And the release "0.3.0" row's wave "8" is open
    And the cr group for "CR-CRB-6A" is auto-expanded showing its cycle rows
    And the history cycle row for that cycle is scrolled into view and blinking
    And the history cycle row for that cycle sits inside the viewport

  Scenario: clicking "⚑ Cycle" on a closed cycle's marker in the All Projects view routes to that cycle's project, lands on Workflow and blinks the cycle row
    Given the viewport is 1280x800
    And a project named "CRB All Projects Project" is registered
    And an orchestrator "crb-orch-7" is registered on that project
    And a release "0.5.0" is proposed for that project
    And a cr-plan declaring cr "CR-CRB-7" titled "CRB all projects CR" into wave "12" of release "0.5.0" is posted for that project
    And a cycle plan is filed for cr "CR-CRB-7" with a cycle labelled "c1 all projects" in wave "12"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-crb7-red"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-crb7-green"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "crb00008"
    When I open the home page
    And I click the "⚑ Cycle" badge on the All Projects timeline's declared marker for that cycle
    Then the URL path ends with that project's workspace path
    And the "Workflow" tab is selected
    And the release "0.5.0" row's wave "12" is open
    And the cr group for "CR-CRB-7" is auto-expanded showing its cycle rows
    And the history cycle row for that cycle is scrolled into view and blinking
    And the history cycle row for that cycle sits inside the viewport

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

  Scenario: CR-CRU-146 §S2 — a toggleable history cycle line carries the pointer cursor over its empty space, honestly signalling it opens; the active section's open-span line, which has no toggle, does not
    Given a project named "CRB Cursor Project" is registered
    And an orchestrator "crb-orch-4" is registered on that project
    And a release "0.173.637" is proposed for that project
    And a cycle plan is filed for cr "CR-CRB-4A" with a cycle labelled "c1 cursor active"
    And cycle 1 of that plan is activated
    When I open the workspace for that project
    Then the active-section cycle line for that cycle shows the default cursor over its empty space, not pointer
    Given a cycle plan is filed for cr "CR-CRB-4B" with a cycle labelled "c1 cursor history"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-crb4-red"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-crb4-green"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "crb00004"
    And I open the workspace for that project
    And I expand the cr group for "CR-CRB-4B"
    Then the history cycle line for that cycle shows the pointer cursor over its empty space

  Scenario: CR-CRU-146 — pixel hit-test: a history cycle line's toggle fires at every measured x-offset across the row, the line spans at least 90% of the row's width, and clicking the "→ Runs" badge leaves that open/closed state unchanged
    Given a project named "CRB Hit Test Project" is registered
    And an orchestrator "crb-orch-5" is registered on that project
    And a release "0.173.637" is proposed for that project
    And a cycle plan is filed for cr "CR-CRB-5" with a cycle labelled "c1 hit test"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-crb5-red"
    And a pass(5/5) run linked to that cycle is ingested for agent "agent-crb5-green"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "crb00005"
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    And I expand the cr group for "CR-CRB-5"
    Then the history cycle line for that cycle measures at least 90% of its row's width
    And clicking the history cycle line for that cycle at each measured x-offset opens then closes its linked runs
    When I click the history cycle line for that cycle in its empty space
    Then the cr group for "CR-CRB-5" shows cycle "c1 hit test" as a closed span containing the linked run for agent "agent-crb5-green"
    When I click the cycle-to-runs badge for cycle "c1 hit test" in the cr group for "CR-CRB-5"
    Then the "Runs" tab is selected
    When I click the "Workflow" workspace tab
    Then the cr group for "CR-CRB-5" shows cycle "c1 hit test" as a closed span containing the linked run for agent "agent-crb5-green"
