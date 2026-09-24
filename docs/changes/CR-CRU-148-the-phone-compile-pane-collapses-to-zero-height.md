# CR-CRU-148 — the phone compile pane collapses to zero height

**Type** fix · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-018 · **Status** PENDING

## Problem

**Found by CR-CRU-022's RED2 (2026-09-24), reproduced and bisected by the orchestrator.** CR-CRU-018's
phone scenario *"AC10 — compile diagnostics scroll inside their own container with the page unscrolled"*
fails deterministically when the `chromium-mobile` project runs on its own, at the step *"the compile
diagnostics container is the element that scrolls, not the page"*:

```
Expected: > 0
Received:   0     (mobile-viewport.steps.ts:384 — scrollHeight > clientHeight)
```

Measured on `feature/CR-CRU-022` at `3764ac3`, which carries no production change to CR-018's surfaces:

| Run | Result |
|---|---|
| `chromium-mobile`, full sequence, 3 consecutive runs | AC10-compile **fails every time** |
| F1 + AC10-compile alone | **passes** (2.3s) |
| AC10-compile paired with each of AC1, AC2, AC3/4, AC5, AC6, AC8 individually | **passes in all six** |
| The full e2e suite (C4, VERIFY, FIX of CR-018; RED2's run) | passes — the desktop scenarios run first |

So the failure is **deterministic and cumulative**: no single earlier scenario causes it, but together
they leave state under which the Compile tab's `pane-scroll` renders with **`scrollHeight` and
`clientHeight` both 0**. The element exists and passes `toBeVisible()`, but it has been squeezed to zero
height. That is a layout collapse, not missing data, and it was masked because the full suite runs the
desktop scenarios first.

**Leading hypothesis, unconfirmed:** each earlier scenario registers a project, so by AC10 the phone
layout carries more projects, and something above the pane (the projects row, the tabs, the Project
band's foot strip) grows until the pane is left no height. CR-CRU-018 §S1 requires the projects row to
scroll inside its own row on a phone, so if that holds, a real phone user with enough projects would
hit this too. **The first job of this CR is to confirm or refute that by measurement.**

## Scope

### §S1 — find the cause by measurement

Measure every block above `pane-scroll` in the failing state, and name the one that takes the height.
Do not fix a guess.

### §S2 — fix it where it lives

- **If it's product layout:** fix it so the Compile pane keeps usable height at the phone band however
  many projects exist, consistent with DN-crucible-responsive-model decisions 6 and 9 (containers scroll,
  the project band relocates but never crowds out content).
- **If it's test state:** make the scenario independent of what earlier scenarios left, **without**
  weakening what it asserts.

## Acceptance criteria

- [ ] The cause is named, with the measured heights that prove it.
- [ ] `chromium-mobile` passes when run on its own, three consecutive times.
- [ ] If the cause is product layout, a regression test reproduces it (many registered projects, phone
      band, Compile tab), fails at `3764ac3`, and passes after the fix.
- [ ] AC10-compile's assertions are unchanged, or strengthened — never weakened.
- [ ] Desktop scenarios are unedited, and the full e2e suite stays green.

## Non-goals

- Anything in CR-CRU-022. This CR fixes CR-CRU-018's shipped behaviour only.

## Implementation Notes

**The Problem section above is wrong, and was measured wrong on 2026-09-24.** It reads the failure as a
layout collapse caused by accumulating projects. The FIX agent measured the failing state and refuted
that: the element the step measured was **detached** (`isConnected=false`), the outgoing **Workflow**
pane's `pane-scroll`, while the live Compile pane measured 831 / 571 at the same instant. **Nothing was
squeezed and no user-facing defect exists.** The cause is a tab-swap race: the Compile click flips state,
the pane swaps on the next render, and the step's lookup resolved the outgoing pane first. The window is
about 20ms, and the workspace's opening fetches (still in flight during the full phone sequence) push the
swap past the lookup. That is why it passed alone and in the full suite, and why CR-018's VERIFY saw
green. CR-CRU-029 had already documented the race at `pane-scroll.steps.ts:64-77`.

**The fix is test-side:** that wait is extracted into one helper, `tests/e2e/steps/pane-mount.ts`
(`mountedPaneScroll`), and AC10 measures the pinned Compile pane, asserting it is attached, the only live
`pane-scroll`, and headed `Compile`. It gained one assertion, `clientHeight > 0`, which the old step
lacked. The product-layout regression-test AC does not apply.

**Same exposure, not fixed here (scope stays at AC10):** the step "no pane scrolls horizontally"
(`viewport-pane-scroll-floor.feature:79/81/83`, right after tab clicks) does a bare `pane-scroll` lookup
with no wait. It is the worst case, because a detached node reads 0 ≤ 0 and **passes silently**. Also
exposed, at lower risk: "the active pane-scroll element scrolls horizontally" (`:61`) and "the
pane-scroll element's scrollTop is {int}" (`viewport-dual-axis-scroll.feature:82`). All three should
adopt `mountedPaneScroll`.
