# CR-CRU-179 — the cycle jump lands, and History drops the stale agents block

**Type** fix (patch CR) · **Points** 3 (confirmed at gap analysis 2026-10-09) · **Wave** 7 (0.3.0) ·
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

## Gap analysis (2026-10-09)

**Baseline:** develop `f85659b` = CR-CRU-175's gated tree (bun 3326/0, python 2411/0; e2e 104/0 at its
VERIFY).

**Reproduced in a real browser** (scratch board on :39911 over a plain copy of the dev store, deleted
after):
- **All Projects** (`/`): 6 `⚑ Cycle` badges; clicking one (cycle 651) changes nothing — the URL stays
  `/`, no Workflow tab, no row. The badge never routes to the run's project.
- **The project's Runs tab:** the newest badge (cycle 651, CR-CRU-175 — in the open release's open wave)
  lands; the OLDEST badge on the timeline (cycle 305, CR-CRU-095, release 0.2.0 / wave 5) does not —
  its release and wave are folded, the badge opens only the CR key (`lensOpenOn(lensKey("cr", …))`),
  so the row never mounts and `revealCycleRow`'s retries give up.

**Code:** `BoundaryToCycleBadge` (public/app.js) — sets `state.workspaceTab`, opens the CR key, calls
`revealCycleRow`. The release key is `lensKey("release", label)` and the wave key
`lensKey("wave", "<label>:<wave>")` (CR-CRU-173/640); the cycle's release and wave come from the
History read the page already holds (`/history`'s waves list each release's CR ids). The All Projects
route needs the run's `projectKey` (on the event) and a `navigate` to `/p/<key>` before the reveal.
**Agents block:** `node.agents` + the `cr-agents-pill` / `CrAgentRuntime` render under an open CR group;
removing it removes `CrAgentRuntime` if nothing else uses it (check).

### Tests this CR knowingly re-pins (approved in advance; the user ruled the block removed)

- The agents-block assertions become its absence: `tests/aggregate-headers.test.ts` (the `cr-agents-pill`
  / `cr-agent-runtime` presence checks), `tests/workflow-lens.test.ts` (the participating-agent runtime
  read), `tests/e2e/steps/workflow.steps.ts` + `tests/e2e/features/workflow.feature` (the per-agent
  runtime step). The tests' other assertions are unchanged. Anything else: stop and ask.

### Cycles

1. the cycle jump lands, and History drops the stale agents block (§S1, §S2)
2. verify
