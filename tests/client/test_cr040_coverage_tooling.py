"""CR-CRU-040 C1 RED -- python-client coverage tooling (gate can't produce coverage).

Two independent breakages, pinned per
docs/changes/CR-CRU-040-python-coverage-tooling.md:

  §S1 -- `coverage` (coverage.py) is not available to the gate: the project
  `.venv` has no `coverage` module (`No module named coverage`), and it is
  not declared as a dev dependency anywhere in pyproject.toml.

  §S2 -- `--cov-source` defaults to `app` (python-crucible.py:1410 regression,
  :1440 pre-merge-gate), but there is no `app/` package in this repo -- the
  real Python source is `crucible_axi` + `clients`.

RED phase: this file asserts the FIX (§S1 dev-dep declared + resolvable,
§S2 correct default) and fails today for exactly the reasons above. No
production code is touched by this file.

Module-loading convention copied verbatim from the sibling AXI test harness
(`test_python_crucible_axi.py`): load `clients/python-crucible.py` by file
path via `importlib`, never import it as a package (it is a hyphenated
filename, not importable as a plain module).

Invocation:
    python3 -m pytest tests/client/test_cr040_coverage_tooling.py -q
Fallback:
    python3 tests/client/test_cr040_coverage_tooling.py
"""

import argparse
import importlib.util
import os
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "python-crucible.py"
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module():
    return _load_module(SCRIPT_PATH, "python_crucible_under_test_cr040")


def _run_main_capturing_cov_source(module, argv, patch_target):
    """Invoke module.main() with the given argv, but intercept the subcommand's
    handler (`cmd_regression` / `cmd_pre_merge_gate`) before it does any real
    work (network calls, subprocess xmlrunner/coverage runs). Returns the
    captured `args` Namespace so we can inspect the RESOLVED `--cov-source`
    default without triggering the actual gate run."""
    captured = {}

    def _capture(args):
        captured["args"] = args
        return 0

    with mock.patch.object(module, patch_target, side_effect=_capture):
        full_argv = ["python-crucible.py"] + argv
        with mock.patch.object(sys, "argv", full_argv):
            try:
                module.main()
            except SystemExit:
                pass
    assert "args" in captured, (
        f"{patch_target} was never invoked -- argv {argv!r} did not reach "
        f"the expected subcommand handler"
    )
    return captured["args"]


class CovSourceDefaultTest(unittest.TestCase):
    """§S2 -- `--cov-source` must default to this repo's real Python source
    (`crucible_axi` + `clients`), not the nonexistent `app` package."""

    def test_regression_cov_source_default_measures_real_source(self):
        module = _load_client_module()
        args = _run_main_capturing_cov_source(
            module, ["regression", "--agent", "cr040-red-probe"], "cmd_regression"
        )
        self.assertIn(
            "crucible_axi", args.cov_source,
            f"regression --cov-source default {args.cov_source!r} must "
            f"reference crucible_axi",
        )
        self.assertIn(
            "clients", args.cov_source,
            f"regression --cov-source default {args.cov_source!r} must "
            f"reference clients",
        )
        self.assertNotEqual(
            args.cov_source, "app",
            "regression --cov-source must not default to the nonexistent "
            "'app' package",
        )

    def test_pre_merge_gate_cov_source_default_measures_real_source(self):
        module = _load_client_module()
        args = _run_main_capturing_cov_source(
            module, ["pre-merge-gate", "--agent", "cr040-red-probe"],
            "cmd_pre_merge_gate",
        )
        self.assertIn(
            "crucible_axi", args.cov_source,
            f"pre-merge-gate --cov-source default {args.cov_source!r} must "
            f"reference crucible_axi",
        )
        self.assertIn(
            "clients", args.cov_source,
            f"pre-merge-gate --cov-source default {args.cov_source!r} must "
            f"reference clients",
        )
        self.assertNotEqual(
            args.cov_source, "app",
            "pre-merge-gate --cov-source must not default to the "
            "nonexistent 'app' package",
        )


class CoverageDevDependencyTest(unittest.TestCase):
    """§S1 -- `coverage` (coverage.py) must be declared as a dev dependency
    AND actually resolvable from the project `.venv` the gate runs under."""

    def test_pyproject_declares_coverage_as_dev_dependency(self):
        with open(PYPROJECT_PATH, "rb") as f:
            data = tomllib.load(f)

        project = data.get("project", {})
        opt_deps = project.get("optional-dependencies", {})
        dep_groups = data.get("dependency-groups", {})

        dev_deps = list(opt_deps.get("dev", [])) + list(dep_groups.get("dev", []))
        has_coverage = any(
            dep.strip().lower().startswith("coverage") for dep in dev_deps
        )
        self.assertTrue(
            has_coverage,
            f"pyproject.toml declares no 'coverage' dev dependency -- found "
            f"dev deps: {dev_deps!r} (checked "
            f"[project.optional-dependencies].dev and "
            f"[dependency-groups].dev)",
        )

    def test_gate_venv_python_can_execute_coverage_module(self):
        """Mirrors the REAL invocation the gate performs
        (`_regression_run`: `python -m coverage run --source ...`), not a
        bare `import coverage` -- a bare import would falsely pass today
        because this repo has an unrelated top-level `coverage/` directory
        (bun's lcov output) that Python treats as an empty namespace
        package when no real coverage.py is installed. Executing `-m
        coverage` fails against a namespace package (no `__main__`),
        exactly like the real gate invocation does today."""
        module = _load_client_module()
        python = module._resolve_python(None, str(REPO_ROOT))
        result = subprocess.run(
            [python, "-m", "coverage", "--version"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            result.returncode, 0,
            f"expected `{python} -m coverage --version` to succeed once "
            f"coverage.py is installed in the gate venv; got returncode="
            f"{result.returncode} stdout={result.stdout!r} "
            f"stderr={result.stderr!r}",
        )


class CoverageRunEnvTest(unittest.TestCase):
    """§S2 lock-in -- the coverage-run subprocess env must NOT set
    PYTHONSAFEPATH. A real coverage.py install already wins over the stray
    top-level `coverage/` namespace-dir shadow, so the flag is obsolete; and
    setting it leaks into the suite's own subprocess-spawning tests (their
    grandchildren inherit it, breaking tmpdir-cwd dotted-name imports). This
    pins the regression: the env `_regression_run` builds for `coverage run`
    must carry no PYTHONSAFEPATH key."""

    class _AbortAfterCapture(Exception):
        pass

    def test_coverage_run_env_does_not_set_pythonsafepath(self):
        module = _load_client_module()
        captured = {}

        def _capture_env(_cmd, _cwd, env, _log_path):
            captured["env"] = env
            # Abort before any real subprocess/network work -- we only need the
            # env that _regression_run built for the coverage `run` subprocess.
            raise CoverageRunEnvTest._AbortAfterCapture()

        with tempfile.TemporaryDirectory() as tmp:
            args = argparse.Namespace(
                project_dir=tmp,
                python=sys.executable,
                reports="reports",
                coverage=True,
                cov_source="crucible_axi,clients",
                start_dir="tests",
                pattern="test_*.py",
                agent="cr040-env-probe",
                log=None,
            )
            with mock.patch.object(module, "_run_logged",
                                    side_effect=_capture_env):
                with self.assertRaises(CoverageRunEnvTest._AbortAfterCapture):
                    module._regression_run(args)

        self.assertIn("env", captured, "_run_logged was never reached")
        self.assertNotIn(
            "PYTHONSAFEPATH", captured["env"],
            "the coverage-run env must NOT set PYTHONSAFEPATH -- it is obsolete "
            "(real coverage.py beats the namespace-dir shadow) and leaks into "
            "grandchild test subprocesses",
        )

    def test_collect_coverage_env_does_not_set_pythonsafepath(self):
        """Same lock-in for the sibling `coverage lcov` step: the env
        `_collect_coverage` builds for its subprocess must ALSO carry no
        PYTHONSAFEPATH key. Patches the `subprocess.run` seam and aborts before
        any real work via a sentinel, mirroring the run-step test above."""
        module = _load_client_module()
        captured = {}

        def _capture_env(_cmd, **kwargs):
            captured["env"] = kwargs.get("env")
            # Abort before the real `coverage lcov` subprocess -- we only need the
            # env that _collect_coverage built for it.
            raise CoverageRunEnvTest._AbortAfterCapture()

        with tempfile.TemporaryDirectory() as tmp:
            base_env = dict(os.environ)
            with mock.patch.object(module.subprocess, "run",
                                    side_effect=_capture_env):
                with self.assertRaises(CoverageRunEnvTest._AbortAfterCapture):
                    module._collect_coverage(sys.executable, tmp, base_env)

        self.assertIn("env", captured, "subprocess.run was never reached")
        self.assertIsNotNone(
            captured["env"], "_collect_coverage must pass an explicit env"
        )
        self.assertNotIn(
            "PYTHONSAFEPATH", captured["env"],
            "the `coverage lcov` env must NOT set PYTHONSAFEPATH -- same obsolete "
            "rationale as the coverage-run step (real coverage.py beats the "
            "namespace-dir shadow)",
        )


if __name__ == "__main__":
    unittest.main()
