Feature: CR-CRU-014 §S3 — the execution roadmap tab: a queued CR's row and its live-derived status
  §S3's roadmap tab renders the registered CR queue as a table whose per-CR
  status badge is DERIVED, zero extra reporting: IN_PROGRESS while an open plan
  exists, COMPLETED once the plan closes with a merge commit,
  COMPLETED_UNTRACKED when no plan is evidence of work (none filed, or all
  abandoned) but some release's crs names the CR, and PENDING otherwise. This
  scenario drives the REAL server through the same routes a
  wrapped client uses (POST …/release-proposals and POST …/queue/plan to put
  the CR on the board — CR-CRU-118 §S2 retired the release-less bulk post this
  scenario used to register through — then POST …/plans, PATCH …/plans/<id>) and
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

  # CR-CRU-147 §S2 (cycle 526, C4) — the dead-CR row: the STATUS cell names
  # the lifecycle state (never PENDING) once the CR is voided through the real
  # `POST …/queue/<cr>/void` route (§S1's own server route), its reason
  # never renders as row text, and the reason is reachable ONLY as the status
  # badge's tooltip on hover — asserted VISIBLE, not merely present in the DOM.
  # The reason is authored longer than the table is wide (F17's own measured
  # defect: "pushes every cell out of its column and runs off the right
  # edge"), so the table's own pane-scroll staying non-scrolling is the
  # geometry half of §S2's AC.
  Scenario: CR-CRU-147 §S2 — a voided CR's row names VOID (never PENDING), its long reason is a hover tooltip and never row text, and the table gains no horizontal scrollbar
    Given a project named "RM Dead CR" is registered
    And an online agent "rm-dead-cr" with message "roadmap dead cr runner" is registered on that project
    And a CR queue registering cr "CR-RM-200" titled "Roadmap dead cr fixture" in wave "9" is posted for that project
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    Then the roadmap row for "CR-RM-200" shows status "PENDING" within 2 seconds
    And the status badge for "CR-RM-200" shows no lifecycle tooltip yet
    When cr "CR-RM-200" is voided with reason "Voided at gap analysis 2026-09-24 (user ruling): the CI run this guarded no longer exists, the repository went public so minutes cost nothing, and the surface it once protected was retired outright in the same pass — re-open only if the repository is made private again and the surface returns."
    Then the roadmap row for "CR-RM-200" shows status "VOID" within 3 seconds
    And no pane scrolls horizontally
    When I hover the status badge for "CR-RM-200"
    Then its lifecycle tooltip states the reason "the CI run this guarded no longer exists"

  # Ruling 7 (2026-09-25, at VERIFY) — the badge already takes focus
  # (`tabindex="0"`, `aria-describedby`); this scenario drives that focus
  # with the keyboard rather than the mouse/touch the scenario above used,
  # and proves the tooltip stays in the accessibility tree once focus moves
  # away rather than vanishing outright.
  Scenario: CR-CRU-147 §S2 ruling 7 — a voided CR's status badge tooltip opens on keyboard focus and stays reachable, not hidden, once focus moves away
    Given a project named "RM Dead CR Keyboard" is registered
    And an online agent "rm-dead-cr-kb" with message "roadmap dead cr keyboard runner" is registered on that project
    And a CR queue registering cr "CR-RM-201" titled "Roadmap dead cr keyboard fixture" in wave "9" is posted for that project
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    Then the roadmap row for "CR-RM-201" shows status "PENDING" within 2 seconds
    And the status badge for "CR-RM-201" shows no lifecycle tooltip yet
    When cr "CR-RM-201" is voided with reason "Voided at gap analysis 2026-09-24 (user ruling): the keyboard reachability check needs its own dead CR, separate from the hover scenario's own fixture."
    Then the roadmap row for "CR-RM-201" shows status "VOID" within 3 seconds
    When I focus the status badge for "CR-RM-201"
    Then its lifecycle tooltip states the reason "the keyboard reachability check needs its own dead CR"
    When I move focus away from the status badge for "CR-RM-201"
    Then the status badge for "CR-RM-201" keeps its lifecycle tooltip in the accessibility tree while closed
