Feature: CR-CRU-014 §S3 — the roadmap GRAPH view (Cytoscape): exclusive toggle + node→Workflow one-rule swap
  §S3's roadmap view is an EXCLUSIVE table|graph toggle (table default). The
  graph half renders the SAME registered CR queue as a depends-on DAG — CRs as
  rectangle action nodes, Start/End ellipse terminals, release-boundary
  diamonds — laid out with cytoscape-dagre. This scenario drives the REAL
  server (POST …/queue) and the SPA's own toggle, then exercises the on-node
  tap's one-rule swap to the Workflow tab (the graph mirror of the table row's
  behaviour).

  Note (E2E harness limit, honest): cytoscape draws nodes to a <canvas>, so
  there is no per-node DOM element Playwright can address by testid. The graph
  container therefore exposes its builder-derived CR node count as the
  `data-cr-node-count` attribute (asserted directly), and the on-node tap is
  driven through the mounted cytoscape instance the app publishes on
  `window.crucibleRoadmapCy` — the same `tap` event an on-canvas pointer fires.

  Scenario: toggling to the graph view renders the queued CRs as a DAG whose node tap swaps to the Workflow tab
    Given a project named "RM Graph" is registered
    And an online agent "rm-graph" with message "graph runner" is registered on that project
    And a CR queue registering cr "CR-RG-200" titled "Graph CR" in wave "5" is posted for that project
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    And I switch the roadmap view to graph
    Then the roadmap graph container renders 1 CR nodes within 3 seconds
    And no roadmap table row is present
    When I tap the roadmap graph node for "CR-RG-200"
    Then the "Workflow" workspace tab becomes active within 2 seconds
