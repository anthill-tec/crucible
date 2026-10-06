Feature: the Roadmap's burndown chart keeps every drawn label inside the plot and shows any step's full label on hover
  §S3 of the CR that revisits the release burndown (docs/changes,
  "the burndown fills its pane and draws F16's projection"): every label is
  drawn inside the plot area, never below or outside it. The today marker's
  label, the P50 and P80 labels and the target label are placed first and
  always shown. Step labels are then placed largest move first, each only
  where it fits without overlapping a label already placed; the steps left
  unlabelled are counted in one `+ N more` note inside the plot. Every step,
  labelled or not, shows its full label when the pointer rests on it (AC4).

  Builds on burndown-chart-draws-projection-and-states-refusal.feature's
  `data-burndown-forecast` / `[data-testid="burndown-chart-labels"]`
  contract with the position/hover half AC4 needs: the chart host also
  carries `data-plot-left/top/right/bottom` (the plot area's own box, CSS
  px, local to the canvas's own top-left corner — devicePixelRatio already
  divided out); each drawn label item also carries
  `data-label-x/y/w/h` in that SAME local space; every `kind="step"` item,
  drawn or not, is a real, hoverable element positioned over its step's
  point, and hovering or focusing it shows `[data-testid="burndown-chart-tooltip"]`
  carrying that step's full `data-label-text`.

  A 63-step history needs 63 real pointed merges spread across real
  calendar time — unreachable through the real routes inside one e2e
  scenario, for the same reason a dated forecast is (see
  burndown-analytics-mock.ts) — so this scenario mocks the two analytics
  reads with a 63-step fixture; everything downstream is the real client
  code under test.

  Scenario: with a 63-step history every drawn label stays inside the plot and none overlap, the projection labels always draw, the unlabelled count matches the "+ N more" note, and hovering an unlabelled step shows its full label
    Given a project named "Burndown Label Crowding Project" is registered
    And an online agent "burndown-label-crowding-agent" with message "building" is registered on that project
    And a CR queue registering cr "CR-FIX-004" titled "burndown label crowding fixture" in wave "1" is posted for that project
    And the viewport is 1280x800
    And the release's burndown and forecast are mocked with a 63-step history and a dated forecast
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    And I tap the roadmap release band
    Then every label the burndown chart drew sits inside the plot area
    And no two labels the burndown chart drew overlap
    And the burndown chart draws the expected today, P50, P80 and target labels despite 63 competing step candidates
    And the number of unlabelled steps equals the burndown chart's "+ N more" note
    And resting the pointer on an unlabelled step shows its full label
