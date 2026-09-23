Feature: CR-CRU-023 §S1 — pane scroll floor at the supported viewport bounds
  BDD layer expression of CR-CRU-023 §S1's two DEFERRED E2E ACs
  (docs/changes/CR-CRU-023-patch-pane-min-width-scroll.md): originally "E2E
  (Playwright, viewport 800×640): the Workflow pane with a long-label active
  plan renders a horizontal scrollbar on the PANE (pane `scrollWidth >
  clientWidth`), the cycle-timer badge keeps its single-line pill form, and
  `document.body.scrollWidth <= window.innerWidth` (no page-level horizontal
  scroll)" and "E2E (viewport 1024×640): standard fixture content renders
  with NO horizontal scroll on any pane (`scrollWidth <= clientWidth` for
  each central pane)". C1 GREEN (commit 71981ce) shipped the shared
  `.app-pane-content` wrapper (`overflow-x: auto` + a 660px child min-width
  floor) with `data-testid="pane-scroll"` on all seven central-pane
  surfaces — exactly one instance renders per route.

  RE-POINTED by CR-CRU-018 §S1/DN decision 5 (2026-09-23): that decision
  SCOPES the 660px floor to the desktop band (≥1025px) and LIFTS it below,
  and DN decision 1 moves "the supported minimum viewport" itself — desktop
  now begins at 1025px, exactly where CR-CRU-023's 1024×640 guarantee ends.
  Both scenarios below therefore move off their original 800×640/1024×640
  viewports (now tablet band, where the floor is gone and the workspace body
  stacks per DN decision 2) onto the desktop band.

  MEASURED (2026-09-23, against the live server): the desktop-band grid
  (`.app-workspace-body { grid-template-columns: minmax(0, 2.6fr)
  minmax(260px, 1fr); }`) alone can NEVER narrow `.app-pane-content` below
  660px once viewport ≥ 1025px — clientWidth measured 688px at exactly
  1025px and grows from there (706px at 1050, 872px at 1280). The 660px
  floor's min-width rule therefore stops being reachable through container
  width alone at any legal desktop-band viewport post-CR-018; a bare
  viewport repoint left the floor-forcing scenario below RED for the WRONG
  reason (no overflow at all). Its label is widened further, alongside the
  repoint, so genuine overflow is CONTENT-driven and independent of the
  container-narrowing mechanism DN decision 1 retires at this band — the
  same scroll-affordance mechanics this scenario pins, just no longer
  reachable via the floor alone. `.app-cycle-text` (the label itself) carries
  `white-space: nowrap` + `text-overflow: ellipsis` BY DESIGN (CR-CRU-025
  §S1 — the label truncates, never the badge), so a longer label alone
  cannot force overflow at any width; the CR ID (`.app-heat-ink`/`.app-cr-
  root`, which carries no such clipping) is what carries the unbreakable
  (no-hyphen) long token instead. 1025×640 — the new exact floor — for the
  "at the supported floor, nothing scrolls" scenario (unaffected: it never
  relied on overflow existing). This is a VERIFICATION-layer suite
  (production already implements the CR-CRU-023 behaviour); both scenarios
  are expected to keep PASSING after the repoint — CR-CRU-018's own
  dispatch note requires this file be re-pointed "deliberately rather than
  discovered" broken once GREEN lands.
  This file's POSITION governs nothing: shell-storyboard.feature's F1 states
  its empty-DB precondition with its own `@empty-db` tag, in the
  `chromium-empty-db` project every other project depends on (see
  playwright.config.ts's ordering comment).
  Every project/cr/agent name below is namespaced "PSF …" to stay clear of
  the other features sharing the instance. Results are ingested with tier
  "e2e" by the orchestrator's ingest step, not by this suite.

  Scenario: the Workflow pane with a long-label active plan scrolls horizontally at the desktop band without crushing the cycle-timer badge or the page body
    Given the viewport is 1280x640
    And a project named "PSF Long Label Project" is registered
    And a cycle plan is filed for cr "CR-PSF-1xUnbreakableSuffixForcingOverflowAtTheDesktopBandOnceCRCRU018MovesThisScenarioOffItsOriginal800pxViewportPerDNDecision1sNewFloorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" with a cycle labelled "an extremely long cycle label meant to squeeze the aligned timer column at narrow pane widths"
    And cycle 1 of that plan is activated
    When I open the workspace for that project
    Then the active pane-scroll element scrolls horizontally
    And the cycle-timer badge renders as a single unbroken line
    And the page body does not scroll horizontally

  Scenario: at the supported 1025×640 desktop-band floor, no central pane scrolls horizontally
    Given the viewport is 1025x640
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
