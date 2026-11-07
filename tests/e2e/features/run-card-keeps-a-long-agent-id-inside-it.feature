Feature: A run card keeps a long agent id inside it

  A run card names the agent that ran it, then its tier and badges, and ends
  in the run's ratio pill at its right edge. An agent id can be far wider
  than the card, with no place to break it. The id is cut with an ellipsis
  inside the card, the card stays no wider than the pane that holds it, and
  the ratio pill stays in view at the card's right edge, so the run's
  pass/fail reading is visible without scrolling the feed sideways. The full
  id is still the card's text; only its drawing is cut.

  Checked on the Runs tab and on home, at the desktop width (1280x800) and at
  the phone band (412x839, the repo's chromium-mobile Pixel 7 viewport),
  resizing the default chromium project through the shared viewport step.

  Everything is the real board: the run goes through the parsed-run route
  under an agent id of 199 characters with no space or hyphen in it, and the
  card is the one the page draws for that run. Every project name is
  namespaced "WIDEID …" to stay clear of other features sharing the board.

  Scenario Outline: on the Runs tab at <viewport>, a run card's long agent id ends in an ellipsis inside the card, the card is no wider than the pane and its ratio pill is in view
    Given the viewport is <viewport>
    And a project named "<project>" is registered
    And a passing run whose agent id is a 199-character word with no break in it is ingested on that project
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then that run card is no wider than its pane
    And that run card's agent id ends in an ellipsis inside the card
    And that run card's ratio pill is wholly inside the card and the viewport without scrolling sideways
    And no pane scrolls horizontally

    Examples:
      | viewport | project             |
      | 1280x800 | WIDEID Runs Desktop |
      | 412x839  | WIDEID Runs Phone   |

  Scenario Outline: on home at <viewport>, a run card's long agent id ends in an ellipsis inside the card, the card is no wider than the pane and its ratio pill is in view
    Given the viewport is <viewport>
    And a project named "<project>" is registered
    And a passing run whose agent id is a 199-character word with no break in it is ingested on that project
    When I open the home page
    Then that run card is no wider than its pane
    And that run card's agent id ends in an ellipsis inside the card
    And that run card's ratio pill is wholly inside the card and the viewport without scrolling sideways

    Examples:
      | viewport | project             |
      | 1280x800 | WIDEID Home Desktop |
      | 412x839  | WIDEID Home Phone   |
