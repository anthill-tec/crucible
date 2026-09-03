# CR-CRU-093 — the project rail collapses, giving every workspace view its width back

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 006
- **Status**: PENDING (0.2.0) — moved into 0.2.0 by user direction 2026-08-28
- **Design document — READ IT FIRST**: `/home/antonyj/Documents/data_projects/crucible/.lavish/crucible-workflow-flowchart.html` §14 (approved 2026-08-28). Absolute path so it resolves from a worktree; it carries the measured widths and the collapse rules.

> The design document is the contract for this CR. Implement what it specifies — do not
> re-derive the model, the vocabulary or the look from scratch.

## Problem

The workspace body is a two-column grid — the active view, then the Project + Vitals rail
(`WorkspaceBody`'s grid container in `public/app.js`; `grid-template-columns: minmax(0, 2.6fr) minmax(260px, 1fr)` at
`public/styles.css:212-214`). The rail is permanent: nothing in the shell collapses it.

Measured on the live board at a 1600px viewport (§14): `.app-center` 1130px, `.app-pane` 434px —
**27.5% of the 1576px body**, spent on a rail while reading a timeline. Collapsing it returns
**~+38%** width to the view.

This is shell chrome, not roadmap work. All six workspace views wrap in `.app-center` and all six
gain the width — the Runs, Coverage, Compile, BDD, Roadmap and Workflow view wrappers in
`public/app.js` — so it is its own CR rather than a
cross-cutting change smuggled inside a feature.

## Scope

### §S1 The measured surface

**Surfaces (verified 2026-08-28):**

| Thing | Location |
|---|---|
| Grid container | `WorkspaceBody` in `public/app.js` (`data-testid="workspace-body"`), `public/styles.css:212-214` |
| The rail | `ProjectPane` in `public/app.js` — `data-testid="project-pane"`, wrapped in `greyed("app-pane")`; `VitalsRail` beside it |
| Rail box + own scroller | `public/styles.css:222-232` |
| The six view wrappers | one per tab name in `public/app.js` (`WorkspaceRuns`, `WorkspaceCoverage`, `WorkspaceCompile`, `WorkspaceBdd`, `RoadmapPanel`, `WorkspaceWorkflow`) |
| Tab names | `public/app-logic.d.mts:67` — `"Roadmap" \| "Workflow" \| "Runs" \| "Coverage" \| "Compile" \| "BDD"` |

Collapsing removes the rail's grid column so the view column takes the full body width; the rail's
own vertical scroller (`public/styles.css:232`) and the 660px pane floor
(`public/styles.css:283`) are untouched.

### §S2 The affordance

Net-new — no collapse affordance exists in the shell today. The only toggles are the tab chips
(the tab strip, `data-testid="workspace-tab"`), the roadmap's table/graph segmented control
(removed by CR-CRU-078), the density chip and the
row-level lens/cycle expanders (`public/styles.css:983-986`). None of them collapses a shell region.

A single user-operated control toggles the rail:

- Lives **outside** `.app-center` — in the rail's own header when expanded, and it MUST remain
  rendered and inside the viewport when collapsed. A collapsed rail with no visible re-open
  control is a defect, not a state.
- A `<button>`, keyboard-reachable, accessible name `collapse project rail` / `expand project rail`,
  carrying `aria-expanded` (`"true"` expanded, `"false"` collapsed) — the shell's existing
  aria idiom already used by the shell's other expanders.
- The rail's `class` binding is the reactive `greyed("app-pane")` closure
  (`greyed()`, applied to the rail by `ProjectPane`). The collapsed modifier composes **into** that
  binding; an imperative `classList` write is wiped on the next re-render.

### §S3 The state lives OUTSIDE the render tree

Not a preference — `roadmapExpandedKeys`'s own comment already states the rule verbatim: state kept

> OUTSIDE the render tree exactly like lensOpenKeys and state.collapsedCycles

Follow `lensOpenKeys` in `public/app.js`: a module-scope value plus a `van.state` rev that
the class binding reads, so a toggle re-renders only what changed and never rebuilds the pane.
`state.collapsedCycles` and its predicate/toggle in `public/app.js` is the same pattern
on the reactive store.

Failure mode being designed out: the shell re-renders on every live frame — SSE messages
(the SSE stream) and the poll fallback (`POLL_MS`). A mount-local flag gives
the click a sub-poll lifetime, so **the rail silently re-expands on the next poll tick**. That is
exactly the bug CR-CRU-077 hit with expansion state.

The pane container is shared by every tab (`WorkspaceBody`'s pane column), so the state is global to the
workspace, not per-tab, and survives tab switches and detail open/close.

### §S4 It persists across reload

CR-CRU-077 §S2 left this gap open in writing — "Expansion state is UI state, not persisted"
(`docs/changes/CR-CRU-077-roadmap-graph-is-the-execution-dag.md:194`); a reload comes up with the
user's choice discarded. Do not repeat it.

Reuse the existing preference pattern, `DENSITY_STORAGE_KEY` and its read-with-fallback guard in `public/app.js`:

- Key: `crucible.rail.collapsed`, values `"collapsed"` / `"expanded"` — a closed value set read
  through an `includes`-style guard, mirroring `DENSITY_MODES.includes(storedDensity)`.
- Absent, empty, or unrecognised stored value ⇒ **expanded**, no throw. Boot never depends on the
  stored string being well-formed.
- Written on every toggle; nothing else writes the key.

### §S5 Every view survives the width change

The reflow is global, so each of the six views is asserted at **both** widths — rail expanded
(~1130px) and collapsed (~1564px). A view that has only ever rendered at 1130px may clip or
overflow at 1564px, and the reverse holds for anything tuned to the wide state.

Per view, per width: no horizontal overflow on the pane scroller
(`[data-testid="pane-scroll"]`: `scrollWidth <= clientWidth`), no page-level horizontal scroll
(`document.body.scrollWidth <= window.innerWidth`), and no element clipped outside the viewport.
The e2e harness already carries the viewport step
(`tests/e2e/steps/pane-scroll.steps.ts:11`, `Given the viewport is {int}x{int}`).

## Acceptance criteria

- **AC1** — **the width gain is geometric.** At viewport 1600×900, with a project workspace open,
  `[data-testid="workspace-body"] > .app-center` measured via `boundingBox()` is at least **1.30×**
  wider collapsed than expanded, and `[data-testid="project-pane"]` contributes **0px** of layout
  width when collapsed. Asserted from measured boxes, never from class presence.
- **AC2** — **the collapsed rail is re-openable.** With the rail collapsed, exactly one visible
  control with accessible name `expand project rail` sits inside the viewport bounds; clicking it
  restores `.app-center` to its pre-collapse width (±1px). Zero visible control while collapsed
  fails this AC.
- **AC3** — **the state survives a poll tick.** Collapse the rail, then let at least one full poll
  interval (the shell's own `POLL_MS`) elapse **and** deliver one data frame. The rail is still
  collapsed and `.app-center`'s measured width is unchanged. A mount-local flag fails here.
- **AC4** — **the state survives navigation.** Collapsing on one tab, then switching
  Roadmap → Runs → Workflow and opening + closing a run detail, leaves the rail collapsed on every
  one of them; the state is workspace-global, not per-tab.
- **AC5** — **the state survives reload.** After collapsing, a page reload renders the rail
  collapsed **on first paint**, with no expanded flash; after expanding, a reload comes up expanded.
  **REWORDED 2026-09-03 by the queue rigidity review.** It previously dictated the storage key AND
  its exact string values (`localStorage.getItem("crucible.rail.collapsed") === "collapsed"`). That
  is a mechanism, not a requirement: where the state lives is the implementer's decision, and the
  shell already has a persisted-preference pattern (the density toggle) that may be the right thing
  to reuse. What must hold is survival across a reload, first-paint included.
- **AC6** — **a stored value the shell cannot interpret falls back to expanded, without throwing.**
  Whatever persistence AC5 chooses, a corrupt, empty, wrongly-typed, wrongly-cased or absent value
  each boots **expanded** with no uncaught exception and no `console.error`. The shell's existing
  preference guard is the pattern to follow — find it rather than invent a second one.
- **AC7** — **every view renders clean at both widths.** For each workspace tab the shell declares
  (its own tab-name union — six today) at viewport 1600×900, in **both** rail states: the tab's
  `[data-testid="pane-scroll"]` has `scrollWidth <= clientWidth`, and
  `document.body.scrollWidth <= window.innerWidth`. Twelve assertions; any single clip fails.
- **AC8** — **toggling does not remount the pane.** Across a collapse and a re-expand, the active
  pane's `[data-testid="pane-scroll"]` is the SAME element node and its `scrollTop` is unchanged
  (the CR-CRU-016 reading-position contract). A re-render that rebuilds the pane fails.
- **AC9** — **the toggle composes with `greyed()`.** With `state.backendUp === false` the collapsed
  rail carries BOTH the `greyed` class and the collapsed modifier, and stays collapsed. A modifier
  that replaces the shell's existing reactive class binding, rather than composing with it, fails.
- **AC10** — **the control is accessible.** It is a `<button>`, focusable and activatable by
  keyboard (Tab then Enter/Space toggles), and its `aria-expanded` reads `"true"` expanded /
  `"false"` collapsed at every step.
- **AC11** — **the 1024×640 floor is unbroken.** At viewport 1024×640, collapsing the rail keeps
  `document.body.scrollWidth <= window.innerWidth` and leaves the pane-content `min-width` floor
  (`.app-pane-content > *` in `public/styles.css`) unviolated — no pane child is squeezed below it.
- **AC12** — **no roadmap behaviour changes.** With the rail expanded vs collapsed, the Roadmap tab
  renders the identical set of CR rows in the identical order and the identical release membership,
  and the collapse control is not a descendant of `.app-center`. This CR's diff touches shell chrome
  only.
  **REWORDED 2026-09-03 by the queue rigidity review.** It also forbade adding *any* new
  `data-testid` under `[data-testid="workspace-body"] > .app-center`, which would have blocked the
  implementer from giving their own work a test handle. The requirement is that the roadmap's
  RENDERED CONTENT is unchanged, not that the DOM gains no attribute.

## Estimated size

S — one grid-column rule, one persisted flag on the `lensOpenKeys` pattern, one button, and the
both-widths sweep across six views.

## Risk

The both-widths sweep is where the cost sits: six views × two widths is a real matrix, and the
likely finding is one view tuned to 1130px that clips at 1564px. AC7 exists to surface that as a
failing assertion rather than a user report.

Composing the collapsed modifier into `greyed()`'s reactive closure is the one place a naive
implementation breaks quietly — the class survives until the next backend-liveness flip, then is
silently dropped. AC9 pins it.

## Non-goals

- Release-strip paging and the measured window size — the roadmap CR owns those. §14 notes the two
  are one behaviour (6 gates open, 9 collapsed); this CR only makes the width available, and never
  hardcodes a gate count.
- Collapsing the tabs row, the top bar, or the home surface's panes — the workspace rail only.
- A resizable/draggable rail, a remembered custom width, or a third partially-collapsed state — the
  state is binary.
- Server-side or per-account persistence — `localStorage`, same as density.
