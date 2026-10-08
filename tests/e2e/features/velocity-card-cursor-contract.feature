Feature: the Velocity card and the Vitals cards show no pointer cursor, only the day or week switch does

  CR-CRU-174 §S2 — "Neither the Velocity card nor the Vitals cards (no click
  behaviour) take a pointer cursor or a hover state; the switch's two
  options do." F18 "1b · per day or per week" card c: "Only the switch is
  clickable. The card itself takes no pointer cursor and no hover; nor do
  the Vitals cards, which have no click either."

  Measured on this branch: `.app-card` (public/styles.css) sets
  `cursor: pointer` and `.app-velocity-card` carries no override, so the
  Velocity card still shows a pointer cursor with no click handler.

  Scenario: the Velocity card and both Vitals cards show no pointer cursor while the switch options do
    Given a project named "Cadence Cursor Project" is registered
    And an online agent "cadence-cursor-agent" with message "building" is registered on that project
    And a CR queue registering cr "CR-CADENCE-002" titled "cursor contract fixture" in wave "1" is posted for that project
    And velocity reads for that project are mocked with a day or week switch fixture
    When I open the workspace for that project
    Then the Velocity card shows no pointer cursor
    And the cycle health card shows no pointer cursor
    And the coverage trend card shows no pointer cursor
    And the velocity view switch day option shows a pointer cursor
    And the velocity view switch week option shows a pointer cursor
    And an agent row in the Project pane still shows a pointer cursor

  Scenario: a projects list card on the home page still shows a pointer cursor
    Given a project named "Cadence Cursor Guard Project" is registered
    When I open the home page
    Then a projects list card on the home page shows a pointer cursor
