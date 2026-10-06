Feature: the Roadmap's burndown chart fills its analytics pane and redraws when the pane resizes
  §S1 of the CR that revisits the release burndown (docs/changes, "the
  burndown fills its pane and draws F16's projection"): the uPlot burndown
  takes the analytics pane's full content width and most of its height at
  the desktop band, with the caption and the forecast card still visible
  below it without scrolling, and redraws to a new width when the pane
  resizes.

  Measured today: `burndownOptions` (public/app.js) hard-codes
  `width: 560, height: 230`, and its host div `.app-burndown-canvas`
  (public/styles.css) hard-codes `width: 560px` — a fixed canvas no resize
  listener ever touches, so neither scenario below can pass against the
  current code.

  Scenario: at a 1280x800 desktop viewport the burndown canvas fills most of the analytics pane and the caption and forecast card stay visible without scrolling
    Given a project named "Burndown Fill Project" is registered
    And an online agent "burndown-fill-agent" with message "building" is registered on that project
    And a CR queue registering cr "CR-BURNDOWN-FILL" titled "burndown pane fill fixture" in wave "1" is posted for that project
    And the viewport is 1280x800
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    And I tap the roadmap release band
    Then the burndown chart canvas is at least 90% of the analytics pane's content width
    And the burndown chart canvas is at least 50% of the analytics pane's content height
    And the burndown caption and the forecast card are visible without scrolling the analytics pane

  Scenario: the burndown canvas redraws narrower when the analytics pane's viewport shrinks
    Given a project named "Burndown Resize Project" is registered
    And an online agent "burndown-resize-agent" with message "building" is registered on that project
    And a CR queue registering cr "CR-BURNDOWN-RESIZE" titled "burndown pane resize fixture" in wave "1" is posted for that project
    And the viewport is 1280x800
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    And I tap the roadmap release band
    Then the burndown chart canvas is at least 90% of the analytics pane's content width
    And the burndown chart canvas width is noted
    When the viewport is 1000x800
    Then the burndown chart canvas is at least 90% of the analytics pane's content width
    And the burndown chart canvas is narrower than the noted width
