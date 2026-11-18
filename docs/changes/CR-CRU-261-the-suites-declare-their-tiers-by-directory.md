# CR-CRU-261 — the suites declare their tiers by directory

**Status:** PENDING · filed 2026-11-15 (release fix; user rulings 2026-11-15: tiers are declared by directory in each
stack's own idiom, run through the one tier switch set every client shares; unit = no process, no socket) · gap
analysis 2026-11-18 (user rulings R1–R4 below)
**Type:** fix
**Points:** 8
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-260
**Labels:** tests, client, gate, ci, release
**Design reference:** `test-reports/work/cr261-gap-analysis.md` (measured baseline and findings);
`test-reports/work/rel040-test-gap-analysis.md` (§3, §4, G1); `TIER_MEANINGS`, `add_tier_verbs` and
`_python_suite_argv` in `_crucible_axi.py` (CR-CRU-111, CR-CRU-112); `docs/research/DN-testing-tiers-in-crucible-projects.md`;
CR-CRU-137 §S1 (one declared per-test budget); CR-CRU-221 (splitting the core before it outgrows its guard)

## Problem

Crucible's own tier vocabulary (`TIER_MEANINGS`) defines a tier by the dependency a test takes: `unit` = no process,
no socket, no live service, no wait on the clock; `integration` = a real dependency. This repo does not declare its
own tiers that way.

- **Bun** splits `unit` from `integration` with a source-text classifier (`scripts/test-targets.ts`,
  `INTEGRATION_MARKERS` + a real-wait regex) run by `scripts/run-test-target.ts`. It reads raw text, so any mention of
  a marker, even in a comment ("port 3849 is never touched"), makes a file integration.
- **Python** has no tiers: `test:client` discovers all of `tests/client/`. The census at `d199371b` measured 3097 of
  5787 tests (53.5%) as unit; 87 modules mix unit and heavier tests.
- **The gate cannot tell python's tiers apart.** Its python translation (`_python_suite_argv`) turns a
  `python3 -m unittest discover -s <dir>` script into `python-crucible.py regression` over that discovery, so every
  python suite reaches the board as `regression`.

## Design

- **Directories.** Bun: `tests/unit/`, `tests/integration/`; `tests/e2e/` stays playwright's (features and steps).
  Python: `tests/client/unit/` and `tests/client/integration/`, each a package. Shared helpers, harnesses and fixtures
  stay where they are (`tests/helpers/`, `tests/fixtures/`, `tests/client/*_harness.py`, `tests/client/__init__.py` and
  the other non-test modules), so `from tests.client import …` keeps working.
- **Placement by measured dependency.** A test file goes to `unit` only if, measured, it starts no process, opens no
  socket and waits on no real time at all (no timer or sleep above 0 ms; ruling R3); everything else goes to
  `integration`. The census at `d199371b` is the list (`test-reports/work/census261-py-modules.csv`,
  `census261-bun-tiers.csv`). **A module that mixes unit and heavier tests goes whole to `integration`** (ruling R2);
  CR-CRU-262, which rewrites the heavy tests, re-places them. The bun test under the playwright tree,
  `tests/e2e/teardown-contracts/crucible-db-isolation.test.ts`, moves to its measured bun tier and reads its contract
  configs where they stay. The two python modules that hold no test (`test_next_announces_the_wave_boundary.py`,
  `test_cr095_next_consumes_published_order.py`) are deleted (ruling R4).
- **What a move rewrites.** A moved file keeps its tests' names and bodies except for: its import paths; the paths it
  derives from its own location (`Path(__file__).resolve().parents[2]`, `join(import.meta.dir, "..")`, …); and every
  citation or dotted module name that names a moved file — in the citation guard's scope (`src public clients
  crucible_axi scripts bin docs/research tests`) and in `.github/`, `bunfig.toml`, `playwright.config.ts`,
  `package.json`. The rewrite is one mechanical codemod, not hand edits. `docs/changes/` is history and is not rewritten.
- **Scripts declare tiers by path.** `package.json`: `test:unit` and `test:integration` run their directory through
  `scripts/run-test-target.ts`, which becomes a by-path runner (`bun test --timeout <declared> tests/<tier>`) and keeps
  reading the one declared per-test budget (CR-CRU-137 §S1); `test:regression` is unchanged.
  `test:client-unit` = `python3 -m unittest discover -s tests/client/unit -t .`, `test:client-integration` likewise;
  `test:client` retires.
- **The python tier is its directory (G1; ruling R1).** When the gate's python translation (`_python_suite_argv`)
  dispatches a discovery script whose start directory's last component names a tier of `TIER_MEANINGS` other than
  `regression`, it invokes the python client's own **tier verb** for it (`python-crucible.py unit --start-dir
  tests/client/unit …`, with `--agent`, `--release` and `--cycle` as today), which files the run under that tier. A
  start directory that names no tier keeps today's `regression`. The python client itself does not change, and a direct
  `python-crucible.py regression` still files `regression`.
- **The classifier retires.** `scripts/test-targets.ts`, its marker table and the guard tests that pin it are removed.
  Its `REPO_ROOT` is re-homed first; its importers (`scripts/webkit-docker-runner.ts`,
  `scripts/webkit-docker-server.ts`, `tests/help-surface-order-independence.test.ts`) follow.
- **CI and the gate run tiers by path.** `release.yml`'s `test-bun` runs both bun tiers; `test-python` runs both python
  tiers; `test-e2e` is unchanged. The local `pre-merge-gate` composes the declared scripts as today.
- **The core's guard.** If G1 grows `_crucible_axi.py` (9062 lines, pinned budget 9062), the pinned budget is
  re-recorded in its three copies as long as the module stays within the ceiling (`CORE_LINE_LIMIT` −
  `CORE_HEADROOM_LINES` = 9120); only past that is the module split, inside this CR, the way CR-CRU-221 did it.

## Acceptance criteria

- [ ] **AC1 — layout.** Every bun test file is under `tests/unit/` or `tests/integration/`; `tests/e2e/` holds no
  `*.test.ts`. Every python test module is under `tests/client/unit/` or `tests/client/integration/`. No `test_*.py`
  or `*.test.ts` remains directly under `tests/client/` or `tests/`. The two test-less modules no longer exist.
- [ ] **AC2 — unit means unit.** A hermetic run of the two unit directories ALONE (isolated network namespace, no
  operator files) under the dependency census records no process start, no socket connect, bind, serve or fetch, and no
  real wait (any timer or sleep above 0 ms). Any recorded event fails the AC, whether or not it can be charged to a file.
- [ ] **AC3 — nothing lost.** The union of the tier runs executes the same tests as the pre-move suite (python: the
  5787 ids at `d199371b` modulo module path — the deleted modules held none; bun: the same test names per
  file stem across 443 files), and passes.
- [ ] **AC4 — python files under its tier.** `_python_suite_argv`, reached from bun's gate dispatch
  (`_dispatch_gate_suite`), maps a discovery start directory to the python client's invocation as follows, each with
  `--agent`, `--release` and `--cycle` forwarded when given: `tests/client/unit` (also with a trailing slash) → `unit`;
  `tests/client/integration` → `integration`; `…/e2e` → `e2e`; `tests/client`, `.`, `tests/unit_helpers`,
  `…/regression` → `regression`; no start directory → not dispatchable, as today. A gate over this repo files two
  python runs on the board, tier `unit` and tier `integration`, each with its own row and counts in the gate's
  `suites[]`.
- [ ] **AC5 — classifier gone.** `scripts/test-targets.ts`, `INTEGRATION_MARKERS`, `classifyTestSource` and
  `partitionTestFiles` no longer exist; no test pins them; `REPO_ROOT`'s three importers import it from its new home.
- [ ] **AC6 — scripts, runner and CI.** `package.json` declares `test:unit`, `test:integration`, `test:client-unit`,
  `test:client-integration` by path, and no `test:client`. `scripts/run-test-target.ts`'s `unit` and `integration` run
  `bun test` over their directory with the per-test budget read from `bun-crucible.py` (its pin in
  `pipeline-test-timeout-default.test.ts` updated). `release.yml`'s `test-bun` and `test-python` run the tier
  directories; the `ci-toolchain-provisioning` and workflow pins are updated.
- [ ] **AC7 — the core's guard.** The shared-module line budgets pass (re-recorded in their three copies if the core
  grows, within 9120; split only past it); every client's suite stays green.
- [ ] **AC8 — citations hold.** `tests/citations-cite-by-symbol.test.ts` passes: no citation in its scope names a test
  path that no longer resolves.

## Non-goals

- Re-placing the tests of mixed modules, and demoting live-board tests (CR-CRU-262); hermetic CI (CR-CRU-263).
- Tiers for the other stacks' own projects and the agent `.md` definitions (after the release: todo #27, the Model B
  request #26).
