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

  # CR-CRU-147 \u00a7S2 (cycle 526, C4) \u2014 the reason bubble on the phone band: no
  # hover exists here, so a TAP on the status badge must open the same
  # tooltip hovering opens at desktop width (roadmap.feature). Reuses AC8's
  # own registration idiom, then voids the CR through the real route exactly
  # as the desktop scenario does.
  Scenario: CR-CRU-147 \u00a7S2 AC3 \u2014 on the phone band, tapping a voided CR's status badge opens the same reason tooltip hovering opens at desktop width
    Given a project named "MOB Dead CR Project" is registered
    And a CR queue registering cr "CR-MOB-VOID" titled "mobile dead cr fixture" in wave "1" is posted for that project
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    Then the roadmap release table renders as cards, not a table, on the phone profile
    And the status badge for "CR-MOB-VOID" shows no lifecycle tooltip yet
    When cr "CR-MOB-VOID" is voided with reason "Voided on the phone-band fixture: this reason must open on TAP, with no pointer hover available at all on a touch-only profile."
    Then the roadmap row for "CR-MOB-VOID" shows status "VOID" within 3 seconds
    When I tap the status badge for "CR-MOB-VOID"
    Then its lifecycle tooltip states the reason "this reason must open on TAP"

  # BORN GREEN, deliberately — a regression rail (CR-CRU-018 C5 F3). This
  # scenario PASSED at RED (9efb9ed): replayed by restoring that commit's
  # public/styles.css + public/app.js and running it alone on chromium-mobile.
  # It is NOT proof of new CR-CRU-018 behaviour. The pre-existing mechanism
  # satisfies it at phone width: the CR-CRU-016 §S1 app frame (body
  # `height: 100%; overflow: hidden`, the flex-column #app, and `.app-main`
  # `min-height: 0; overflow: hidden`) keeps the document at the viewport
  # height, while the CR-CRU-029 §S1 pane-scroll box (`.app-pane-content`,
  # flex-filled with `min-height: 0` and `overflow: auto` on both axes;
  # CR-CRU-034 §S1 adds `position: relative`) owns the overflow. It guards
  # §S3 ("scroll stays contained") at phone width against a later
  # regression.
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

  # CR-CRU-022 \u00a7S5 (last AC) + DN-crucible-analytics.md \u00a710 "Phone" decision
  # \u2014 reusing THIS two-engine harness (CR-CRU-018) rather than building a new
  # one, per CR-CRU-022's own gap-analysis coupling note and its \u00a7S5 AC block's
  # last bullet. RED phase, re-confirmed in this pass: `grep -a` over `public/`
  # for `roadmap-progress` / `analytics-pane` / `burndown-chart` returns ZERO
  # hits (same baseline tests/cr022-analytics-ui.test.ts's header records), so
  # every assertion below currently has no code path producing it \u2014 the
  # release band, the pane and its chart do not exist at any viewport yet, let
  # alone a phone-specific collapse of them.
  Scenario: CR-CRU-022 AC \u2014 at the phone band the release band collapses to one \u226544px line, velocity rides the Project band's foot strip, and the analytics pane's chart scrolls inside its own container with the page unscrolled
    Given a project named "MOB Analytics Project" is registered
    And an online agent "mob-analytics-agent" with message "building" is registered on that project
    And a CR queue registering cr "CR-MOB-ANALYTICS" titled "phone analytics band fixture" in wave "1" is posted for that project
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    Then the roadmap release band renders as one line measuring at least 44px on the phone profile
    And velocity appears on the project band foot strip
    When I tap the roadmap release band
    Then the page body does not scroll horizontally
    And the analytics pane's chart scrolls inside its own container, not the page

  # CR-CRU-146 (VERIFY F1) — DN-crucible-responsive-model.md decision 11
  # ("cycle rows go full-width and the row is the toggle") is PER BAND, so the
  # hit-area proof cycle-run-navigation.feature makes at desktop width is made
  # here at the phone band too, under every phone project (chromium-mobile,
  # webkit-iphone) with a real touch tap. The tapped point is the line's widest
  # gap, proven by elementFromPoint to resolve to the line itself, outside
  # every child, before each tap.
  Scenario: CR-CRU-146 — at the phone band a history cycle line spans at least 90% of its row, and a tap on its own empty space opens its linked runs and a second tap closes them
    Given a project named "MOB Cycle Line Project" is registered
    And a cycle plan is filed for cr "CR-MOB-146" with a cycle labelled "c1 phone line"
    And cycle 1 of that plan is activated
    And a fail(2/5) run linked to that cycle is ingested for agent "mob-cycleline-red"
    And a pass(5/5) run linked to that cycle is ingested for agent "mob-cycleline-green"
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "mob00146"
    When I open the workspace for that project
    And I expand the cr group for "CR-MOB-146"
    Then the history cycle line for that cycle measures at least 90% of its row's width
    And tapping the history cycle line for that cycle in its empty space opens then closes its linked runs

  # CR-CRU-164 \u00a7S2 \u2014 the verified-runs chip is part of the band's phone-band
  # collapse: the one-line band has no room for it (CR-CRU-022 \u00a7S5's own
  # ≥44px one-line rule), so it rides the analytics pane instead, the same
  # relocation pattern CR-CRU-022's own phone scenario already established
  # for velocity (the Project band's foot strip) \u2014 here the destination is
  # the pane the band's own tap already opens.
  Scenario: CR-CRU-164 \u00a7S2 \u2014 on the phone band the verified-runs chip does not render in the one-line release band but does render in the analytics pane
    Given a project named "MOB Verify Chip Project" is registered
    And an online agent "mob-verify-chip-agent" with message "building" is registered on that project
    And a CR queue registering cr "CR-MOB-VCHIP" titled "mobile verified chip fixture" in wave "1" is posted for that project
    And 2 passing runs are filed under that release
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    Then the roadmap release band does not show the verified-runs chip
    When I tap the roadmap release band
    Then the analytics pane shows the verified-runs chip reading "verified · 2 runs ↗"

