Feature: a changed cycle's long label renders unclipped, and its long reason wraps beneath the line, in a real browser (F23)
  BDD layer expression of CR-CRU-176 §S2/AC2
  (docs/changes/CR-CRU-176-a-running-gate-is-a-live-run-and-a-cycles-change-sits-beneath-it.md),
  governed by storyboard F23 (.lavish/crucible-v2-design.html, "A cycle's
  recorded change sits beneath it, never beside it", APPROVED 2026-10-08):
  the cycle line keeps its glyph, `cycle N · "label"`, kind badge, timer and
  `→ Runs` exactly as a cycle with no record; the record is a dim line
  indented to the label, BENEATH the cycle line, wrapping over as many
  lines as it needs. Driven against the REAL served SPA + REAL server,
  house style (Gherkin + playwright-bdd, not a bespoke .e2e.ts file).

  RED phase — expected to fail against current production: `CycleRow`'s
  `CycleLine(...)` call spreads `...cycleChangeRecord(cycle)` as FURTHER
  CHILDREN of the SAME flex line the label renders into (`.app-cycle-text`,
  `overflow:hidden; text-overflow:ellipsis`), so a long record crowds the
  label into an ellipsis instead of sitting, unwrapped, below it.

  Reuses seeding.steps.ts's project step, navigation.steps.ts's "I open the
  workspace for that project", workflow.steps.ts's "I click the {string}
  workspace tab" / "a cycle plan is filed for cr {string} with a cycle
  labelled {string}", roadmap-graph.steps.ts's "an orchestrator {string} is
  registered on that project", and pane-scroll.steps.ts's "the viewport is
  {int}x{int}" wherever they already say exactly what's needed; only the
  cycle-add-with-record step and the label-width/record-position/record-wrap
  assertions are new here.

  The baseline cycle (filed first, no recorded change) and the changed one
  (appended via the orchestrator-only cycle-add route, carrying the record)
  share the SAME label text, so comparing their rendered widths isolates
  whether the record crowds the label — the ordinal digit each one renders
  (`cycle 1 ·` / `cycle 2 ·`) differs only in a single monospace digit,
  which is pixel-identical whichever digit it is.

  Every project/cr name below is namespaced "F23LAYOUT " / "CR-F23LAYOUT-…"
  to stay clear of other features sharing the webServer/DB instance.
  Results are ingested with tier "e2e" by the orchestrator's ingest step,
  not by this suite.

  Scenario: at the desktop viewport (1280x800) a changed cycle's long label renders at the same width as an identical cycle with no record, and its long reason wraps beneath the line instead of crowding it
    Given the viewport is 1280x800
    And a project named "F23LAYOUT Desktop Project" is registered
    And an orchestrator "f23layout-desk-orch" is registered on that project
    And a cycle plan is filed for cr "CR-F23LAYOUT-DESK-1" with a cycle labelled "a sealed run leaves no running snapshot behind, and every pane keeps carrying its own full title no matter how long the reason beside it runs"
    And a cycle labelled "a sealed run leaves no running snapshot behind, and every pane keeps carrying its own full title no matter how long the reason beside it runs" is added to that plan with reason "user ruling 2026-10-08: cycle 620's screenshot showed 0.2.0's orphaned running snapshots reading as a running gate forever, so the migration retires them and F22 adds pane titles so every surface names what it is showing at a glance" cause "spec-design" and spec-ref "docs/changes/spec-f23-e2e-fixture.md §S2"
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the changed cycle's label renders at the same width as the baseline cycle's label
    And the changed cycle's change-record box sits below its cycle line's box
    And the changed cycle's change-record wraps onto more than one line

  Scenario: at the phone viewport (390x844) a changed cycle's long label renders at the same width as an identical cycle with no record, and its long reason wraps beneath the line instead of crowding it
    Given the viewport is 390x844
    And a project named "F23LAYOUT Phone Project" is registered
    And an orchestrator "f23layout-phone-orch" is registered on that project
    And a cycle plan is filed for cr "CR-F23LAYOUT-PHONE-1" with a cycle labelled "a sealed run leaves no running snapshot behind, and every pane keeps carrying its own full title no matter how long the reason beside it runs"
    And a cycle labelled "a sealed run leaves no running snapshot behind, and every pane keeps carrying its own full title no matter how long the reason beside it runs" is added to that plan with reason "user ruling 2026-10-08: cycle 620's screenshot showed 0.2.0's orphaned running snapshots reading as a running gate forever, so the migration retires them and F22 adds pane titles so every surface names what it is showing at a glance" cause "spec-design" and spec-ref "docs/changes/spec-f23-e2e-fixture.md §S2"
    When I open the workspace for that project
    And I click the "Workflow" workspace tab
    Then the changed cycle's label renders at the same width as the baseline cycle's label
    And the changed cycle's change-record box sits below its cycle line's box
    And the changed cycle's change-record wraps onto more than one line
