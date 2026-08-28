Feature: CR-CRU-014 §S3, amended by CR-CRU-083 AC7 and CR-CRU-078 §S1 — the roadmap GRAPH zone (Cytoscape): unconditional render + status-gated node→Workflow swap
  The roadmap renders every zone at once (CR-CRU-078 §S1/AC1 retired the
  exclusive table|graph toggle this scenario used to click). The graph zone
  renders the SAME registered CR queue as a depends-on DAG — CRs as
  rectangle action nodes, Start/End ellipse terminals, release-boundary
  diamonds — laid out with cytoscape-dagre. This scenario drives the REAL
  server (POST …/queue, POST …/plans) and the SPA, then exercises the
  on-node tap's one-rule swap to the Workflow tab (the graph mirror of the
  table row's behaviour).

  Gating rule (CR-CRU-083 AC7, mirroring the row since CR-CRU-014): the tap is
  landable ONLY for a node whose OWN derived status is evidence of tracked
  work — IN_PROGRESS or COMPLETED, i.e. a CR with a plan to land on. A PENDING
  node (no plan filed) and a COMPLETED_UNTRACKED one (shipped by a release,
  never plan-tracked) are INERT, exactly like their rows: there is no
  execution history for the Workflow tab to show. This scenario therefore taps
  the same node TWICE — once while it is PENDING (inert), then again once a
  filed plan has made it IN_PROGRESS (swaps). The third and fourth cases
  (COMPLETED swaps, COMPLETED_UNTRACKED inert) are pinned at unit level in
  tests/roadmap-graph.test.ts; the e2e's job is to prove the seam through the
  real server and the real SPA, not to re-enumerate the matrix.

  Note (E2E harness limit, honest): cytoscape draws nodes to a <canvas>, so
  there is no per-node DOM element Playwright can address by testid. The graph
  container therefore exposes its builder-derived CR node count as the
  `data-cr-node-count` attribute (asserted directly), and the on-node tap —
  plus the per-node derived status the tap gate reads — are driven and read
  through the mounted cytoscape instance the app publishes on
  `window.crucibleRoadmapCy`, the `tap` event an on-canvas pointer fires.

  Scenario: the roadmap graph zone renders the queued CRs as a DAG whose node tap is inert while PENDING and swaps to the Workflow tab once a filed plan makes it IN_PROGRESS
    Given a project named "RM Graph" is registered
    And an online agent "rm-graph" with message "graph runner" is registered on that project
    And a CR queue registering cr "CR-RG-200" titled "Graph CR" in wave "5" is posted for that project
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    Then the roadmap graph container renders 1 CR nodes within 3 seconds
    And the roadmap graph node for "CR-RG-200" carries status "PENDING" within 3 seconds
    When I tap the roadmap graph node for "CR-RG-200"
    Then the "Roadmap" workspace tab is still active 500 milliseconds later
    When a cycle plan is filed for cr "CR-RG-200" with a cycle labelled "C1"
    Then the roadmap graph node for "CR-RG-200" carries status "IN_PROGRESS" within 5 seconds
    When I tap the roadmap graph node for "CR-RG-200"
    Then the "Workflow" workspace tab becomes active within 2 seconds
