Feature: A shelf of jars

  A fixture for the Gherkin scenario reader: one Scenario Outline with two
  Examples rows, between two plain scenarios. This free-form description
  is not a step, and neither is a comment.

  # A comment is not a step.
  Scenario: an empty shelf holds no jars
    Given an empty shelf
    When I count the jars on it
    Then there are 0 jars

  Scenario Outline: a shelf of <count> <colour> jars weighs <weight> grams
    Given a shelf with <count> <colour> jars
    # A comment inside an outline is not a step either.
    And each jar weighs <unit> grams
    When I weigh the shelf
    Then it weighs <weight> grams
    And the label still reads "<label>"

    Examples:
      | count | colour | unit | weight |
      | 2     | red    | 50   | 100    |
      |   3   |  blue  | 40   | 120    |

  Scenario: a full shelf takes no more jars
    Given a shelf with 12 jars
    When I add a jar
    Then the shelf refuses it
