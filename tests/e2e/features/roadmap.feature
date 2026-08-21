Feature: CR-CRU-014 §S3 — the execution roadmap tab: a queued CR's row and its live-derived status
  §S3's roadmap tab renders the registered CR queue as a table whose per-CR
  status badge is DERIVED, zero extra reporting: PENDING with no plan filed,
  IN_PROGRESS while an open plan exists, COMPLETED once the plan closes with a
  merge commit. This scenario drives the REAL server through the same routes a
  wrapped client uses (POST …/queue, POST …/plans, PATCH …/plans/<id>) and
  asserts the SPA's own DOM row flip in place over SSE — never a fixture
  stubbed into the page.

  Scenario: a registered CR's roadmap row flips PENDING → IN_PROGRESS → COMPLETED live as its plan is filed and closed
    Given a project named "RM Lifecycle" is registered
    And an online agent "rm-lifecycle" with message "roadmap runner" is registered on that project
    And a CR queue registering cr "CR-RM-100" titled "Roadmap lifecycle" in wave "5" is posted for that project
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    Then the roadmap row for "CR-RM-100" shows status "PENDING" within 2 seconds
    When a cycle plan is filed for cr "CR-RM-100" with a cycle labelled "C1"
    Then the roadmap row for "CR-RM-100" shows status "IN_PROGRESS" within 3 seconds
    When cycle 1 of that plan is activated
    And cycle 1 of that plan is marked done
    And the plan is closed with merge commit "deadbeef01"
    Then the roadmap row for "CR-RM-100" shows status "COMPLETED" within 3 seconds
