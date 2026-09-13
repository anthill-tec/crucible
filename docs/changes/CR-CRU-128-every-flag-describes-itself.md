# CR-CRU-128 — every flag describes itself

**Status:** PENDING
**Type:** patch
**Priority:** P3
**Depends on:** CR-CRU-030, CR-CRU-075, CR-CRU-127
**Labels:** patch, clients, axi, documentation
**Phase:** Wave 6 (0.2.0)
**Design reference:** the AXI manifesto (https://axi.md) principle **10 — consistent `--help`**,
under the user's standing 2026-07-21 requirement that every client be a *"sane, complete,
self-explanatory"* AXI interface that *"stops project orchestrators from losing context and process
accuracy."*

## Context

**A flag that carries no help text is invisible to the agent that must use it.** The fleet's AXI
conformance suite (`tests/client/test_bun_crucible_axi_conventions.py`) enforces per-verb `help[]`
next-step templates and structured-error shape, but asserts nothing about whether each declared
FLAG describes itself — so a verb can be fully AXI-compliant by that suite's measure while one of
its required flags is undocumented. That is how `plan-file` came to have no way to declare a cycle's
kind (CR-CRU-127) while the conformance suite stayed green for months.

Measured 2026-09-13 by AST-walking every `add_argument` call carrying an option string:

| source | flags declared | lacking `help=` |
|---|---|---|
| `clients/arduino-crucible.py` | 40 | 0 |
| `clients/bun-crucible.py` | 56 | 2 |
| `clients/mvn-crucible.py` | 74 | **10** |
| `clients/python-crucible.py` | 62 | 1 |
| `clients/rust-crucible.py` | 113 | 5 |
| **`clients/_crucible_axi.py` (shared registrar)** | **29** | **0** |

**345 flags across the five clients, 18 undescribed — and every one of the 18 is hand-rolled. The
shared registrar is 29 for 29.** A flag routed through the registrar is described by construction;
a hand-rolled flag is described only if its author remembered.

**The 18:**

- `bun-crucible.py:2107` `--source`, `:2161` `--agent`
- `mvn-crucible.py:2131` `--agent`, `:2139` `--compose-file`, `:2140` `--no-wait`, `:2141`
  `--services`, `:2142` `--all-services`, `:2147` `--compose-file`, `:2152` `--agent`, `:2153`
  `--compose-file`, `:2154` `--goal`, `:2155` `--coverage-profile`
- `python-crucible.py:1524` `--agent`
- `rust-crucible.py:2525` `--agent`, `:2538` `--agent`, `:2555` `--crate`, `:2570` `--crate`,
  `:2581` `--crate`

**Six of the 18 are `--agent`, and all six are declared `required=True`** — on `auto-ingest`
(`bun:2161`, `mvn:2131`, `python:1524`, `rust:2525`), `pre-merge-gate` (`mvn:2152`) and one gate
verb (`rust:2538`). A mandatory flag with no description is the worst case in the set: the agent
cannot learn that it is required, or what it takes, from the surface it is meant to read.

Two further measurements shape the census in §S2/§S3. Of the 374 option-bearing declarations, **338
pass a literal help string, 18 pass a NON-literal** (10 a module constant, 4 a concatenation, 4 an
f-string; 6 of them in `_crucible_axi.py`), and 18 pass none. And **19 `--agent` declarations carry
help describing the ingest side-effect rather than the flag** — `"If set, ingest surefire
(compile-fail → /api/v2/runs/compile)"` and 18 more across bun, mvn, python and rust.

## Scope

### §S1 Every declared flag carries help text

**Surfaces (verified 2026-09-13):** the 18 declarations listed in Context, across five clients.

The 18 gain help text. Wording follows each flag's existing siblings on the same verb, and comes
from what the flag actually does — read the code that consumes it, not the flag's name.

`--agent` has **no single existing description to reuse**: its 60 fleet declarations carry 22
distinct help values. This CR therefore NOMINATES one canonical wording, applies it to the six
`required=True` sites, and states in it that the flag is required. Harmonising the other `--agent`
wordings is out of scope; the nomination is recorded so the next author has one wording to copy
rather than eight to choose between.

### §S2 A derived census makes it structural, not a one-time sweep

A test AST-walks every `add_argument` call in the five clients and the shared module and asserts
that each option-bearing call declares `help=`. Derived from the source, so a flag added tomorrow
without help text fails immediately; not a pinned list of 18, which goes stale the moment the 19th
arrives.

The census tests for the **presence of the `help=` keyword, never for a literal string**: 18
declarations pass a non-literal value, so a `Constant`-only check would report 18 false offenders
against a real count of 18 — the right total from entirely wrong members. Where §S3 needs the help
TEXT, a non-literal is resolved by importing the module and reading the constant.

Two properties the census must have:

- **Non-vacuity.** The walk is proven to reach every client — the client count (5) and a per-client
  floor on flags found are asserted, so a broken walker cannot pass as a clean fleet.
- **It names offenders.** The failure message lists `file:line  --flag` for each.

Both already exist as repo convention and are reused rather than rebuilt: `CLIENT_FILES` /
`AXI_MODULE_PATH` / `EXPECTED_CLIENT_COUNT = 5` at `tests/client/test_client_tier_surface.py:107-125`,
and `_load_module_by_path` at `tests/client/test_cr054_verb_surface_lift.py:188` for the non-literal
resolution. Six suites already AST-walk `add_argument`; a seventh differently-shaped walker is a
cost this CR does not pay.

### §S3 The census's mechanical quality checks

`help=` being present is not the same as it being USEFUL. This CR asserts presence plus four
mechanical properties, and deliberately does not grade prose:

1. The text is non-empty.
2. It is not a bare repetition of the flag's own name.
3. A flag declared with no `choices=` whose value comes from a server-owned closed vocabulary names
   that vocabulary — a flag without `choices=` has nowhere else to teach its values. The
   vocabularies in scope are enumerated in the implementation, not guessed.
4. A flag with no `action=` takes a VALUE, so its help must not open with `"If set"` — that
   describes a switch the flag is not. The 19 existing offenders are recorded as a dated exemption
   ceiling that may only SHRINK, following the `PRE_CR_ASSERTION_RESIDUE` shape at
   `tests/project-namespace-tripwire.test.ts:504-509`; repairing them is out of scope.

What stays unreachable is prose QUALITY: `"Agent id (typically vidushi)"` describes the right thing
while hardcoding one project's orchestrator id into a fleet client, and no mechanical check in this
CR will catch that.

## Acceptance criteria

**§S1**
- [ ] Every one of the 18 declarations carries a `help=`; the figure is RE-MEASURED at
      implementation time and never taken from this spec.
- [ ] The six `required=True` `--agent` declarations (`bun:2161`, `mvn:2131`, `mvn:2152`,
      `python:1524`, `rust:2525`, `rust:2538`) carry ONE byte-identical nominated wording, and that
      wording states the flag is required.
- [ ] No flag's name, default, `required`, `action`, `choices` or behaviour changes — asserted by
      comparing each touched `add_argument` call's non-`help` keywords before and after.

**§S2**
- [ ] The census fails if ANY option-bearing `add_argument` in the five clients or the shared module
      lacks a `help=` keyword, and names each offender as `file:line  --flag`.
- [ ] The census counts a NON-literal `help=` (module constant, concatenation, f-string) as PRESENT:
      with all 18 fixed, it reports **zero** offenders across 374 declarations, not 18.
- [ ] Mutation: stripping a literal `help=` turns the census red naming that exact `file:line
      --flag`; stripping a NON-literal one (e.g. `_crucible_axi.py`'s `GATE_CYCLE_HELP`) does the
      same.
- [ ] The census asserts the client count is 5 and a per-client minimum flag count.

**§S3**
- [ ] A flag whose help is empty, or is only its own name with punctuation stripped, fails.
- [ ] A flag declared with no `choices=` whose value comes from an enumerated server-owned
      vocabulary fails unless its help names that vocabulary.
- [ ] A flag with no `action=` whose help begins `"If set"` fails, unless it is one of the 19 listed
      exemptions; the exemption list is asserted to be exactly 19 and may only shrink.
- [ ] Mutation: adding a 20th such flag turns the census red.

## Estimated size

S — one cycle: 18 help strings plus one derived census test. The census is the durable half; the 18
strings are the one-time debt it stops accruing.

## Risk

- **A presence check can be satisfied by a useless string**, measured at 19 flags rather than
  hypothetical. §S3's four properties narrow it without pretending to grade prose; the residual gap
  is stated in §S3.
- **The census's own walker is a correctness risk, not only the flags it measures.** 18 declarations
  pass a non-literal `help=` — exactly the count of real offenders — so a walker that conflates "no
  `help=`" with "help is not a literal" produces the right total from wrong members. Mutation proof
  must therefore strip a non-literal help constant as well as a literal one.
- **`mvn` holds 10 of the 18**, several of them compose/goal flags whose semantics live in that
  stack's tooling rather than in Crucible. Their wording must come from the code that consumes them.
- Adding `help=` to `python-crucible.py:1524` shifts the lines below it, including the machine-checked
  citation into that file's `plan-file` block; the re-pin is a close-out step.

## Non-goals

- Grading the QUALITY of existing help text, or rewriting the 338 flags that already carry some.
- Repairing the 19 `"If set"` `--agent` descriptions — the census refuses a NEW one; the existing 19
  are an exemption ceiling that may only shrink.
- Harmonising the 22 distinct `--agent` wordings beyond the six sites §S1 nominates.
- Lifting hand-rolled flags into the shared registrar. The measured correlation argues for it, but
  that is a five-client refactor belonging to the registrar-parity family (CR-CRU-075's), not to a
  documentation census. Recorded here as the measured argument FOR that work.
- Changing any flag's name, default, requiredness or behaviour. This CR adds description only.
- The per-verb `help[]` next-step templates — already enforced by
  `tests/client/test_bun_crucible_axi_conventions.py`.
