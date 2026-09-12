# CR-CRU-125 — History narrates a CR that is still live

**Status:** PENDING (0.2.0 — born mid-release, D4)
**Type:** bugfix
**Priority:** P2
**Depends on:** CR-CRU-020 (the history lens whose filter this corrects)
**Labels:** bugfix, ui, workflow-lens
**Phase:** Wave 6 (0.2.0 — user-directed, live orchestrator session 2026-09-12)
**Design reference:** CR-CRU-020 §S1.3 — *"the history lens is closed-plans-only: an OPEN plan's CR
node renders solely in the ACTIVE view"* — the rule this CR repairs rather than replaces

## Context

Observed live on the board 2026-09-12, while `CR-CRU-122` was mid-verify: the Workflow view showed
that CR in **both** panels at once — as the Active workflow at the top, and simultaneously under
`HISTORY — WAVE 6` as:

```
▾ CR-CRU-122 · 0/2 cycles
   ✗ one shared spinner, wired at every backend-delay site   ⏱ 62m 38s
   ⊘ verify the spinner component and all six wired sites…
```

The History entry is not merely a duplicate — it **misreports the CR's outcome**. A healthy CR in
flight reads as `0/2 cycles` with a ✗ failed cycle and a ⊘ skipped one. `CR-CRU-123` renders the
same way. Anyone reading the board's own history would conclude both CRs had failed.

**Cause, read from source.** `workflowLens` (`public/app-logic.mjs`) builds **one CR node per
PLAN** (its own comment at `:846`: *"Declared: one CR node per plan"*), then strips History down
with a single filter (`:934`):

```js
wave.crs = wave.crs.filter((c) => c.status !== "open");
```

That excludes open plan *records*. It does not exclude a **CR** that has an open plan. So a CR
holding two plans splits across the two panels:

| CR | plan | plan status | cycles | renders in |
|---|---|---|---|---|
| `CR-CRU-122` | 129 | `aborted` | 426 `failed`, 427 `skipped` | **History** — survives the filter |
| `CR-CRU-122` | 131 | `open` | 430 `done`, 431 `active` | Active panel — stripped from History |
| `CR-CRU-123` | 130 | `aborted` | 428 `failed`, 429 `skipped` | **History** |

CR-CRU-020 §S1.3's rule was written when a CR had at most one plan; it has no rule for a CR carrying
an abandoned attempt *beside* a live one. The condition first became reachable on 2026-09-12, when
`abort` + re-`plan-file` (the sanctioned recovery path) was used for the first time on a CR that then
went on to execute — which is also the condition that exposed `cycle-add`'s resolver defect
(CR-CRU-124 §S1). One state, two latent defects.

**What is NOT the defect, so it is not "fixed" here:** a CR with several *terminal* plans legitimately
renders several History entries — the live board already shows `CR-CRU-077` three times and
`CR-CRU-095`, `CR-CRU-105`, `CR-CRU-035`, `CR-CRU-037` twice each, each entry a real prior attempt.
Those stay. The `0/2 cycles` rollup and the ✗/⊘ glyphs are also correct *for an aborted plan read in
isolation* — the aborted plan really did fail its active cycle and skip the rest. Only the decision
to narrate that plan while the CR is live is wrong.

**Surfaces (verified 2026-09-12):** `workflowLens`'s History filter (`public/app-logic.mjs:934`) and
its wave-visibility pass (`:996-998`, which drops a wave with zero visible CR nodes). No server
change; no change to the Active panel.

## Scope

### §S1 History excludes a CR that is live, not merely an open plan record

`workflowLens`'s History filter is keyed on the **CR**, not the plan: a CR node is dropped from
History when ANY plan in the lens input declares that `cr` with `status: "open"`. A CR with only
terminal plans is unaffected and keeps every one of its entries, in the order it already renders
them.

The existing `status !== "open"` condition stays as-is beneath the new one (an open plan's own node
must still never reach History) — the CR-level rule is additive, so CR-CRU-020 §S1.3's guarantee is
strengthened rather than restated.

### §S2 A wave whose only remaining material is a live CR still renders nothing

`workflowLens` already drops a wave with zero visible CR nodes (`:996-998`, CR-CRU-021 §S6 cycle 13
gap 2 — *"no header-only ghost entry"*). §S1 removes more nodes than before, so that pass must still
hold: a wave left with nothing but a live CR's stripped nodes renders no header at all, rather than
an empty `HISTORY — WAVE n` band. This section adds no code; it is the regression pin that §S1 does
not reintroduce a ghost header.

## Acceptance criteria

**§S1**
- [ ] Given plans `[{cr: "X", status: "aborted", cycles: [failed, skipped]}, {cr: "X", status:
      "open", cycles: [done, active]}]`, `workflowLens`'s output contains NO History CR node for
      `X` — the exact live shape (CR-CRU-122's plans 129 and 131).
- [ ] Given the same input, the Active view still renders `X` from its open plan, unchanged —
      asserted so the fix cannot make a live CR vanish from both panels.
- [ ] Given plans `[{cr: "Y", status: "aborted"}, {cr: "Y", status: "closed", merge: {...}}]` (no
      open plan), History renders BOTH of `Y`'s nodes — regression pin on the live board's existing
      multi-attempt CRs (`CR-CRU-077` ×3, `CR-CRU-095` ×2, `CR-CRU-105` ×2, `CR-CRU-035` ×2,
      `CR-CRU-037` ×2), which must keep every entry.
- [ ] Given plans `[{cr: "Z", status: "closed"}]` only, History renders `Z` exactly as today —
      regression pin on the ordinary case.
- [ ] A CR whose only plan is `aborted` (never re-filed) still renders in History — the abandoned-
      and-not-resumed case must not be swept away with the live one.
- [ ] Driven at the DOM level too, not only over the pure lens: with the two-plan fixture mounted,
      `[data-testid="cr-group"][data-cr="X"]` appears exactly ONCE in the whole Workflow pane, and
      it is inside `[data-testid="workflow-active"]`, not inside `[data-testid="workflow-history"]`.

**§S2**
- [ ] A wave whose every CR is live (each holding an aborted plan beside an open one) emits NO
      `[data-testid="wave-group"]` and no `HISTORY — WAVE n` header — the ghost-header pin.
- [ ] A wave holding one live CR AND one genuinely closed CR still renders its header and exactly
      the closed CR's node.

## Estimated size

S — one cycle. One filter predicate in one pure function, plus the regression pins that the
multi-attempt and ghost-header behaviours are untouched.

## Risk

- **`workflowLens` is pure and heavily pinned already** (`tests/app-logic.test.ts` and the workflow
  lens suites), which is what makes a one-predicate change safe to assert precisely. The real risk is
  over-reach: keying on the CR could sweep away the legitimate multi-attempt entries the live board
  depends on, which is why §S1 carries an explicit regression AC naming the five CRs that must keep
  every entry.
- No server change and no Active-panel change, so the blast radius is the History tree only.

## Non-goals

- Changing how an aborted plan's own cycles are rendered (`✗` failed / `⊘` skipped) or its
  `0/N cycles` rollup — correct for an aborted plan read in isolation.
- Collapsing or de-duplicating a CR's multiple TERMINAL entries — several real attempts are several
  real entries.
- Any change to `abort`, to `plan-file`, or to the recovery path that creates this state; the state
  is legitimate and the lens must read it correctly.
- `cycle-add`'s resolver defect arising from the same two-plan condition — that is CR-CRU-124.
