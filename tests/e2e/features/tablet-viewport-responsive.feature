Feature: CR-CRU-018 §S1/§S3 — tablet-band responsive layout
  BDD layer expression of CR-CRU-018's tablet-profile acceptance criteria
  (docs/changes/CR-CRU-018-responsive-mobile.md), governed by
  docs/research/DN-crucible-responsive-model.md. Tablet band: viewport
  width 641-1024px (DN decision 1). Decision 2: tablet keeps the content
  column and stacks the Project pane BENEATH it, full width — the ONE
  layout axis that changes for this band.

  Runs under the dedicated `chromium-tablet` Playwright project (a
  touch-enabled 820x1180 viewport, playwright.config.ts), matched to THIS
  file only via `testMatch`. Carries `grepInvert: /@empty-db/` per the CR's
  ordering note, so shell-storyboard.feature's F1 empty-DB precondition is
  never re-run by this project.

  RED phase — expected to fail against current production: the workspace
  body is a fixed two-column CSS grid at every width
  (`.app-workspace-body { grid-template-columns: minmax(0, 2.6fr)
  minmax(260px, 1fr); }`, public/styles.css) with zero `@media` rules
  anywhere, so the Project pane never stacks beneath the content at any
  viewport and the 660px floor never lifts below 1025px.

  Every project/agent name below is namespaced "TAB …" to stay clear of
  other features sharing the webServer/DB instance. Results are ingested
  with tier "e2e" by the orchestrator's ingest step, not by this suite.

  Scenario: AC1 — no page-level horizontal scroll at the tablet profile, home and workspace alike
    Given a project named "TAB Overflow Project" is registered
    And an online agent "tab-overflow-agent" with message "building" is registered on that project
    When I open the home page
    Then the page body does not scroll horizontally
    And the main content region is visible at a usable width
    When I open the workspace for that project
    Then the page body does not scroll horizontally
    And the main content region is visible at a usable width
    When I click the "Runs" workspace tab
    Then the page body does not scroll horizontally
    And the main content region is visible at a usable width

  Scenario: AC7 — the project band relocates to stack beneath the content column, full width, and never disappears
    Given a project named "TAB Band Project" is registered
    And an online agent "tab-band-agent" with message "building the widget" is registered on that project
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then the project pane is visible
    And the project pane sits BENEATH the main content column, not beside it
    And the project pane spans at least 90% of the workspace width
    And the project pane shows the project name, the live-agent count, and the health dot

  Scenario: AC6 — the 660px pane-content floor is absent on the tablet profile
    Given a project named "TAB Floor Project" is registered
    And 3 filler passing runs are ingested on that project
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then the workspace Runs pane's content child does NOT carry the 660px min-width floor

  # The `→ Runs` pill is a touch target on touch media. The tablet band keeps
  # the pill on History's cycle line and on Now's, so on this coarse-pointer
  # profile each must be at least 44px tall — one scenario per line, so each
  # pill's floor is proven on its own. The page is first proven to match
  # `(pointer: coarse)`, so the floor is measured where it applies.
  Scenario: at the tablet band on a coarse pointer the history cycle line's → Runs pill is at least 44px tall
    Given a project named "TAB History Pill Project" is registered
    And an orchestrator "tab-orch-histpill" is registered on that project
    And a release "0.173.637" is proposed for that project
    And a cycle plan is filed for cr "TAB-HISTPILL" with a cycle labelled "c1 history pill"
    And cycle 1 of that plan is activated
    And a pass(5/5) run linked to that cycle is ingested for agent "tab-histpill-green"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "tabpill1"
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    And I expand the cr group for "TAB-HISTPILL"
    Then the page matches the coarse-pointer media query
    And the history → Runs pill for cr "TAB-HISTPILL" is at least 44px tall

  Scenario: at the tablet band on a coarse pointer Now's active cycle line carries a → Runs pill that is at least 44px tall
    Given a project named "TAB Now Pill Project" is registered
    And an orchestrator "tab-orch-nowpill" is registered on that project
    And a release "0.173.637" is proposed for that project
    And a cycle plan is filed for cr "TAB-NOWPILL" with a cycle labelled "c1 now pill"
    And cycle 1 of that plan is activated
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the page matches the coarse-pointer media query
    And Now's → Runs pill for that cycle is at least 44px tall

  # The touch floor must not cost the pill its shape: on this coarse-pointer
  # profile each tablet pill, History's and Now's, is at least 44px tall with
  # horizontal padding on each side of at least half that height, so it still
  # reads as a pill — one scenario per line, each preceded by the
  # coarse-pointer proof.
  Scenario: at the tablet band on a coarse pointer the history cycle line's → Runs pill is at least 44px tall with horizontal padding on each side of at least half that height
    Given a project named "TAB History Pill Shape Project" is registered
    And an orchestrator "tab-orch-histshape" is registered on that project
    And a release "0.173.637" is proposed for that project
    And a cycle plan is filed for cr "TAB-HISTSHAPE" with a cycle labelled "c1 history pill shape"
    And cycle 1 of that plan is activated
    And a pass(5/5) run linked to that cycle is ingested for agent "tab-histshape-green"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "tabshap1"
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    And I expand the cr group for "TAB-HISTSHAPE"
    Then the page matches the coarse-pointer media query
    And the history → Runs pill for cr "TAB-HISTSHAPE" is at least 44px tall with horizontal padding on each side of at least half that height

  Scenario: at the tablet band on a coarse pointer Now's active cycle line carries a → Runs pill that is at least 44px tall with horizontal padding on each side of at least half that height
    Given a project named "TAB Now Pill Shape Project" is registered
    And an orchestrator "tab-orch-nowshape" is registered on that project
    And a release "0.173.637" is proposed for that project
    And a cycle plan is filed for cr "TAB-NOWSHAPE" with a cycle labelled "c1 now pill shape"
    And cycle 1 of that plan is activated
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the page matches the coarse-pointer media query
    And Now's → Runs pill for that cycle is at least 44px tall with horizontal padding on each side of at least half that height
