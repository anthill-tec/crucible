# CR-CRU-127 — a filed cycle declares its kind

**Status:** PENDING (0.2.0 — born mid-release, D4)
**Type:** bugfix
**Priority:** P2
**Depends on:** CR-CRU-011 (cycle plans), CR-CRU-107 (`plan-file`'s repeatable `--cycle`),
CR-CRU-121 (the shared registrar precedent for a `plan-file` flag), CR-CRU-124 (`cycle-add --kind`,
the vocabulary this CR extends to the other filing door)
**Labels:** bugfix, clients, plan-verbs, data-integrity
**Phase:** Wave 6 (0.2.0 — user-directed, live orchestrator session 2026-09-12)
**Design reference:** `docs/research/DN-crucible-wave-track-release.md` (the cycle model);
`src/v2.ts`'s `CYCLE_KINDS` is the vocabulary of record.

## Context

**A cycle filed through `plan-file` cannot say what kind it is, so every cycle after the first is
stored mislabelled.** The kinds are `red-green | verify | fix` (`CYCLE_KINDS`, `src/v2.ts:1337`),
and `parseCycleInput` defaults to `red-green` when the field is absent (`:1368-1369`). `plan-file`
never sends the field, so every cycle it files is stored `red-green` whatever it actually is.

**This is measured, live, on this board — not inferred:**

| plan | cycle | label | stored kind | truth |
|---|---|---|---|---|
| 132 (CR-CRU-124) | 433 | *verify the resolver rule, the message scope, and the fleet census* | `red-green` | verify |
| 133 (CR-CRU-123) | 436 | *verify the animation, AC7's no-new-child pin, …* | **`verify`** | verify |

Cycle 436 is correct for exactly one reason: CR-CRU-124 shipped `cycle-add --kind` hours earlier, so
the orchestrator filed the red-green cycle through `plan-file` and then **appended** the verify cycle
through `cycle-add --plan 133 --kind verify`. Cycle 433 is permanently wrong because no such door
existed when it was filed, and a stored cycle's kind is settled history (CR-CRU-124 §S4's non-goal —
this CR does not retro-fix it either).

The consequence is not cosmetic. The workflow lens renders a cycle's kind glyph from the stored
value (`KIND_GLYPHS`, `public/app.js`), so a verify cycle draws the red-green glyph `⟲` where it
should draw `☑`. The board narrates the wrong phase for every multi-cycle plan filed in one call —
which is the discipline this project adopted after CR-CRU-122 precisely so the authorized cycle set
is declared up front.

**Surfaces, measured 2026-09-12:**

| surface | state |
|---|---|
| `handlePlanFile` (`src/v2.ts:1378`) | iterates `body.cycles` through **`parseCycleInput`** (`:1389-1394`) — the SAME parser `handleCycleAppend` uses (`:1551`). The server already accepts a per-cycle `kind` |
| `cmd_plan_file` (`clients/_crucible_axi.py:2869`) | hard-codes `"cycles": [{"label": label} for label in labels]` (`:2904` — the spec first cited `:2884`, corrected by gap analysis) — the kind is not merely unset, it is unexpressible |
| `--cycle` declaration | **hand-rolled in all five clients**: arduino `:1279`, bun `:2194`, mvn `:2182`, python `:1561`, rust `:2801`. No shared registrar, exactly the state `plan-file --release` was in before CR-CRU-121 |

## Scope

### §S1 The kind is declared per cycle, paired by position

**User ruling 2026-09-12 (grammar).** A repeatable `--cycle-kind` pairs with the repeatable
`--cycle` **by position**: the Nth `--cycle-kind` is the kind of the Nth `--cycle`.

```
plan-file --cr CR-CRU-nnn --title "…" \
  --cycle "the implementation" --cycle-kind red-green \
  --cycle "verify it"          --cycle-kind verify
```

The two rejected alternatives are recorded because the reasons outlive the decision. One flag per
kind (`--red-green` / `--verify`) reads better but argparse does not preserve interleaved order
**across different flags**, so authored order — which is load-bearing, since cycles activate in
ascending order — would have to be reconstructed rather than read. A delimited value
(`--cycle "verify:label"`) keeps order trivially but re-opens the defect CR-CRU-078 already paid
for: `--cycles` split on a comma inside a label and silently filed three cycles nobody planned.

A **count mismatch is refused client-side before any POST**, naming both counts. Silent truncation
or silent padding would file a plan whose kinds are off by one — worse than the defect being fixed.

`--cycle-kind` is declared with **no argparse `choices=`**, following CR-CRU-124 §S4 deliberately:
the vocabulary belongs to the server, so an unknown kind must surface as the route's own refusal
rather than an argparse exit, and the fleet never holds a second copy of `CYCLE_KINDS`.

### §S2 One shared registrar reaches all five clients

The flag is declared **once** in `clients/_crucible_axi.py` — the CR-CRU-121 (`--release`) and
CR-CRU-124 (`--plan`/`--kind`) pattern — and each of the five clients gains exactly one delegation
line. `--cycle` itself is hand-rolled five times today; this CR does not lift it (out of scope), but
the NEW flag must not repeat that mistake.

A census asserts it mechanically: no client may declare `--cycle-kind` in its own source, exactly
one shared function declares it, every client's `plan-file` subparser reaches that function, and the
client count itself is asserted so a sixth stack cannot be added silently.

### §S3 The body carries the kind

`cmd_plan_file` sends `{"label": …, "kind": …}` per cycle. No client-side default is invented — the
kind that travels is the kind the caller declared.

### §S4 The mandate: a filed cycle with no kind is REFUSED

**User ruling 2026-09-12 (enforcement), NARROWED by user ruling 2026-09-13.** The kind is
**required**, not optional-with-a-default — enforced **CLIENT-SIDE ONLY**. `plan-file` refuses a
cycle carrying no declared kind before any POST. **The ROUTE stays permissive:** `parseCycleInput`
keeps its `red-green` default and `POST …/plans` continues to accept a kindless cycle entry.

**Why the narrowing, recorded with the measurement that drove it.** The route half of the original
ruling was measured at **~110 extra call sites** (30 test files POSTing `cycles[]` directly) against
**~22** for the client half — roughly five times the whole rest of the CR. And its only present-day
beneficiaries are our own tests: the SPA never POSTs a plan (`WorkflowActive` reads `scopedPlans()`;
no POST exists in `public/app.js`), so every real filing already goes through a client. The user took
the narrower option knowing the residue, which is recorded as a candidate in
`docs/changes/README.md` rather than silently dropped: **anything that is not one of the five
clients can still file a kindless cycle and the board will store it `red-green`.**

**The refusal was never to live in `parseCycleInput`, and now lives in no server file at all.** The
original constraint is preserved for the record because it explains the shape: `parseCycleInput` is
shared with `handleCycleAppend` (`src/v2.ts:1359`, called at `:1551`), and CR-CRU-124 §S4/AC3 pins
by full-body equality that `cycle-add` with no `--kind` omits the field and lets the server default
apply. Under the narrowed ruling that contract is untouched by construction — no server file changes
at all — which is strictly safer than the original placement rule.

**§S4a The legacy `--cycles` door is closed, not exempted.** Found by gap analysis 2026-09-13
(DRIFT-7) and load-bearing precisely BECAUSE enforcement is now client-only: `--cycles` (the
comma-split legacy form) also files cycles, and §S1 pairs `--cycle-kind` with the repeatable
`--cycle` only. MEASURED: **19 of the 22** `plan-file` argv lists in `tests/client/*.py` use
`--cycles`, so it is the dominant existing form, not a vestige. Leaving it exempt would leave the
mandate with a hole big enough to drive the original defect straight through — on the only
enforcement surface left. **Orchestrator ruling:** with kinds required, `--cycles` is REFUSED for
filing, with a `help[]` handing back the `--cycle` + `--cycle-kind` form. It is already the legacy
flag, and CR-CRU-078's silent three-cycle comma split is the recorded reason it should not be the
path new data arrives through. The alternative — pairing kinds positionally against comma-split
labels — was rejected: it would make a label containing a comma corrupt the KIND pairing too,
turning one recorded defect into two.

### §S5 Every caller is migrated

A required flag breaks every existing caller. The full set is enumerated and migrated in this CR —
fleet clients, the test tree (both `.ts` and `tests/client/*.py`), and the e2e step files — with the
count itself asserted, per CR-CRU-118 §S4b's precedent. An inverting assertion (one that pins
today's kind-less body) is REWRITTEN to state the new contract, never deleted and never re-pinned to
the new text.

### §S6 The flags are DESCRIBED to calling agents — the AXI standard

The user's standing requirement (2026-07-21): every client is an **AXI** interface
(https://axi.md) that must be *"sane, complete, self-explanatory, and structurally prevent
orchestrators from losing context and process accuracy."* A cycle stored with the wrong kind IS a
loss of process accuracy — the named failure mode that standard exists to close — so this CR is
AXI work, not merely flag work.

**Why the help text is load-bearing here and not cosmetic.** §S1 deliberately omits argparse
`choices=` so the server owns `CYCLE_KINDS`. That decision REMOVES the only other place an agent
could discover the vocabulary: without `choices=`, `--help` is the sole surface that can teach a
calling agent that the kinds are `red-green | verify | fix`. An agent that cannot read the
vocabulary must discover it by being refused, which is precisely the context-loss AXI principle 10
(consistent `--help`) exists to prevent.

Three obligations, each with an existing enforcement point in
`tests/client/test_bun_crucible_axi_conventions.py`:

1. **Principle 10 — consistent `--help`.** `--cycle-kind`'s help text NAMES all three kinds, in one
   wording identical across all five clients (the shared registrar makes that structural). This
   mirrors CR-CRU-124, whose `--kind` help names the three the route accepts.
2. **Principle 9 — contextual disclosure.** Both new refusals (count mismatch, absent kind) carry a
   non-empty `help[]` that hands back the **CORRECTED invocation**, not a restatement of the error.
   The pattern already exists and is asserted: `_assert_structured_refusal`
   (`tests/client/test_bun_crucible_axi_conventions.py:1066`) requires at `:1084` that `help[]`
   "hand back the CORRECTED repeatable-`--cycle`" form — CR-CRU-107's precedent. The new refusals
   join it rather than inventing a second shape.
3. **Principle 6 — structured errors on STDOUT, exit 0/1/2.** Both refusals emit the TOON-AXI
   envelope on **stdout** with a non-zero exit, never a bare stderr line or a traceback
   (`_assert_structured_failure`, `:859`).

And a regression: `plan-file`'s EXISTING `help[]` next-step template must keep working —
`test_plan_file_help_suggests_the_cycle_activate_placeholder_template` (`:500`) pins that a
successful filing suggests the literal `cycle-activate <id>`. A mandate that broke the verb's
forward guidance would trade one context loss for another.

## Acceptance criteria

**§S1**
- [ ] `plan-file` with two `--cycle` flags and two `--cycle-kind` flags files two cycles whose STORED
      kinds, read back from the store (never the POST response), are the two declared, in order.
- [ ] The Nth kind pairs with the Nth cycle — asserted with two DIFFERENT kinds in a non-alphabetical
      order, so a pairing that sorts or reverses fails.
- [ ] More kinds than cycles, and more cycles than kinds, are BOTH refused with `ok:false`, an error
      naming both counts, and **zero POSTs** — asserted on the POST recorder, not just the exit code.
- [ ] An unrecognised kind (`--cycle-kind smoke`) reaches the ROUTE and surfaces the server's own
      refusal as `ok:false`; argparse does not reject it, and no cycle is stored.
- [ ] `--cycle-kind` is declared with no `choices=` — asserted against the client source, so the
      vocabulary cannot be copied into the fleet.

**§S2**
- [ ] All five clients accept `--cycle-kind` on `plan-file`, declared at exactly ONE shared registrar
      call site; no client declares it in its own source (AST census, with `--cr` as the non-vacuity
      anchor).
- [ ] Every client's `plan-file --help` prints the flag with one identical wording — asserted by
      driving all five real `plan-file --help` subprocesses, not by reading source.
- [ ] The census asserts the client count (5) itself.

**§S3**
- [ ] The request body carries `kind` per cycle entry, asserted on the recorded payload.

**§S4**
- [ ] `plan-file` with `--cycle` and NO `--cycle-kind` is refused client-side: `ok:false`, non-zero
      exit, zero POSTs.
- [ ] **The ROUTE is UNCHANGED and still permissive** (narrowed by user ruling 2026-09-13, replacing
      the original route-refusal AC): `POST …/plans` with a cycle entry carrying no `kind` still
      succeeds and still stores `red-green`. Asserted against the server directly, as a REGRESSION
      pin — the enforcement is client-side, and no server file is touched by this CR.
- [ ] `plan-file --cycles "a,b"` (the legacy form) is REFUSED client-side under the mandate, with a
      non-empty `help[]` handing back the `--cycle` + `--cycle-kind` form, `ok:false`, non-zero
      exit, and zero POSTs (§S4a). Asserted on the POST recorder, not just the exit code.
- [ ] **Refusal ORDER is a contract** (pinned by RED 2026-09-13, finding F4 — three existing tests
      pass argv that could trip more than one refusal, so the order is asserted rather than left to
      chance):
      1. BOTH `--cycle` and `--cycles` present → the existing `cycle-flags-conflict` refusal fires
         FIRST, preserving CR-CRU-107/AC4 whose error must name BOTH flags. A §S4a check placed
         first would name only `--cycles` and silently retire that contract.
      2. `--cycles` present alone → the §S4a refusal, whose error names `--cycles` (which is why the
         existing empty-`--cycles` test still passes).
      3. A blank/whitespace `--cycle` occurrence → `cycle-list-empty` BEFORE any kind check: a call
         naming no cycle has nothing for a kind to pair with.
- [ ] The three refusals this CR adds are told apart by DISTINCT codes, and each error names its own
      flag or counts — asserted by distinctness, NOT against invented literals (RED finding F5: the
      spec names no code strings, so pinning three literals would be RED dictating GREEN's
      vocabulary rather than pinning observable behaviour).
- [ ] The `--cycles` closure is SCOPED, asserted as a census: `--cycles` is declared exactly once per
      client and only on `plan-file` (MEASURED by RED 2026-09-13 — arduino `:1281`, bun `:2196`,
      mvn `:2184`, python `:1563`, rust `:2803`), and its DECLARATION survives the closure.
      **Corrected from "remains accepted by every OTHER verb that takes it, if any" (RED finding F2):
      that wording was VACUOUS** — no other verb takes the flag, so it asserted nothing. The census
      also guards a real failure mode the original wording missed: refusing `--cycles` by DELETING
      its argparse declaration would replace the structured AXI refusal with argparse's bare usage
      error, which is a §S6 violation dressed as a fix.
- [ ] **`cycle-add` is UNCHANGED**: with no `--kind` its body still omits the field entirely and the
      server still applies `red-green`. CR-CRU-124 §S4/AC3's full-body equality assertion passes
      byte-unchanged — the regression pin proving the shared parser was not made stricter.

**§S5**
- [ ] The FLEET half of the migration is asserted mechanically: five clients, five delegation lines,
      exactly one shared registrar, and the client count itself. **The CALLER half is enforced at
      RUNTIME, not counted (corrected per RED finding F3):** an un-migrated caller now FAILS, which
      is a stronger guarantee than a census — and a static count is not soundly assertable here,
      because the negative tests deliberately pass an unpaired `--cycle` and a bare `--cycles`, so
      any allowlist would be broken by the very tests that prove the mandate. The measured figure the
      original AC asked for lives in this CR's gap analysis (≈64 sites). Route POSTs are NOT
      migrated — the narrowed ruling leaves them valid, removing ~110 of the originally measured
      ~174 sites.
- [ ] `bun test` and the python client suites are green with no test weakened to accommodate the
      mandate.

**§S6 (AXI)**
- [ ] `--cycle-kind`'s help text NAMES all three kinds (`red-green`, `verify`, `fix`) in every one of
      the five clients — the ONLY place an agent can learn the vocabulary, since §S1 omits
      `choices=`. Asserted per client against the real printed help.
- [ ] The count-mismatch refusal and the absent-kind refusal each carry a non-empty `help[]` that
      hands back the CORRECTED invocation — asserted through the existing
      `_assert_structured_refusal` shape, not a new one.
- [ ] Both refusals emit the TOON-AXI envelope on STDOUT with a non-zero exit and no traceback
      (`_assert_structured_failure`).
- [ ] REGRESSION: a SUCCESSFUL `plan-file` still suggests the literal `cycle-activate <id>` in its
      `help[]` — `test_plan_file_help_suggests_the_cycle_activate_placeholder_template`'s
      **ASSERTION passes unchanged; its INVOCATION migrates with every other caller.**
      **Corrected from "passes byte-unchanged" (RED finding F1 — a self-contradiction between two
      ACs both added 2026-09-13):** that test files with `--cycles "a,b"` and asserts exit 0, which
      is exactly the form §S4a now refuses, so the two ACs could not both hold. Resolved by §S5's
      own standing rule — an inverting invocation is REWRITTEN, never re-pinned — which preserves
      the criterion's substance (a successful filing still hands back its next step) while letting
      the driving argv migrate like every other caller's.
- [ ] `tests/client/test_bun_crucible_axi_conventions.py` is green, with its per-verb `help[]`
      coverage extended to the new refusals rather than left asserting only the old surface.
- [ ] **The two suggested-invocation templates are updated to the mandated form** (gap analysis
      DRIFT-1, BLOCKING as the spec stood). Both must teach an invocation that the new mandate
      ACCEPTS, and both are asserted:
      1. `CYCLE_FLAG_TEMPLATE` (`clients/_crucible_axi.py:1241-1242`), consumed by three refusal
         `help[]` lists (`:1250`, `:2848`, `:2876`);
      2. `_next_start_help`'s own hand-built step string (`:1855-1856`) — the `next` verb's
         state-derived help, which is the literal command an orchestrator copies to START a CR.
      Both are updated, not one: the template exists TWICE (a shared constant and a hand-built
      duplicate), so repairing either alone is the half-migration this CR's §S5 exists to prevent.
      MEASURED as safe for the existing pins: `_REPEATABLE_OCCURRENCE`
      (`tests/client/test_plan_file_cycle_flag_help.py:116`) is `/--cycle(?![-\w])/`, which excludes
      `--cycle-kind` by construction, and `_REPEATABLE_WITH_LABEL` (`:118`) requires only
      `--cycle "<…>"` — so an ADDITIVE template change keeps AC7/AC8 green rather than needing them
      rewritten.

## Estimated size

S/M — **ONE cycle** under the narrowed ruling (user, 2026-09-13). The estimate has now been wrong in
both directions and the arithmetic is written down so the next reader can check it rather than
re-guess: the spec said "one or two"; the gap analysis measured the ORIGINAL scope at **≈174 sites**
and corrected it UP to two cycles; the user then dropped the route half, which removes the **110
route POSTs across 30 files** that were 63% of it.

What remains is MEASURED at **≈64 sites**: 22 `plan-file` argv lists in `tests/client/*.py` that
pass a cycle flag (**19 of them the legacy `--cycles`**, which §S4a now refuses — so they migrate to
`--cycle` + `--cycle-kind`), ~23 `.ts` suites that spawn a real client (mostly one mention each;
`clients-bun-crucible.test.ts` carries 14 and uses `--cycles`), 5 client delegation lines, the 5
e2e step files behind `harness.ts`'s single `filePlan`, and the 2 suggested-invocation templates.
`store.filePlan`'s 3 direct callers are untouched, as are all 110 route POSTs.

For the record, the spec's yardstick — CR-CRU-118's 184 call sites across 15 suites, a figure that
was wrong twice before it was measured properly — was a good predictor of the ORIGINAL scope and a
bad one for the shipped scope. The lesson is that a size estimate is only meaningful against a
settled enforcement boundary.

## Risk

- **The shared parser is the trap.** `parseCycleInput` serves both filing doors. A refusal placed
  there satisfies §S4's wording and silently retires CR-CRU-124 §S4/AC3. §S4's own AC pins the
  `cycle-add` side as a regression, so the mistake fails a test rather than shipping.
- **A required flag is a breaking change to a shipped verb.** Every caller must be migrated in the
  same CR; a partial migration leaves `plan-file` unusable on the un-migrated path.
- **Positional pairing is only as good as its refusal.** If a mismatch were tolerated, the failure
  mode is a plan whose kinds are off by one — silently wrong data, the exact class this CR removes.

## Non-goals

- **Route-level enforcement of the mandate** (user ruling 2026-09-13 — dropped from this CR after
  the gap analysis measured its price at ~110 extra call sites, 63% of the CR, defending a path
  whose only present-day non-fleet callers are our own tests). `POST …/plans` stays permissive and
  keeps its `red-green` default, asserted as a regression pin in §S4 so the omission is deliberate
  and visible rather than assumed. **The residue is real and is recorded as a candidate in
  `docs/changes/README.md`:** anything that is not one of the five clients — a curl, a new tool, a
  future stack — can still file a kindless cycle and the board will store it `red-green`, which is
  this CR's own defect surviving on the one door it does not close.
- **Retro-correcting stored kinds.** Plan 132's cycle 433 stays `red-green`; a stored cycle's kind is
  settled history (CR-CRU-124 §S4's non-goal, restated).
- **Lifting `--cycle` itself into a shared registrar.** It is hand-rolled five times; that is a
  pre-existing parity gap, measured here and left to the registrar-parity work (CR-CRU-075's family).
- Changing `CYCLE_KINDS`, the glyph map, or how the lens renders a kind.
- Changing `cycle-add`'s optional `--kind`, or any other verb's flags.
- Adding `choices=` to `--cycle-kind`. It is omitted deliberately (§S1); §S6 is what makes that
  safe, by requiring the vocabulary to be discoverable in `--help` instead.
- The bundled Model-B `crucible-report-<stack>` skills, whose `plan-file` guidance will need the new
  flag — that delivery is the standing RELEASE-time obligation already recorded in this register.

## Gap analysis (orchestrator, 2026-09-13)

Performed by the orchestrator. Not delegated.

### Step 0 — MEASURED baseline

On `08628c7` (`release/0.2.0`), both stacks through their clients, serially:

| stack | passed | failed | pending | total | files |
|---|---|---|---|---|---|
| TypeScript | 2365 | 0 | 0 | 2365 | 169 |
| Python | 1788 | 0 | 1 | 1789 | 86 |
| **combined** | **4153** | **0** | **1** | **4154** | **255** |

`tsc --noEmit` exit 0; both gate exits 0.

**The first attempt exited NON-ZERO with that identical green suite, and the cause is worth
recording (DRIFT-5).** The gate's own ingest was refused with
`409 bound cycle 440 is in closed plan CR-CRU-125 — ingest refused, run NOT stored`: the
orchestrator was still registered BOUND to cycle 440, which `cr-close` had just sealed inside a
closed plan. The server is right — *"a stale binding never spills into another cycle"* — but the
consequence is that **every** ingest fails until the binding is cleared, and a plain
`register --agent … --role ORCHESTRATOR` does NOT clear it (CR-CRU-056 rebinds only on an EXPLICIT
`--cycle`, so omitting the flag preserves the stale value; measured: `boundCycleId` still `440`
after re-registering). Only `unregister` followed by `register` cleared it (`boundCycleId: None`).
A/B on the same tree: exit 1 while bound, exit 0 after clearing, counts identical. **Operational
rule:** clear the binding immediately after `cr-close`, before any further run.

### §S5's caller census — MEASURED, as the spec's AC demands

| surface | measured | breaks under the mandate? |
|---|---|---|
| Route POSTs to `…/plans` carrying `cycles[]` | **110 sites across 30 files** | **YES** — §S4's route refusal |
| — heaviest: `plans.test.ts` 40, `registered-caller-auth.test.ts` 16, `cycle-activation-guards.test.ts` 8, `cycle-insert-before.test.ts` 7, `plan-abort.test.ts` 5 | | |
| `plan-file` argv invocations in `tests/client/*.py` | **59 across 16 files**, of which **22 pass `--cycle`** | YES — the client-side mandate |
| `store.filePlan(…)` direct callers | **3 across 3 files** | **NO** — §S4 places the refusal in `handlePlanFile`, not the store |
| Client `--cycle` declarations | **5** (arduino `:1279`, bun `:2194`, mvn `:2182`, python `:1561`, rust `:2801`) | each gains one delegation line |
| e2e step files carrying cycles | **5**, funnelling through `tests/e2e/steps/harness.ts`'s single `filePlan` | YES, but via one helper |
| Suggested-invocation templates | **2** (see the new §S6 AC) | YES — they would teach a refused command |

**Total ≈ 174 call sites.** The spec cited CR-CRU-118's 184 as its yardstick and was therefore NOT
an underestimate — a rare case of an estimate surviving measurement. But **the size line is
optimistic**: migration only partly funnels through helpers. `tests/plans.test.ts` HAS a `planFile`
helper and still carries 46 inline `cycles: [` bodies; `cycle-activation-guards.test.ts` funnels
through `filePlanAB`; most other sites are individual edits. Size should read **M — two cycles, with
§S5's migration as its own cycle**, not "one or two".

### Findings

| # | Dim | Finding | Fix scope | Blocking? |
|---|---|---|---|---|
| DRIFT-1 | 3 / rule 14 | Both suggested-invocation templates would teach a command the mandate refuses, and NO AC covered them. `CYCLE_FLAG_TEMPLATE` (`_crucible_axi.py:1241-1242`) feeds three refusal `help[]` lists; `_next_start_help` (`:1855-1856`) is the literal command an orchestrator copies to start a CR — it is what this board handed the orchestrator for CR-CRU-127 itself. §S6 covered the new flag's help and the `cycle-activate` regression only. | SPEC_UPDATE | **Yes** — new §S6 AC added above |
| DRIFT-2 | 7 | §S5's caller count was unmeasured (its own AC required measuring it here). Now measured at ≈174 sites; the size line needs to say two cycles. | SPEC_UPDATE | **Yes** — sizing |
| DRIFT-3 | 7 | **Cost concentration, surfaced not cut.** §S4's ROUTE half drives ~110 of the ~174 sites; the CLIENT half costs 22 and alone discharges the CR's stated problem ("a cycle filed through `plan-file` cannot say what kind it is"). The route half's only current non-fleet callers ARE the tests — the SPA never POSTs a plan (`WorkflowActive` reads `scopedPlans()`; verified no POST in `public/app.js`). **It stays:** the user RULED the mandate holds "at the route, so the mandate holds for any caller and not merely for the fleet". Recorded as a price, not a proposal. | none (user ruling) | No |
| DRIFT-4 | 2 | `cmd_plan_file`'s body line is at `_crucible_axi.py:2904`, not `:2884`. Every `src/v2.ts` citation VERIFIED ACCURATE: `:1337` CYCLE_KINDS, `:1368-1369` the `red-green` default, `:1378` handlePlanFile, `:1389` the cycles check, `:1551` the shared parser inside handleCycleAppend. | SPEC_UPDATE | No — corrected above |
| DRIFT-5 | — | A stale cycle binding blocks EVERY ingest and survives an unbound re-register; only `unregister` + `register` clears it. Cost this analysis one full 10-minute gate re-run. | operational note | No |
| DRIFT-6 | 2 | **Positive result:** the existing help-surface guards are robust to the new flag BY CONSTRUCTION. `_REPEATABLE_OCCURRENCE` is `/--cycle(?![-\w])/`, which excludes `--cycle-kind` as well as `--cycles`; `_REPEATABLE_WITH_LABEL` needs only `--cycle "<…>"`. So AC7/AC8 stay green under an additive template change and need no rewrite — worth knowing before RED is tempted to retarget them. | none | No |

Dimension 3 (bounded surface): **N/A** — no stated pixel/row budget is touched; a kind glyph is one
character in an existing slot. Dimension 5 (design-lineage): the load-bearing lineage call is already
IN the spec and verified correct — `parseCycleInput` (`src/v2.ts:1359`) really is shared with
`handleCycleAppend` (`:1534`, parser call at `:1551`), so §S4's insistence that the refusal live in
`handlePlanFile` is right, and its own AC pins the `cycle-add` side. Dimension 6 (public-symbol
removal): **N/A** — nothing is removed; legacy `--cycles` stays.

### Verdict

**SPEC_UPDATE_NEEDED → RESOLVED, now READY.** DRIFT-1's missing AC is added, DRIFT-4's citation
corrected, §S5's figure measured, and **DRIFT-3 decided by the user on 2026-09-13: CLI-only
enforcement.** The route half is dropped to a non-goal with a regression pin and a candidate note,
which removed 110 of the 174 measured sites and resized the CR from two cycles to one.

**DRIFT-7, found only because of that ruling.** Narrowing enforcement to the client made the legacy
`--cycles` flag load-bearing: it also files cycles, §S1 pairs kinds with `--cycle` only, and **19 of
the 22** python argv invocations use it. Left exempt it would have been an unguarded door on the
only enforcement surface remaining — the original defect, reachable. Closed by §S4a as an
orchestrator ruling (refuse `--cycles` for filing, `help[]` hands back the repeatable form) rather
than by positional pairing against comma-split labels, which would let a comma inside a label
corrupt the KIND pairing too and turn one recorded defect (CR-CRU-078) into two. **This is the
finding worth remembering from this analysis:** narrowing a scope did not simply subtract work, it
MOVED the risk onto a surface that had been safe by redundancy.

### Close-out steps (planned ONCE, not per cycle)

- **Re-measure the citation heads at close-out.** This CR edits `clients/` heavily (shared registrar
  + five delegations + templates), so the `clients` head (815 at CR-CRU-125's close) will move by
  however many CR literals the provenance comments add. MEASURE with the guard's own machinery;
  never transcribe. `src` moves only if `handlePlanFile` gains a comment naming the CR.
- **Run `test:e2e` by hand.** `tests/e2e/steps/harness.ts` files plans through the route, so the
  mandate reaches it, and `pre-merge-gate` does not collect e2e (DN open question 5).
- **Clear the orchestrator's cycle binding after `cr-close`** (DRIFT-5) — `unregister` + `register`,
  before any further ingest.
