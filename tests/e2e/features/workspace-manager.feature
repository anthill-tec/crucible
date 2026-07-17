Feature: CR-CRU-012 workspace manager — archive UI round-trip (§S2, §S1b)
  BDD layer expression of CR-CRU-012's E2E AC: "open manager via chip → add
  project → edit its name → archive it → badge disappears live → unarchive
  → badge returns; results ingested tier:'e2e'." Exercises the manager
  slide-over (cycle 27 — list/edit-in-place/add) end to end with the
  archive/unarchive half (cycle 28) added on top: per-project archive
  action gated by an in-row confirm, the "archived (N)" fold, and the
  unarchive action, all driving the SAME live home-badge surface via the
  refetch/SSE contract.

  This feature seeds its own project through the manager UI itself (no API
  seeding helper — the whole point is the manager's OWN add-project form),
  so it must sort alphabetically AFTER shell-storyboard.feature ("w" > "s")
  the way workflow.feature already does, to let that feature's F1 empty-DB
  precondition observe a truly empty database before this feature's
  scenario seeds a project into the shared server/db instance. Every
  project name below is namespaced "WM …" to stay clear of the other
  features sharing that instance. Results are ingested with tier "e2e" by
  the orchestrator's ingest step, not by this suite.

  Scenario: Manager round-trip — add a project, rename it, archive it with a live badge removal, then unarchive it to bring the badge back
    Given I open the home page
    When I click the manage chip
    Then the projects manager is visible
    When I add a project named "WM Round Trip Co" of type "backend" with sutRoot "/tmp/wm-round-trip" via the manager
    Then the manager lists a project row for "WM Round Trip Co"
    When I edit that project's name to "WM Round Trip Co Renamed" via the manager
    Then the manager lists a project row for "WM Round Trip Co Renamed"
    And a projects-row badge for "WM Round Trip Co Renamed" is visible
    When I archive that project via the manager
    Then the badge for "WM Round Trip Co Renamed" disappears from the home projects row within 2 seconds
    And the manager no longer lists a project row for "WM Round Trip Co Renamed"
    When I expand the archived fold
    Then the archived fold header reads "archived (1)"
    When I unarchive that project via the manager
    Then a projects-row badge for "WM Round Trip Co Renamed" becomes visible within 2 seconds without reloading
    And the manager lists a project row for "WM Round Trip Co Renamed"
