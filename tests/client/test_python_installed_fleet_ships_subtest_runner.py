"""The installer's packaged fleet (`crucible_axi.install.FLEET_FILES`, laid
down under `<target-dir>/clients/` by `run_fleet_stage`) is nine files today:
the five hyphen-named clients, `_crucible_axi.py`, `toon.py`,
`STATUS-CONTRACT.md` and the shipped `crucible.toml`. None of them is a
runner module `python-crucible.py` could spawn in place of `-m xmlrunner`,
so a real `run_install` never lands one, and the INSTALLED copy of
`python-crucible.py` runs a suite exactly the way the in-repo copy does
today -- undercounting a passing loop of `subTest` cases the same way.

This file runs the REAL `[fleet]`/`[manifest]` install stages against a
scratch target directory (the `[server]`/`[unit]` stages are stubbed, the
same no-subprocess doubles the sibling installer suite already uses, so
nothing here touches a real Bun install or the operator's systemd user
manager), and then drives the INSTALLED `<target-dir>/clients/python-crucible.py`
against a subtest fixture through a real in-process HTTP board double.

The runner module's chosen name (`subtest_runner.py`) matches the sibling
file that drives the in-repo client directly; the fixture here is the
smaller plain-loop shape this file needs on its own."""

import contextlib
import importlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"

sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "tests" / "client"))
from live_run_harness import RecordingBoard, install_project  # noqa: E402

RUNNER_MODULE_FILENAME = "subtest_runner.py"
CLIENTS_DIRNAME = "clients"
TOON_FILENAME = "toon.py"

AGENT = "installed-fleet-subtest-fixture-agent"
PROJECT_KEY = "installed-fleet-subtest-fixture-key"

PARITY_FIXTURE_SOURCE = '''\
import unittest


class InstalledSubtestParityCase(unittest.TestCase):
    def test_three_case_loop(self):
        for i in range(3):
            with self.subTest(case=i):
                self.assertTrue(True)

    def test_plain_case(self):
        self.assertTrue(True)
'''


def _import_fresh(*module_names):
    """Import the named `crucible_axi` modules from the repo-root checkout,
    purging the whole package first so this test's own patches of
    `DEFAULT_STAGE_RUNNERS` land on the SAME module object `run_install`
    reads -- the convention the sibling installer suite already follows."""
    root_str = str(REPO_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)
    for name in list(sys.modules):
        if name == "crucible_axi" or name.startswith("crucible_axi."):
            del sys.modules[name]
    return tuple(importlib.import_module(name) for name in module_names)


def _fast_server_stage(target_dir, force):
    return {"path": os.path.join(target_dir, "server"), "converged": False}


def _fast_unit_stage(target_dir, force):
    return {"path": os.path.join(target_dir, "unit"), "converged": False}


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    full_argv = ["python-crucible.py"] + list(argv)
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", full_argv), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            module.main()
            code = 0
        except SystemExit as exc:
            if exc.code is None:
                code = 0
            elif isinstance(exc.code, int):
                code = exc.code
            else:
                code = 1
    return code, stdout.getvalue(), stderr.getvalue()


def _last_parsed_payload(board):
    parsed = [body for path, body in board.posts() if path == "/api/v2/runs/parsed"]
    assert parsed, f"no /api/v2/runs/parsed POST observed; posts={board.posts()!r}"
    return parsed[-1]


class _InstalledFleetCase(unittest.TestCase):
    def setUp(self):
        self.assertTrue(
            REAL_VENV_PYTHON.exists(),
            f"this file needs a real interpreter with unittest-xml-reporting "
            f"4.0.0 installed; expected one at {REAL_VENV_PYTHON}")
        self.target = tempfile.mkdtemp(prefix="installed-fleet-target-")
        self.addCleanup(shutil.rmtree, self.target, ignore_errors=True)
        self.install, = _import_fresh("crucible_axi.install")

    def run_install_with_stubbed_server_and_unit(self):
        with mock.patch.dict(self.install.DEFAULT_STAGE_RUNNERS,
                             {"server": _fast_server_stage,
                              "unit": _fast_unit_stage}):
            return self.install.run_install(self.target)

    def clients_dir(self):
        return os.path.join(self.target, CLIENTS_DIRNAME)


class RunnerModuleShipsBesideToonInThePackagedFleetTest(_InstalledFleetCase):
    """It ships -- the runner module is part of the installer's packaged
    fleet, and a real install lays it down beside `toon.py`."""

    def test_runner_module_lands_in_the_clients_dir_beside_toon(self):
        ok, stages, warnings = self.run_install_with_stubbed_server_and_unit()
        self.assertTrue(
            ok, f"a stubbed-server/unit install must still be ok:true; "
                f"stages={stages} warnings={warnings}")
        toon_path = os.path.join(self.clients_dir(), TOON_FILENAME)
        self.assertTrue(
            os.path.isfile(toon_path),
            f"fixture assumption broken: the existing [fleet] stage must "
            f"still land {TOON_FILENAME!r}; clients_dir listing="
            f"{os.listdir(self.clients_dir()) if os.path.isdir(self.clients_dir()) else '<missing>'}")
        runner_path = os.path.join(self.clients_dir(), RUNNER_MODULE_FILENAME)
        self.assertTrue(
            os.path.isfile(runner_path),
            f"the runner module ({RUNNER_MODULE_FILENAME!r}) must be part of "
            f"the installer's packaged fleet and land beside {TOON_FILENAME!r} "
            f"under <target-dir>/clients/ -- crucible_axi.install.FLEET_FILES "
            f"names no such file today; clients_dir listing="
            f"{sorted(os.listdir(self.clients_dir()))}")
        self.assertGreater(
            os.path.getsize(runner_path), 0,
            f"a landed runner module must not be an empty file; "
            f"path={runner_path!r}")


class InstalledPythonClientRunsASubtestFixtureWithCorrectTotalsTest(_InstalledFleetCase):
    """It ships -- the INSTALLED python client, run from
    `<target-dir>/clients/python-crucible.py`, must report the correct
    totals above for a subtest fixture, not the undercounted totals the
    in-repo client reports today."""

    def test_installed_client_reports_the_full_subtest_total_for_an_all_passing_run(self):
        ok, stages, warnings = self.run_install_with_stubbed_server_and_unit()
        self.assertTrue(
            ok, f"a stubbed-server/unit install must still be ok:true; "
                f"stages={stages} warnings={warnings}")
        installed_client_path = os.path.join(self.clients_dir(), "python-crucible.py")
        self.assertTrue(
            os.path.isfile(installed_client_path),
            f"the installed python client must exist at "
            f"{installed_client_path!r}; clients_dir listing="
            f"{os.listdir(self.clients_dir())}")

        project_dir = tempfile.mkdtemp(prefix="installed-fleet-project-")
        self.addCleanup(shutil.rmtree, project_dir, ignore_errors=True)
        board = RecordingBoard()
        self.addCleanup(board.close)
        install_project(project_dir, board.url, PROJECT_KEY)
        pkg_dir = os.path.join(project_dir, "pkg")
        os.makedirs(pkg_dir, exist_ok=True)
        Path(os.path.join(pkg_dir, "__init__.py")).write_text("", encoding="utf-8")
        Path(os.path.join(pkg_dir, "fixture_subtests.py")).write_text(
            PARITY_FIXTURE_SOURCE, encoding="utf-8")

        installed_module = _load_module(
            installed_client_path, "installed_python_crucible_under_test")
        argv = ["test", "--start-dir", "pkg", "--pattern", "fixture_subtests.py",
                "--project-dir", project_dir, "--agent", AGENT,
                "--python", str(REAL_VENV_PYTHON)]
        _code, _out, err = _run_main(installed_module, argv)

        payload = _last_parsed_payload(board)
        summary = payload["summary"]
        self.assertEqual(
            summary["total"], 4,
            f"the INSTALLED client must report total=4 (3 passing subtests "
            f"+ 1 plain test) for an all-passing run, exactly as a correct "
            f"in-repo client must; got summary={summary!r} stderr={err!r}")
        self.assertEqual(summary["passed"], 4, f"{summary!r}")
        self.assertEqual(summary["failed"], 0, f"{summary!r}")


if __name__ == "__main__":
    unittest.main()
