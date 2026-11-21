Feature: The page's utility styles are a static stylesheet

  The dashboard's utility styles (Tailwind's theme variables, its base reset
  and the two utilities the Roadmap's terminal markers carry) are served as a
  static, vendored stylesheet rather than generated in the page by a runtime.
  The page loads no script that writes a stylesheet, links the static one
  after its own `/styles.css`, and no stylesheet in the document changes while
  a run opens, streams and closes, or when the Roadmap first renders. Every
  view still looks as it did: the computed styles of a named set of elements
  equal a baseline recorded in this browser while the runtime still loaded
  (tests/fixtures/page-computed-styles-baseline.json, which names each
  element's selector, the properties compared, and the viewport, theme and
  density it was taken at).

  Everything here is the real board: runs are ingested through the parsed
  runs route, the run opens through the run-start route, streams through the
  stream route and closes through the runs route, and the Roadmap's release
  and CR are put on the board through the release-proposal and queue routes.

  Scenario: The page loads no stylesheet-generating script and links the static utility stylesheet after its own
    Given a project named "SSL Static Styles Links Project" is registered
    When I open the home page
    Then the page loads no Tailwind runtime script
    And the page links the static Tailwind stylesheet after "/styles.css"

  Scenario: No stylesheet in the document changes while a run opens, streams and closes on the Runs tab
    Given a project named "SSR Static Styles Run Project" is registered
    And a passing 1-test run is ingested for agent "ssr-history" on that project
    And an online agent "ssr-streamer" with message "between runs" is registered on that project
    And agent "ssr-streamer" is the run's streaming agent
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    Then the Runs timeline shows 1 settled run cards within 10 seconds
    When I start watching the document's stylesheets
    And a run is started for agent "ssr-streamer" on that project
    Then the running card for "ssr-streamer" is on the Runs tab within 10 seconds
    When the run streams batch 1 of its five-batch stream through the stream route
    Then the running card for "ssr-streamer" reads "1/5" in "src/batch-1.test.ts" within 10 seconds
    When the run streams batch 2 of its five-batch stream through the stream route
    Then the running card for "ssr-streamer" reads "2/5" in "src/batch-2.test.ts" within 10 seconds
    When the run streams batch 3 of its five-batch stream through the stream route
    Then the running card for "ssr-streamer" reads "3/5" in "src/batch-3.test.ts" within 10 seconds
    When the run streams batch 4 of its five-batch stream through the stream route
    Then the running card for "ssr-streamer" reads "4/5" in "src/batch-4.test.ts" within 10 seconds
    When the run streams batch 5 of its five-batch stream through the stream route
    Then the running card for "ssr-streamer" reads "5/5" in "src/batch-5.test.ts" within 10 seconds
    When the run is closed through POST /api/v2/runs naming the crucible-events codec
    Then the closed run's card heads the Runs timeline of 2 settled run cards and no running card is left within 10 seconds
    And no stylesheet in the document changed while I watched

  Scenario: No stylesheet in the document changes when the Roadmap view first renders
    Given a project named "SSM Static Styles Roadmap Project" is registered
    And an online agent "ssm-roadmap" with message "roadmap runner" is registered on that project
    And a CR queue registering cr "CR-SSM-100" titled "Static styles roadmap" in wave "1" is posted for that project
    When I open the home page
    Then a projects-row badge for "SSM Static Styles Roadmap Project" is visible
    And the page's main thread has been quiet for 500 ms within 10 seconds
    And the page has drawn no Roadmap terminal yet
    When I start watching the document's stylesheets
    And I click the projects-row badge for "SSM Static Styles Roadmap Project"
    Then the "Roadmap" workspace tab is active
    And the roadmap row for "CR-SSM-100" shows status "PENDING" within 5 seconds
    And the Roadmap's start and end terminals are drawn within 5 seconds
    And no stylesheet in the document changed while I watched

  Scenario: The named elements keep the computed styles recorded under the runtime
    Given the viewport is 1280x800
    And a project named "SSB Static Styles Baseline Project" is registered
    And a passing 1-test run is ingested for agent "ssb-history" on that project
    And an online agent "ssb-streamer" with message "between runs" is registered on that project
    And agent "ssb-streamer" is the run's streaming agent
    And a CR queue registering cr "CR-SSB-100" titled "Static styles baseline" in wave "1" is posted for that project
    When I open the home page
    Then the board is drawn at the baseline's viewport, theme and density
    And the baseline's "home timeline card" keeps its recorded computed styles
    And the baseline's "home filter pulldown" keeps its recorded computed styles
    When I click the manage chip
    Then the projects manager is visible
    And the baseline's "manager drawer" keeps its recorded computed styles
    And the baseline's "manager form control" keeps its recorded computed styles
    When I open the workspace for that project
    And I click the "Runs" workspace tab
    And a run is started for agent "ssb-streamer" on that project
    And the run streams batch 1 of its five-batch stream through the stream route
    Then the running card for "ssb-streamer" reads "1/5" in "src/batch-1.test.ts" within 10 seconds
    And the project pane's agent row for "ssb-streamer" reads "running 1/5 · src/batch-1.test.ts" within 10 seconds
    And the baseline's "runs timeline card" keeps its recorded computed styles
    And the baseline's "running card" keeps its recorded computed styles
    And the baseline's "agent card" keeps its recorded computed styles
    When I click the event card for "ssb-history"
    Then the run overlay is visible
    And the baseline's "run detail header" keeps its recorded computed styles
    And the baseline's "run detail back button" keeps its recorded computed styles
    When I click the "← runs" chip
    And I click the "Roadmap" workspace tab
    Then the roadmap row for "CR-SSB-100" shows status "PENDING" within 5 seconds
    And the Roadmap's start and end terminals are drawn within 5 seconds
    And the baseline's "roadmap start terminal" keeps its recorded computed styles
    And the baseline's "roadmap end terminal" keeps its recorded computed styles
    And the baseline recording is complete
