# CR-CRU-260 — the client suite runs from its own install and owns its caches

**Status:** PENDING · filed 2026-11-15 (release fix: found by the 0.4.0 leak census and CI run 43668348319; user
rulings 2026-11-15: a test-only install rather than a client setting, and a suite-owned maven repository kept between
runs)
**Type:** fix
**Points:** 5
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

- **A test-only install.** One harness helper per language (python under `tests/client/`, TypeScript under
  `tests/helpers/`) lays down, once per test process, a temporary install directory holding `clients/` (a link to the
  checkout's) and its own `crucible.toml`: no `[client] url`, no `[lint]` or `[run]` tables, no limits overrides. It is
  removed at process exit. Because the client derives `_INSTALL_DIR` from its own path, a client loaded or spawned from
  there reads only that file; no product code changes and no environment seam is added (CR-CRU-131 stands).
- **One constant.** Every test that loads or spawns a client takes its path from that helper. No test module builds
  its own path to the checkout's `clients/`. `986cda36`'s per-module binds fold into the helper where they duplicate
  it.
- **A test declares its board.** With CR-CRU-259 and no url in the test install, a test that reaches a board without
  declaring one gets the refusal: it fails loudly instead of leaking.
- **A suite-owned maven repository.** The integration tests that run maven take `-Dmaven.repo.local=<suite repo>` from
  their fixture; the suite repo is a git-ignored path in the checkout (`.cache/test-suite/m2`). A provisioning script
  (`scripts/provision-test-caches.sh`, or a bun script beside the other test scripts) fills it online with what the
  maven fixtures need and fills only what is missing. A test whose cache is empty fails with a message naming that
  script. The operator's `~/.m2` is never read.
- **Wheels build offline.** The three modules build with `--no-isolation` from the project's own `.venv`;
  `hatchling` and `hatch-vcs` join the `dev` extra in `pyproject.toml` (with the comment block that explains each dev
  dependency).
- **CI.** `ffdea8df`'s `~/.m2` warm-up step is removed; `test-python` runs the provisioning script instead. Its
  `cargo-llvm-cov` and `llvm-tools-preview` installs stay (a toolchain, like `go`, not operator state).

## Acceptance criteria

- [ ] **AC1 — no operator config.** A full run of both suites in a clean clone with an operator `crucible.toml` at its
  root whose `[client] url`, limits, `[lint]` and `[run]` differ from the defaults gives the same pass/fail per test as
  without it; and no test reads the root file (proved by the audit census: no open of `<repo>/crucible.toml`).
- [ ] **AC2 — one path.** No test module or helper outside the two harness helpers names the checkout's `clients/`
  directory as a place to load or spawn a client from (a guard test over `tests/`).
- [ ] **AC3 — maven.** With `HOME` pointing at an empty directory and no network, the maven live-run tests pass from a
  provisioned suite repo; with the suite repo empty they fail naming the provisioning script.
- [ ] **AC4 — wheels.** With no network, the three wheel modules pass.
- [ ] **AC5 — CI.** `release.yml` has no `~/.m2` warm-up and runs the provisioning script before `test-python`; the
  `ci-toolchain-provisioning` pins are updated.
- [ ] **AC6 — torn down.** After a suite run, no temporary install directory the helper created is left behind.
- [ ] **AC7 — every board is declared.** The no-root-toml dependency census (an isolated network namespace with the
  board tripwire) shows no `BoardUndeclared` failure and no tripwire hit. At CR-CRU-259's close, that census
  (`870f6905`) counted 127 such failures in about 27 modules: `test_cr054_http_core_lift`, `test_cr017_client_lifecycle`,
  `test_cr054_verb_surface_lift`, `test_bun_crucible_lifecycle`, `test_bun_crucible_agent_report_isolation`,
  `test_bun_crucible_auto_attach`, `test_plan_file_wave_refusal`, `test_cr051_files_count_parity`,
  `test_declared_target_report_mechanism`, `test_bun_crucible_axi_conventions`, the five
  `test_*_crucible_agent_identity_required`, the five census modules' module-level cases, and others
  (`test-reports/work/dep-census-py.out`). Each now declares the board it reaches, or asserts the refusal.
  **Added 2026-11-15 (user ruling):** CR-CRU-259 and CR-CRU-260 are pushed together, and that CI run must be green
  before CR-CRU-261's close-out.

## Non-goals

- Tiers by directory (CR-CRU-261), the live-board demotion (CR-CRU-262), hermetic CI (CR-CRU-263).
- The Playwright e2e suite (it already sets its own `CRUCIBLE_DB`).
