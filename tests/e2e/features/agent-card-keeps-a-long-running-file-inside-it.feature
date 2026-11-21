Feature: An agent's card keeps a long running file inside it

  While an agent's run streams, its card in the project pane reads
  "running <done>/<total> · <current file>". A test path can be far longer
  than the card is wide, with no break point in it. The card keeps the count
  whole and cuts the file from its start behind a leading "…", so the file's
  end — its name, the part that tells two files apart — stays on screen. The
  cut is visual only: the line's text keeps the whole path, the path's
  characters are drawn in their own order, and the file part carries the
  whole path as its hover title. The line stays one line inside the card, and
  the project pane never scrolls sideways.

  The project pane has no resizer, so its widths are the board's three screen
  bands — phone, tablet and desktop — and each is checked in the board's
  three row densities. The card's other lines (the agent's id, its message,
  its idle line) wrap inside the card when they hold one very long token.

  Everything here is the real board: the run opens through the run-start
  route and its batch goes to the stream route, and the page moves on the
  board's own throttled live frames. Every wait is on the page, bounded by a
  few frame cadences. On the phone band the project pane is a foot strip
  until it is tapped open as a sheet, so the card is measured in that sheet.

  Scenario Outline: at the <band> band in <density> density a streaming card keeps its count whole and cuts its long file from the start
    Given a project named "Long File <band> <density> Project" is registered
    And an online agent "long-file-runner" with message "suite starting" is registered on that project
    And the board's row density is "<density>"
    And the viewport is <width>x<height>
    When I open the workspace for that project
    And a run is started for agent "long-file-runner" on that project
    Then the agent row for "long-file-runner" shows the agent streaming and reads "suite starting" within 6 seconds
    When that run's first stream batch lands for agent "long-file-runner" with 16 of 1943 tests done, the last in the long file
    Then the agent row for "long-file-runner" reads "running 16/1943 · " and then the whole long file within 6 seconds
    When the project pane's agents are on screen
    Then the board is drawn at density "<density>"
    And the long file is wider than the card of "long-file-runner"
    And the card of "long-file-runner" draws "running 16/1943" in full
    And the card of "long-file-runner" draws the long file's last character inside the card and none of its first characters
    And the card of "long-file-runner" draws a "…" at the long file's left edge
    And the card of "long-file-runner" draws its running line's characters in their own order
    And the card of "long-file-runner" draws its running line as one line inside the card
    And the project pane has no horizontal overflow
    And the file part of the running line of "long-file-runner" carries the whole long file as its hover title

    Examples:
      | band    | width | height | density     |
      | phone   | 412   | 839    | comfortable |
      | phone   | 412   | 839    | compact     |
      | phone   | 412   | 839    | ultra       |
      | tablet  | 820   | 1180   | comfortable |
      | tablet  | 820   | 1180   | compact     |
      | tablet  | 820   | 1180   | ultra       |
      | desktop | 1280  | 800    | comfortable |
      | desktop | 1280  | 800    | compact     |
      | desktop | 1280  | 800    | ultra       |

  Scenario: a streaming card whose file fits draws the file whole, with no "…"
    Given a project named "Short File Project" is registered
    And an online agent "short-file-runner" with message "suite starting" is registered on that project
    And the viewport is 1280x800
    When I open the workspace for that project
    And a run is started for agent "short-file-runner" on that project
    Then the agent row for "short-file-runner" shows the agent streaming and reads "suite starting" within 6 seconds
    When that run's first stream batch lands for agent "short-file-runner" with 2 of 6 tests done, the last in "src/short.test.ts"
    Then the project pane's agent row for "short-file-runner" reads "running 2/6 · src/short.test.ts" within 6 seconds
    When the project pane's agents are on screen
    Then the card of "short-file-runner" draws every character of its running line inside the card
    And the card of "short-file-runner" draws no "…" on its running line
    And the card of "short-file-runner" draws its running line as one line inside the card
    And the project pane has no horizontal overflow

  Scenario Outline: at the <band> band a card whose message is one long token keeps it inside the card
    Given a project named "Long Message <band> Project" is registered
    And an online agent "long-message-runner" is registered on that project with one 240-character token as its message
    And the viewport is <width>x<height>
    When I open the workspace for that project
    And a run is started for agent "long-message-runner" on that project
    Then the agent row for "long-message-runner" reads that long token within 6 seconds
    When the project pane's agents are on screen
    Then every character of that long token is drawn inside the card that holds it
    And the project pane has no horizontal overflow

    Examples:
      | band    | width | height |
      | phone   | 412   | 839    |
      | tablet  | 820   | 1180   |
      | desktop | 1280  | 800    |

  Scenario: a card whose agent id is one long token keeps it inside the card
    Given a project named "Long Agent Id Project" is registered
    And an online agent whose id is one 160-character token is registered on that project
    And the viewport is 1280x800
    When I open the workspace for that project
    Then the project pane shows the card of that long-id agent within 6 seconds
    When the project pane's agents are on screen
    Then every character of that long token is drawn inside the card that holds it
    And the project pane has no horizontal overflow

  Scenario: a card whose idle line holds one long token keeps it inside the card
    Given a project named "Long Idle Line Project" is registered
    And an online agent "long-idle-runner" with message "warming up" is registered on that project
    And a passing 1-test run is ingested for agent "long-idle-runner" on that project
    And an online agent "long-idle-runner" is registered on that project with one 240-character token as its message
    And the viewport is 1280x800
    When I open the workspace for that project
    Then the agent row for "long-idle-runner" reads an idle line holding that long token within 6 seconds
    When the project pane's agents are on screen
    Then every character of that long token is drawn inside the card that holds it
    And the project pane has no horizontal overflow
