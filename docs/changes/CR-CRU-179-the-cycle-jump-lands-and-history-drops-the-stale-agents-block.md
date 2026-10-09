# CR-CRU-179 — the cycle jump lands, and History drops the stale agents block

**Type** fix (patch CR) · **Points** 3 (provisional, 2026-10-09; set at gap analysis) · **Wave** 7 (0.3.0) ·
**Depends on** CR-CRU-178 · **Status** PENDING — filed 2026-10-09 (user report and rulings)

## Problem

**Reported 2026-10-09 (user), two defects in 0.3.0 features:**

1. **The `⚑ Cycle` jump on the Run Timeline does not land** (seen on the All Projects view). The
   badge (`BoundaryToCycleBadge`, CR-CRU-025 §S2) sets the workspace tab to Workflow, opens the CR's
   History group and reveals the cycle row. Since CR-CRU-173 History nests CRs inside a release and a
   wave that start folded (release / wave fold keys), and the badge opens only the CR key, so the row
   never mounts and the reveal gives up. From the All Projects view there is also no workspace to land
   in unless the badge routes to the run's project first.
2. **History repeats `1 agent · vidushi · 0ms` under every CR.** The block (CR-CRU-011/021, "the agents
   that worked a CR and their runtime") lists only agents still registered — after a CR closes that is
   the orchestrator alone, from its gate run — and the runtime is that agent's current session, not
   its time on the CR. It carries no information. **User ruling: remove it.**

Filed as a patch CR per `new-scope-mid-cr-is-a-patch-cr`; stays in 0.3.0 (a release's features are
finished in that release).

## Steps

### §S1 — the cycle jump always lands

From any Run Timeline (a project's Runs tab, or the All Projects view), `⚑ Cycle` lands on that cycle's
row in its project's Workflow tab: routing to the run's project first when needed, opening the
release, the wave and the CR group that hold the row (History), or finding it in Now (an open plan),
then scrolling to it and blinking it as today.

### §S2 — History has no agents block

The `N agents` pill and the per-agent runtime rows under an expanded History CR group are removed.
Who ran what stays on the Runs tab and each cycle's `→ Runs`.

## Acceptance criteria

- [ ] `⚑ Cycle` on a closed CR's cycle marker lands on that cycle's row — from the project's Runs tab
      and from the All Projects view — with the row's release, wave and CR group opened; and on an
      active cycle's marker it lands on the row in Now — asserted on the page and in a real browser.
- [ ] An expanded History CR group renders no agents pill and no agent runtime rows; nothing else in
      the group changes — asserted on the page.
