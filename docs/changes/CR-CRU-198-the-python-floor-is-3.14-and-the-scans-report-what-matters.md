# CR-CRU-198 — the python floor is 3.14, and the lint and secrets scans report what matters

**Type** maintenance · **Points** 5 (set at the CR-CRU-190 gap analysis, 2026-10-19) · **Wave** 8
(0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-19 (split from CR-CRU-190 at its gap
analysis, user ruling)

## Problem

1. **The declared python floor is not the baseline.** Found during CR-CRU-191. `pyproject.toml`
   declares `requires-python = ">=3.10"` and classifiers 3.10–3.13, but the clients and the
   installer import `tomllib`, which needs 3.11. Python 3.14 is the adopted baseline (user ruling,
   2026-10-16). The low floor is also why ruff files `tomllib` as third-party, which three
   `I001` suppressions currently paper over. The release workflow sets up python `3.x`.
2. **One block in the rust client is indented a level too deep.** In `_smoke_refusal`, two nested
   `if`s were merged into one, but the body kept its old indent. It is valid and behaves the same,
   but it reads as nested one level deeper than it is.
3. **gitleaks reports identifiers as secrets.** pi-lens's gitleaks pass, with its default rules,
   reports 880 `generic-api-key` findings across the tree, 102 of them in 46 tracked files. None is a
   secret: they are project keys (UUIDv7), and test fixtures' made-up keys and agent ids. The rest
   are in gitignored run output under `test-reports/` and `__pycache__/`. A real secret would be lost
   among them.
4. **Three test files carry ruff findings.** Under pi-lens's ruff configuration,
   `test_cr090_fleet_stage.py`, `test_cr090_cli_install_integration.py` and
   `test_gate_catches_the_python_suite_regression.py` report 19 findings (`UP031`, `F541`, `SIM117`,
   `S314`), so every edit to them surfaces lint unrelated to the edit.
5. **One test leaks `AGENT_ID` into later tests.** Found by CR-CRU-190's VERIFY (2026-10-19).
   Arduino's `main()` sets `os.environ["AGENT_ID"]` whenever `--agent` is given. A test that
   calls it in-process (`_drive_register` in
   `tests/client/test_an_escaping_os_or_value_error_becomes_an_envelope.py`) never restores the
   environment, and the live-run harness's `scrubbed_env` does not remove `AGENT_ID`. So
   `test_arduino_test_unfiled_runs_the_suite_and_posts_nothing`, run after that module, exits 2
   with `agent-identity-required`. The full suite passes only because discovery orders the two
   modules the other way.

## Scope

### §S1 — the python floor is the 3.14 baseline

`pyproject.toml` declares `requires-python = ">=3.14"`, with classifiers naming 3.14 only, and the
release workflow's python setup names 3.14. Since `tomllib` is then stdlib at the declared floor,
the three `I001` suppressions for it are removed, and the imports are ordered as ruff orders them
at that target. This repo's `.venv` is rebuilt on 3.14 (`uv venv --python 3.14`, then
`uv pip install unittest-xml-reporting coverage`) before the cycle runs, so the client's runs use the
baseline interpreter.

### §S2 — the rust client's `_smoke_refusal` reads as it runs

The merged condition's body is indented to its real depth. Nothing else changes.

### §S3 — gitleaks reports secrets, not identifiers

A gitleaks configuration in the repo extends gitleaks' default rules. It allows a project key (a
UUIDv7) and a test fixture's key or id where it appears as a key or id value. It also excludes the
gitignored run output (`test-reports/`, `__pycache__/`). No default rule is disabled, so a real
secret anywhere in the tree is still reported.

### §S4 — the three test files are lint-clean

The three files' findings are fixed in the tests themselves. No assertion's meaning changes.

### §S5 — no test leaks `AGENT_ID`

The leak is fixed at its source: the test that drives a client's `main()` in-process restores the
environment it changed, and the live-run harness scrubs `AGENT_ID` from the environment it hands a
client.

## Acceptance criteria

- [ ] **The floor is 3.14.** `pyproject.toml` declares `requires-python = ">=3.14"` and only the 3.14
      classifier, the release workflow sets up python 3.14, and no `I001` suppression for `tomllib`
      remains under `clients/` or `crucible_axi/`. Ruff under pi-lens's own configuration and
      Pyright 1.1.414 (pi-lens's bundled CLI) both stay clean over `clients/` and `crucible_axi/`,
      and the full python and bun suites pass with the `.venv` on python 3.14.
- [ ] **`_smoke_refusal` is indented truly.** Its body sits one level inside the merged `if`, and the
      rust client's existing tests pass unchanged.
- [ ] **gitleaks is quiet on identifiers and loud on secrets.** pi-lens's gitleaks pass, run over the
      whole tree, reports zero findings on the current tree. With a planted fixture holding a real
      token shape (e.g. a GitHub token pattern) in a tracked test file, it reports that one. The
      repo's gitleaks configuration extends the default rules and disables none.
- [ ] **The three test files are clean.** Ruff under pi-lens's configuration reports zero findings
      in each of the three files, and their test counts and outcomes are unchanged.
- [ ] **No test leaks `AGENT_ID`.** `test_arduino_test_unfiled_runs_the_suite_and_posts_nothing`
      passes when run in one client run directly after
      `test_an_escaping_os_or_value_error_becomes_an_envelope`, and fails that way before the fix.
- [ ] **No new CR literals.** No CR-shaped literal is added in `src/`, `public/`, `clients/` or test
      comments, and the citation tripwire's pins are unchanged.

## How it is worked

Test edits in §S4 and §S5 are approved by this spec, and each lands in its own commit. Model B hears of the
3.14 floor in the 0.4.0 release notes.

## Non-goals

- The rest of `tests/`'s ruff findings.
