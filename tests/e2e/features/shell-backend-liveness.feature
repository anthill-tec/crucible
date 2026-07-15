Feature: CR-CRU-006 shell — backend liveness (own server process)
  A standalone server process, killed and restarted out from under a live
  page, to prove the client's own liveness/reconnect contract. Converted
  from tests/e2e/shell.e2e.ts's "backend liveness" describe block (see the
  RED-agent report mapping table for the old-test → scenario mapping).

  Scenario: F10 backend down greys the UI
    Given a standalone Crucible server is running on its own port
    When I open that server's home page
    Then the health pill does not contain "unreachable" and shows a live-green dot
    When the standalone server process is killed
    Then the health pill contains "unreachable" within 28 seconds
    And the timeline is greyed within 5 seconds
    When the standalone server process is restarted on the same port and scratch database
    Then the health pill no longer contains "unreachable" within 10 seconds
    And the timeline is no longer greyed within 10 seconds
