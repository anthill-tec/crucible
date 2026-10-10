# CR-CRU-146 — the history cycle row looks clickable and is not

**Type** fix · **Points** 2 · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-020, CR-CRU-021,
CR-CRU-018 · **Status** PENDING

> **Gap analysis 2026-09-25 — most of this CR shipped in CR-CRU-018** (DN-crucible-responsive-model
> decision 11, merged `85bca00`). One `CycleLine` builder (`public/app.js`) now puts the ONE toggle
> handler on the whole `.app-cycle-line` for both the active section and history, and the `→ Runs`
> badge still stops propagation. `tests/workflow-cycle-row-toggle.test.ts` asserts clicks on the
> label, status glyph, `▸ N runs` hint and empty space, the second click closing it, one shared toggle
> state, and the badge carve-out. **What remains, measured:**
>
> 1. **The pixel hit-test.** Those tests run in happy-dom, which has no layout, so "several
>    x-offsets across the row" and "the handler spans the row's width" (AC1, AC6) are unproven in a
>    browser. CR-CRU-018's close-out handed exactly this to this CR.
> 2. **§S2 is not met.** `.app-cycle-line` has no pointer affordance (`public/styles.css`), so over
>    98% of a clickable row still shows the default cursor. Only the 13 px glyph
>    (`.app-cycle-toggle`) shows `pointer`. The CR-group row directly above uses `.app-lens-toggle`
>    (pointer, no text selection, hover highlight), so the toggleable cycle line reuses that class
>    rather than inventing a second one. A line with no toggle (the active section's open span,
>    ruling (a)) stays plain.
>
## Problem

**User-reported 2026-09-18:** *"The cycle click to open the cycle in workflow including history is
not working anymore!"*

Measured on the live board at `8f8312d`, driving the real UI rather than reading the code:

| What was clicked | Result |
|---|---|
| the history cycle ROW (`[data-testid="lens-cycle-row"]`) | **nothing** — linked-run spans 0 → 0, row text unchanged |
| its LABEL (`.app-cycle-label`) | **nothing** — no handler on it |
| the bare `▸` glyph (`[data-testid="cycle-toggle"]`) | works — spans 0 → 1, the cycle's linked runs render |

The glyph is **13 × 20 px inside an 896 px row — 1.4% of it.** `.app-cycle-toggle`
(`public/styles.css:1074`) is `cursor: pointer; user-select: none;` and nothing else: no padding, no
box, no hit-area expansion. Everything else on the row — status glyph, label, sealed timer, the
`→ Runs` badge's neighbourhood, and the `▸ N runs` hint — is dead to the click that a reader
naturally makes.

**Not a code regression.** `git log -S` shows the toggle has been a bare glyph span since
CR-CRU-020/021 introduced it; no commit narrowed it. What changed is the ROW: it has since
accumulated a timer (CR-CRU-021 §S3), a `→ Runs` badge (CR-CRU-025 §S1 / CR-CRU-120 §S2) and a
`▸ N runs` hint (CR-CRU-021 §S6 #8), so it now reads as a rich interactive row whose 98.6% is inert.
The report is accurate about the experience even though no diff caused it.

**It also contradicts the sibling row's own decided principle.** The CR-group header directly above
it carries `class: "app-cr-line app-lens-toggle app-card-meta"` with the handler on the LINE
(`public/app.js:4829`), spanning the full 896 px — CR-CRU-020 §S1.2 settled that *"the existing
header row IS the toggle"*. Two collapsible rows, stacked, one full-width and one at 1.4%.

**The worst part is the hint.** `▸ N runs` was added to tell the reader there is more behind the row.
It is rendered inside the line and is itself unclickable — a clickability cue that does nothing when
clicked, which is how a working mechanism comes to be reported as broken.

## What is NOT broken (measured, so the fix does not go hunting)

- The toggle mechanism: clicking the glyph expands the closed span and renders `LinkedRunRow`s.
- The Runs → Workflow jump (`⚑ Cycle`, `[data-testid="boundary-to-cycle"]`): flips the tab, expands
  the containing history CR-group, and reveals the target row. Timed on a 181-marker feed: the
  newest cycle's row mounted **63 ms** after the click, the oldest loaded one (cycle 305,
  CR-CRU-095, wave 5) **67 ms** — both inside `revealCycleRow`'s 30 × 5 ms retry budget, both
  scrolled into the viewport and carrying `app-locate-blink`.

## Scope

### §S1 — the row is the toggle, as its sibling already is

Move the handler from the glyph to the row's line, matching the CR-group's established form so the
two stacked rows behave identically. The glyph stays as the visual affordance; it simply stops being
the only target.

Carve-outs are required, not optional — the line already carries nested interactive nodes that must
keep their own behaviour and must NOT trip the row toggle:

- `[data-testid="cycle-to-runs"]` (the `→ Runs` badge) — already `stopPropagation`s for the
  marker case; the same discipline applies here.
- any future badge added to the line inherits the same rule.

The `▸ N runs` hint becomes part of the toggle surface rather than a decoration that lies.

### §S2 — the affordance is honest at a glance

A reader must be able to tell, without clicking, that the row opens. `cursor: pointer` on a 13 px
glyph does not communicate that when the pointer is anywhere else on an 896 px row.

## Acceptance criteria

**Delivered by CR-CRU-018** (`tests/workflow-cycle-row-toggle.test.ts`, happy-dom). This CR re-runs
them and must leave them green, untouched:

- [x] Clicking the history cycle row — on its LABEL, on its status glyph, on the `▸ N runs` hint, and
      on empty space in the line — opens that cycle's linked runs.
- [x] Clicking the row again closes it (the toggle stays a toggle).
- [x] The `→ Runs` badge still performs its OWN navigation and does NOT toggle the row.
- [x] The active-section cycle row and the history cycle row are built through the same `CycleLine`
      predicate (the active section passes no toggle, by ruling (a)).
- [x] The CR-group row's existing full-row toggle keeps working, unchanged.

**Remaining (this CR):**

- [x] **Pixel hit-test, in a real browser (e2e).** On the Workflow tab, a history cycle row is
      clicked at **at least four x-offsets across its measured width** (near the left edge, over
      the label, in the empty space right of the label, and near the right edge short of the
      `→ Runs` badge). Each click opens that cycle's linked runs, and the next click at the same
      offset closes it. A click on the `→ Runs` badge navigates and does not toggle.
- [x] **The handler spans the row.** In the same browser run, the element carrying the toggle is
      the cycle's line, and its measured width is at least 90% of the row's width, so a refactor
      that re-narrows the hit area to the glyph reds.
- [x] **§S2 — the affordance is honest.** A toggleable cycle line carries `.app-lens-toggle`, the
      class the CR-group row already uses, and a line with no toggle does not. Asserted in the DOM
      (both rows) and in a real browser: the computed `cursor` over the line's empty space is
      `pointer` for a toggleable history row, and not `pointer` for the active section's open span.
- [x] No second hit-area mechanism: `CycleLine` remains the one place the line's handler and its
      class are decided.

## Risk

- **Swallowing the nested badges' clicks.** The `→ Runs` badge and any future affordance live inside
  the line; a naive row-level handler steals them. The third AC exists for exactly that, and the
  marker row's existing `stopPropagation` pattern is the precedent to copy.

## Non-goals

- Redesigning the Workflow history layout, the cycle narration, or the timer.
- Changing what expansion SHOWS (the linked-run rows are correct).
- The `⚑ Cycle` jump and `revealCycleRow` — measured working, and not touched.
