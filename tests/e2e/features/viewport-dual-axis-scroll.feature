Feature: CR-CRU-029 §S1+§S2 — dual-axis scroll stays operable in narrow viewports
  BDD layer expression of CR-CRU-029's acceptance criteria
  (docs/changes/CR-CRU-029-patch-dual-axis-scroll-visibility.md): at the
  supported minimum viewport (1024×640, narrower down to the 660px floor), a
  pane whose content overflows on BOTH axes must expose a horizontal scroll
  affordance that stays reachable while the pane is scrolled vertically to
  ANY position — not just after scrolling all the way down.

  Root cause pinned here: `.app-center > .app-pane-content` carries the
  CR-CRU-016 AC2 scroll-restore runway (`min-height: calc(100% + 260px)`,
  styles.css ~line 236) on top of the CR-CRU-023 §S1 horizontal floor
  (`overflow-x: auto` + a 660px child min-width, ~line 247-248). Today
  `.app-pane-content` (`data-testid="pane-scroll"`) is NOT itself a
  height-bounded box — it is a normal-flow child of the vertically-scrolling
  `.app-center`/`.app-pane` (`data-testid="workspace-runs"`), so its own
  horizontal scrollbar renders at the bottom of its full (content + 260px)
  height, which only enters the viewport once the ANCESTOR has been scrolled
  nearly all the way down. §S1 wants `.app-pane-content` itself turned into
  the height-bounded dual-axis scroller (both bars pinned to ITS box, which
  stays viewport-sized regardless of scroll position) — candidate (a) in the
  CR, preferred unless it breaks the CR-016 restore contract.

  Uses the SAME 800×640 narrow viewport CR-023's own
  viewport-pane-scroll-floor.feature already established as forcing
  horizontal overflow via the 660px floor (no long-label trick needed — any
  content overflows below ~687px of available pane width), plus enough
  filler runs to force genuine vertical overflow on the workspace Runs pane.

  Sorts after shell-storyboard.feature ("t" < "v", same slot as
  viewport-pane-scroll-floor.feature) so that feature's F1 "truly empty DB"
  precondition still holds; sorts before wave-backfill.feature ("v" < "w").
  Every project name below is namespaced "DAS …" to stay clear of other
  features sharing the webServer/DB instance. Results are ingested with tier
  "e2e" by the orchestrator's ingest step, not by this suite.

  Scenario: §S1 the horizontal scroll affordance on a dual-axis-overflowing Runs pane stays within the viewport at the top, middle, and bottom of the vertical scroll range, and the horizontal axis stays operable throughout
    Given the viewport is 800x640
    And a project named "DAS Dual Axis Project" is registered
    And 30 filler passing runs are ingested on that project
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then the pane-scroll element's bounding box stays within the viewport when the workspace Runs pane is scrolled to the top
    And the pane-scroll element's bounding box stays within the viewport when the workspace Runs pane is scrolled to the middle
    And the pane-scroll element's bounding box stays within the viewport when the workspace Runs pane is scrolled to the bottom
    And driving a horizontal scroll on the pane-scroll element after that still moves its scrollLeft

  # §S2 — CR-CRU-016 AC2 must still hold once §S1 restructures the scroll
  # container. Asserted directly against the bounded `pane-scroll` box (the
  # CR's own wording: "opening then closing a run detail returns the feed to
  # its exact prior scroll position ON THE BOUNDED CONTAINER") rather than
  # the outer `workspace-runs` element the CURRENT restore code targets
  # (public/app.js's `activePaneEl()`/`savedPaneScroll`) — GREEN must make
  # `pane-scroll` itself the element CR-016's save/restore acts on once it
  # becomes the real scroller (mechanism (a)). Today `pane-scroll` has no
  # `overflow-y` of its own, so its `scrollTop` never moves off 0 regardless
  # of the round trip — the correct RED signal for this not-yet-bounded
  # container.
  Scenario: §S2 CR-CRU-016 scroll-restore holds on the bounded pane-scroll container at the narrow dual-axis viewport
    Given the viewport is 800x640
    And a project named "DAS Restore Project" is registered
    And 30 filler passing runs are ingested on that project
    And a passing 1-test run is ingested for agent "agent-das-restore" on that project
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    And I scroll the pane-scroll element down by 240px
    And I click the event card for "agent-das-restore" without letting Playwright re-scroll the pane
    Then the run overlay is visible
    When I click the "← runs" chip
    Then the run overlay and its scrim are gone
    And the pane-scroll element's scrollTop is 240

  # §S2 preserved-invariant guard (non-regression, expected to PASS both
  # before and after GREEN — mirrors CR-CRU-031 C2's "1 preserved-invariant
  # guard" precedent alongside its RED batch): the CR-CRU-023 floor value
  # and the pane-scroll testid identity are UNCHANGED in effect by this
  # patch, which only fixes reachability.
  Scenario: §S2 the CR-CRU-023 660px pane-scroll floor is unchanged by the dual-axis fix
    Given the viewport is 800x640
    And a project named "DAS Floor Guard Project" is registered
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then the workspace Runs pane's content child carries the 660px min-width floor
