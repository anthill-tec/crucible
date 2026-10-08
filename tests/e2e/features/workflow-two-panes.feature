Feature: the Workflow tab is two independently scrolling panes on desktop, and two sub-tabs on a phone
  BDD layer expression of CR-CRU-172 §S1/AC2
  (docs/changes/CR-CRU-172-the-workflow-tab-splits-into-now-and-history.md),
  governed by storyboard F22 (.lavish/crucible-v2-design.html, "Workflow in
  two panes — Now, and a History of releases…", "Now … its own scroll" /
  "History … its own scroll") and the phone card's own line ("Now and
  History become two sub-tabs; the rows are the toggles (F15d)"). Driven
  against the REAL served SPA + REAL server, house style (Gherkin +
  playwright-bdd, not a bespoke .e2e.ts file).

  Today both `[data-testid="workflow-now"]` and `[data-testid="workflow-history"]`
  render inside the SAME single `[data-testid="pane-scroll"]` box
  (WorkflowFeed, public/app.js) — one shared scroller, no phone sub-tab
  split at all. Every assertion below that depends on independent
  scrolling, a height cap, or a phone sub-tab therefore has no code path
  producing it yet.

  Reuses seeding.steps.ts's project step, navigation.steps.ts's "I open the
  workspace for that project", workflow.steps.ts's "I click the {string}
  workspace tab", and pane-scroll.steps.ts's "the viewport is {int}x{int}"
  wherever they already say exactly what's needed; only the bulk-fixture
  filing steps and the pane-independence / half-height / phone-sub-tab
  assertions are new here.

  Every project/cr name below is namespaced "W2P " / "CR-W2P-…" to stay
  clear of the other features sharing that instance. Results are ingested
  with tier "e2e" by the orchestrator's ingest step, not by this suite.

  Scenario: at the desktop band, Now sits above History, each scrolls independently of the other, and Now never grows past half the Workflow pane's height
    Given the viewport is 1280x800
    And a project named "W2P Overflow Project" is registered
    And a cycle plan is filed for cr "CR-W2P-1" with 40 cycles
    And 32 closed CR plans are filed and merged under wave "1" for a long History
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then Now sits above History in document order
    And Now's pane and History's pane each scroll independently of the other
    And Now's pane height is at most half of the Workflow pane's height

  Scenario: at the phone band, the Workflow tab renders Now and History as two full-width toggle sub-tabs, Now selected on entry, and selecting History hides Now and shows the wave list
    Given the viewport is 390x844
    And a project named "W2P Phone Project" is registered
    And a cycle plan is filed for cr "CR-W2P-2" with a cycle labelled "c1 phone"
    And 3 closed CR plans are filed and merged under wave "1" for a long History
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the Workflow tab shows Now and History as two full-width toggle sub-tabs
    And the "Now" sub-tab is selected
    And the Now pane is visible
    And the History pane is not visible

    When I select the "History" sub-tab
    Then the "History" sub-tab is selected
    And the Now pane is not visible
    And the History pane is visible
    And the history lens shows a cr group for "CR-W2P-H1" with rollup "1 cycles ✓"

  Scenario: a title renders above and outside each pane on the desktop band, and no title renders above either pane on the phone band — the sub-tab rows are the titles there
    Given the viewport is 1280x800
    And a project named "W2P Pane Titles Project" is registered
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then a title reading "Now" renders above and outside "Now" pane
    And a title reading "History" renders above and outside "History" pane

    When the viewport is 390x844
    Then the Workflow tab shows no title above either pane
