Feature: The run detail's failure jump counts the failures it has not yet opened

  A failing run opens with its tree minimized and no failure box open, so
  the failure jump in the run-detail header counts every failure: a run
  with three reads "▸ 3 more failures". Each press opens the next failure
  in walk order — the failing suites in tree order, their failing leaves in
  order — starting from the first, and the count drops by one. From the
  press that opens the last unopened failure on, the label names the open
  failure's place in walk order ("▸ failure k of N"), and further presses
  keep cycling, wrapping from the last failure to the first. After every
  press exactly one failure box is open, on the failing leaf the label's
  place names.

  The run below holds three failing leaves across two failing suites, with
  an all-pass suite between them; its walk order is FJ-alpha-1,
  FJ-alpha-2, FJ-gamma-3.

  Scenario: Five presses walk three failures from the first, counting down and then naming each failure's place
    Given a project named "Failure Jump Count Project" is registered
    And a run with three failing leaves across two failing suites is ingested for agent "agent-failure-jump-count"
    When I open the run overlay directly at its cold URL
    Then the run overlay is visible
    And the failure jump reads "▸ 3 more failures"
    And no failure box is open in the run detail
    When I press the failure jump
    Then the failure jump reads "▸ 2 more failures"
    And exactly one failure box is open, on the failing leaf the jump's place names in walk order
    When I press the failure jump
    Then the failure jump reads "▸ 1 more failure"
    And exactly one failure box is open, on the failing leaf the jump's place names in walk order
    When I press the failure jump
    Then the failure jump reads "▸ failure 3 of 3"
    And exactly one failure box is open, on the failing leaf the jump's place names in walk order
    When I press the failure jump
    Then the failure jump reads "▸ failure 1 of 3"
    And exactly one failure box is open, on the failing leaf the jump's place names in walk order
    When I press the failure jump
    Then the failure jump reads "▸ failure 2 of 3"
    And exactly one failure box is open, on the failing leaf the jump's place names in walk order
