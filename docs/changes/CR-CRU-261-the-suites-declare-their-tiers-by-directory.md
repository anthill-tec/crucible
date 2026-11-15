# CR-CRU-261 — the suites declare their tiers by directory

**Status:** PENDING · filed 2026-11-15 (release fix; user rulings 2026-11-15: tiers are declared by directory in each
stack's own idiom, run through the one tier switch set every client shares; unit = no process, no socket)
**Type:** fix
**Points:** 8
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-260
**Labels:** tests, client, gate, ci, release
**Design reference:** `test-reports/work/rel040-test-gap-analysis.md` (§3, §4, G1); `TIER_MEANINGS` and
`add_tier_verbs` in `_crucible_axi.py` (CR-CRU-112); `docs/research/DN-testing-tiers-in-crucible-projects.md`;
CR-CRU-221 (splitting the core before it outgrows its guard)

## Problem

Crucible's own tier vocabulary (`TIER_MEANINGS`) defines a tier by the dependency a test takes: `unit` = no process,
no socket, no live service, no wait on the clock; `integration` = a real dependency. This repo does not declare its
own tiers that way.

- **Bun** splits `unit` from `integration` with a source-text classifier (`scripts/test-targets.ts`,
  `INTEGRATION_MARKERS` + a real-wait regex) run by `scripts/run-test-target.ts`. It reads raw text, so any mention of
  a marker, even in a comment ("port 3849 is never touched"), makes a file integration; 45 files mention 3849, almost
  all in comments.
- **Python** has no tiers: `test:client` discovers all of `tests/client/`. The census measured 52% of its 5638 tests
  as unit; 118 of 351 modules mix unit and heavier tests.
- **The gate cannot tell python's tiers apart.** It dispatches a `python3 -m unittest discover -s <dir>` script to
  `python-crucible.py regression` over that discovery (`_python_suite_argv`), so every python suite reaches the board
  as `regression`.

## Design

- **Directories.** Bun: `tests/unit/`, `tests/integration/`, `tests/e2e/` (exists). Python: `tests/client/unit/` and
  `tests/client/integration/`, each a package. Shared helpers, harnesses and fixtures stay where they are
  (`tests/helpers/`, `tests/fixtures/`, `tests/client/*_harness.py` and the other non-test modules), so imports keep
  working.
- **Placement by measured dependency.** A test goes to `unit` only if it starts no process, opens no socket and waits
  on no real time; everything else goes to `integration`. The census files
  (`test-reports/work/leak-census/py-tiers-measured.csv`, `bun-tiers-combined.csv`) are the starting list; a mixed
  module splits into one module per tier with the same name stem. A moved test keeps its name and body except for
  import paths.
- **Scripts declare tiers by path.** `package.json`: `test:unit` = `bun test tests/unit`, `test:integration` =
  `bun test tests/integration`, `test:client-unit` = `python3 -m unittest discover -s tests/client/unit -t .`,
  `test:client-integration` likewise, `test:regression` = all four (or the runner's union of them). `test:client`
  retires. The exact script names follow whatever the gate's composition (CR-CRU-112 §S1) reads; the rule is that each
  script names one tier's directory.
- **The python tier is its directory (G1).** When the gate or `regression` dispatches a python discovery script, the
  run is filed under the tier its start directory names (`…/unit` → `unit`, `…/integration` → `integration`) instead
  of `regression`. A start directory that names no tier keeps today's behaviour. This is the python client's
  translation of the shared switch set, beside bun's script, go's build tag, maven's profile, rust's nextest profile
  and arduino's make target.
- **The classifier retires.** `scripts/test-targets.ts`, its marker table and the guard tests that pin it are
  removed; `scripts/run-test-target.ts` becomes a by-path runner or is removed if the scripts call `bun test`
  directly.
- **CI and the gate run tiers by path.** `release.yml`'s `test-bun` runs both bun tiers; `test-python` runs both python
  tiers; `test-e2e` is unchanged. The local `pre-merge-gate` composes the declared scripts as today.
- **Core size first.** If G1 grows `_crucible_axi.py` past its pinned budget (9119 of 9120 lines today), the shared
  module is split first, inside this CR, the way CR-CRU-221 did it, with `SHARED_MODULE_LINE_BUDGETS` updated in its
  three copies.

## Acceptance criteria

- [ ] **AC1 — layout.** Every bun test file is under `tests/unit/`, `tests/integration/` or `tests/e2e/`; every python
  test module under `tests/client/unit/` or `tests/client/integration/`. No `test_*.py` or `*.test.ts` remains
  directly under `tests/client/` or `tests/`.
- [ ] **AC2 — unit means unit.** A hermetic run of the two unit directories under the dependency census (audit hook /
  preload) records no process start, no socket connect or bind, and no real wait of a second or more.
- [ ] **AC3 — nothing lost.** The union of the tier runs executes the same test ids as the pre-move suite (python:
  same ids modulo module path; bun: same test names per file stem), and passes.
- [ ] **AC4 — python files under its tier.** A gate or `regression` run of the python tier scripts files two runs on
  the board, tier `unit` and tier `integration`; a discovery script whose start directory names no tier still files
  `regression`.
- [ ] **AC5 — classifier gone.** `scripts/test-targets.ts` and `INTEGRATION_MARKERS` no longer exist; no test pins
  them.
- [ ] **AC6 — CI.** `release.yml`'s `test-bun` and `test-python` run the tier directories; the `ci-toolchain-
  provisioning` and workflow pins are updated.
- [ ] **AC7 — the core's guard.** The shared-module line budgets pass; any split keeps every client's behaviour
  (their own suites green).

## Non-goals

- Demoting live-board tests (CR-CRU-262) and hermetic CI (CR-CRU-263).
- Tiers for the other stacks' own projects and the agent `.md` definitions (after the release: todo #27, the Model B
  request #26).
