# CR-CRU-198 — the python floor is 3.14, and the lint and secrets scans report what matters

**Type** maintenance · **Points** 8 (5 at filing 2026-10-19; raised at its spec pre-review the same
day, when the installer, CI and the arduino client joined its scope) · **Wave** 8 (0.4.0) ·
**Depends on** — · **Status** PENDING — filed 2026-10-19 (split from CR-CRU-190 at its gap
analysis, user ruling)

## Problem

1. **The declared python floor is not the baseline.** Found during CR-CRU-191. Python 3.14 is the
   adopted baseline (user ruling, 2026-10-16), but:
   - `pyproject.toml` declares `requires-python = ">=3.10"` and classifiers 3.10–3.13;
   - each of the five clients' PEP 723 headers declares `requires-python = ">=3.10"`, and two tests
     pin that string;
   - the release workflow's two python setups name `3.x`, and two more jobs that run python
     (`test-bun`, `publish-testpypi`) set up none, so they run on the runner's default python;
   - this repo's `.venv` runs python 3.12.

   The clients and the installer import `tomllib`, which needs 3.11, so the declared floor is not
   even true today. Comments that justify a choice by the 3.10 floor (the `python -P` reasoning in
   `python-crucible.py`, and the scenario note in `tests/clients-python-arduino-crucible.test.ts`)
   become false with it.
2. **Raising the floor strands an upgrade.** `uv tool install --upgrade crucible-axi`, which
   `install.sh` and the README use, keeps an existing tool environment's interpreter. On python
   older than 3.14 (this machine's is 3.13) it silently stays on the newest release that interpreter
   allows, and `install.sh` reports the install as current. A fresh install picks uv's default
   interpreter, which may also be older. `--python 3.14` makes uv rebuild the environment and
   install the 3.14 release.
3. **Three `I001` suppressions give the wrong reason.** At each of `clients/_crucible_axi.py`,
   `clients/rust-crucible.py` and `crucible_axi/install.py`, ruff's `I001` is suppressed twice: a
   `# pi-lens-ignore: I001 …` comment and a `# noqa: I001` on the first import. The comment blames
   the declared floor. The real cause is that pi-lens lints with its own ruff configuration, which
   sets no target version, so ruff never reads `requires-python` and files `tomllib` as
   third-party: raising the floor does not clear them.
4. **One block in the rust client is indented a level too deep.** In `_smoke_refusal`, two nested
   `if`s were merged into one, but the body kept its old indent. It is valid and behaves the same,
   but it reads as nested one level deeper than it is.
5. **gitleaks reports identifiers as secrets.** pi-lens's gitleaks pass, with its default rules,
   reports 102 `generic-api-key` findings in the tracked tree: 101 made-up fixture labels in tests
   (`agg-collapse-expand-1`, `cr022-points-key` and the like) and one UUID in a design note
   (`docs/research/DN-crucible-api-reconstruction.md`). None is a secret, and a real secret would be
   lost among them. Today pi-lens scans this repo only on request, because nothing opts it in.
6. **Three test files carry ruff findings.** Under pi-lens's ruff configuration,
   `test_cr090_fleet_stage.py`, `test_cr090_cli_install_integration.py` and
   `test_gate_catches_the_python_suite_regression.py` report 19 findings (13 `UP031`, 3 `F541`,
   1 `SIM117`, 1 `S314`), so every edit to them surfaces lint unrelated to the edit.
7. **The arduino client writes its agent id into its own process environment.** Arduino's `main()`
   sets `os.environ["AGENT_ID"]` whenever `--agent` is given, and two places then read
   `AGENT_ID` from the environment as a request to file the run, although no environment variable
   is an identity source. Any test that calls `main()` in-process (`_drive_register` in
   `tests/client/test_an_escaping_os_or_value_error_becomes_an_envelope.py`,
   `test_client_tier_stamping.py`'s own runner, and others) leaves `AGENT_ID` behind. So
   `test_arduino_test_unfiled_runs_the_suite_and_posts_nothing`, run after such a module, files a run
   nobody asked to file and exits 2 with `agent-identity-required`. Found by CR-CRU-190's VERIFY
   (2026-10-19); the full suite passes only because discovery orders the modules the other way.

## Scope

### §S1 — the python floor is 3.14, everywhere it is declared

`pyproject.toml` declares `requires-python = ">=3.14"`, with `Programming Language :: Python :: 3`
and `Programming Language :: Python :: 3.14` its only python classifiers; each of the five clients'
PEP 723 headers declares `requires-python = ">=3.14"`. The two tests that pin the header follow it.
Every CI job that runs python sets up python 3.14: the release workflow's two existing setups, and
the `test-bun` and `publish-testpypi` jobs. Comments that reason from the 3.10 floor are corrected
to the 3.14 one; no behaviour changes with them. This repo's `.venv` is rebuilt on 3.14 before the
cycle runs (`uv venv --clear --python 3.14`, then `uv pip install -e '.[dev]'`, the dev toolchain
`pyproject.toml` declares).

### §S2 — an install or upgrade lands on 3.14

`install.sh` and the README's install and upgrade commands pass `--python 3.14` to
`uv tool install`, after the package name. Before an upgrade rebuilds a tool environment that runs
an older python, `install.sh` says so, naming the old python and that the environment is rebuilt
on 3.14.

### §S3 — the `I001` suppressions name their real cause

Both suppressions stay at each of the three sites. Only the `# pi-lens-ignore: I001` comment's
text changes: it says that pi-lens lints with its own ruff configuration, which sets no target
version, so ruff files `tomllib` as third-party whatever the declared floor.

### §S4 — the rust client's `_smoke_refusal` reads as it runs

The merged condition's body is indented to its real depth. Nothing else changes.

### §S5 — gitleaks reports secrets, not identifiers

A `.gitleaks.toml` at the repo root extends gitleaks' default rules and disables none. It allows
a hyphen-joined label of short segments only for the `generic-api-key` rule and only under
`tests/`, and it excludes the gitignored run output (`test-reports/`, `__pycache__/`). There is no
UUID allow: the design note's one UUID line carries an inline `gitleaks:allow`. The configuration
holds when pi-lens extends it with its own scoped configuration. Committing it opts this repo into
pi-lens's session-start and per-edit secrets scans; a fixture label outside the allowed shape then
surfaces as a finding, by design.

### §S6 — the three test files are lint-clean

The three files' findings are fixed in the tests themselves; `S314` follows the fleet's convention
(`# noqa: S314` with its pi-lens-ignore reason, as the clients carry). No assertion's meaning
changes.

### §S7 — the arduino client keeps its agent id out of its own environment

Arduino's `main()` never writes `os.environ`. The child processes it spawns receive `AGENT_ID` in
their own environment when `--agent` is given. Whether a run is filed is decided by `--agent`
alone, never by an `AGENT_ID` in the environment.

## Acceptance criteria

- [ ] **The floor is 3.14.** `pyproject.toml` declares `requires-python = ">=3.14"` and exactly the
      `Python :: 3` and `Python :: 3.14` classifiers; each of the five clients' PEP 723 headers
      declares `requires-python = ">=3.14"`; the two header-pinning tests expect `>=3.14`; every CI
      job that runs python (`build`, `test-python`, `test-bun`, `publish-testpypi`) sets up python
      `3.14`. No comment reasons from a 3.10 floor. The full python and bun suites pass with the
      `.venv` on python 3.14.
- [ ] **An upgrade lands on 3.14.** `install.sh`'s two `uv tool install` commands and the README's
      install and upgrade commands carry `--python 3.14` after the package name. Measured once (in
      VERIFY) against a local package index holding a `>=3.10` and a `>=3.14` release: an existing
      tool environment on python 3.13 is upgraded to the `>=3.14` release, and `install.sh` prints
      that it rebuilds the 3.13 environment on 3.14.
- [ ] **The suppressions say why.** Both suppressions remain at each of the three sites, and each
      `# pi-lens-ignore: I001` comment names pi-lens's ruff configuration having no target version as
      the cause. Ruff under pi-lens's own configuration and Pyright 1.1.414 (pi-lens's bundled CLI)
      both stay clean over `clients/` and `crucible_axi/`.
- [ ] **`_smoke_refusal` is indented truly.** Its body sits one level inside the merged `if`, and the
      rust client's existing tests pass unchanged.
- [ ] **gitleaks is quiet on identifiers and loud on secrets.** A committed test parses
      `.gitleaks.toml` and asserts it extends the defaults, disables no rule, and scopes its label
      allowlist to `generic-api-key` under `tests/`. Measured once (in VERIFY) with gitleaks 8.30.1
      run as pi-lens runs it (`detect --no-git`, a scoped configuration extending the repo's) over a
      `git archive` export of the tracked tree: zero findings. With planted values reported, all of
      them: in a test file, a GitHub token, a 40-character hex key and a 32-character random
      secret; outside `tests/`, a random hyphenated token and an `api_key` holding a UUID.
- [ ] **The three test files are clean.** Ruff under pi-lens's configuration reports zero findings
      in each of the three files, and their test counts and outcomes are unchanged.
- [ ] **Arduino keeps its agent id to its children.** After `main()` runs in-process with
      `--agent`, `os.environ` holds no `AGENT_ID`; a child process it spawns sees `AGENT_ID`; with
      `AGENT_ID` set in the environment and no `--agent`, a run is not filed.
      `test_arduino_test_unfiled_runs_the_suite_and_posts_nothing` passes when run in one client run
      directly after `test_an_escaping_os_or_value_error_becomes_an_envelope`, and fails that way
      before the fix.
- [ ] **No new CR literals.** No CR-shaped literal is added in `src/`, `public/` or `clients/`, the
      citation tripwire's pins are unchanged, and the citations already on rewritten lines are kept.

## How it is worked

Test edits in §S1 (the two header-pinning tests and their docstrings), §S6 and the bun test's
scenario note are approved by this spec, and each lands in its own commit. Model B hears of the
3.14 floor and the installer's `--python 3.14` in the 0.4.0 release notes. Under a direct `python3`
run a client's floor is advisory; under `uv run` it selects the interpreter.

## Non-goals

- The rest of `tests/`'s ruff findings.
- A project ruff configuration. `pyproject.toml` must not contain `[tool.ruff]`: pi-lens would then
  drop its own ruleset for this repo.
- Adopting `python -P`; only its comments change.
