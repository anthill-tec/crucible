# CR-CRU-198 — the python floor is 3.14, and the lint and secrets scans report what matters

**Type** maintenance · **Points** 5 (set at the CR-CRU-190 gap analysis, 2026-10-19; confirmed at
this CR's gap analysis) · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed
2026-10-19 (split from CR-CRU-190 at its gap analysis, user ruling)

## Problem

1. **The declared python floor is not the baseline.** Found during CR-CRU-191. Python 3.14 is the
   adopted baseline (user ruling, 2026-10-16), but:
   - `pyproject.toml` declares `requires-python = ">=3.10"` and classifiers 3.10–3.13;
   - each of the five clients' PEP 723 headers declares `requires-python = ">=3.10"`, and two tests
     pin that string;
   - the release workflow's two python setups name `3.x`;
   - this repo's `.venv` runs python 3.12.

   The clients and the installer import `tomllib`, which needs 3.11, so the declared floor is not
   even true today.
2. **Three `I001` suppressions give the wrong reason.** `clients/_crucible_axi.py`,
   `clients/rust-crucible.py` and `crucible_axi/install.py` suppress ruff's `I001` because ruff files
   `tomllib` as third-party. Their comments blame the declared floor. The real cause is that pi-lens
   lints with its own ruff configuration, which sets no target version, so ruff never reads
   `requires-python`: raising the floor does not clear them.
3. **One block in the rust client is indented a level too deep.** In `_smoke_refusal`, two nested
   `if`s were merged into one, but the body kept its old indent. It is valid and behaves the same,
   but it reads as nested one level deeper than it is.
4. **gitleaks reports identifiers as secrets.** pi-lens's gitleaks pass, with its default rules,
   reports 880 `generic-api-key` findings. 760 are in gitignored run output under `test-reports/`.
   Of the 102 in tracked files, 101 are made-up fixture labels in tests (`agg-collapse-expand-1`,
   `cr022-points-key` and the like) and one is a UUID in a design note. None is a secret, and a real
   secret would be lost among them.
5. **Three test files carry ruff findings.** Under pi-lens's ruff configuration,
   `test_cr090_fleet_stage.py`, `test_cr090_cli_install_integration.py` and
   `test_gate_catches_the_python_suite_regression.py` report 19 findings (`UP031`, `F541`, `SIM117`,
   `S314`), so every edit to them surfaces lint unrelated to the edit.
6. **One test leaks `AGENT_ID` into later tests.** Found by CR-CRU-190's VERIFY (2026-10-19).
   Arduino's `main()` sets `os.environ["AGENT_ID"]` whenever `--agent` is given, for its child
   processes. A test that calls it in-process (`_drive_register` in
   `tests/client/test_an_escaping_os_or_value_error_becomes_an_envelope.py`) never restores the
   environment, and the live-run harness's `scrubbed_env` does not remove `AGENT_ID`. So
   `test_arduino_test_unfiled_runs_the_suite_and_posts_nothing`, run after that module, exits 2
   with `agent-identity-required`. The full suite passes only because discovery orders the two
   modules the other way.

## Scope

### §S1 — the python floor is 3.14, everywhere it is declared

`pyproject.toml` declares `requires-python = ">=3.14"` with the 3.14 classifier only; each of the
five clients' PEP 723 headers declares `requires-python = ">=3.14"`; the release workflow's two
python setups name `3.14`. The two tests that pin the clients' header follow it. This repo's `.venv`
is rebuilt on 3.14 before the cycle runs (`uv venv --python 3.14`, then `uv pip install -e '.[dev]'`,
the dev toolchain `pyproject.toml` declares), so the client's runs use the baseline interpreter.

### §S2 — the `I001` suppressions name their real cause

The three `I001` suppressions stay. Their comments say that pi-lens lints with its own ruff
configuration, which sets no target version, so ruff files `tomllib` as third-party whatever the
declared floor.

### §S3 — the rust client's `_smoke_refusal` reads as it runs

The merged condition's body is indented to its real depth. Nothing else changes.

### §S4 — gitleaks reports secrets, not identifiers

A `.gitleaks.toml` at the repo root extends gitleaks' default rules and disables none. It allows,
for the `generic-api-key` rule only, a value that is a UUID or a hyphen-joined label of short
segments, and it excludes the gitignored run output (`test-reports/`, `__pycache__/`). Every other
rule, and a random-looking value under `generic-api-key`, is still reported. The configuration
holds when pi-lens extends it with its own scoped configuration, the way pi-lens runs gitleaks.

### §S5 — the three test files are lint-clean

The three files' findings are fixed in the tests themselves. No assertion's meaning changes.

### §S6 — no test leaks `AGENT_ID`

The leak is fixed at its source: the test that drives a client's `main()` in-process restores the
environment it changed, and the live-run harness scrubs `AGENT_ID` from the environment it hands a
client.

## Acceptance criteria

- [ ] **The floor is 3.14.** `pyproject.toml` declares `requires-python = ">=3.14"` and only the 3.14
      classifier; each of the five clients' PEP 723 headers declares `requires-python = ">=3.14"`;
      the release workflow's two python setups name `3.14`; the two tests that pin the header expect
      `>=3.14`. The full python and bun suites pass with the `.venv` on python 3.14.
- [ ] **The suppressions say why.** Each of the three `I001` suppressions' comments names pi-lens's
      ruff configuration having no target version as the cause, and ruff under pi-lens's own
      configuration and Pyright 1.1.414 (pi-lens's bundled CLI) both stay clean over `clients/` and
      `crucible_axi/`.
- [ ] **`_smoke_refusal` is indented truly.** Its body sits one level inside the merged `if`, and the
      rust client's existing tests pass unchanged.
- [ ] **gitleaks is quiet on identifiers and loud on secrets.** Run as pi-lens runs it (`detect
      --no-git` over the whole tree, with a scoped configuration that extends the repo's
      `.gitleaks.toml`), gitleaks reports zero findings on the tree. With three planted values in a
      tracked test file (a GitHub token, a 40-character hex key and a 32-character random
      alphanumeric secret), it reports all three. The repo's configuration extends the default rules
      and disables none.
- [ ] **The three test files are clean.** Ruff under pi-lens's configuration reports zero findings
      in each of the three files, and their test counts and outcomes are unchanged.
- [ ] **No test leaks `AGENT_ID`.** `test_arduino_test_unfiled_runs_the_suite_and_posts_nothing`
      passes when run in one client run directly after
      `test_an_escaping_os_or_value_error_becomes_an_envelope`, and fails that way before the fix.
- [ ] **No new CR literals.** No CR-shaped literal is added in `src/`, `public/` or `clients/`, the
      citation tripwire's pins are unchanged, and the citations already on rewritten lines are kept.

## How it is worked

Test edits in §S1 (the two header-pinning tests), §S5 and §S6 are approved by this spec, and each
lands in its own commit. Model B hears of the 3.14 floor in the 0.4.0 release notes: a client run
through `uv run --script` on an older python is then refused.

## Non-goals

- The rest of `tests/`'s ruff findings.
- A project ruff configuration. It would switch pi-lens off its own ruleset for this repo.
