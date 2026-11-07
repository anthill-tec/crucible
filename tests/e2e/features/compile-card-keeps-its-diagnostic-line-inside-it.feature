Feature: A compile card keeps its diagnostic line inside it

  A compile card previews its first diagnostics, one line each
  ("file:line — message"). A compiler message can be far longer than the card
  is wide. The line stays one line and ends in an ellipsis inside the card;
  the card stays as wide as its timeline, no wider than the pane that holds
  it, so one long message never widens the card or makes the feed scroll
  sideways. The timeline's rows skip their work while off screen, and that
  must not change what a row shows or how wide it is.

  Checked on the Runs tab and on home, at the desktop width (1280x800) and at
  the phone band (412x839, the repo's chromium-mobile Pixel 7 viewport),
  resizing the default chromium project through the shared viewport step.

  A row whose unbreakable content (a very long agent id) overflows still lets
  the pane scroll sideways to it: that half is the dual-axis scenario of
  viewport-dual-axis-scroll.feature, which this feature does not repeat.

  Everything is the real board: the compile report goes through the compile
  route, and the card is the one the page draws for it. Every project name is
  namespaced "DIAGLINE …" to stay clear of other features sharing the board.

  Scenario Outline: on the Runs tab at <viewport>, a compile card's long diagnostic line ends in an ellipsis inside the card and the card is no wider than the pane
    Given the viewport is <viewport>
    And a project named "<project>" is registered
    And a compile report whose first error carries a 420-character message is ingested for agent "<agent>"
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then that compile card's first diagnostic line holds the whole message on one line
    And that compile card's first diagnostic line ends in an ellipsis inside the card
    And that compile card is no wider than its pane
    And no pane scrolls horizontally

    Examples:
      | viewport | project                   | agent                 |
      | 1280x800 | DIAGLINE Runs Desktop     | diagline-runs-desktop |
      | 412x839  | DIAGLINE Runs Phone       | diagline-runs-phone   |

  Scenario Outline: on home at <viewport>, a compile card's long diagnostic line ends in an ellipsis inside the card and the card is no wider than the pane
    Given the viewport is <viewport>
    And a project named "<project>" is registered
    And a compile report whose first error carries a 420-character message is ingested for agent "<agent>"
    When I open the home page
    Then that compile card's first diagnostic line holds the whole message on one line
    And that compile card's first diagnostic line ends in an ellipsis inside the card
    And that compile card is no wider than its pane

    Examples:
      | viewport | project                   | agent                 |
      | 1280x800 | DIAGLINE Home Desktop     | diagline-home-desktop |
      | 412x839  | DIAGLINE Home Phone       | diagline-home-phone   |
