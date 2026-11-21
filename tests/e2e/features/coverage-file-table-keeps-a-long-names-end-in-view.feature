Feature: The coverage file table keeps the end of a long file name in view

  A run's coverage is listed file by file, on the project's Coverage tab and
  on the run's own page. A row shows its file's name without the directory
  every file of the run shares. A name can still be far wider than its cell:
  on a desktop browser the cell cuts it on the left, so the name's end — the
  file itself, the part that tells two rows apart — stays on screen, on one
  line. The cut is visual only: the characters are drawn in their own order,
  and the row carries the whole name, as the report wrote it, as its hover
  title. A name that fits is drawn whole.

  Everything here is the real board: the run is filed through the ingest
  route with an lcov report, and the page draws what the board decoded and
  stored. What is drawn is measured per character, never read off the text.

  Scenario: on the Coverage tab a file name wider than its cell is cut on the left, so its end stays in view
    Given a project named "Long Coverage Name Tab Project" is registered
    And a green run whose coverage report names one very long file and two short ones is ingested for agent "long-cov-name-tab-agent"
    And the viewport is 1280x800
    When I open the workspace for that project
    And I click the "Coverage" workspace tab
    Then the coverage file table lists 3 files
    And the long coverage file name is wider than the cell it is drawn in
    And the long coverage file name's last character is drawn and none of its first characters
    And the long coverage file name is drawn on one line, its characters in their own order
    And the long coverage file's row carries its whole name as its title
    And a short coverage file name is drawn whole on one line

  Scenario: on a run's own page a file name wider than its cell is cut on the left, so its end stays in view
    Given a project named "Long Coverage Name Run Project" is registered
    And a green run whose coverage report names one very long file and two short ones is ingested for agent "long-cov-name-run-agent"
    And the viewport is 1280x800
    When I open the run overlay directly at its cold URL under the workspace
    Then the run overlay is visible
    When I tap the run's coverage line
    Then the coverage file table lists 3 files
    And the long coverage file name is wider than the cell it is drawn in
    And the long coverage file name's last character is drawn and none of its first characters
    And the long coverage file name is drawn on one line, its characters in their own order
    And the long coverage file's row carries its whole name as its title
    And a short coverage file name is drawn whole on one line
