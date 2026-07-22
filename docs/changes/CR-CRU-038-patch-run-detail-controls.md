# CR-CRU-038 — Patch: run-detail drill-in controls — minimized error tree, raw-output toggle, header-relocated controls

**Status:** PENDING
**Type:** patch
**Priority:** P2 (UI correctness; non-blocking — schedule after CR-037)
**Depends on:** CR-CRU-016 (in-pane drill-in), CR-CRU-034 (drill-down dual-axis scroll — last touched the footer jump + raw toggle)
**Labels:** ui, drill-in, run-detail, density, dx
**Phase:** Wave 4 (0.1.0)

## Context
Three run-detail drill-in control defects, surfaced by the user 2026-07-22 on the
RUN DETAIL view, plus a storyboard gap. The drill-in (`public/app.js`, the test
`eventBody` around lines 2979–3400; tests in `tests/density.test.ts`) today:

- **Auto-expands failing suites** on open (`public/app.js:2979` "failing suites
  auto-expand"). The footer **failure-jump** control (`▸ N more failures`,
  `jumpToNextFailure`, `public/app.js:3327`) collapses the errored tests and then
  focus-opens each in sequence — a walk-through that only reads well when the tree
  STARTS minimized. Because the tree starts expanded, the jump's minimize-then-walk
  feels like it fights the initial state.
- Ships a **raw-output toggle** (`showRaw`, `public/app.js:3017`; "reveals the stored
  raw output", `:3309`) that is not evidently working — CR-034 already noted it
  "appends into the dead-space flex layout" (`CR-CRU-034` §S1). Its behavior is
  neither reliable nor discoverable.
- Places **both** footer controls (failure-jump + raw-toggle) at the BOTTOM of the
  drill-in. On runs with many tests / long scroll they fall below the fold and are
  missed. The **density chip** (`data-testid="density-toggle"`) already sits in the
  drill-in HEADER bar (`public/app.js:391`, header assembled ~`:1024`).

These behaviors are also **absent from the storyboard** (`.lavish/crucible-v2-design.html`).

## Scope

### §S1 Error runs open with a MINIMIZED tree (failing-suite headers only)
On opening a run detail that HAS failures, the tree defaults to **failing-suite
headers only** — each failing suite header renders (with its inline `✗ N / ✓ M`
counts) but its leaf rows are **collapsed**. The failure-jump control then expands
+ focus-walks the failing leaves one box at a time (the existing one-box-at-a-time
focus model, CR-016 §S2). Replace the current "failing suites auto-expand" default
(`public/app.js:2979`) for error runs.
- **All-pass runs are UNCHANGED** — only runs with ≥1 failure default to the
  minimized tree.
- The failure-jump's own minimize-then-walk behavior is unchanged; it now starts
  from the minimized state so the walk is coherent.

### §S2 Raw-output toggle — works, discoverable, per-test-preferred
The raw-output toggle reliably reveals/hides raw output within the drill-in's own
scroller (no layout dead-space regression; honor CR-034 §S1's single-scroller rule).
- **Content resolution:** show the **per-failing-test raw output when the reporter
  captured it**; fall back to the **run-level stored raw blob** when per-test raw is
  absent. (`showRaw` currently reveals the run-level blob only.)
- **Hidden when empty:** if NEITHER per-test raw NOR a run-level blob exists for the
  run, the toggle **does not render at all** — no dead control that reveals nothing.
- **Discoverable:** an evident, labeled control (not bare footer text) — see §S3
  (it moves to the header).

### §S3 Relocate failure-jump + raw-toggle to the drill-in HEADER
Both the failure-jump (`▸ N more failures`) and the raw-output toggle move OUT of
the footer and into the drill-in **header bar, adjacent to the density chip**
(`public/app.js` header ~`:1024`), so they stay visible regardless of scroll depth.
- The failure-jump shows the live failure count and advances on click (unchanged
  behavior; new location).
- Remove the footer copies (no duplication) — the footer no longer carries these
  controls.
- The controls only render for runs that have failures (a clean all-pass run shows
  neither a jump nor a raw toggle, matching today's "footer only when ≥1 failure").

### §S4 Storyboard sync — record the control behaviors
Document the above in `.lavish/crucible-v2-design.html` (the F4 / run-detail
drill-in frame): the minimized-by-default error tree, the header-resident
failure-jump + raw-output controls, and the per-test-preferred raw resolution.

## Acceptance criteria
- [ ] Opening a run detail with ≥1 failure renders failing-suite headers with their
      `✗/✓` counts but with leaf rows COLLAPSED (minimized tree); an all-pass run's
      tree default is unchanged.
- [ ] The failure-jump control advances to + focus-opens the next failing leaf one
      box at a time (CR-016 one-box focus model preserved), starting from the
      minimized state.
- [ ] The raw-output toggle reveals per-failing-test raw output when present, else
      the run-level raw blob; toggling hides it again; it renders inside the drill-in
      scroller with no dead-space/layout break (CR-034 §S1 single-scroller intact).
- [ ] The raw-output toggle is HIDDEN entirely when the run has NO raw output
      (neither per-test nor run-level) — no empty/dead toggle.
- [ ] Both the failure-jump and raw-output controls render in the drill-in HEADER
      adjacent to the density chip, and NOT in the footer; they remain visible while
      the drill-in body scrolls.
- [ ] Neither control renders for an all-pass run.
- [ ] `.lavish/crucible-v2-design.html` records the minimized-error-tree default,
      the header control placement, and the per-test-preferred raw resolution.

## Notes
- Gap-analysis (spec↔`public/app.js`↔`tests/density.test.ts`) to run immediately
  before the branch/RED — the density/drill-in test suite pins the current footer +
  auto-expand behavior and must be retargeted (RED owns the retarget) to the new
  minimized-default + header-control contract.
