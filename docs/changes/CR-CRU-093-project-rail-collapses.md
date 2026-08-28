# CR-CRU-093 — the project rail collapses, giving every workspace view its width back

- **Type**: feature
- **Wave**: 6 (post-0.2.0)
- **Depends on**: 006
- **Status**: PENDING (post-0.2.0)
- **Design document — READ IT FIRST**: `/home/antonyj/Documents/data_projects/crucible/.lavish/crucible-workflow-flowchart.html` §14 (approved 2026-08-28). Absolute path so it resolves from a worktree; it carries the measured widths and the collapse rules.

> The design document is the contract for this CR. Implement what it specifies — do not
> re-derive the model, the vocabulary or the look from scratch.

## Problem

The workspace body is a two-column grid — the active view, then the Project + Vitals rail
(`public/app.js:4022-4025`; `grid-template-columns: minmax(0, 2.6fr) minmax(260px, 1fr)` at
`public/styles.css:212-214`). The rail is permanent: nothing in the shell collapses it.

Measured on the live board at a 1600px viewport (§14): `.app-center` 1130px, `.app-pane` 434px —
**27.5% of the 1576px body**, spent on a rail while reading a timeline. Collapsing it returns
**~+38%** width to the view.

This is shell chrome, not roadmap work. All six workspace views wrap in `.app-center` and all six
gain the width — Runs (`public/app.js:1931`), Coverage (`:2281`), Compile (`:2308`),
BDD (`:2324`), Roadmap (`:3078`), Workflow (`:3943`) — so it is its own CR rather than a
cross-cutting change smuggled inside a feature.

## Scope

### §S1 The measured surface

**Surfaces (verified 2026-08-28):**

| Thing | Location |
|---|---|
| Grid container | `public/app.js:4022` (`data-testid="workspace-body"`), `public/styles.css:212-214` |
| The rail | `public/app.js:2200-2230` — `ProjectPane`, `data-testid="project-pane"`, `greyed("app-pane")` at `:2202`; `VitalsRail` at `:2119-2121` |
| Rail box + own scroller | `public/styles.css:222-232` |
| The six view wrappers | `public/app.js:1931`, `:2281`, `:2308`, `:2324`, `:3078`, `:3943` |
| Tab names | `public/app-logic.d.mts:67` — `"Roadmap" \| "Workflow" \| "Runs" \| "Coverage" \| "Compile" \| "BDD"` |

Collapsing removes the rail's grid column so the view column takes the full body width; the rail's
own vertical scroller (`public/styles.css:232`) and the 660px pane floor
(`public/styles.css:283`) are untouched.

### §S2 The affordance

Net-new — no collapse affordance exists in the shell today. The only toggles are the tab chips
(`public/app.js:1866`, `data-testid="workspace-tab"`), the roadmap's table/graph segmented control
(`public/app.js:3057-3070`, removed by CR-CRU-078), the density chip (`public/app.js:449`) and the
row-level lens/cycle expanders (`public/styles.css:983-986`). None of them collapses a shell region.

A single user-operated control toggles the rail:

- Lives **outside** `.app-center` — in the rail's own header when expanded, and it MUST remain
  rendered and inside the viewport when collapsed. A collapsed rail with no visible re-open
  control is a defect, not a state.
- A `<button>`, keyboard-reachable, accessible name `collapse project rail` / `expand project rail`,
  carrying `aria-expanded` (`"true"` expanded, `"false"` collapsed) — the shell's existing
  aria idiom (`public/app.js:3425-3427`).
- The rail's `class` binding is the reactive `greyed("app-pane")` closure
  (`public/app.js:375-376`, applied at `:2202`). The collapsed modifier composes **into** that
  binding; an imperative `classList` write is wiped on the next re-render.

### §S3 The state lives OUTSIDE the render tree

Not a preference — `public/app.js:2490` already states the rule verbatim: state kept

> OUTSIDE the render tree exactly like lensOpenKeys and state.collapsedCycles

Follow `lensOpenKeys` (`public/app.js:3102-3112`): a module-scope value plus a `van.state` rev that
the class binding reads, so a toggle re-renders only what changed and never rebuilds the pane.
`state.collapsedCycles` (`public/app.js:51`, predicate/toggle at `:1001-1006`) is the same pattern
on the reactive store.

Failure mode being designed out: the shell re-renders on every live frame — SSE messages
(`public/app.js:321`) and the 5000 ms poll fallback (`public/app.js:337`). A mount-local flag gives
the click a sub-poll lifetime, so **the rail silently re-expands on the next poll tick**. That is
exactly the bug CR-CRU-077 hit with expansion state.

The pane container is shared by every tab (`public/app.js:4024`), so the state is global to the
workspace, not per-tab, and survives tab switches and detail open/close.

### §S4 It persists across reload

CR-CRU-077 §S2 left this gap open in writing — "Expansion state is UI state, not persisted"
(`docs/changes/CR-CRU-077-roadmap-graph-is-the-execution-dag.md:194`); a reload comes up with the
user's choice discarded. Do not repeat it.

Reuse the existing preference pattern, `DENSITY_STORAGE_KEY` (`public/app.js:434-437`):

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
- **AC3** — **the state survives a poll tick.** Collapse the rail, then let at least one full
  5000 ms poll interval (`public/app.js:337`) elapse **and** deliver one data frame. The rail is
  still collapsed and `.app-center`'s measured width is unchanged. A mount-local flag fails here.
- **AC4** — **the state survives navigation.** Collapsing on one tab, then switching
  Roadmap → Runs → Workflow and opening + closing a run detail, leaves the rail collapsed on every
  one of them; the state is workspace-global, not per-tab.
- **AC5** — **the state survives reload.** After collapsing,
  `localStorage.getItem("crucible.rail.collapsed") === "collapsed"`; after `page.reload()` the rail
  renders collapsed on first paint. Expanding then reloading comes up expanded with the key
  `"expanded"`.
- **AC6** — **a corrupt stored value falls back to expanded, without throwing.** For each of
  `"{"`, `"true"`, `""`, `"COLLAPSED"` and the key absent, boot renders the rail **expanded** and
  no uncaught exception or `console.error` is emitted during load. Mirrors the density guard at
  `public/app.js:436-437`.
- **AC7** — **every view renders clean at both widths.** For each of the six tabs
  (`public/app-logic.d.mts:67`) at viewport 1600×900, in **both** rail states: the tab's
  `[data-testid="pane-scroll"]` has `scrollWidth <= clientWidth`, and
  `document.body.scrollWidth <= window.innerWidth`. Twelve assertions; any single clip fails.
- **AC8** — **toggling does not remount the pane.** Across a collapse and a re-expand, the active
  pane's `[data-testid="pane-scroll"]` is the SAME element node and its `scrollTop` is unchanged
  (the CR-CRU-016 reading-position contract). A re-render that rebuilds the pane fails.
- **AC9** — **the toggle composes with `greyed()`.** With `state.backendUp === false` the collapsed
  rail carries BOTH the `greyed` class and the collapsed modifier, and stays collapsed. A modifier
  that replaces the reactive class binding (`public/app.js:375-376`) fails.
- **AC10** — **the control is accessible.** It is a `<button>`, focusable and activatable by
  keyboard (Tab then Enter/Space toggles), and its `aria-expanded` reads `"true"` expanded /
  `"false"` collapsed at every step.
- **AC11** — **the 1024×640 floor is unbroken.** At viewport 1024×640, collapsing the rail keeps
  `document.body.scrollWidth <= window.innerWidth` and leaves the 660px pane-content floor
  (`public/styles.css:283`) unviolated — no pane child is squeezed below it.
- **AC12** — **no roadmap behaviour changes.** With the rail expanded vs collapsed, the Roadmap tab
  renders the identical set of CR rows in the identical order and the identical release membership;
  no new `data-testid` is added under `[data-testid="workspace-body"] > .app-center`; and the
  collapse control is not a descendant of `.app-center`. This CR's diff touches shell chrome only.

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
