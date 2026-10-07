Feature: the Roadmap's burndown chart draws F16's projection and states a refused forecast inside the plot
  §S2 of the CR that revisits the release burndown (docs/changes,
  "the burndown fills its pane and draws F16's projection"): with a dated
  forecast the chart draws the today marker, the P50 and P80 traces (date
  labels, shaded band between them) and the labelled target; with a refused
  forecast (`insufficient_history`, `unpointed`) the plot area states the
  refusal where the traces would be and draws no traces (F18 §3, "When the
  forecast refuses").

  A dated forecast needs three real completed calendar weeks of pointed
  merge history (src/analytics.ts), which no sequence of real-route posts
  can manufacture inside one e2e scenario — these scenarios intercept the
  two analytics GETs the chart's draw already depends on
  (tests/e2e/steps/burndown-analytics-mock.ts explains why and documents the
  real shape every mocked body still carries), so everything downstream of
  those two reads — navigation, the pane, uPlot, the draw hook, the DOM it
  produces — is the real, unmodified client code under test.

  This CR's own observable contract (documented for GREEN in the RED
  report): the chart host `[data-testid="burndown-chart"]` carries
  `data-burndown-forecast="dated"|"refused"`; a sibling
  `[data-testid="burndown-chart-labels"]` holds one element per label the
  draw hook placed, each tagged `data-label-kind`, `data-label-text` and
  (when actually drawn) `data-label-drawn="true"`.

  CR-CRU-161 §S4/AC4 extends that same contract with the trace geometry
  itself: with a dated forecast the host ALSO carries `data-p50-line` and
  `data-p80-line` — each the drawn trace's own `x,y` vertex pairs (CSS px,
  space-separated, drawing order, the SAME local space `data-actual-line`
  already uses), starting at the today marker's own drawn point and ending
  on the zero line at that trace's own date; a refused forecast carries
  neither attribute at all (burndown-analytics-mock.ts's
  `BurndownTraceExpectation` documents the real timestamps a test
  interpolates the expected pixel from).

  Scenario: with a dated forecast the burndown draws the today marker, the P50 and P80 traces with their date labels, the shaded band and the labelled target
    Given a project named "Burndown Projection Project" is registered
    And an online agent "burndown-projection-agent" with message "building" is registered on that project
    And a CR queue registering cr "CR-FIX-001" titled "burndown projection fixture" in wave "1" is posted for that project
    And the viewport is 1280x800
    And the release's burndown and forecast are mocked with a dated forecast
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    And I tap the roadmap release band
    Then the burndown chart states its forecast as "dated"
    And the burndown chart draws the expected today, P50, P80 and target labels
    And the burndown chart shows the P50 and P80 band
    And the burndown chart draws the P50 and P80 traces from today to their own zero dates
    And the P50 and P80 traces end at different dates

  Scenario: with a forecast refused for insufficient history the plot states the refusal and draws no traces
    Given a project named "Burndown Refusal History Project" is registered
    And an online agent "burndown-refusal-history-agent" with message "building" is registered on that project
    And a CR queue registering cr "CR-FIX-002" titled "burndown refusal fixture" in wave "1" is posted for that project
    And the viewport is 1280x800
    And the release's burndown and forecast are mocked with a forecast refused for insufficient history
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    And I tap the roadmap release band
    Then the burndown chart states its forecast as "refused"
    And the burndown chart draws a refusal label naming the real refusal it was answered
    And the burndown chart draws no P50 or P80 label
    And the burndown chart hides the P50 and P80 band
    And the burndown chart draws no P50 or P80 trace

  Scenario: with a forecast refused for unpointed CRs the plot states the refusal and draws no traces
    Given a project named "Burndown Refusal Unpointed Project" is registered
    And an online agent "burndown-refusal-unpointed-agent" with message "building" is registered on that project
    And a CR queue registering cr "CR-FIX-003" titled "burndown unpointed refusal fixture" in wave "1" is posted for that project
    And the viewport is 1280x800
    And the release's burndown and forecast are mocked with a forecast refused for unpointed CRs
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    And I tap the roadmap release band
    Then the burndown chart states its forecast as "refused"
    And the burndown chart draws a refusal label naming the real refusal it was answered
    And the burndown chart draws no P50 or P80 label
    And the burndown chart hides the P50 and P80 band
    And the burndown chart draws no P50 or P80 trace
