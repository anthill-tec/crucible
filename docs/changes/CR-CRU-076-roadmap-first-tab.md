# CR-CRU-076 — Roadmap is first in the workspace tab band

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 014, 021
- **Status**: PENDING (0.2.0)

## Problem

The workspace tab strip renders `Workflow · Runs · Coverage · Compile · Roadmap · BDD`
(`TAB_NAMES`, `public/app-logic.mjs`), putting the roadmap **fifth**.

That inverts how a project actually works. Every project **starts with roadmap creation** —
the CR backlog is registered up front, at design time, before any workflow runs (CR-014 §S2:
`queue-file` is a design-phase orchestrator action). Workflow is the **runtime representation**
of the activities tied to a roadmap CR as they execute. The roadmap is the origin document and
execution is downstream of it, so the origin document leads the band rather than sitting
behind four runtime views.

This is a deliberate reversal of a prior decision, stated plainly rather than quietly
re-flipped:

**CR-CRU-021 — "Patch: Workflow as the primary workspace tab"** (COMPLETED, wave 4) exists
precisely to put Workflow first. Its `§S1 AC1` is *"L.workspaceTabs order flips to
Workflow-first (both project types)"*, asserted in `tests/workflow-primary-tab.test.ts` as an
exact-array match for both project types. CR-021 **predates the Roadmap tab entirely** — CR-014
added it later, at position five — so its ordering was decided in a world with no roadmap
surface competing for first place. **This CR supersedes CR-021 §S1 AC1, and only that AC.**

CR-021 `§S1 AC2` — *"entering a workspace defaults to the Workflow pane"* — is a **separate,
behavioural** contract about the landing pane and **stands untouched**. Re-ordering a band is
presentation; changing what loads on arrival is behaviour. Not the same decision, not bundled.

Sites encoding the old order, which must move together:

| site | what it pins |
|---|---|
| `public/app-logic.mjs` | `TAB_NAMES` — the single source of truth |
| `public/app-logic.d.mts` | generated declaration of the same tuple |
| `tests/workflow-primary-tab.test.ts` | CR-021 §S1 AC1 — exact order, both project types |
| `tests/app-logic.test.ts` | exact 6-name order including Roadmap |
| `tests/workflow-tab.test.ts` | order comment + assertions |
| `tests/pane-scroll-floor.test.ts` | order-dependent tab assertions |
| `tests/storyboard-fidelity.test.ts` | tab count/name assertions vs the storyboard |

Storyboard is already at the target state: frames **F14**, **F14a** and **F14½** draw
`Roadmap · Workflow · Runs · Coverage · Compile · BDD`, and all four prose recitals of the old
order were rewritten to match.

## Scope

### §S1 Re-order the band

`TAB_NAMES` becomes `["Roadmap", "Workflow", "Runs", "Coverage", "Compile", "BDD"]`, and
`app-logic.d.mts` is regenerated. `workspaceTabs()` derives from the tuple, so the strip, the
gating logic and every consumer follow from one edit — no per-site ordering.

Enable/disable semantics are untouched: Workflow / Runs / Compile never gated, Coverage gates
on `latestCoverageEventId` with its existing hint, BDD gates on project type. Position only.

### §S2 Re-target the pinned contracts

Every pinned site is updated **deliberately**, reason recorded in the test docstring — never
bent, narrowed, or deleted to reach green:

- `tests/workflow-primary-tab.test.ts` — the file's premise changes. Its §S1 AC1 block is
  re-pointed to Roadmap-first, with a docstring stating that CR-076 supersedes CR-021 §S1 AC1
  and why (roadmap is the origin document; CR-021 predated the tab). Its **§S1 AC2 landing
  assertions stay exactly as they are** — out of scope.
- `tests/app-logic.test.ts`, `tests/workflow-tab.test.ts`, `tests/pane-scroll-floor.test.ts`,
  `tests/storyboard-fidelity.test.ts` — order expectations updated to the new tuple.

Tests asserting *set membership* or *count* rather than order must keep passing unchanged. If
one fails, that is a real positional coupling and gets fixed properly, not silenced.

## Acceptance criteria

- **AC1** — `TAB_NAMES` is exactly `["Roadmap","Workflow","Runs","Coverage","Compile","BDD"]`
  and `workspaceTabs()` returns that order for **both** project types, asserted as an exact
  array.
- **AC2** — the **rendered** strip's first tab is `Roadmap`, asserted against the DOM (not the
  tuple), so data/render divergence is caught.
- **AC3** — gating semantics byte-for-byte unchanged: Workflow / Runs / Compile never
  disabled; Coverage disabled without `latestCoverageEventId`, carrying its existing hint; BDD
  gated on project type. Proven by pre-existing assertions passing untouched.
- **AC4** — **landing behaviour unchanged**: entering a workspace still defaults to the
  Workflow pane (CR-021 §S1 AC2), `workflow-active` present, URL still `/p/<key>`.
- **AC5** — `/p/<key>/roadmap` still lands on the Roadmap tab, and the Project pane's
  `🗺 roadmap` chip still activates it. Re-ordering breaks neither entry point.
- **AC6** — `app-logic.d.mts` matches `app-logic.mjs`; `bunx tsc --noEmit` clean.
- **AC7** — every re-targeted test names CR-076 and its reason in the docstring; no assertion
  is weakened from an exact-order match to a looser check.

## Estimated size

XS — one tuple, one regenerated declaration, five test files re-pointed.

## Risk

Low mechanically; the **supersession** is the real risk. Silently reversing CR-021 would leave
two live CRs asserting opposite orderings. Mitigated by naming the superseded AC here, in the
queue row, and in the re-targeted test docstring, so the lineage is greppable.

Secondary: a test that looks order-agnostic but indexes positionally (`tabs[0]`) would begin
asserting Roadmap by accident. Such sites are fixed to select by name.

## Non-goals

- **The default landing pane.** CR-021 §S1 AC2 stands. Making it data-driven (roadmap when no
  plan is open, workflow when a cycle is active) is a separate behavioural change, deliberately
  not bundled.
- Roadmap tab **content** — graph and table work is CR-077 / CR-078.
- Deep-link and drill-through defects — CR-079.
- The five-tab storyboard frames (F8, F11, F13) predating the Roadmap tab; whether they gain
  the tab is a storyboard decision, not code.
