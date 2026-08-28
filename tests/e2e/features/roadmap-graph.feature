Feature: CR-CRU-014 §S3, amended by CR-CRU-083 AC7 and CR-CRU-078 §S1/§S4 — the roadmap FLOWCHART zone: the focused release's waves + the status-gated node→Workflow swap
  The roadmap renders every zone at once (CR-CRU-078 §S1/AC1 retired the
  exclusive table|graph toggle this scenario used to click). CR-CRU-078 §S4
  then replaced what zone 2 DRAWS: CR-CRU-077's dependency-composed
  whole-project DAG — 94 nodes and 208 edges on the live board, 160 of them
  `dependsOn`, laid out by cytoscape-dagre — is gone, and with it the
  <canvas> this scenario had to reach through `window.crucibleRoadmapCy`.
  Zone 2 now draws the FOCUSED release only, as plain DOM:
  `Start → wave container(s) → ◇gate → End`, with the wave holding its CRs in
  authored `seq` order and NO edge of any kind (AC20).

  Two consequences for this scenario, both improvements:
    • the CR node is a real DOM element with a testid, so the tap is a real
      click and the node's derived status is a real assertion — the harness
      no longer needs a published cytoscape handle to see anything;
    • zone 2 needs a FOCUSED RELEASE to draw, so the scenario now declares
      one: an ORCHESTRATOR-role agent proposes `0.2.0` (CR-CRU-091 §S8) and
      the queue registers its CR into it. That is the real registration path,
      not a fixture — which is what an e2e is for.

  Gating rule (CR-CRU-083 AC7, mirroring the row since CR-CRU-014): the tap is
  landable ONLY for a node whose OWN derived status is evidence of tracked
  work — IN_PROGRESS or COMPLETED, i.e. a CR with a plan to land on. A PENDING
  node (no plan filed) and a COMPLETED_UNTRACKED one (shipped by a release,
  never plan-tracked) are INERT, exactly like their rows: there is no
  execution history for the Workflow tab to show. This scenario therefore taps
  the same node TWICE — once while it is PENDING (inert), then again once a
  filed plan has made it IN_PROGRESS (swaps). The third and fourth cases
  (COMPLETED swaps, COMPLETED_UNTRACKED inert) are pinned at unit level in
  tests/roadmap-release-focus.test.ts; the e2e's job is to prove the seam
  through the real server and the real SPA, not to re-enumerate the matrix.

  Scenario: the roadmap flowchart draws the focused release's wave, and its CR node's tap is inert while PENDING and swaps to the Workflow tab once a filed plan makes it IN_PROGRESS
    Given a project named "RM Graph" is registered
    And an online agent "rm-graph" with message "graph runner" is registered on that project
    And an orchestrator "rm-graph-orch" is registered on that project
    And a release "0.2.0" is proposed for that project
    And a CR queue registering cr "CR-RG-200" titled "Graph CR" in wave "5" for release "0.2.0" is posted for that project
    When I open the workspace for that project
    And I click the "Roadmap" workspace tab
    Then the roadmap flowchart for release "0.2.0" renders wave "5" holding 1 CR nodes within 3 seconds
    And the roadmap flowchart node for "CR-RG-200" carries status "PENDING" within 3 seconds
    When I click the roadmap flowchart node for "CR-RG-200"
    Then the "Roadmap" workspace tab is still active 500 milliseconds later
    When a cycle plan is filed for cr "CR-RG-200" with a cycle labelled "C1"
    Then the roadmap flowchart node for "CR-RG-200" carries status "IN_PROGRESS" within 5 seconds
    When I click the roadmap flowchart node for "CR-RG-200"
    Then the "Workflow" workspace tab becomes active within 2 seconds
