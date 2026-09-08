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

### §S3 Each client drives its own stack's declaration seam (DN D4)

A project declares its own target membership in its own toolchain's idiom, and each client detects
THAT idiom — no Crucible-specific config file is invented, because it would be a second description
of the project's tests beside the one the toolchain already has. Per client:

| client | seam |
|---|---|
| `bun-crucible.py` | `package.json` scripts (`test:unit`, `test:integration`, …) |
| `python-crucible.py` | `unittest`/`pytest` start-dirs (the existing `--start-dir`/`--pattern`) |
| `mvn-crucible.py` | maven profiles |
| `rust-crucible.py` | cargo `--test` targets / features |
| `arduino-crucible.py` | sketch directories |

Absent a declaration the verb refuses with the missing declaration named, and never falls back to
the whole suite. The client never classifies files: which file is which is the project's decision
(DN, "the portability boundary"). This is a requirement PER CLIENT, not one requirement about "the
client" — five seams, five assertions.

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
- **AC6** — a project-declared target is driven from the seam §S3 names, asserted for EACH of the
  five clients against a fixture project carrying that stack's declaration: the declared target runs
  and the run is stamped with the verb's tier. Five assertions, and the count of clients exercised
  is itself asserted — "the client drives the seam" is satisfiable by one client and that is the
  defect this AC exists to prevent.
- **AC6a** — a tier whose target the project has NOT declared refuses with `ok:false`, exit 1, and
  `help[]` naming the missing declaration for that stack (the `package.json` script, the start-dir,
  the profile). Asserted per client, and it may never fall back to running the whole suite.
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
