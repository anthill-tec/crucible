Feature: CR-CRU-018 §S1/§S2/§S3 — phone-band responsive layout
  BDD layer expression of CR-CRU-018's phone-profile acceptance criteria
  (docs/changes/CR-CRU-018-responsive-mobile.md), governed by
  docs/research/DN-crucible-responsive-model.md (bands, collapse
  persistence, touch-vs-density precedence, the 660px floor's scope).
  Phone band: viewport width ≤ 640px (DN decision 1).

  Runs under the dedicated `chromium-mobile` Playwright project
  (devices["Pixel 7"], playwright.config.ts), matched to THIS file only via
  `testMatch` — never a second pass of the whole suite body. Carries
  `grepInvert: /@empty-db/` per the CR's own ordering note, so
  shell-storyboard.feature's F1 empty-DB precondition (its own
  `chromium-empty-db` project) is never re-run by this project.

  RED phase — expected to fail against current production, which has ZERO
  `@media` rules anywhere in public/styles.css (only the vendor files carry
  any) and no viewport-driven JS branch at all: every assertion below that
  depends on band-specific arrangement (single column, tab wrapping inside
  its own container without a page scrollbar, the project pane rendering as
  a foot strip, a ≥44px touch floor, the ephemeral collapse, the 660px
  floor's absence, roadmap cards, larger coverage heat cells) currently has
  no code path producing it.

  Every project/agent name below is namespaced "MOB …" to stay clear of
  other features sharing the webServer/DB instance. Results are ingested
  with tier "e2e" by the orchestrator's ingest step, not by this suite.

  Scenario: AC1 — home renders single-column with no page-level horizontal scroll at any routed surface, including an open drill-in
    Given a project named "MOB Overflow Project" is registered
    And an online agent "mob-overflow-agent" with message "building" is registered on that project
    And a passing 1-test run is ingested for agent "mob-overflow-runner" on that project
    When I open the home page
    Then the page body does not scroll horizontally
    And the main content region is visible at a usable width
    And the home timeline renders as a single column on the phone profile
    When I open the workspace for that project
    Then the page body does not scroll horizontally
    And the main content region is visible at a usable width
    And the workspace renders as a single column on the phone profile
    When I click the "Runs" workspace tab
    Then the page body does not scroll horizontally
    And the main content region is visible at a usable width
    When I click the event card for "mob-overflow-runner"
    Then the run overlay is visible
    And the page body does not scroll horizontally
    And the main content region is visible at a usable width
    When I click the "← runs" chip
    Then the run overlay and its scrim are gone
    When I click the "Workflow" workspace tab
    Then the page body does not scroll horizontally
    And the main content region is visible at a usable width
    When I click the "Roadmap" workspace tab
    Then the page body does not scroll horizontally
    And the main content region is visible at a usable width

  Scenario: AC2 — the workspace tabs row stays inside its own container, the Project pane renders as a collapsed foot strip that expands to a sheet on tap, and an in-pane drill-in fills the viewport with the back chip visible unscrolled
    Given a project named "MOB Workspace Project" is registered
    And an online agent "mob-ws-agent" with message "building the widget" is registered on that project
    And a passing 1-test run is ingested for agent "mob-ws-runner" on that project
    When I open the workspace for that project
    Then the workspace tabs row does not force the page to scroll horizontally
    And the project band renders as a foot strip stating the project name, the live-agent count, and the health dot
    When I tap the project band foot strip
    Then the project band expands as a sheet over the content
    And the sheet's backdrop is visible
    When I tap the project band sheet's backdrop
    Then the project band collapses back to the foot strip
    When I click the "Runs" workspace tab
    And I click the event card for "mob-ws-runner"
    Then the run overlay is visible
    And the "← runs" chip is visible without scrolling the page
    And the run overlay's bounding box spans at least 95% of the viewport height

  Scenario: AC3/AC4 — every interactive chip/row/card measures at least 44px in one dimension on the phone profile, at every density, and density defaults to comfortable
    Given a project named "MOB Touch Project" is registered
    And an online agent "mob-touch-agent" with message "building" is registered on that project
    And a passing 1-test run is ingested for agent "mob-touch-runner" on that project
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then the density toggle reads "comfortable" with no stored preference
    And every sampled interactive control measures at least 44px in some dimension at density "comfortable"
    When I cycle the density toggle to "compact"
    Then every sampled interactive control measures at least 44px in some dimension at density "compact"
    When I cycle the density toggle to "ultra"
    Then every sampled interactive control measures at least 44px in some dimension at density "ultra"

  Scenario: AC5 — a phone-width pane collapse is ephemeral and never writes RAIL_STORAGE_KEY; the user's own stored choice survives the trip
    Given a project named "MOB Ephemeral Project" is registered
    And the desktop rail is expanded and the user has stored that preference
    When I open the workspace for that project
    Then the project band renders as a foot strip stating the project name, the live-agent count, and the health dot
    And the RAIL_STORAGE_KEY preference is still exactly "expanded"
    When the viewport is 1280x800
    Then the project pane renders expanded, matching the user's stored preference

  Scenario: AC6 — the 660px pane-content floor is absent on the phone profile
    Given a project named "MOB Floor Project" is registered
    And 3 filler passing runs are ingested on that project
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then the workspace Runs pane's content child does NOT carry the 660px min-width floor

  Scenario: AC8 — the roadmap release-scoped table renders as cards carrying id, status, wave and dependencies, the same fields as the desktop table
    Given a project named "MOB Roadmap Project" is registered
    And a CR queue registering cr "CR-MOB-1" titled "mobile roadmap card fixture" in wave "1" is posted for that project
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    Then the roadmap release table renders as cards, not a table, on the phone profile
    And the roadmap card for "CR-MOB-1" shows its id, status, wave and dependencies fields

  Scenario: AC10 — compile diagnostics scroll inside their own container with the page unscrolled
    Given a project named "MOB Compile Project" is registered
    And a rustc compile error report with 40 diagnostics is ingested for agent "mob-compile-agent"
    When I open the workspace for that project
    And I click the "Compile" workspace tab
    Then the page body does not scroll horizontally
    And the compile diagnostics container is the element that scrolls, not the page

  Scenario: AC10 — the coverage/regression run detail's heat-strip cells render larger on the phone profile than at desktop width for the SAME leaf count
    Given a project named "MOB Heatcell Project" is registered
    And a 60-leaf regression run is ingested for agent "mob-heatcell-agent"
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    And I click the event card for "mob-heatcell-agent"
    Then the run overlay is visible
    And the heat-strip is visible with exactly 60 heat cells
    And the heat-strip cell size on the phone profile is larger than the same run's heat-strip cell size at desktop width
