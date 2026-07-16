# CR-CRU-021 — Patch: Workflow as the primary workspace tab

**Status:** PENDING
**Type:** patch
**Priority:** P3
**Depends on:** CR-CRU-020
**Labels:** patch, ui, workspace, tabs
**Phase:** Wave 4 (after 020)
**Design reference:** user direction at the CR-020 gate review 2026-07-16 ("the Workflow should be the primary view in the project specific workspace followed by runs")

## Context
The workspace opens on Runs today. With plans/lens live, the Workflow view is
the project's primary narrative; Runs becomes the second tab.

## Scope

### §S1 Tab order + default
`L.workspaceTabs` order becomes `Workflow · Runs · Coverage · Compile · BDD`;
the workspace's default active tab on entry (badge click, cold `/p/<key>`
load) becomes `Workflow`. The one-rule, tabs-hide, and back-chip naming are
order-agnostic and unchanged; cold `/p/<key>/run/<id>` detail loads keep
their existing behavior (close lands on the pane that hosted the detail —
now Workflow by default for tab-less cold loads).

## Acceptance criteria
- [ ] `L.workspaceTabs` returns names exactly `["Workflow","Runs","Coverage","Compile","BDD"]` (both project types; existing enable/disable semantics untouched); tab-list assertions across suites re-targeted under this CR's sanction.
- [ ] Entering a workspace (badge click AND cold `/p/<key>` load) renders the Workflow pane active (`Workflow` tab `on`, `workflow-active` present); selecting Runs still works and the one-rule/tabs-hide behaviors are unchanged (spot re-run of the CR-016/020 binding tests).
- [ ] Cold `/p/<key>/run/<id>`: the detail renders in-pane; closing it lands on the WORKFLOW pane with its tab `on` (the new default), chip text `← workflow`.

## Estimated size
XS.

## Non-goals
Any lens/active-view content changes; home surface changes.
