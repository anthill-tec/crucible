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
PLAN** (its own comment at `:845`, corrected from `:846` by gap analysis: *"Declared: one CR node
per plan"*), then strips History down
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

**Keyed on the CR, computed GLOBALLY.** The live-CR set is derived from the RAW `plans` input
*before* the per-wave loop, not from each wave's own nodes: a re-filed plan takes its `--wave` from
the caller, so a CR's aborted and open plans are not guaranteed to share a wave label. This mirrors
`declaredWaveLabels` (`public/app-logic.mjs:927`), which already computes a global fact off `plans`
for exactly this reason — the mechanism is extended, not invented.

**Inferred nodes are IN SCOPE.** `workflowLens` builds two kinds of node: DECLARED (one per plan,
carrying `status`) and INFERRED (built from unlinked runs, `source: "inferred"`, with **no `status`
field at all** — `public/app.js:4616` renders `node.status ?? "inferred"`). Today's
`c.status !== "open"` therefore keeps every inferred node, so a CR-keyed filter that looked only at
declared nodes would leave this defect reachable by the inferred path. The filter keys on `cr` for
BOTH kinds: an inferred node for a live CR narrates the same CR the Active panel is already showing.

**Design lineage (gap analysis 2026-09-13).** CR-CRU-079 §S2 already ASSUMED this rule. Its comment
at `public/app.js:4375-4377` justifies marking the open plan's root as the drill-through target
because an IN_PROGRESS CR *"has no history group to land on"*. Today it can have one — and then
BOTH the Active root (`:4380`) and the History group (`:4621`) carry `data-drill-target="true"`,
leaving `document.querySelector` (`:4247`) to resolve the target by DOM order alone. §S1 restores
the invariant CR-079 was written against and closes that latent ambiguity as a side effect.

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
      open plan), History renders BOTH of `Y`'s nodes, **in the order it renders them today**
      (`closedAt` descending, nodes lacking `closedAt` keeping filing order via the stable sort at
      `public/app-logic.mjs:938`) — regression pin on the live board's existing multi-attempt CRs
      (`CR-CRU-077` ×3, `CR-CRU-095` ×2, `CR-CRU-105` ×2, `CR-CRU-035` ×2, `CR-CRU-037` ×2), which
      must keep every entry. The ORDER clause is explicit because §S1's prose promised it and prose
      is measured against nothing (gap analysis 2026-09-13, DRIFT-5).
- [ ] Given plans `[{cr: "Z", status: "closed"}]` only, History renders `Z` exactly as today —
      regression pin on the ordinary case.
- [ ] A CR whose only plan is `aborted` (never re-filed) still renders in History — the abandoned-
      and-not-resumed case must not be swept away with the live one.
- [ ] An INFERRED node whose `cr` stem names a live CR is ALSO dropped from History — the
      inferred-path variant of §S1, which the `status`-keyed filter could never have caught because
      inferred nodes carry no `status` (gap analysis 2026-09-13, DRIFT-4).
- [ ] An inferred node whose stem names a CR with NO open plan is untouched.
- [ ] Driven at the DOM level too, not only over the pure lens: with the two-plan fixture mounted,
      `[data-testid="cr-group"][data-cr="X"]` appears **ZERO** times inside
      `[data-testid="workflow-history"]`, and `X` still renders in the Active panel as exactly ONE
      `[data-testid="workflow-cr-root"][data-cr="X"]` inside `[data-testid="workflow-active"]`.

      **Corrected by gap analysis 2026-09-13 (DRIFT-1 — BLOCKING as originally written).** The
      original AC required the `cr-group` to appear "exactly ONCE … inside `workflow-active`". That
      is unsatisfiable: `LensCrGroup` (`public/app.js:4611-4621`) is the ONLY producer of
      `[data-testid="cr-group"]` and it is reached solely through `WorkflowHistory`
      (`:4744-4750`), while `WorkflowActive` (`:4384-4425`) renders open plans straight from
      `scopedPlans()` and identifies its CR through `crRootProps` →
      `[data-testid="workflow-cr-root"][data-cr]` (`:4378-4382`). After §S1 the count inside
      History is ZERO and the Active panel emits no `cr-group` at all, so the original wording could
      only be satisfied by ADDING `cr-group` markup to the Active panel — new DOM work that §S1
      ("no change to the Active panel") and the Risk section both forbid.

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

## Gap analysis (orchestrator, 2026-09-13)

Performed by the orchestrator per the mandatory pre-implementation procedure. Not delegated.

### Step 0 — MEASURED baseline

Run at 02:29–02:42 on `d34dae9` (`release/0.2.0`), both stacks through their clients, serially:

| stack | passed | failed | pending | total | files |
|---|---|---|---|---|---|
| TypeScript | 2354 | 0 | 0 | 2354 | 169 |
| Python | 1788 | 0 | 1 | 1789 | 86 |
| **combined** | **4142** | **0** | **1** | **4143** | **255** |

`tsc --noEmit` exit 0; `PY_EXIT=0`; `BUN_EXIT=0`. Re-measured deliberately AFTER CR-CRU-126's merge
and the two doc commits that followed it, because `docs/changes/README.md` is read as a fixture by
the roadmap-grammar suites — an orchestrator's own commits are inputs to the system under test.

### Findings

| # | Dim | Finding | Fix scope | Blocking? |
|---|---|---|---|---|
| DRIFT-1 | 2 | AC6 demanded `[data-testid="cr-group"]` inside `workflow-active`; only `WorkflowHistory` produces that testid, and the Active panel marks its CR with `workflow-cr-root`. Unsatisfiable without new Active-panel DOM the spec forbids. | SPEC_UPDATE | **Yes** — corrected above |
| DRIFT-2 | 2 | §S1's "one CR node per plan" comment is at `app-logic.mjs:845`, not `:846`. `:934` and `:996-998` verified exact. | SPEC_UPDATE | No |
| DRIFT-3 | 5 | CR-CRU-079 §S2 already assumed a live CR has no History group; today both Active root and History group can carry `data-drill-target="true"`, resolved only by DOM order. §S1 closes it. | none (corroboration) | No |
| DRIFT-4 | 2 | INFERRED nodes carry no `status`, so the current filter keeps them all; a declared-only CR filter would leave the defect reachable by the inferred path. Two ACs added. | SPEC_UPDATE | **Yes** — corrected above |
| DRIFT-5 | — | §S1's promise that multi-attempt entries keep "the order it already renders them" lived in prose with no AC (rule 14). AC3 now pins `closedAt` desc + stable filing order. | SPEC_UPDATE | No |
| DRIFT-6 | 16 | Inverse blast radius: 54 `app-logic.mjs:<line>` citations across 23 files; ~14 sit below `:934` and shift on an insertion above the filter. NONE is machine-checked (verified — the only machine-checked citation guard cites `src/store.ts`). The new provenance comment moves the `public` `PROSE_CITATIONS` head **476 → 477**. | close-out step | No |
| DRIFT-7 | 4 | The server already derives CR-level liveness (`PlanStatusFacts`/`byCr`, `src/store.ts:3575`; roadmap `IN_PROGRESS = open plan`). §S1's client-side CR-keying must agree with that definition, and is an extension of an existing notion rather than a new one. | note | No |
| DRIFT-8 | 7 | §S2 adds no code and its open-plan-only ghost-header case is ALREADY pinned (`tests/workflow-lens.test.ts:477`, `:523`). The aborted-beside-open variant is genuinely new, so §S2 earns its place at near-zero cost. | none | No |
| DRIFT-9 | 7 | There are ZERO `"aborted"` pins in either lens suite today, so AC5's abandoned-and-not-resumed case is new coverage, not a duplicate — and it is the anti-over-reach pin the Risk section relies on. | none | No |

Dimension 3's bounded-surface check: **N/A** — §S1 only ever REMOVES nodes from a rendered list, so
no stated budget gains unbounded content. Dimension 6 (public-symbol removal): **N/A** — nothing is
removed; the existing `status !== "open"` predicate stays.

### Verdict

**SPEC_UPDATE_NEEDED → now READY.** Both blocking findings (DRIFT-1, DRIFT-4) are corrected in the
sections above. Estimated size stands at S/one cycle: the fix is still one predicate, but it is
keyed globally off `plans` and applies to both node kinds, and it carries eight ACs rather than six.

### Close-out steps (planned ONCE, not per cycle)

- **Re-record the `public` `PROSE_CITATIONS` head** in `tests/project-namespace-tripwire.test.ts`:
  `476 → 477` for §S1's provenance comment in `public/app-logic.mjs`. MEASURE it at close-out with
  the guard's own machinery rather than transcribing this figure — a second citation in the same
  commit would make it 478 and the measurement is what catches that.
- **Do NOT re-pin the 54 informal `app-logic.mjs:<line>` citations.** None is machine-checked and
  most are historical CR prose; re-pinning 14 shifted informal references is disproportionate, the
  same ruling CR-CRU-126 recorded for `store.ts`.
- **Run `test:e2e` by hand at close-out.** Six e2e step files assert `cr-group` / `workflow-history`
  / `wave-group` and `pre-merge-gate` does not collect e2e (DN open question 5), so the gate cannot
  speak for this CR's own blast radius. Use the project's designed path — plain `test:e2e`, then
  `bun-crucible.py auto-ingest` (the `e2e` verb injects a `--reporter-outfile` flag Playwright
  rejects; recorded 2026-09-12 as a separate client defect).
