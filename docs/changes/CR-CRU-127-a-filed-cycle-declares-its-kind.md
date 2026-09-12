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
| `cmd_plan_file` (`clients/_crucible_axi.py:2869`) | hard-codes `"cycles": [{"label": label} for label in labels]` (`:2884`) — the kind is not merely unset, it is unexpressible |
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

**User ruling 2026-09-12 (enforcement).** The kind is **required**, not optional-with-a-default.
`plan-file` refuses a cycle carrying no declared kind — client-side, and at the route, so the
mandate holds for any caller and not merely for the fleet.

**The refusal MUST live in `handlePlanFile`, NOT in `parseCycleInput`.** This is the one place this
CR can break a shipped contract. `parseCycleInput` is shared with `handleCycleAppend`, and
CR-CRU-124 §S4/AC3 pins that `cycle-add` with no `--kind` sends a body with the field **absent** and
the server applies its default — asserted by full-body equality. Making the shared parser refuse
absence would retire that contract silently. The mandate is a property of the `plan-file` route.

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
- [ ] `POST …/plans` with a cycle entry carrying no `kind` is refused by the ROUTE (400), nothing
      stored — asserted against the server directly, not through a client.
- [ ] **`cycle-add` is UNCHANGED**: with no `--kind` its body still omits the field entirely and the
      server still applies `red-green`. CR-CRU-124 §S4/AC3's full-body equality assertion passes
      byte-unchanged — the regression pin proving the shared parser was not made stricter.

**§S5**
- [ ] Every caller that files a plan declares kinds; the migrated caller count is asserted, and the
      figure is MEASURED in this CR's gap analysis rather than estimated.
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
- [ ] REGRESSION: a successful `plan-file` still suggests the literal `cycle-activate <id>` in its
      `help[]` — `test_plan_file_help_suggests_the_cycle_activate_placeholder_template` passes
      byte-unchanged.
- [ ] `tests/client/test_bun_crucible_axi_conventions.py` is green, with its per-verb `help[]`
      coverage extended to the new refusals rather than left asserting only the old surface.

## Estimated size

M — one or two cycles. §S1–§S4 are a shared registrar, a pairing rule, two refusals and one
regression pin; §S5's size is entirely the caller count, which the gap analysis must measure before
the plan is filed (CR-CRU-118's equivalent migration touched 184 call sites across 15 suites, and
that figure was wrong twice before it was measured properly).

## Risk

- **The shared parser is the trap.** `parseCycleInput` serves both filing doors. A refusal placed
  there satisfies §S4's wording and silently retires CR-CRU-124 §S4/AC3. §S4's own AC pins the
  `cycle-add` side as a regression, so the mistake fails a test rather than shipping.
- **A required flag is a breaking change to a shipped verb.** Every caller must be migrated in the
  same CR; a partial migration leaves `plan-file` unusable on the un-migrated path.
- **Positional pairing is only as good as its refusal.** If a mismatch were tolerated, the failure
  mode is a plan whose kinds are off by one — silently wrong data, the exact class this CR removes.

## Non-goals

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
