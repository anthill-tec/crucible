@main
Feature: Scenarios the reporter streams

  Background:
    Given the background is laid

  Scenario: every step passes
    Given a passing step
    When another passing step runs
    Then the scenario passes

  Scenario: a step fails
    Given a passing step
    When a step fails on purpose
    Then a step that never runs

  @before-hook-fails
  Scenario: a Before hook fails
    Given a passing step

  Scenario: passes on its second attempt
    Given a step that fails on the first attempt only
    Then the scenario passes

  @fail
  Scenario: an expected failure
    Given a passing step
    When a step fails on purpose

  Rule: a rule groups its scenarios

    Scenario: a scenario under a rule
      Given a passing step
