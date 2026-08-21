# CR-CRU-079 — roadmap deep-link parity and active-CR drill-through

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 078
- **Status**: PENDING (0.2.0)

## Problem

Two roadmap navigation contracts are specified and neither is honoured. Both were verified
against the running app on the live 78-CR board, not inferred:

### 1. The chip is not deep-linkable

F14 locks **two** entry points: PRIMARY the Roadmap tab in the workspace strip, SHORTCUT the
Project pane's `🗺 roadmap` chip — and states *"Both activate the tab at `/p/<key>/roadmap`
(deep-linkable)"*.

The chip is present and works as a tab swap (`data-testid="roadmap-chip"`, rendered inside
`project-pane`, `onclick: () => (state.workspaceTab = "Roadmap")`), and clicking it does render
the roadmap. But it **never updates the URL**: after clicking, `location.pathname` is still
`/p/<key>`, never `/p/<key>/roadmap`. So the tab route is shareable and the chip route is not —
you cannot copy the URL of what you are looking at, and a reload throws you back to Workflow.
One of two specified doors silently fails the contract.

### 2. The row drill-through does not target the clicked CR

F14½ specifies the roadmap row → Workflow drill-through, and F14a decision 7c sharpens it:
clicking an `IN_PROGRESS` CR row lands on **that CR's active cycles** as they are displayed and
tracked.

What actually happens: clicking a roadmap row **does** swap to the Workflow tab, but it lands on
generic Workflow history with **nothing targeted**. Verified by clicking the row for
`CR-CRU-017` on the live board: all **63** CR groups remained collapsed, none expanded, none
highlighted, nothing scrolled into view, and the URL stayed `/p/<key>/roadmap`. You are dropped
into a 63-group history and must find the CR by hand — which is precisely the work the
drill-through exists to remove.

F14½'s badge reads *NOT YET IMPLEMENTED*, which is misleading in both directions: the tab swap
is implemented, the targeting is not.

## Scope

### §S1 Chip deep-link parity

The chip navigates to `/p/<key>/roadmap` rather than mutating tab state directly, so both entry
points produce the same shareable URL and survive a reload. One rule for both doors: the
destination is a route, not a mode flag.

### §S2 Targeted drill-through

Clicking a CR row navigates to that CR's context in the Workflow view and **lands on it**:
the CR's group expanded, scrolled into view, and marked as the drill-through target. For an
`IN_PROGRESS` CR this lands on its **active cycles** as they are tracked (decision 7c).

The back affordance returns to the roadmap with expansion and scroll intact, per the one-rule
pane model (`← roadmap`), consistent with CR-020 §S2's navigation contract.

### §S3 Honest state for the unreachable case

If a clicked CR has no workflow history at all (`PENDING`, never planned), the drill-through
must not pretend: it either stays put or lands with an explicit empty state naming the CR. It
never silently drops the user into unrelated history — the current failure mode.

## Acceptance criteria

- **AC1** — clicking the `🗺 roadmap` chip results in `location.pathname === "/p/<key>/roadmap"`,
  and reloading that URL renders the roadmap. Asserted on the URL, since the tab swap already
  passes today while the contract fails.
- **AC2** — both entry points (tab and chip) reach an identical, shareable URL; neither is
  privileged.
- **AC3** — clicking a CR row lands on **that CR**: its group is expanded and scrolled into
  view, and it is distinguishable as the target. Asserted for a specific CR id, with the
  further assertion that **other** groups remain collapsed — the current bug is "all collapsed",
  so "none expanded" must fail this AC.
- **AC4** — for an `IN_PROGRESS` CR the landing shows its **active cycles**, not merely its
  group header.
- **AC5** — the back affordance returns to the roadmap with prior expansion and scroll intact.
- **AC6** — a `PENDING` CR with no workflow history produces an explicit empty state naming the
  CR, or no navigation at all — never an untargeted landing in unrelated history.
- **AC7** — F14½'s frame status is corrected in the storyboard to match reality once shipped.

## Estimated size

S–M — one route change for the chip, target-and-expand plumbing in the Workflow pane, plus the
empty-state path.

## Risk

The drill-through mutates Workflow-pane expansion state from outside, so the risk is fighting
the pane's own collapse-by-default rule (CR-020 §S1.3: history groups collapse by default). The
target expansion must be an explicit, addressed state rather than a global "expand all", or
history becomes unusable at 63 groups.

Second risk: making the chip navigate changes an existing shipped affordance's mechanism from
state-mutation to routing. AC2 exists to ensure both doors converge instead of diverging into
two behaviours.

## Non-goals

- Graph topology, waves, gates, lanes, motion — **CR-077**.
- Removing the toggle, selection-driven table, row grammar — **CR-078**.
- Tab ordering — **CR-076**.
- Changing the workspace **landing** pane — still CR-021 §S1 AC2, untouched.
- Release→gate association and the P50/P80 forecast — out of 0.2.0 (CR-022, deferred).
