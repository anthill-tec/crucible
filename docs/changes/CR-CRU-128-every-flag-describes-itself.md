# CR-CRU-128 — every flag describes itself

**Status:** PENDING (0.2.0) — wave 6, `seq 6015`, registered 2026-09-13. Filed 2026-09-12.
**Type:** patch
**Priority:** P3
**Depends on:** CR-CRU-030 (the AXI fleet compliance baseline and the shared module),
CR-CRU-075 (the derived verb-surface census this CR's mechanism copies),
CR-CRU-127 (`--cycle-kind`, the flag whose discoverability raised the question — **SHIPPED
2026-09-13, commit `974cbd8`**, so this dependency is satisfied and its §S6 precedent is quoted in
the re-measurement below)
**Labels:** patch, clients, axi, documentation
**Phase:** **Wave 6 (0.2.0)**, sequenced last in the wave at `seq 6015`, behind CR-CRU-127.

> **CORRECTION 2026-09-13 — this CR was filed into the wrong WAVE and the wrong RELEASE, on an
> invented authority.** It originally read *"Phase: Wave 7 (0.3.0) — user ruling 2026-09-12"*, with
> a status line saying *"scheduled behind wave 6 by user ruling"*. Both attributions were FALSE.
> What the user said, quoted correctly even then, was: *"I want a wider compliance check, but that
> can happen after we finish the CRs in the current queue."* **"The current queue" meant the WAVE 6
> queue** — confirmed by the user 2026-09-13 — i.e. run this after wave 6's CRs are done, IN wave 6
> and IN release 0.2.0. The orchestrator instead read "the current queue" as "the current release",
> inferred `wave 7 / release 0.3.0`, registered the queue row at `seq 7005, release 0.3.0`
> (commit `71b3a9e`, whose subject even says "wave 7"), and wrote the inference into this spec as
> the user's own ruling.
>
> Recorded rather than quietly repaired, because an invented ruling is worse than a wrong figure: a
> figure gets re-measured, a ruling gets CITED — by later CRs, by sub-agent briefs, and by the next
> reader who has no way to tell it apart from a real one. The consequence was material: it parked
> this CR behind three unrelated feature CRs (015 BDD harness, 018 responsive, 022 analytics) and
> moved it into a different RELEASE, which this project treats as settled fact once shipped.
>
> Corrected on the board by `cr-plan --cr CR-CRU-128 --release 0.2.0 --wave 6` → `seq 6015`,
> `dependsOn: CR-CRU-127`, `release: 0.2.0`. **The lesson for the queue, stated generally: "the
> current queue" is a WAVE-scoped phrase in this project, because a wave IS the queue being worked.
> Reading it as a release boundary silently re-scopes a release.**
**Design reference:** the AXI manifesto (https://axi.md), principle **10 — consistent `--help`**,
under the user's standing 2026-07-21 requirement that every client be a *"sane, complete,
self-explanatory"* AXI interface that *"stops project orchestrators from losing context and process
accuracy."*

## Context

**A flag that carries no help text is invisible to the agent that must use it.** The fleet's AXI
conformance suite (`tests/client/test_bun_crucible_axi_conventions.py`, 34 tests, green) enforces
per-verb `help[]` next-step templates and structured-error shape — but it asserts **nothing** about
whether each declared FLAG describes itself. So a verb can be fully AXI-compliant by that suite's
measure while one of its required flags is undocumented.

That is not hypothetical. It is how `plan-file` came to have no way to declare a cycle's kind
(CR-CRU-127) while the conformance suite stayed green for months.

**Measured 2026-09-12** by AST-walking every `add_argument` call carrying an option string:

| source | flags declared | lacking `help=` |
|---|---|---|
| `clients/arduino-crucible.py` | 40 | 0 |
| `clients/bun-crucible.py` | 56 | 2 |
| `clients/mvn-crucible.py` | 74 | **10** |
| `clients/python-crucible.py` | 62 | 1 |
| `clients/rust-crucible.py` | 113 | 5 |
| **`clients/_crucible_axi.py` (shared registrar)** | **28** | **0** |

**345 flags fleet-wide, 18 undescribed — and every one of the 18 is hand-rolled in a client.** The
shared registrar is 28 for 28. That correlation is the CR's central finding: a flag routed through
the shared registrar is described *by construction*, because the registrar is written once and
reviewed once; a hand-rolled flag is described only if its author remembered. This is the same
structural argument CR-CRU-054 made for behaviour and CR-CRU-075 made for verb presence, applied to
flag documentation.

**The 18, by client and line:**

- `bun-crucible.py:2107` `--source`, `:2161` `--agent`
- `mvn-crucible.py:2131` `--agent`, `:2139` `--compose-file`, `:2140` `--no-wait`, `:2141`
  `--services`, `:2142` `--all-services`, `:2147` `--compose-file`, `:2152` `--agent`, `:2153`
  `--compose-file`, `:2154` `--goal`, `:2155` `--coverage-profile`
- `python-crucible.py:1524` `--agent`
- `rust-crucible.py:2525` `--agent`, `:2538` `--agent`, `:2555` `--crate`, `:2570` `--crate`,
  `:2581` `--crate`

**Six of the 18 are `--agent`** — a flag that is REQUIRED on those verbs (CR-CRU-056 §S2b: every
workflow verb posts as a live registered caller). An undescribed mandatory flag is the worst case in
the set: the agent cannot learn it is required, or what it takes, from the surface it is supposed to
read.

### RE-MEASURED 2026-09-13, after wave 6 closed (user-instructed refresh)

The figures above were taken on 2026-09-12, BEFORE CR-CRU-121/124/125/126/127 landed — three of
which are client-heavy. Re-run with the identical AST walk (`add_argument` calls carrying an option
string, checked for `help=`) at `974cbd8`, with wave 6 COMPLETED and zero open plans:

| source | flags declared | lacking `help=` | Δ since 2026-09-12 |
|---|---|---|---|
| `clients/arduino-crucible.py` | 40 | 0 | — |
| `clients/bun-crucible.py` | 56 | 2 | — |
| `clients/mvn-crucible.py` | 74 | **10** | — |
| `clients/python-crucible.py` | 62 | 1 | — |
| `clients/rust-crucible.py` | 113 | 5 | — |
| **`clients/_crucible_axi.py` (shared registrar)** | **29** | **0** | **+1** |

**The five clients are UNCHANGED at 345 flags and 18 undescribed. The shared registrar moved 28 → 29
and is still 29 for 29.** The whole of wave 6's flag growth is that single `+1`: CR-CRU-127's
`--cycle-kind`.

**This is the CR's central claim reproducing itself under observation, not a restatement of it.**
Wave 6 added a REQUIRED, repeatable flag to a verb across all five clients. Because it was routed
through the shared registrar, the per-client flag counts did not move at all — the five clients each
gained a one-line delegation, not an `add_argument` — and the new flag arrived described, with help
text that names its whole vocabulary. A hand-rolled equivalent would have added five declarations
and five chances to forget. The correlation the original census only *observed* has now been
*tested* by a live change: **the registrar path accrued zero new documentation debt while adding a
mandatory flag to five clients.**

**All 18 offenders and their line numbers are still exactly as listed below**, re-verified rather
than assumed. That is not luck of no-change: CR-127 inserted a delegation line into every client
(arduino `:1281`, bun `:2196`, mvn `:2184`, python `:1563`, rust `:2803`), but every one of the 18
sits ABOVE its client's `plan-file` subparser, so none shifted. Checked per client rather than
inferred from the totals — a matching total can hide two offsetting moves.

**§S3's vocabulary rule already has its first compliant instance.** `--cycle-kind` is declared with
no `choices=` (deliberately — the vocabulary is the server's `CYCLE_KINDS`) and its help names all
three kinds. CR-CRU-127's §S6 measured why that matters: argparse's `textwrap` has
`break_on_hyphens=True`, so `red-green` sitting deeper in the paragraph rendered as `red- green` and
failed the assertion until the kinds were moved to LEAD the text, and the help subprocess had its
`COLUMNS` pinned. **Implementation note for §S3:** a census that checks "the help names the
vocabulary" MUST read the flag's declared help STRING, not the rendered `--help` output, or it
inherits that wrap fragility — and if it does drive the real help, it must pin `COLUMNS` the way
`test_plan_file_names_the_release_it_plans.py` and `test_cycle_add_targets_the_plan_it_means.py` now
do.

## Scope

### §S1 Every declared flag carries help text

The 18 measured flags gain help text. Wording follows each flag's existing siblings on the same
verb, and where the same flag is already described elsewhere in the fleet (`--agent` is described on
most verbs), the existing wording is REUSED verbatim rather than re-invented — an inconsistent
description of one flag across five clients is its own AXI violation.

### §S2 A derived census makes it structural, not a one-time sweep

A test AST-walks every `add_argument` call in the five clients and the shared module and asserts
that each option-bearing call declares `help=`. Derived from the source, so a flag added tomorrow
without help text fails immediately; not a pinned list of 18, which would go stale the moment the
19th arrives.

Two properties the census must have, both learned from CR-CRU-075's equivalent:

- **Non-vacuity.** The walk must be proven to reach every client — assert the client count (5) and a
  per-client floor on flags found, so a broken walker cannot pass as a clean fleet.
- **It names offenders.** The failure message lists `file:line  --flag` for each, because a bare
  count tells the next agent nothing actionable.

**Reuse the scaffold; do not invent one** (gap analysis 2026-09-13, DRIFT-4). Both properties above
already exist as repo convention, and **six suites already AST-walk `add_argument`**
(`test_client_tier_surface.py`, `test_cr054_fleet_inventory.py`, `test_cr054_verb_surface_lift.py`,
`test_cycle_add_targets_the_plan_it_means.py`, `test_plan_file_declares_each_cycle_kind.py`,
`test_plan_file_names_the_release_it_plans.py`). Specifically: `CLIENT_FILES` + `AXI_MODULE_PATH` +
`EXPECTED_CLIENT_COUNT = 5` at `tests/client/test_client_tier_surface.py:107-125` is the
non-vacuity shape to copy verbatim, and `_load_module_by_path`
(`test_cr054_verb_surface_lift.py:188`) is the mechanism for resolving a non-literal `help=`. A
seventh differently-shaped walker is the cost this CR should not pay.

### §S3 The census is honest about what it cannot see

`help=` being present is not the same as it being USEFUL. This CR asserts presence, which is
mechanically checkable, and deliberately does not attempt to grade quality — an assertion that
wording is "good" would be unfalsifiable. What it DOES additionally check, because it is
mechanical: the text is non-empty, is not a bare repetition of the flag name, (for a flag whose
value comes from a closed vocabulary the server owns) names that vocabulary — the CR-CRU-127 §S6
rule generalised, since a flag declared without `choices=` has nowhere else to teach its values —
and, per DRIFT-3, that a value-taking flag does not describe itself as a switch.

**The honest limit, now MEASURED rather than asserted** (gap analysis 2026-09-13). The original
text called presence-vs-usefulness "a known limit" without saying how big it is. It is bigger than
the defect: **19 `--agent` declarations describe the ingest side-effect instead of the flag**, and
all three of the original refinements pass them. That measurement is what turned the limit into
DRIFT-3's fourth check — which is the whole argument for measuring a stated limit instead of
recording it as a caveat. What remains genuinely unreachable is prose QUALITY: a flag reading
`"Agent id (typically vidushi)"` is describing the right thing while hardcoding one project's
orchestrator id, and no mechanical check this CR can write will catch that.

## Acceptance criteria

**§S1**
- [ ] All 18 measured flags carry help text; the figure is RE-MEASURED at implementation time, not
      taken from this spec. **This AC's own instruction has been discharged once already:** the
      count WAS re-measured on 2026-09-13 after wave 6 closed (see the re-measurement block above)
      and came back at the same 18, with the same line numbers, because wave 6's only new flag went
      through the shared registrar. Re-measure AGAIN at implementation time regardless — the point
      of the AC is that the figure is never transcribed, and it has now survived one refresh rather
      than being assumed stable.
- [ ] **`--agent`'s wording is NOMINATED, not "reused"** (corrected by gap analysis 2026-09-13,
      DRIFT-1 — the original AC said *"the added wording is byte-identical to that existing
      description — asserted for `--agent`"*, which is **UNSATISFIABLE: there is no single existing
      description**). MEASURED: **60 `--agent` declarations across the fleet carry 22 DISTINCT help
      values** (including the 6 with none). Even excluding the 19 covered by DRIFT-3, roughly eight
      genuine wordings compete: `"Agent id — REQUIRED (§S5): …"` (8×), `"Agent id (typically the
      orchestrator)"` (4×), `"Agent id (typically the orchestrator's)"` (3×), `"Agent id (typically
      vidushi)"` (3×, and it hardcodes THIS project's orchestrator id into a fleet client's help),
      two different `"enforced at RUNTIME"` variants (4× each), `"Agent id for the gate events …"`
      (4×), and arduino's own singleton. The implementation NOMINATES one canonical wording for the
      six `required=True` sites and asserts the added text equals THAT, byte-for-byte. Harmonising
      the other ~54 stays a non-goal (this CR adds description, it does not rewrite 338 strings) —
      but the nomination is recorded in the spec so the next flag has one wording to copy instead
      of eight to choose from.
- [ ] All six are declared `required=True` in argparse — VERIFIED, not inferred, on `auto-ingest`
      (bun `:2161`, mvn `:2131`, python `:1524`, rust `:2525`), `pre-merge-gate` (mvn `:2152`) and
      a gate verb (rust `:2538`). The added wording therefore states that the flag is REQUIRED.

**§S2**
- [ ] A derived census fails if ANY option-bearing `add_argument` in the five clients or the shared
      module lacks `help=`; proven by mutation — strip one help string and the census must go red
      naming that exact `file:line --flag`.
- [ ] **The census tests for the PRESENCE of a `help=` keyword, NEVER for a literal string**
      (gap analysis DRIFT-2, blocking as the spec stood). MEASURED across the 374 option-bearing
      declarations: 338 pass a literal, **18 pass a NON-literal** — 10 an `ast.Name` constant, 4 a
      `BinOp` concatenation, 4 an f-string — and 18 pass none. A census written as
      `isinstance(value, ast.Constant)` would therefore report **18 false offenders against a real
      count of 18**, a numerical coincidence that would ship a wrong figure while looking right.
      Six of the non-literals live in `_crucible_axi.py` (e.g. `GATE_CYCLE_HELP`,
      `PLAN_FILE_CYCLE_KIND_HELP`), which is the tree the CR holds up as exemplary — so getting
      this wrong would indict the registrar it is arguing for.
- [ ] Where §S3 needs the help TEXT (not merely its presence), a non-literal value is RESOLVED by
      importing the module and reading the constant — the mechanism
      `tests/client/test_cr054_verb_surface_lift.py:188` (`_load_module_by_path`) already provides.
      A `Name`/`BinOp`/f-string help is not exempt from §S3; it is resolved, or the CR states why not.
- [ ] The census asserts the client count (5) and a per-client minimum flag count, so a walker that
      silently reaches nothing cannot pass.
- [ ] The failure message enumerates every offender as `file:line  --flag`.

**§S3**
- [ ] A flag whose help text is empty, or is only the flag's own name with punctuation stripped,
      fails the census.
- [ ] A flag declared with no `choices=` whose value comes from a server-owned closed vocabulary
      names that vocabulary in its help text — the CR-CRU-127 §S6 rule, asserted generally rather
      than per-CR. The vocabularies in scope are enumerated in the implementation, not guessed.
- [ ] **A value-taking flag does not describe itself as a switch** (added by gap analysis
      2026-09-13, DRIFT-3 — the finding that the CR's own mechanism was blind to more flags than it
      fixes). MEASURED: **19 `--agent` declarations carry help describing the INGEST SIDE-EFFECT
      rather than the flag** — `"If set, ingest surefire (compile-fail → /api/v2/runs/compile)"`,
      `"If set, ingest the declared run's junit result"`, and 17 more across bun (3), mvn (8),
      python (3) and rust (5). Every one of them PASSES a presence census, and passes all three
      refinements above: non-empty ✓, not a name-echo ✓, no closed vocabulary to name ✓. So 19
      flags — MORE than the 18 this CR repairs — describe the wrong thing and the census cannot
      see it.
      The check is mechanical and narrow: a flag with **no `action=`** takes a VALUE, so help that
      opens `"If set"` is describing a boolean the flag is not. Those 19 are pre-existing debt and
      repairing them is NOT in this CR (that would be the 338-string rewrite the non-goals refuse);
      the AC is that the census REFUSES A NEW ONE, with the 19 recorded as a named, dated
      exemption ceiling that may only SHRINK — the `PRE_CR_ASSERTION_RESIDUE` shape
      (`tests/project-namespace-tripwire.test.ts:504-509`), which CR-CRU-127's VERIFY proved is the
      pattern that stops a guard being disarmed by raising its own ceiling.

## Estimated size

S — one cycle. 18 help strings plus one derived census test, the census being the durable half.
Unchanged by the gap analysis: DRIFT-2 and DRIFT-3 add checks to a test that has to be written
either way, DRIFT-4 REMOVES work by reusing an existing scaffold, and DRIFT-1 replaces an
impossible "reuse the existing wording" with a nomination — a decision, not a build. The one real
addition is the 19-entry shrink-only exemption ceiling for DRIFT-3.

## Risk

- **A presence check can be satisfied by a useless string, and that is MEASURED at 19 flags, not
  hypothetical.** §S3's refinements (non-empty, not a name-echo, names a closed vocabulary, and —
  added by gap analysis — a value-taking flag not described as a switch) narrow it without
  pretending to grade prose. The residual gap is stated in §S3 rather than implied.
- **The census's own walker is a correctness risk, not just the flags it measures** (DRIFT-2). 18
  declarations pass a non-literal `help=`, which is exactly the count of real offenders — so a
  walker that conflates "no `help=`" with "help is not a literal" produces the right TOTAL from
  entirely wrong members. Mutation-proving the census must therefore include stripping a
  NON-literal help constant, not only a literal one.
- **`mvn` holds 10 of the 18**, and several are compose/goal flags whose semantics live in that
  stack's own tooling rather than in Crucible. The wording must come from what the flag actually
  does — reading the code that consumes it, not from the flag's name.

## Non-goals

- Grading the QUALITY of existing help text, or rewriting the **338** flags that already have some
  (corrected from "327" by the 2026-09-13 re-measurement: 374 option-bearing declarations = 338
  literal + 18 non-literal + 18 absent).
- Lifting hand-rolled flags into the shared registrar. The correlation measured above argues for it,
  but that is a large refactor across five clients and belongs to the registrar-parity family
  (CR-CRU-075's), not to a documentation census. **Recorded here as the measured argument FOR that
  work**, so whoever takes it has the evidence.
- Changing any flag's name, default, requiredness or behaviour. This CR adds description only.
- The per-verb `help[]` next-step templates — already enforced by
  `tests/client/test_bun_crucible_axi_conventions.py` and out of scope.

## Gap analysis (orchestrator, 2026-09-13)

Performed by the orchestrator. Not delegated.

### Step 0 — baseline

Python fleet at `4ff59a8`: **1813 pass / 0 fail / 1 pending across 87 files**, `PY_EXIT=0`;
TypeScript gate exit 0. These are the suites this CR touches — the whole client fleet surface plus
the guards that read it.

**Recorded against myself:** I ran the FULL two-stack `pre-merge-gate` (4,179 tests, ~12 minutes)
to obtain this, for the third time in one session, when the only changes since the last green gate
at `b8d83bc` were three DOCS commits. Step 0 asks for *"the suites the CR touches"*; the
README-as-fixture risk justified the roadmap suites, not the entire fleet twice. The figures below
are all STATIC measurements and needed no run at all. **Rule for next time: a docs-only delta
re-baselines the suites that read those docs, not the gate.**

### Findings

| # | Dim | Finding | Fix scope | Blocking? |
|---|---|---|---|---|
| DRIFT-1 | 2 | §S1's *"the added wording is byte-identical to that existing description — asserted for `--agent`"* is UNSATISFIABLE: 60 `--agent` declarations carry **22 distinct help values**, ~8 of them genuine competing wordings. There is no single existing description to be identical to. | SPEC_UPDATE | **Yes** — corrected: the wording is NOMINATED |
| DRIFT-2 | 2 | **18 of 374** declarations pass a NON-literal `help=` (10 `ast.Name`, 4 `BinOp`, 4 f-string; 6 of them in `_crucible_axi.py`). A `isinstance(ast.Constant)` census reports 18 false offenders against a real count of 18 — the right total from entirely wrong members. | SPEC_UPDATE | **Yes** — the census asserts PRESENCE, and resolves non-literals via `_load_module_by_path` |
| DRIFT-3 | 7 | **19** `--agent` declarations describe the INGEST SIDE-EFFECT, not the flag (`"If set, ingest surefire …"`). All pass presence AND all three original §S3 refinements. The CR's mechanism was blind to more flags than the CR repairs. | SPEC_UPDATE | **Yes** — fourth mechanical check added; the 19 become a shrink-only ceiling |
| DRIFT-4 | 4 | The §S2 scaffold already exists: `CLIENT_FILES`/`AXI_MODULE_PATH`/`EXPECTED_CLIENT_COUNT = 5` (`test_client_tier_surface.py:107-125`) and `_load_module_by_path` (`test_cr054_verb_surface_lift.py:188`); **six suites already AST-walk `add_argument`**. | SPEC_UPDATE (reuse) | No — REMOVES work |
| DRIFT-5 | 3 | The spec's *"six of the 18 are `--agent`, a flag that is REQUIRED"* is CONFIRMED and understated: all six are literally `required=True` — `auto-ingest` ×4 (bun `:2161`, mvn `:2131`, python `:1524`, rust `:2525`), `pre-merge-gate` (mvn `:2152`), one gate verb (rust `:2538`). A mandatory flag with no description at all. | none (claim verified) | No |
| DRIFT-6 | 16 | Inverse blast radius: **127 citations point into client files**, but only **3 shift** — and one is MACHINE-CHECKED: `clients/_crucible_axi.py:1555` cites `clients/python-crucible.py:1555-1576` (`_next_start_help`), and python's insertion point `:1524` sits above it. That entry is in `test_cr092_next_decision_resolver.py`'s guard and was re-pinned by CR-CRU-127's GREEN hours earlier. | close-out step | No |
| DRIFT-7 | 2 | The non-goals cited "327 flags that already have some" — the measured figure is **338** (374 = 338 literal + 18 non-literal + 18 absent). | SPEC_UPDATE | No — corrected |

Dimension 3 (bounded surface): **N/A** — no rendered or fixed-width surface; the closest thing is
argparse's own wrapping, and CR-CRU-127 already established the defence (pin `COLUMNS`; never
normalise a hyphen away). Dimension 5 (design-lineage): **N/A** — nothing is claimed dead.
Dimension 6 (public-symbol removal): **N/A** — the CR adds description only; no flag, name, default
or requiredness changes.

### Verdict

**SPEC_UPDATE_NEEDED → now READY.** Three blocking findings (DRIFT-1, DRIFT-2, DRIFT-3) are
corrected above; DRIFT-4 removes work rather than adding it; DRIFT-5 confirms a claim; DRIFT-6 and
DRIFT-7 are a close-out step and a figure correction. Size stands at S / one cycle.

**The finding worth carrying out of this analysis:** every one of the three blocking findings is a
case of the CR's own MECHANISM being wrong rather than its target. The 18 undescribed flags were
measured correctly on 2026-09-12 and are still exactly right. What was wrong was (1) assuming a
canonical wording existed to copy, (2) assuming `help=` is always a literal, and (3) assuming three
refinements covered the presence-vs-usefulness gap when the gap is 19 flags wide. A census is only
as good as the walker, and the walker is the part nobody reviews.

### Close-out steps (planned ONCE, not per cycle)

- **Re-pin the machine-checked `_next_start_help` citation** (DRIFT-6): `clients/_crucible_axi.py`'s
  docstring citing `clients/python-crucible.py:1555-1576` drifts when `help=` is added at python
  `:1524`. LOCATE the construct at HEAD; never add an offset. The sibling entries in
  `test_cr092_next_decision_resolver.py`'s table get re-measured in the same pass.
- **Re-measure the `clients` prose-citation head**, currently **828** (`src` 614, `public` 477). This
  CR adds provenance comments to five clients, so the head moves by however many `CR-CRU-128`
  literals land in `clients/**.py`. MEASURE with the guard's own machinery; never transcribe. Note
  that a stale head fails TWICE — the tripwire and its cascade through
  `tests/help-surface-order-independence.test.ts:190`, whose `HELP_FILE` IS the tripwire file.
- **Do NOT re-pin the 3 informal shifted citations** beyond the machine-checked one; the standing
  ruling (CR-CRU-126, CR-CRU-125) is that informal `path:line` prose is not re-pinned wholesale.
- **A CR literal in a Python assertion MESSAGE counts as residue** (CR-CRU-127's FIX, the hard way).
  Keep `CR-CRU-128` out of `assertEqual(...)` messages in the new census test; docstrings are exempt
  prose.
