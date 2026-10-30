Feature: CR-CRU-017 §S3 — the run lifecycle on the timeline: a live running card that resolves in place, and the aborted state
  §S3's whole subject is a run the dashboard can watch: "Timeline shows an OPEN
  run as a live running… card (pulsing, elapsed timer off startedAt,
  SSE-updated) that resolves into the end event's card (or the aborted card) in
  place. A running card is NOT clickable (default cursor, no drill-down) until
  it resolves — the pointer cursor + drill-down enable only on the
  completed/aborted card (user rule). Drill-in of an aborted run shows the
  reason + whatever partial context exists. Workflow tab: an active cycle's
  open span shows its currently-running run live."

  CR-CRU-223 narrows that rule to a running card WITHOUT a live state, which
  is still not clickable (default cursor, no drill-down). A running card whose
  open run has a live state shows the run's progress — a bar at done of total,
  the current file, the failures so far — has the pointer cursor, and opens
  the live drill-in at /run/<runId>, which fills in as tests finish and, when
  the run settles, replaces its URL with the settled run's /run/<eventId>.

  Every scenario drives the REAL server through the same API a wrapped client
  uses (POST /api/v2/runs/start, then an ingest carrying that runId) and asserts
  the SPA's own DOM. The CR-CRU-017 scenarios stub nothing; the CR-CRU-223
  scenarios stub ONLY the two live reads (the open-run brief's `live` and
  GET /api/v2/runs/<runId>/live, through `page.route`, as
  burndown-analytics-mock.ts does), because the live state they answer is
  filled by CR-CRU-200. The abort path uses
  the §S1 auto-abort the server already owns (an open run whose agent has
  tombstoned is aborted `agent died`); §S2's explicit abort ROUTE is a later
  cycle and is deliberately not exercised here.

  Scenario: an OPEN run renders a running card whose elapsed timer actually advances, and that card refuses to be clicked while it is still running
    Given a project named "RL Running" is registered
    And an online agent "rl-running" with message "long run" is registered on that project
    And a run is started for agent "rl-running" on that project
    When I open the home page
    Then a running card for "rl-running" becomes visible within 2 seconds
    And that running card's elapsed timer advances within 3 seconds
    And that running card shows no ratio pill at all
    And that running card has the default cursor, not the pointer
    When I click that running card
    Then no run overlay opens and the URL still has no run path

  Scenario: ingesting the started run resolves the running card into the completed run card IN PLACE over SSE, and only then does drill-in become available
    Given a project named "RL Resolve" is registered
    And an online agent "rl-resolve" with message "resolving run" is registered on that project
    And a run is started for agent "rl-resolve" on that project
    And I have opened the home page
    And a running card for "rl-resolve" becomes visible within 2 seconds
    And I mark the page so a reload would be detectable
    When the started run is ingested as a passing 1-test run for agent "rl-resolve"
    Then the running card for "rl-resolve" disappears within 3 seconds
    And an event card for "rl-resolve" becomes visible within 2 seconds
    And the page was never reloaded
    And that card's ratio pill contains "1/1"
    And the event card for "rl-resolve" has the pointer cursor
    When I click the event card for "rl-resolve"
    Then the run overlay is visible

  Scenario: an ABORTED run gets its own struck/grey presentation carrying the reason, outside the pass/fail/pending palette, and drills in to that reason
    Given a project named "RL Abort" is registered
    And an online agent "rl-abort" with message "doomed run" is registered on that project
    And a run is started for agent "rl-abort" on that project
    And I have opened the home page
    And a running card for "rl-abort" becomes visible within 2 seconds
    When that project's agents are configured to tombstone almost immediately
    And the server settles that project's dead open runs
    Then an aborted run card for "rl-abort" becomes visible within 5 seconds showing reason "agent died"
    And the running card for "rl-abort" disappears within 3 seconds
    And that aborted card is struck through and greyed, and carries none of the pass, fail or pending classes
    And that aborted card has the pointer cursor
    When I click the aborted run card for "rl-abort"
    Then the run overlay is visible
    And the run overlay shows the abort reason "agent died"

  Scenario: the Workflow tab's ACTIVE cycle open span shows the run that is running right now
    Given a project named "RL Workflow" is registered
    And an online agent "rl-workflow" with message "cycle runner" is registered on that project
    And a cycle plan is filed for cr "CR-RL-017" with a cycle labelled "C1"
    And cycle 1 of that plan is activated
    And a run linked to that cycle is started for agent "rl-workflow"
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the active cycle's open span shows a running entry for "rl-workflow" within 3 seconds
    And that open-span running entry's elapsed timer advances within 3 seconds

  Scenario: CR-CRU-223 — a running card whose run has a live state shows the run's progress and has the pointer cursor
    Given a project named "RL Live Card" is registered
    And an online agent "rl-live-card" with message "streaming run" is registered on that project
    And a run is started for agent "rl-live-card" on that project
    And the board holds a live state for that run: 412 of 1280 finished in "test_relay.py" with 3 failures
    When I open the home page
    Then a running card for "rl-live-card" becomes visible within 2 seconds
    And that running card shows a progress bar at 32 percent, "412/1280", "test_relay.py" and "3 ✗"
    And that running card's elapsed timer advances within 3 seconds
    And that running card shows no ratio pill at all
    And that running card has the pointer cursor

  Scenario: CR-CRU-223 — clicking the live card opens the live drill-in at /run/<runId>, and a reload lands on the same live view
    Given a project named "RL Live Drill" is registered
    And an online agent "rl-live-drill" with message "streaming run" is registered on that project
    And a run is started for agent "rl-live-drill" on that project
    And the board holds a live state for that run: 412 of 1280 finished in "test_relay.py" with 3 failures
    And I have opened the home page
    And a running card for "rl-live-drill" becomes visible within 2 seconds
    When I open that running card's live drill-in
    Then the URL is the live drill-in of that run
    And the run overlay is visible
    And the live drill-in's header reads "live · 412/1280 · 409 ✓ 3 ✗"
    And the live drill-in lists the failures "test_acks_each_batch", "test_close_sends_the_rest" and "test_run_end_totals" in order
    And the live drill-in's passed row reads "409"
    When I reload the page
    Then the URL is the live drill-in of that run
    And the live drill-in's header reads "live · 412/1280 · 409 ✓ 3 ✗"
    And the live drill-in lists the failures "test_acks_each_batch", "test_close_sends_the_rest" and "test_run_end_totals" in order

  Scenario: CR-CRU-223 — after a change frame the live drill-in reads only the new failures and shows a fourth one without a reload
    Given a project named "RL Live Frame" is registered
    And an online agent "rl-live-frame" with message "streaming run" is registered on that project
    And an online agent "rl-live-bystander" with message "another run" is registered on that project
    And a run is started for agent "rl-live-frame" on that project
    And the board holds a live state for that run: 412 of 1280 finished in "test_relay.py" with 3 failures
    And I have opened the live drill-in of that run
    And the live drill-in lists the failures "test_acks_each_batch", "test_close_sends_the_rest" and "test_run_end_totals" in order
    And I mark the page so a reload would be detectable
    When the board's live state for that run gains the failure "test_resume_after_restart"
    And a change frame reaches the page when agent "rl-live-bystander" opens a run on that project
    Then the live drill-in lists "test_resume_after_restart" as its fourth failure within 3 seconds
    And the refresh read only the failures after the first 3
    And the live drill-in's header reads "live · 413/1280 · 409 ✓ 4 ✗"
    And the page was never reloaded

  Scenario: CR-CRU-223 — when the run settles the live drill-in replaces its URL with the settled run's, shows its detail, and Back leaves the run detail
    Given a project named "RL Live Settle" is registered
    And an online agent "rl-live-settle" with message "streaming run" is registered on that project
    And a run is started for agent "rl-live-settle" on that project
    And the board holds a live state for that run: 412 of 1280 finished in "test_relay.py" with 3 failures
    And I have opened the home page
    And a running card for "rl-live-settle" becomes visible within 2 seconds
    And I open that running card's live drill-in
    And the URL is the live drill-in of that run
    When the started run is ingested as a passing 1-test run for agent "rl-live-settle"
    Then the URL becomes the settled run's drill-in within 3 seconds
    And the run overlay is visible and contains the event id
    And the live drill-in's rows are gone
    When I go back in the browser
    Then the URL is the home page with no run path
    And an event card for "rl-live-settle" becomes visible within 2 seconds
    And the running card for "rl-live-settle" disappears within 3 seconds
