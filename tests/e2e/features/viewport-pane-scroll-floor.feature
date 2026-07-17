Feature: CR-CRU-023 §S1 — pane scroll floor at the supported viewport bounds
  BDD layer expression of CR-CRU-023 §S1's two DEFERRED E2E ACs
  (docs/changes/CR-CRU-023-patch-pane-min-width-scroll.md): "E2E (Playwright,
  viewport 800×640): the Workflow pane with a long-label active plan renders
  a horizontal scrollbar on the PANE (pane `scrollWidth > clientWidth`), the
  cycle-timer badge keeps its single-line pill form, and
  `document.body.scrollWidth <= window.innerWidth` (no page-level horizontal
  scroll)" and "E2E (viewport 1024×640): standard fixture content renders
  with NO horizontal scroll on any pane (`scrollWidth <= clientWidth` for
  each central pane)". C1 GREEN (commit 71981ce) shipped the shared
  `.app-pane-content` wrapper (`overflow-x: auto` + a 660px child min-width
  floor) with `data-testid="pane-scroll"` on all seven central-pane
  surfaces — exactly one instance renders per route.
  This is a VERIFICATION-layer suite: production already implements the
  behavior, so both scenarios below are expected to PASS.
  Filename note: this feature is named "viewport-pane-scroll-floor" (not the
  originally-proposed "pane-scroll-floor") so it sorts alphabetically AFTER
  shell-storyboard.feature ("s" < "v") — that feature's F1 scenario asserts
  a TRULY EMPTY DB, a precondition that must hold before ANY feature in this
  shared webServer/DB run seeds a project (same ordering constraint
  documented for drill-in.feature in playwright.config.ts; "pane-scroll-
  floor.feature" would have sorted BEFORE shell-storyboard.feature and
  broken that precondition). It sorts before workflow.feature ("v" < "w"),
  which has no such constraint. Every project/cr/agent name below is
  namespaced "PSF …" to stay clear of the other features sharing the
  instance. Results are ingested with tier "e2e" by the orchestrator's
  ingest step, not by this suite.

  Scenario: the Workflow pane with a long-label active plan scrolls horizontally at 800×640 without crushing the cycle-timer badge or the page body
    Given the viewport is 800x640
    And a project named "PSF Long Label Project" is registered
    And a cycle plan is filed for cr "CR-PSF-1" with a cycle labelled "an extremely long cycle label meant to squeeze the aligned timer column at narrow pane widths"
    And cycle 1 of that plan is activated
    When I open the workspace for that project
    Then the active pane-scroll element scrolls horizontally
    And the cycle-timer badge renders as a single unbroken line
    And the page body does not scroll horizontally

  Scenario: at the supported 1024×640 floor, no central pane scrolls horizontally
    Given the viewport is 1024x640
    And a project named "PSF Floor Project" is registered
    And a cycle plan is filed for cr "CR-PSF-2" with a cycle labelled "schema groundwork"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "agent-psf2"
    And a green regression run with 80% coverage is ingested for agent "agent-psf2"
    And a rustc compile error report is ingested for agent "agent-psf2-compile"
    When I open the home page
    Then no pane scrolls horizontally
    When I open the workspace for that project
    Then no pane scrolls horizontally
    When I click the "Runs" workspace tab
    Then no pane scrolls horizontally
    When I click the "Coverage" workspace tab
    Then no pane scrolls horizontally
    When I click the "Compile" workspace tab
    Then no pane scrolls horizontally
