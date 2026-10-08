Feature: CR-CRU-174 §S3 (issue 6) — the projects manager drawer never scrolls sideways
  BDD layer expression of CR-CRU-174 §S3's first clause ("lay the cards and
  the add row out so that the drawer never scrolls sideways, at every
  viewport the responsive model covers"), per the approved storyboard frame
  F12's redraw (.lavish/crucible-v2-design.html, "Redrawn for CR-CRU-171
  issues 6 + 7", APPROVED 2026-10-08, card a — "never sideways"): each
  project card's facts sit on their own lines (a long path or key wraps
  instead of widening the card), so a project with an unusually long sutRoot
  and the standard long (36-char UUID) project key must never force the
  drawer's content wider than its own box, at the desktop band, the tablet
  band (the repo's own `chromium-tablet` project viewport, 820x1180,
  playwright.config.ts) and the phone band (the repo's own `chromium-mobile`
  project device, Pixel 7, viewport 412x839).

  RED phase — expected to fail against current production: the manager's
  per-project meta line (`ManagerRowView` in public/app.js) is ONE joined
  string ("sutRoot: … · liveness … · retention … · key … (immutable)") with
  no wrapping affordance beyond the browser's own word-wrap at spaces, so an
  unbroken long path/key run forces `[data-testid="projects-manager"]`
  (`.app-manager`, styles.css) wider than its own box and the drawer scrolls
  sideways.

  Runs in the default `chromium` project (desktop viewport), resizing
  explicitly via the shared "the viewport is {int}x{int}" step
  (tests/e2e/steps/pane-scroll.steps.ts) to the SAME pixel dimensions the
  repo's dedicated tablet/phone Playwright projects use, rather than
  depending on those projects' own testMatch-gated feature files. Every
  project name below is namespaced "MGRSCROLL …" to stay clear of other
  features sharing the webServer/DB instance. Results are ingested with tier
  "e2e" by the orchestrator's ingest step, not by this suite.

  Scenario: at the desktop viewport (1280x800) the manager drawer shows a long sutRoot and key without scrolling sideways
    Given a project named "MGRSCROLL Desktop Project" is registered with a long sutRoot
    And the viewport is 1280x800
    When I open the home page
    And I click the manage chip
    Then the projects manager is visible
    And the manager drawer does not scroll horizontally

  Scenario: at the tablet viewport (820x1180, the repo's chromium-tablet profile) the manager drawer shows a long sutRoot and key without scrolling sideways
    Given a project named "MGRSCROLL Tablet Project" is registered with a long sutRoot
    And the viewport is 820x1180
    When I open the home page
    And I click the manage chip
    Then the projects manager is visible
    And the manager drawer does not scroll horizontally

  Scenario: at the phone viewport (412x839, the repo's chromium-mobile Pixel 7 profile) the manager drawer shows a long sutRoot and key without scrolling sideways
    Given a project named "MGRSCROLL Phone Project" is registered with a long sutRoot
    And the viewport is 412x839
    When I open the home page
    And I click the manage chip
    Then the projects manager is visible
    And the manager drawer does not scroll horizontally
