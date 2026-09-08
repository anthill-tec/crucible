# CR-CRU-111 — the client can say which tier it ran

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 016, 075
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/research/DN-testing-tiers-in-crucible-projects.md` — "What a tier is",
  "Who classifies, and who drives", and decisions **D1** (per-tier verbs), **D2** (the verb set is
  the six tiers), **D3** (a mislabelled `unit` run warns) and **D4** (the declaration seam is
  per-stack convention, enumerated per client)

## Context

`Tier` is `"unit" | "module" | "integration" | "e2e" | "regression" | "bdd"` (`src/types.ts`) and
the server has accepted the field since CR-CRU-016 §S4. The bun client can produce three of the six
and cannot produce `integration` at all: `cmd_test` stamps `tier="unit"` on every targeted run
whatever that run touches, so a targeted run of a real browser suite is recorded on the board as a
unit run. No client in the fleet accepts a `--tier` flag; `mvn-crucible.py` instead exposes `unit`,
`module` and `e2e` as verbs, so the fleet answers the same question two different ways.

**Surfaces (verified 2026-09-08):** `_ingest_parsed(..., tier=None)` and `_start_run(..., tier=None)`
in `clients/bun-crucible.py`; the two `tier="unit"` call sites in `cmd_test`; `tier="regression"` in
`cmd_regression`; `tier="e2e"` in `cmd_auto_ingest`; `cmd_unit`/`cmd_module`/`cmd_e2e` in
`clients/mvn-crucible.py`; `Tier` in `src/types.ts`; `recordTestEvent`'s `tier: meta?.tier ?? "unit"`
default in `src/store.ts`.

## Scope

### §S1 Per-tier verbs, fleet-wide (DN D1, D2)

Every client that runs tests exposes the tier as a VERB — the six values of `Tier` and no others —
registered from one place in `clients/_crucible_axi.py` beside the other fleet-wide verb surfaces
rather than hand-rolled per client. `mvn-crucible.py`'s existing `unit`/`module`/`e2e` verbs migrate
onto that registration and keep their behaviour; `bun-crucible.py`'s hardcoded tiers stop being
hardcoded.

A tier the vocabulary does not contain is a structured refusal. A tier the vocabulary contains but
the PROJECT has declared no target for is a DIFFERENT refusal, naming the missing declaration: the
tier existing and the project having one are separate facts, and conflating them is what let
`cmd_test` claim `unit` for everything.

### §S2 A targeted run stops claiming to be `unit`

`cmd_test` no longer stamps a tier the caller did not state. A targeted run carries the tier the
caller names; absent a stated tier the run carries no tier and the server's own default applies,
which is honest, rather than the client asserting a fact it cannot know from a file path.

### §S3 Each client runs the tier the way ITS OWN toolchain runs it (DN D4)

A tier verb runs the local modality that stack actually has, and reports the run under that tier.
Where the toolchain already splits the tiers, the client uses THAT split — asking such a project to
declare anything would invent a second description of a distinction its build system already makes.
Only where the toolchain has no tier notion does the project declare one. Per client, from the DN's
verified table:

| client | how a tier is run | declaration needed? |
|---|---|---|
| `mvn-crucible.py` | maven's own split — surefire (`*Test`) for unit, failsafe / `integration-test` for integration | **no** — the lifecycle is the split |
| `rust-crucible.py` | cargo target selection — in-crate `--lib` for unit, `tests/` targets (`--test`) for integration; `smoke-test`/`docker-e2e-gate` above | **no** — cargo is the split |
| `arduino-crucible.py` | the build the tier belongs to — native host `g++`/`make` for unit, `arduino-cli` for target compile, HIL for hardware | **no** — three build systems are the split |
| `bun-crucible.py` | a project-declared target: `package.json` scripts (`test:unit`, `test:integration`, …) | **yes** — `bun test` has no tier notion |
| `python-crucible.py` | a project-declared suite: `--start-dir`/`--pattern` per tier | **yes** — `unittest` discovery has none |

The client never classifies files: which file is which is the project's decision (DN, "the
portability boundary"). Where a declaration IS required and absent, the verb refuses with the
missing declaration named and never falls back to the whole suite. This is a requirement PER
CLIENT — five modalities, five assertions — and levelling the vocabulary must not level the
mechanism.

### §S4 A `unit` run that waits says so (DN D3)

The client measures a run's wall time against its CPU time and, when wall exceeds CPU by the stated
factor, carries a structured warning naming both figures. It does not refuse: classification is the
project's decision, so the client reports the contradiction rather than vetoing it — but it must
report it, or `unit` means nothing as a suite grows. This is the DN's falsifiability corollary made
mechanical; without it the tier definitions are prose.

### §S5 The envelope states the tier it ingested

The AXI envelope names the tier of the run it just ingested, so an orchestrator reading the envelope
knows what was covered without inspecting the board. Every exit path states it — success, failure,
zero-discovery and the compile-tier fallback alike.

## Acceptance criteria

- **AC1** — each of the six `Tier` values of `src/types.ts` (`unit`, `module`, `integration`, `e2e`,
  `regression`, `bdd`) is an invocable VERB, asserted by driving the client's own `--help` and then
  the verb itself, not by reading source. A seventh name is `invalid choice` from argparse's own
  refusal, and the six appear in the root help's choices group.
- **AC2** — the tier a run is stamped with is the tier the caller stated, asserted on the POST body
  the client sends (`payload["tier"]`) for each of the six values.
- **AC3** — `cmd_test` with no stated tier sends NO `tier` key. Asserted on the POST body: the key
  is absent, not `"unit"`.
- **AC4** — the tier surface is registered from ONE place for every client that runs tests, and the
  registrar-parity check counts the call sites: the shared registration in
  `clients/_crucible_axi.py` is invoked by EACH of `bun-crucible.py`, `python-crucible.py`,
  `mvn-crucible.py`, `rust-crucible.py` and `arduino-crucible.py`, proven by a derived count over
  the five files rather than by a frozen list.
- **AC5** — `mvn-crucible.py`'s `unit`, `module` and `e2e` verbs still run and still stamp their
  own tiers after the migration; their existing behaviour is preserved, asserted per verb.
- **AC6** — each client runs the tier through the modality §S3 names for it, asserted for EACH of
  the five clients against a fixture project of that stack: the invocation the client builds is the
  stack's own (maven's failsafe lifecycle, cargo's `--test` target selection, arduino's native-host
  build, the declared bun script, the declared python start-dir) and the ingested run carries the
  verb's tier. Five assertions, and the count of clients exercised is itself asserted — "the client
  runs the tier" is satisfiable by one client, and that is the defect this AC exists to prevent.
- **AC6a** — for the two stacks that REQUIRE a declaration (bun, python), a tier whose target the
  project has not declared refuses with `ok:false`, exit 1, and `help[]` naming the missing
  declaration (the `package.json` script, the start-dir). It may never fall back to running the
  whole suite. Asserted for both, and asserted NOT to apply to maven/cargo/arduino, whose split is
  the toolchain's — a refusal demanding a declaration from cargo would be the defect.
- **AC6b** — a `unit` run whose wall time exceeds its CPU time by the stated factor carries a
  structured warning naming both figures and the factor, with `ok` unchanged — the run is reported,
  not refused. Asserted twice: once on a deliberately sleeping fixture (warning present) and once on
  a CPU-bound fixture (warning absent), so the check cannot pass by always warning.
- **AC7** — the AXI envelope carries the ingested tier on every exit path: success, a failing suite,
  zero-discovery, and the compile-tier fallback. Four assertions, one per path.
- **AC8** — caller existence: a grep at VERIFY time returns ≥1 non-test caller of the shared tier
  registration per client, and zero clients still pass a hardcoded tier literal into
  `_ingest_parsed`/`_start_run` except where the verb's own name IS the tier (`regression`, `e2e`).
- **AC9** — no CR-namespace literal reaches printed help (`tests/project-namespace-tripwire.test.ts`
  AC2 stays green), and the fleet verb-surface census (CR-CRU-075 §S2) is updated to the new verb
  count in the same commit that adds the verbs.

## Estimated size

M — one shared registrar, five thin call sites, and the `mvn` migration. §S3's script detection is
the only new mechanism; §S2 and §S4 are corrections to existing call sites.

## Risk

The fleet-wide spelling is a one-way door: five clients teaching six values is expensive to respell
later, which is why DN **D1** settles the spelling before this CR is cut rather than during it.

Removing the `tier="unit"` default from `cmd_test` changes what the board records for targeted runs.
Historical rows are untouched and stay `unit`; the change is forward-only, and the board's own
reading of a tier-less run is the server default — so §S2 must confirm the server's default is
acceptable for a targeted run rather than assuming it.

## Non-goals

- Classifying files into tiers. That is the project's decision, per the DN.
- Per-tier coverage (DN open question 4) and e2e ownership (open question 5) — both still open.
  The wall-vs-CPU check is NOT deferred: DN **D3** settled it as a warning and it is §S4/AC6b of
  this CR.
- Changing what any existing test asserts.
