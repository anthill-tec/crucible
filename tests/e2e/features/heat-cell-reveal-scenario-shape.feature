Feature: a heat-strip click locates a scenario row in a playwright-bdd run
  A run of framework playwright-bdd is drawn in the scenario shape: one suite
  per feature and browser, a scenario its leaf, the scenario's Gherkin steps
  under it. Every row a heat cell can locate there is a scenario row. A
  loaded scenario's cell locates that scenario's row. A synthetic cell, drawn
  for a suite not yet loaded, loads the suite and locates its first failing
  scenario's row when the cell is red, else its first scenario's row.

  Each run is streamed to the board as the bun client streams a
  playwright-bdd target: opened, its crucible-events stream posted, and
  closed with codec crucible-events.

  Scenario: A loaded scenario's heat cell scrolls its scenario row into the pane's view and blinks it
    Given a project named "Heat Reveal Scenario Shape Loaded Project" is registered
    And a playwright-bdd run is streamed for agent "agent-heat-shape-loaded" with three all-green features of two scenarios each
    When I open the run overlay directly at its cold URL
    And I click the heat cell of the scenario "Alpha closes the catalogue"
    Then the scenario row "Alpha closes the catalogue" carries the locate-blink class
    And the scenario row "Alpha closes the catalogue" is scrolled within the pane-scroll's visible area
    And exactly one row in the overlay carries the locate-blink class

  Scenario: A green synthetic cell of a folded feature not yet loaded opens it and blinks its first scenario's row
    Given a project named "Heat Reveal Scenario Shape Green Synth Project" is registered
    And a playwright-bdd run is streamed for agent "agent-heat-shape-green-synth" with three all-green features of two scenarios each
    When I open the run overlay directly at its cold URL
    And I click a passing synthetic heat cell of the feature "Gamma"
    Then the scenario row "Gamma lists the shelves" carries the locate-blink class
    And the scenario row "Gamma lists the shelves" is scrolled within the pane-scroll's visible area
    And the scenario row "Gamma sorts the shelves" does not carry the locate-blink class
    And exactly one row in the overlay carries the locate-blink class

  Scenario: A red synthetic cell of a suite still loading blinks its first failing scenario's row
    Given a project named "Heat Reveal Scenario Shape Red Synth Project" is registered
    And a playwright-bdd run is streamed for agent "agent-heat-shape-red-synth" with a green feature and a feature "Beta" whose first scenario passes and next two fail
    And the board holds its first read of the feature "Beta"
    When I open the run overlay directly at its cold URL
    And I click a failing synthetic heat cell of the feature "Beta"
    Then the scenario row "Beta refunds the card" carries the locate-blink class
    And the scenario row "Beta refunds the card" is scrolled within the pane-scroll's visible area
    And the scenario row "Beta voids the order" does not carry the locate-blink class
    And exactly one row in the overlay carries the locate-blink class
