# CR-CRU-111 — the client can say which tier it ran

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 016, 075
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/research/DN-testing-tiers-in-crucible-projects.md` — "What a tier is",
  "Who classifies, and who drives", open questions 1, 2, 3 and 6

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

### §S1 One way to name a tier, fleet-wide

The fleet gains ONE spelling for "which tier did this run belong to", chosen once and applied to
every client that runs tests. The choice between a `--tier` flag and per-tier verbs is the user's
(DN open question 1); whichever is chosen, `mvn-crucible.py`'s existing `unit`/`module`/`e2e` verbs
and `bun-crucible.py`'s hardcoded tiers both end up expressed through it, and the shared
registration lives in `clients/_crucible_axi.py` beside the other fleet-wide verb surfaces rather
than being hand-rolled per client.

An unrecognised tier is a structured refusal, not a silent passthrough: the six values are the whole
vocabulary and the server's own type is the source of that list.

### §S2 A targeted run stops claiming to be `unit`

`cmd_test` no longer stamps a tier the caller did not state. A targeted run carries the tier the
caller names; absent a stated tier the run carries no tier and the server's own default applies,
which is honest, rather than the client asserting a fact it cannot know from a file path.

### §S3 The client drives a project-declared target

A project declares its own target membership; the client runs it and tags it. For bun/npm the
declaration seam is `package.json` scripts (`test:unit`, `test:integration`, …) — detected, not
invented, and absent scripts the verb refuses with the missing script named rather than falling back
to the whole suite. The client never classifies files: which file is which is the project's
decision (DN, "the portability boundary").

### §S4 The envelope states the tier it ingested

The AXI envelope names the tier of the run it just ingested, so an orchestrator reading the envelope
knows what was covered without inspecting the board. Every exit path states it — success, failure,
zero-discovery and the compile-tier fallback alike.

## Acceptance criteria

- **AC1** — the tier vocabulary the client accepts is exactly the six values of `Tier` in
  `src/types.ts` (`unit`, `module`, `integration`, `e2e`, `regression`, `bdd`), asserted by driving
  the client, not by reading its source. A seventh value is refused with `ok:false`, exit 1, a
  `warnings[]` entry naming the offending value, and `help[]` listing the six.
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
- **AC6** — a project-declared target is driven by name: with `test:integration` present in
  `package.json`, the client runs it and stamps `integration`; with the script absent, the client
  refuses with `ok:false`, exit 1, and `help[]` naming the missing script. Asserted for both cases.
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
later, which is why DN open question 1 is settled before this CR is cut rather than during it.

Removing the `tier="unit"` default from `cmd_test` changes what the board records for targeted runs.
Historical rows are untouched and stay `unit`; the change is forward-only, and the board's own
reading of a tier-less run is the server default — so §S2 must confirm the server's default is
acceptable for a targeted run rather than assuming it.

## Non-goals

- Classifying files into tiers. That is the project's decision, per the DN.
- Per-tier coverage (DN open question 4) and the wall-vs-CPU assertion for `unit`
  (open question 3) — both wait on the DN being settled.
- Changing what any existing test asserts.
