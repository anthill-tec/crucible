@waits-on-setup
Feature: Scenarios that wait on the failed setup

  Scenario: the first scenario that never runs
    Given a passing step

  Scenario: the second scenario that never runs
    Given a passing step
