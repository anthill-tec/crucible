# CR-CRU-253 — the client modules type-check clean, and the installer tests stay off the shipped ports

**Status:** PENDING · filed 2026-11-13 (user ruling: CR-CRU-199 split in three for ease of execution; this is
the client hygiene added to CR-CRU-199 on 2026-11-04, plus two items carried from CR-CRU-252's VERIFY and RED) ·
gap analysis: `test-reports/work/cr199-gap-analysis.md` (F10, F11)
**Type:** maintenance
**Points:** 3
**Wave:** 8 (0.4.0)
**Depends on:** —
**Labels:** clients, installer, tests, hygiene
**Design reference:** CR-CRU-221 (the run pipeline's own shared module, which binds its core late);
CR-CRU-252 (the installer's fill step)

## Problem

- **23 type errors in the run module.** `clients/_crucible_run.py` declares `_core = None` and lets the core
  rebind it once loaded. A type checker therefore types every `_core.<name>` access as an attribute of `None`.
  pi-lens reports 23 errors (20 on 2026-11-04), all from this one cause. They hide any real error in the module.
  `clients/arduino-crucible.py`'s error from 2026-11-04 is gone (0 today).
- **`run_manifest_stage` grew.** CR-CRU-252 added the fill branches to it. VERIFY graded the growth a suggestion
  (pi-lens' measure 13 → 20; ruff's McCabe 13 today). Its server-file "lay down or fill" choice can be its own
  helper.
- **A test probes the shipped port window.** `test_an_installed_deployment_resolves_its_configuration`'s
  `provision_server` copies the shipped `src/crucible.toml`, whose range is 3800–3899. Its fresh installs then
  `bind`-probe that window on the real host, including the boards on 3849 and 3850. Binding an occupied port
  fails harmlessly, but a test must not touch those ports at all.
- **Ruff has no project configuration, and the tree is not clean.** `pyproject.toml` declares no `[tool.ruff]`,
  so ruff falls back to whatever rule set the machine's ruff defaults to (ruff 0.16.8 here: 1122 findings over
  `clients crucible_axi tests`). On ruff's classic default set (`E4`, `E7`, `E9`, `F`), `clients/` and
  `crucible_axi/` are clean and `tests/` carries 22 findings (12 `F541`, 8 `F401`, 1 `E741`, 1 `F841`) over 15
  modules. CR-CRU-254 declares ruff as this project's linter, so the rule set must be the project's and the tree
  clean on it first.

## Steps

### §S1 — the run module's late-bound core is typed

`_core` is declared with a type that lets a checker resolve the core's names, for example `Any` or the core
module's type under `TYPE_CHECKING`. It is still bound to `None` until the core binds it, and still read at call
time, never copied. No runtime behaviour changes.

### §S2 — the server file's step is its own helper

The server-file "lay down or fill" branch of `run_manifest_stage` moves into a helper in `crucible_axi/manifest.py`.
Behaviour, the stage's report, its `filled` / `notFilled` rows and its `converged` value are unchanged.

### §S3 — the installer test provisions ephemeral ports

`provision_server` writes a template whose `port_range_min`/`port_range_max` and `port` are ephemeral ports,
claimed as CR-CRU-139's tests claim them. The template is otherwise the shipped one. No installer test probes,
binds or connects to a port in 3800–3899.

### §S4 — the project's ruff rule set is pinned, and the tree is clean on it

`pyproject.toml` gains `[tool.ruff.lint] select = ["E4", "E7", "E9", "F"]`, so `ruff check` reads the
project's rule set on any machine. `ruff` joins the `dev` optional-dependency group (the toolchain the python
client drives, installed by `pip install '.[dev]'`), so the tests below run it as `python -m ruff` from the
project's own environment rather than whatever ruff a machine has on PATH (amended 2026-11-13 at RED: the
project's `.venv` had no ruff). The 22 findings in `tests/` are fixed: an unused import removed, an f-string
without placeholders made a plain string, the ambiguous name renamed, and the unused variable dropped. No test's
behaviour changes.

## Acceptance criteria

- [ ] **AC1 — the run module type-checks clean.** An LSP probe of `clients/_crucible_run.py` reports no
  `reportAttributeAccessIssue` on `_core`. The run-module and client suites pass unedited.
- [ ] **AC2 — the manifest stage is back under its old weight.**
  - Ruff's McCabe check (`C901`, max-complexity 10) passes for `run_manifest_stage`, pinned by a test that runs it.
  - The installer suites pass unedited, including CR-CRU-252's fill module.
- [ ] **AC3 — no installer test touches the shipped window.**
  - `provision_server`'s template declares no port and no range bound inside 3800–3899.
  - A guard test asserts this for every installer-test helper that writes a server template.
- [ ] **AC4 — ruff passes on the project's own rule set.** `ruff check clients crucible_axi tests` from the repo
  root, with no other configuration, exits 0. A test runs it. Every edited test module still passes, with the same
  counts.
- [ ] **AC5 — the budgets.** `SHARED_MODULE_LINE_BUDGETS`' `_crucible_run.py` entry follows the module's new line
  count in all three copies. The core's count is unchanged.

## Non-goals

- Type errors outside the client fleet.
- Any change to the late binding itself (CR-CRU-221's design).
- The stale status column of `docs/changes/README.md`.
