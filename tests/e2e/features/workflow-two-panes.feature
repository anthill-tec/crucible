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

  # Re-pin (approved by the orchestrator — user ruling 2026-10-08): the
  # half-pane cap on Now is withdrawn. Now grows with its content and never
  # scrolls; History takes the height Now leaves, with its own scroll.
  Scenario: at the desktop band, Now sits above History, Now grows with its content and never scrolls; History scrolls on its own
    Given the viewport is 1280x800
    And a project named "W2P Overflow Project" is registered
    And an orchestrator "w2p-orch-1" is registered on that project
    And a release "0.173.637" is proposed for that project
    And a cycle plan is filed for cr "CR-W2P-1" with 40 cycles
    And 32 closed CR plans are filed and merged under wave "1" for a long History
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then Now sits above History in document order
    And Now grows with its content and never scrolls
    And History scrolls on its own

  Scenario: at the phone band, the Workflow tab renders Now and History as two full-width toggle sub-tabs, Now selected on entry, and selecting History hides Now and shows the wave list
    Given the viewport is 390x844
    And a project named "W2P Phone Project" is registered
    And an orchestrator "w2p-orch-2" is registered on that project
    And a release "0.173.637" is proposed for that project
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

  # CR-CRU-178 §S1 — "Now and History read as two panes" (F24, option B,
  # APPROVED 2026-10-09): one card holding both, Now on a raised band under
  # its own header bar (live dot · NOW · "what is running"), a hatched
  # divider, History beneath under its own header bar (clock glyph ·
  # HISTORY · "only what is past"), the bar pinned while History's list
  # scrolls. The frame wins; agents raise disagreements. Spec:
  # docs/changes/CR-CRU-178-now-and-history-read-as-two-panes.md.
  #
  # Today NEITHER a header bar NOR a divider NOR a live dot NOR a split
  # card exists anywhere — WorkflowFeed mounts the small CR-CRU-172 §S1
  # titles directly against WorkflowNow()/WorkflowHistory(), with nothing
  # between them and no wrapping card (verified against public/app.js on
  # this branch). Every assertion below is therefore genuine RED.
  Scenario: at the desktop band, Now and History render inside one split card with a header bar on each, Now's band background differs from History's area, a divider is visible between them, and History's header bar stays visible while its list scrolls
    Given the viewport is 1280x800
    And a project named "W2P Split Card Project" is registered
    And an orchestrator "w2p-orch-3" is registered on that project
    And a release "0.173.639" is proposed for that project
    And a cycle plan is filed for cr "CR-W2P-3" with 40 cycles
    And 32 closed CR plans are filed and merged under wave "1" for a long History
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then Now and History render inside one split card
    And the "Now" header bar names "Now" with the line "what is running"
    And the "History" header bar names "History" with the line "only what is past"
    And Now's band background differs from History's area background
    And a divider is visible between Now's box and History's header bar
    And History's header bar stays visible while its list scrolls

    When the viewport is 390x844
    Then the Workflow tab shows no header bar above either pane
    And no divider renders between Now and History

  Scenario: the live dot in Now's header bar is lit while an open plan or a running gate is in Now, and dim when nothing is running
    Given the viewport is 1280x800
    And a project named "W2P Dot State Project" is registered
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the live dot in Now's header bar is dim

    When a cycle plan is filed for cr "CR-W2P-DOT-1" with a cycle labelled "dot cycle"
    And cycle 1 of that plan is activated
    And I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the live dot in Now's header bar is lit

    When cycle 1 of that plan is marked done
    And the plan is closed with merge commit "w2pdot01"
    And an in-flight no-mistakes gate is ingested via the API for release "9.9.8" with run id "run-w2p-dot-1"
    And I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the live dot in Now's header bar is lit

