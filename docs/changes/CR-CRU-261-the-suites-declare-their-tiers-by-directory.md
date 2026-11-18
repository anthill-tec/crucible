# CR-CRU-261 — the suites declare their tiers by directory

**Status:** PENDING · filed 2026-11-15 (release fix; user rulings 2026-11-15: tiers are declared by directory in each
stack's own idiom, run through the one tier switch set every client shares; unit = no process, no socket) · gap
analysis 2026-11-18 (user rulings R1–R4) · spec pre-review 2026-11-18 (CHANGES, F1–F9 folded; user rulings on F2, F3,
F4, F8)
**Type:** fix
**Points:** 8
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-260
**Labels:** tests, client, gate, ci, release
**Design reference:** `test-reports/work/cr261-gap-analysis.md` (measured baseline and findings);
`test-reports/work/prereview261-report.md`; `test-reports/work/rel040-test-gap-analysis.md` (§3, §4, G1);
`TIER_MEANINGS`, `add_tier_verbs` and `_python_suite_argv` in `_crucible_axi.py` (CR-CRU-111, CR-CRU-112);
`docs/research/DN-testing-tiers-in-crucible-projects.md`; CR-CRU-137 §S1 (one declared per-test budget); CR-CRU-221
(splitting the core before it outgrows its guard)

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
- **The placement list is measured, once, before anything moves.** The orchestrator re-runs the dependency census at
  `d199371b` (clean clone, isolated network namespace, tripwire, the suite's maven cache provisioned) with instruments
  that see every kind of dependency the vocabulary names (pre-review F1):
  - bun: every spawn; `Bun.serve`, `Bun.listen`, `net.Server.listen`; `fetch`, `net.connect`,
    `net.Socket.connect`, `Bun.connect`, `WebSocket`; any `setTimeout` or sleep above 0 ms and any `setInterval`;
  - python: every spawn, socket connect and bind; any `time.sleep` above 0; timed `Condition`/`Event` waits, thread
    joins, queue gets, `select`, `asyncio.sleep`.

  The list it yields (`test-reports/work/census261b-py-placement.csv`, `census261b-bun-placement.csv`) is the
  placement, by these rules:
  - a test file goes to `unit` only if it took none of those dependencies (ruling R3: no real wait at all);
  - a python module that mixes unit and heavier tests goes whole to `integration` (ruling R2); CR-CRU-262, which
    rewrites the heavy tests, re-places them;
  - a python module goes to the heavier tier of itself and of every test module it imports, transitively (ruling on
    F8: 182 `from tests.client.test_… import` lines in 124 modules, some importing `TestCase` classes). Before the
    rule is applied, the plain helpers that unit modules import from an integration test module are lifted into a
    helper module beside `tests/client/__init__.py`, and the importers import them from there (user ruling
    2026-11-18): above all `test_client_fleet_envelope_census.py`'s `declare_and_require_board`, `CLIENT_FILES`,
    `install_project_limits`, `_build_fake_bin_dir`, `_load_toon_module` and `_UNREACHABLE_CRUCIBLE_URL`, which alone
    raise 25 of the 32 modules the rule raises at `d199371b`. A `TestCase` class is never lifted. The placement is
    recomputed after the lift (census261b measured: unit 86 modules / 1350 tests before it; bun 89 unit files of 443);
  - a bun event charged to a helper rather than a file (an async frame that lost its file) is charged to every test
    file importing that helper, directly or through another helper.

  The bun test under the playwright tree, `tests/e2e/teardown-contracts/crucible-db-isolation.test.ts`, moves to its
  measured bun tier and reads its contract configs where they stay. The two python modules that hold no test
  (`test_next_announces_the_wave_boundary.py`, `test_cr095_next_consumes_published_order.py`) are deleted (ruling R4).
  `tests/app-logic.d.ts` — an ambient mirror keyed `"../public/app-logic.mjs"`, a name only files directly under
  `tests/` import — is deleted with its shape assertion in `bdd-index-lists-playwright-bdd-runs.test.ts`;
  `public/app-logic.d.mts` is the declaration the moved files resolve (pre-review F9).
- **What a move rewrites** (pre-review F5). A moved file keeps its tests' names and bodies except for what follows, done
  by one codemod rather than hand edits:
  - its import paths, and its dotted module names (`tests.client.test_x` → `tests.client.<tier>.test_x`);
  - every path it derives from its own location, resolved by WHAT IT POINTS TO, not by directory depth (a
    `Path(__file__).parent / "manifest_contract.py"` still reaches the helper that stays; a `… / "test_x.py"` reaches
    `test_x`'s new tier);
  - every citation, string-literal repo path or path-segment join that names a moved file, in the citation guard's
    scope (`src public clients crucible_axi scripts bin docs/research tests`) and in `.github/`, `bunfig.toml`,
    `playwright.config.ts`, `package.json`, `docs/RUNBOOK.md`, `scripts/sandboxed-install-tests.sh`;
  - NOT `tests/fixtures/**`, NOT source code held as text inside a test body, and NOT `docs/changes/` (history).

  No moved python module may put its own directory on `sys.path` (39 such inserts today, e.g.
  `test_cr090_fleet_stage.py`); the codemod rewrites each to an import from `tests.client` or the helper's module path.
  The text that describes the retired classifier (`docs/research/DN-testing-tiers-in-crucible-projects.md`, the
  comments in `event-cycle-id-backfill.test.ts` and `commit-boundary-derivation.test.ts`) is rewritten by hand.
- **Scripts declare tiers by path.** `package.json`: `test:unit` and `test:integration` run their directory through
  `scripts/run-test-target.ts`, which becomes a by-path runner (`bun test --timeout <declared> ./tests/<tier>` — the
  `./` makes it a directory, not a name filter) and keeps reading the one declared per-test budget (CR-CRU-137 §S1).
  Its `client` target retires with `test:client`; `regression` keeps its whole-suite `bun test` and its python half
  stays `discover -s tests/client -t .`, which collects both tiers (pre-review F7). `test:client-unit` =
  `python3 -m unittest discover -s tests/client/unit -t .`, `test:client-integration` likewise.
- **The python tier is its directory (G1; rulings R1 and F3).** When the gate's python translation
  (`_python_suite_argv`) dispatches a discovery script whose start directory's last component names a tier the gate
  covers — a tier of `TIER_MEANINGS` that is neither `regression` nor in `GATE_UNCOVERED_TIERS` (so `unit`, `module`,
  `integration`, `bdd`) — it invokes the python client's own **tier verb** for it (`python-crucible.py unit
  --start-dir tests/client/unit …`, with `--agent`, `--release` and `--cycle` as today), which files the run under that
  tier. Any other start directory, `…/e2e` included, keeps today's `regression`. The python client itself does not
  change, and a direct `python-crucible.py regression` still files `regression`.
- **The dispatched run has no `-t` (ruling on F4).** The translation drops `-t` and the python client passes none, so
  the gate's run imports `tests/client/<tier>` modules as top-level modules (the deferred "no top-level directory"
  defect, `docs/changes/README.md`, stays deferred). Everything that keeps such a run correct is guarded: every module
  under `tests/client/unit/` and `tests/client/integration/` imports `tests.client` (so the suite's isolation always
  applies), and none puts its own directory on `sys.path`. The `_python_suite_argv` docstring and the README's
  deferred note are corrected to say so.
- **The classifier retires.** `scripts/test-targets.ts` and everything it exports (`INTEGRATION_MARKERS`,
  `classifyTestSource`, `declaresRealWait`, `enumerateTestFiles`, `partitionTestFiles`) and the guard tests that pin it
  are removed. Its `REPO_ROOT` is re-homed first; its importers (`scripts/webkit-docker-runner.ts`,
  `scripts/webkit-docker-server.ts`, `tests/help-surface-order-independence.test.ts`) follow. The three python guards
  that partition this repo's test files through it (`test_bun_vitest_fixture_stays_out_of_this_repos_suite.py`,
  `test_playwright_bdd_fixture_stays_out_of_this_repos_suites.py`, `test_pytest_fixture_stays_out_of_this_repos_suite.py`)
  check instead that no file under a tier directory is a fixture and that the scripts and CI steps run only the tier
  directories (pre-review F6).
- **CI and the gate run tiers by path.** `release.yml`'s `test-bun` runs `bun test --timeout <declared>
  ./tests/unit` then `./tests/integration` (the declared figure, pinned equal to the client's by
  `pipeline-test-timeout-default.test.ts` as today); `test-python` runs `discover -s tests/client/unit -t .` then
  `…/integration`; `test-e2e` is unchanged. The local `pre-merge-gate` composes the declared scripts as today.
- **One cycle keeps the suite green.** The move, the scripts, the runner, CI, the three fixture guards and the
  workflow pins change together in the same cycle, so no cycle ends with the suite red.
- **The core's guard.** If G1 grows `_crucible_axi.py` (9062 lines, pinned budget 9062), the pinned budget is
  re-recorded in its three copies as long as the module stays within the ceiling (`CORE_LINE_LIMIT` −
  `CORE_HEADROOM_LINES` = 9120); only past that is the module split, inside this CR, the way CR-CRU-221 did it.

## Acceptance criteria

- [ ] **AC1 — layout.** Every bun test file is under `tests/unit/` or `tests/integration/`; `tests/e2e/` holds no
  `*.test.ts`. Every python test module is under `tests/client/unit/` or `tests/client/integration/`, where
  `census261b-*-placement.csv` puts it. No `test_*.py` or `*.test.ts` remains directly under `tests/client/` or
  `tests/`. The two test-less modules and `tests/app-logic.d.ts` no longer exist.
- [ ] **AC2 — unit means unit (orchestrator check).** The orchestrator runs the two unit directories ALONE under the
  same census (clean clone, isolated network namespace, no operator files) and records the result in
  `test-reports/work/`: no process start, no socket connect, bind, listen, serve or fetch, and no real wait (any timer
  or sleep above 0 ms). Any recorded event fails the AC, whether or not it can be charged to a file. VERIFY re-runs it.
  The standing in-suite guard is CR-CRU-263 AC6 (ruling on F2).
- [ ] **AC3 — nothing lost (orchestrator check).** The union of the tier runs executes the same tests as the
  pre-move suite and passes, compared against baselines recorded before the move: python, the ids at `d199371b`
  (`census261b-py-tiers.csv`) modulo module path — the deleted modules held none; bun, the test names per file stem
  (`census261b-bun-junit.xml`).
- [ ] **AC4 — python files under its tier.** Unit tests of `_python_suite_argv` (reached from bun's gate dispatch,
  `_dispatch_gate_suite`) prove the mapping, each with `--agent`, `--release` and `--cycle` forwarded when given:
  `tests/client/unit`, `tests/client/unit/`, `./tests/client/unit` → `unit`; `tests/client/integration` →
  `integration`; `…/module` → `module`; `…/bdd` → `bdd`; `…/e2e`, `…/regression`, `tests/client`, `.`,
  `tests/unit_helpers` → `regression`; no start directory → not dispatchable, as today. One feature-level integration
  test drives a fixture project declaring `test:client-unit` and `test:client-integration` through the bun gate on a
  test-only board and finds two python runs filed, tier `unit` and tier `integration`, each with its own `suites[]`
  row and counts. Discovered WITHOUT `-t`, each tier directory of this repo collects the same number of tests as its
  `test:client-<tier>` script. The orchestrator's own gate over this repo is the "over this repo" evidence.
- [ ] **AC5 — classifier gone.** `scripts/test-targets.ts` and all it exported (`INTEGRATION_MARKERS`,
  `classifyTestSource`, `declaresRealWait`, `enumerateTestFiles`, `partitionTestFiles`) no longer exist; no test pins
  them; `REPO_ROOT`'s three importers import it from its new home; the DN and the two test comments no longer describe
  the classifier as current.
- [ ] **AC6 — scripts, runner and CI.** `package.json` declares `test:unit`, `test:integration`, `test:client-unit`,
  `test:client-integration` by path, and no `test:client`. `scripts/run-test-target.ts` has no `client` target; its
  `unit` and `integration` run `bun test` over `./tests/<tier>` with the per-test budget read from `bun-crucible.py`
  (its pin in `pipeline-test-timeout-default.test.ts` updated). `release.yml`'s `test-bun` and `test-python` run the
  tier directories with the declared budget; the `ci-toolchain-provisioning` pins and the three fixture guards
  (`test_bun_vitest_fixture_…`, `test_playwright_bdd_fixture_…`, `test_pytest_fixture_…`) pin the new steps and check
  that no file under a tier directory is a fixture.
- [ ] **AC7 — the core's guard.** The shared-module line budgets pass (re-recorded in their three copies if the core
  grows, within 9120; split only past it); every client's suite stays green.
- [ ] **AC8 — citations hold.** `tests/citations-cite-by-symbol.test.ts` passes: no citation in its scope names a test
  path that no longer resolves.
- [ ] **AC9 — a moved python module stands on its own.** A static guard over `tests/client/unit/` and
  `tests/client/integration/` finds that every module imports `tests.client` and that none inserts its own directory
  (or any `tests/client` path) into `sys.path`.

## Non-goals

- Re-placing the tests of mixed modules, and demoting live-board tests (CR-CRU-262); hermetic CI and the standing
  unit-tier guard (CR-CRU-263 AC6).
- A top-level-directory option for the python client (the deferred defect in `docs/changes/README.md`).
- Tiers for the other stacks' own projects and the agent `.md` definitions (after the release: todo #27, the Model B
  request #26).
