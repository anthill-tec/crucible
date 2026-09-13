# CR-CRU-128 — every flag describes itself

**Status:** PENDING (0.3.0 — scheduled behind wave 6 by user ruling 2026-09-12)
**Type:** patch
**Priority:** P3
**Depends on:** CR-CRU-030 (the AXI fleet compliance baseline and the shared module),
CR-CRU-075 (the derived verb-surface census this CR's mechanism copies),
CR-CRU-127 (`--cycle-kind`, the flag whose discoverability raised the question — **SHIPPED
2026-09-13, commit `974cbd8`**, so this dependency is satisfied and its §S6 precedent is quoted in
the re-measurement below)
**Labels:** patch, clients, axi, documentation
**Phase:** Wave 7 (0.3.0) — user ruling 2026-09-12: *"I want a wider compliance check, but that can
happen after we finish the CRs in the current queue."*
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

### §S3 The census is honest about what it cannot see

`help=` being present is not the same as it being USEFUL. This CR asserts presence, which is
mechanically checkable, and deliberately does not attempt to grade quality — an assertion that
wording is "good" would be unfalsifiable. What it DOES additionally check, because it is
mechanical: the text is non-empty, is not a bare repetition of the flag name, and (for a flag whose
value comes from a closed vocabulary the server owns) names that vocabulary — the CR-CRU-127 §S6
rule generalised, since a flag declared without `choices=` has nowhere else to teach its values.

## Acceptance criteria

**§S1**
- [ ] All 18 measured flags carry help text; the figure is RE-MEASURED at implementation time, not
      taken from this spec. **This AC's own instruction has been discharged once already:** the
      count WAS re-measured on 2026-09-13 after wave 6 closed (see the re-measurement block above)
      and came back at the same 18, with the same line numbers, because wave 6's only new flag went
      through the shared registrar. Re-measure AGAIN at implementation time regardless — the point
      of the AC is that the figure is never transcribed, and it has now survived one refresh rather
      than being assumed stable.
- [ ] Where a flag is already described elsewhere in the fleet, the added wording is byte-identical
      to that existing description — asserted for `--agent`, which appears 6 times in the set.

**§S2**
- [ ] A derived census fails if ANY option-bearing `add_argument` in the five clients or the shared
      module lacks `help=`; proven by mutation — strip one help string and the census must go red
      naming that exact `file:line --flag`.
- [ ] The census asserts the client count (5) and a per-client minimum flag count, so a walker that
      silently reaches nothing cannot pass.
- [ ] The failure message enumerates every offender as `file:line  --flag`.

**§S3**
- [ ] A flag whose help text is empty, or is only the flag's own name with punctuation stripped,
      fails the census.
- [ ] A flag declared with no `choices=` whose value comes from a server-owned closed vocabulary
      names that vocabulary in its help text — the CR-CRU-127 §S6 rule, asserted generally rather
      than per-CR. The vocabularies in scope are enumerated in the implementation, not guessed.

## Estimated size

S — one cycle. 18 help strings plus one derived census test. The census is the durable half; the 18
strings are the one-time debt it stops accruing.

## Risk

- **A presence check can be satisfied by a useless string.** §S3's three mechanical refinements
  (non-empty, not a name-echo, names a closed vocabulary) narrow that without pretending to grade
  prose. Stated as a known limit rather than left as an implied guarantee.
- **`mvn` holds 10 of the 18**, and several are compose/goal flags whose semantics live in that
  stack's own tooling rather than in Crucible. The wording must come from what the flag actually
  does — reading the code that consumes it, not from the flag's name.

## Non-goals

- Grading the QUALITY of existing help text, or rewriting the 327 flags that already have some.
- Lifting hand-rolled flags into the shared registrar. The correlation measured above argues for it,
  but that is a large refactor across five clients and belongs to the registrar-parity family
  (CR-CRU-075's), not to a documentation census. **Recorded here as the measured argument FOR that
  work**, so whoever takes it has the evidence.
- Changing any flag's name, default, requiredness or behaviour. This CR adds description only.
- The per-verb `help[]` next-step templates — already enforced by
  `tests/client/test_bun_crucible_axi_conventions.py` and out of scope.
