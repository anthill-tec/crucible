Feature: CR-CRU-164 §S2/AC4 — the roadmap release band's verified-runs chip and its Runs-tab filter
  The roadmap's release band (zone 3 header, `roadmap-progress`) carries a
  "verified · N runs ↗" chip when the focused release has runs filed under
  it (`GET /api/v2/events?project=<key>&release=<label>`, §S2); clicking it
  opens the Runs tab filtered to that release.

  Measured against this branch: no "verified" text and no by-release events
  fetch exist anywhere in `public/app.js` (also confirmed by the happy-dom
  half, `tests/roadmap-release-verified-runs-chip.test.ts`) — this scenario
  is expected to FAIL at every `Then` step below.

  Scenario: at a 1280x800 desktop viewport the verified-runs chip renders in the release band and clicking it opens the Runs tab filtered to that release
    Given a project named "Verify Chip Project" is registered
    And an online agent "verify-chip-agent" with message "building" is registered on that project
    And a CR queue registering cr "CR-VCHIP-1" titled "verified chip fixture" in wave "1" is posted for that project
    And 3 passing runs are filed under that release
    And the viewport is 1280x800
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    Then the roadmap release band shows the verified-runs chip reading "verified · 3 runs ↗"
    When I click the roadmap verified-runs chip
    Then the "Runs" workspace tab is active
    And the Runs pane shows exactly the 3 runs filed under that release
    And the Runs pane states it is filtered to that release with a way back to the unfiltered list
