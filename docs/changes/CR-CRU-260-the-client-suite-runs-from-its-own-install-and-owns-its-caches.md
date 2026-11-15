# CR-CRU-260 — the client suite runs from its own install and owns its caches

**Status:** PENDING · filed 2026-11-15 (release fix: found by the 0.4.0 leak census and CI run 43668348319; user
rulings 2026-11-15: a test-only install rather than a client setting, and a suite-owned maven repository kept between
runs)
**Type:** fix
**Points:** 13 (re-scored from 5 at gap analysis, 2026-11-15, user ruling: one CR in four cycles)
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-259
**Labels:** tests, client, ci, release
**Design reference:** `test-reports/work/rel040-test-gap-analysis.md` (L1, L3, L4, §5 b, §6); CR-CRU-131 (no
environment config seam); the cardinal test rule (knowledge `the-gate-and-regression-scope`)

## Problem

The cardinal rule: a test, fixture or suite sets up and tears down its own environment, and never reads operator
state. The client suite breaks it three ways.

- **The operator's `crucible.toml`.** A client derives its install dir from its own location
  (`_INSTALL_DIR`), so a client loaded or run from the checkout treats the repo root as its install and reads the
  operator's git-ignored root `crucible.toml`: its board, its limits, its `[lint]` and `[run]` tables. Nine tests
  failed on CI for that (fixed one module at a time in `986cda36`); every other test that runs a client from the
  checkout depends on it silently. About 180 python modules and 50 bun files build their own path to `clients/`.
- **`~/.m2`.** `test_a_declared_maven_run_shows_its_real_surefire_console_live_end_to_end` (8 tests) runs maven offline
  against the operator's maven repository. CI was given a warm-up step for it (`ffdea8df`), which covers the leak
  instead of fixing it.
- **PyPI.** Three modules (`test_crucible_axi_wheel_packaging`, `test_shipped_limits_ship_as_package_data`,
  `test_cr046_uv_env_gate`, 14 tests) build a wheel with `python -m build --wheel`, whose isolated build environment
  downloads `hatchling` and `hatch-vcs`.

## Design

- **A test-only install.** One harness helper per language lays down a temporary install directory holding `clients`
  (a symlink to the checkout's, so edits stay live and nothing is duplicated) and its own `crucible.toml`: no
  `[client] url`, no `[lint]` or `[run]` tables, no limits overrides. The python helper extends the existing
  `tests/client/__init__.py` mechanism (its run-shared directory and marker); the TypeScript one sits in
  `tests/helpers/` and is wired through `tests/helpers/isolated-store-preload.ts`. Because the client derives
  `_INSTALL_DIR` from `dirname(abspath(__file__))`, which does not resolve symlinks, and every client loads its
  siblings by that same path, a client loaded or spawned from there reads only that file; no product code changes and
  no environment seam is added (CR-CRU-131 stands). Pre-review checked: no `realpath` of a module path in `clients/`;
  coverage's `abs_file` resolves the link, so `source = ["crucible_axi","clients"]` still matches.
- **Who owns the install** (pre-review F2). The process that creates it alone removes it, at exit (python `atexit`;
  bun `process.on("exit")`, which the preload's root `afterAll` makes fire). Child processes reuse it through the
  marker and never remove it. Its name carries a fixed prefix and the creating PID; creating one sweeps any whose PID
  is dead, so a killed run leaves nothing behind for long.
- **Two constants, two uses.** The helper exports the test install's client paths (to LOAD or SPAWN a client) and the
  checkout's client source directory (to READ client source, or to COPY it into a test's own install). Source scans,
  line budgets and citations read the source constant; nothing loads or spawns from it. No other module builds its own
  path to the checkout's `clients/`; `986cda36`'s per-module binds fold into the helper.
- **The orchestrator CLI's clients** (pre-review F4). `crucible_axi.manifest.source_clients_dir()` answers the
  checkout's `clients/` in a checkout, and `cli._load_client_module` loads `_crucible_axi` from there, so a test that
  drives `crucible_axi.cli` gets the repo root as its install. Those tests point `manifest._CLIENTS_CANDIDATES` at the
  test install's `clients/` (the idiom `test_the_orchestrator_binds_the_install_it_is_acting_on.py` already uses). No
  product change.
- **No test runs a client as the repo root's project** (pre-review F3). A client spawned with the repo root as its
  working directory resolves the repo root as its project, and a project's `crucible.toml` and `.env` come before the
  install's. The python suite already points the six `<STACK>_CRUCIBLE_PROJECT_DIR` variables at an empty directory
  (`tests/client/__init__.py`, guarded by `test_the_client_suite_cannot_reach_the_live_project.py`); the bun preload
  does the same, with its own guard.
- **No test process loads the root `.env`** (pre-review F5). Bun loads `<cwd>/.env` into `process.env` by default
  (measured on bun 1.4.4: `--no-env-file`, or `env = false` in a `bunfig.toml`, turns it off). The bun suite runs with
  `.env` loading off, and every board a python test spawns (`bun run src/server.ts`) runs with it off too. How the
  operator's own board starts is not changed.
- **A test declares its board.** With CR-CRU-259 and no url in the test install, a test that reaches a board without
  declaring one gets the refusal: it fails loudly instead of leaking. Declarations reuse the existing spellings,
  `declare_and_require_board` (python, `test_client_fleet_envelope_census.py`) and `declareClientBoard` (bun,
  `tests/helpers/client-board.ts`); no third spelling is added.
- **No test reads the operator's board.** The live-census legs of `queue-release-membership-mandatory.test.ts`,
  `queue-historical-membership.test.ts` and `roadmap-visual-grammar.test.ts`, which read the dev board through the root
  `crucible.toml` and the root `.env`'s project key, are removed; each file's synthetic-board tests stay.
  `declaredClientBoard()` loses its `REPO_ROOT` default (user ruling 2026-11-15).
- **A copied client is laid out as an install.** A test that copies client modules puts them under
  `<install>/clients/`, inside a parent directory the test owns (`mkdtemp(dir=<own parent>)`), so their `_INSTALL_DIR`
  is the test's install and never `/tmp` (the census scratch copies in `test_client_fleet_envelope_census.py`, VERIFY
  958 Sug5; pre-review F7).
- **Suite-owned caches.** Every toolchain cache a test drives lives under the git-ignored `.cache/test-suite/`, kept
  between runs; the operator's caches under `$HOME` are never read (pre-review F11):
  - **maven** (`.cache/test-suite/m2`): the maven fixture's copied `.mvn/maven.config` gains
    `-Dmaven.repo.local=<absolute suite repo>`. A provisioning script (`scripts/provision-test-caches.sh`) fills it
    online by running the fixture's real lifecycle against the suite repo (lifecycle plugins and surefire providers
    included, which `dependency:go-offline` misses), then writes a stamp keyed on the fixture's `pom.xml` and the maven
    version. The test checks the stamp, not mere emptiness, and fails naming the script (pre-review F9).
  - **go** (`GOCACHE`, `GOMODCACHE` under `.cache/test-suite/go-*`), set by the go harnesses.
  - **uv** (`UV_CACHE_DIR` under `.cache/test-suite/uv`), set by `test_cr046_uv_env_gate`.
- **Wheels build offline, with the suite's own interpreter** (pre-review F8). The three modules build with
  `sys.executable -m build --wheel --no-isolation`; the fallback interpreter probe goes. A probe for `build`,
  `hatchling` and `hatch_vcs` fails naming the `dev` extra. `hatchling` and `hatch-vcs` join the `dev` extra in
  `pyproject.toml` (with the comment block that explains each dev dependency).
- **CI.** `ffdea8df`'s `~/.m2` warm-up step is removed; `test-python` runs the provisioning script, then the suite with
  `.venv/bin/python` (the interpreter that carries `.[dev]`); the separate "Install build" step goes. Its
  `cargo-llvm-cov` and `llvm-tools-preview` installs stay (a toolchain, like `go`, not operator state).

## Acceptance criteria

In-suite ACs are proved by tests; **orchestrator checks** (marked) are proved by the orchestrator's hermetic census
(an isolated network namespace, no root toml, the board tripwire, the audit hook) and recorded in the close-out
(pre-review F1). The census audit hook gains an `open` event for AC1.

- [ ] **AC1 — no operator config** (orchestrator check). A full run of both suites in a clean clone with an operator
  `crucible.toml` and `.env` at its root, whose `[client] url`, limits, `[lint]` and `[run]` differ from the defaults,
  gives the same pass/fail per test as without them; and the audit census records no open of `<repo>/crucible.toml`
  or `<repo>/.env`. **In-suite backstop (AC10).**
- [ ] **AC2 — one path.** No test module, helper or fixture outside the two harness helpers builds a path to the
  checkout's `clients/` (a guard test over `tests/`, python and TypeScript). "Builds a path" means: a `clients` path
  segment joined to a base derived from the repo (`__file__`, `import.meta.dir` or `import.meta.url`, `REPO_ROOT` and
  its aliases), or a relative `clients/…` used as a spawn argument, an import path or a file read. Exempt: comments,
  docstrings, assertion and message text, and paths under a temp base. The guard is proved on one planted module per
  spelling, in both languages (pre-review F6).
- [ ] **AC3 — maven.** With `HOME` pointing at an empty directory, the maven live-run tests pass from a provisioned
  suite repo; pointed at a fresh empty directory (a test-only parameter, never the real suite repo), or at one whose
  stamp does not match, they fail naming the provisioning script. The no-network half is an orchestrator check.
- [ ] **AC4 — wheels.** The three wheel modules build with `sys.executable` and `--no-isolation`; with a module missing
  they fail naming the `dev` extra. With no network they pass (orchestrator check).
- [ ] **AC5 — CI.** `release.yml` has no `~/.m2` warm-up and no separate build install; `test-python` runs the
  provisioning script and then the suite with `.venv/bin/python`; the `ci-toolchain-provisioning` pins are updated.
- [ ] **AC6 — torn down.** A child process that imports the helper and exits leaves no install behind; a child killed
  before exit leaves one that the next creation sweeps; a reusing child never removes its parent's. Proved in both
  languages, the bun one also with `CRUCIBLE_TEST_TMPROOT_DISABLE=1` (the shape of `run-scoped-temp-root.test.ts`).
- [ ] **AC7 — every board is declared** (orchestrator check). The census shows no `BoardUndeclared` failure and no
  tripwire hit, for both suites. At CR-CRU-259's close, that census (`870f6905`) counted 127 such failures in about 27
  python modules: `test_cr054_http_core_lift`, `test_cr017_client_lifecycle`, `test_cr054_verb_surface_lift`,
  `test_bun_crucible_lifecycle`, `test_bun_crucible_agent_report_isolation`, `test_bun_crucible_auto_attach`,
  `test_plan_file_wave_refusal`, `test_cr051_files_count_parity`, `test_declared_target_report_mechanism`,
  `test_bun_crucible_axi_conventions`, the five `test_*_crucible_agent_identity_required`, the five census modules'
  module-level cases, and others (`test-reports/work/dep-census-py.out`). Each now declares the board it reaches, or
  asserts the refusal. **Added 2026-11-15 (user ruling):** CR-CRU-259 and CR-CRU-260 are pushed together, and that CI
  run must be green before CR-CRU-261's close-out.
- [ ] **AC8 — copies are installs.** No test copies a client module anywhere but under a `clients/` directory of its own
  temp install, inside a parent the test owns. With a `crucible.toml` planted in that parent, a flat copy reads it and
  the `<install>/clients/` copy does not; the census scratch copies pass.
- [ ] **AC9 — no operator board, no root `.env`.** No test resolves a board from the repo root, and
  `declaredClientBoard` takes its directory explicitly (a guard over `tests/`). No bun test process and no
  test-spawned board carries a variable the test did not set from a `.env`: a guard asserts `CRUCIBLE_PROJECT_KEY` is
  absent from the bun suite's own `process.env` and from a test-spawned server's, with a planted `.env` in the
  working directory.
- [ ] **AC10 — the backstops.** Every client the helpers load or spawn has `_INSTALL_DIR` equal to the test install,
  never the repo root, including the `_crucible_axi` the orchestrator CLI vendors; a bun-spawned client's project is
  never the repo root; and a test-install client with no project board answers the `BoardUndeclared` envelope.

## Cycles

Each cycle is green on its own, with or without the root toml (pre-review F10).

1. AC7's board declarations (python) and AC8: the 127 drives declare their boards first, so they pass either way.
2. The python test install, its ownership and guard (AC2 python half, AC6 python half, AC10), the migration, and the
   orchestrator-CLI family.
3. The bun test install: the preload's project-dir and `.env` rules, any bun board declarations its switch exposes,
   the migration, the live legs' removal (AC2 TypeScript half, AC6 bun half, AC9).
4. Suite-owned caches (maven with its stamp, go, uv), offline wheels, CI and its pins (AC3, AC4, AC5).

## Non-goals

- Tiers by directory (CR-CRU-261), the live-board demotion (CR-CRU-262), hermetic CI (CR-CRU-263).
- The Playwright e2e suite (it already sets its own `CRUCIBLE_DB`).
