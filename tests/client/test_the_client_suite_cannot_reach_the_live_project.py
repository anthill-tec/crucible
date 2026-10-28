"""The client suite cannot reach the live project.

Every client resolves its project as `--project-dir`, else its own
`<STACK>_CRUCIBLE_PROJECT_DIR`, else the git repo of the working directory
(arduino: the working directory itself). This repo's root holds the `.env` and
`crucible.toml` that name the LIVE project on the development board, so a
client test that forgets `--project-dir` would register agents and file
milestones there.

The `tests/client` package therefore points all five variables at one fresh,
empty directory for the suite's process. This guard reads the environment the
suite's process actually carries -- it never sets the variables itself -- and
proves that each client's resolution with no `--project-dir` lands in that
directory and not in the repo.

Hygiene: no message here prints any environment value other than the
isolation directory's own path, and no `.env` is ever opened -- the isolation
directory is checked only for the ABSENCE of the two files.
"""

import argparse
import importlib.util
import itertools
import os
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"

#: The five client-steering variables, one per stack, and the client each steers.
STACK_VARIABLES = {
    "python": "PY_CRUCIBLE_PROJECT_DIR",
    "bun": "BUN_CRUCIBLE_PROJECT_DIR",
    "mvn": "MVN_CRUCIBLE_PROJECT_DIR",
    "rust": "RUST_CRUCIBLE_PROJECT_DIR",
    "arduino": "ARDUINO_CRUCIBLE_PROJECT_DIR",
}

#: The two files that make a directory a Crucible project.
PROJECT_FILES = (".env", "crucible.toml")

LIVE_REPO_MESSAGE = (
    "a client test with no --project-dir resolves the live repo")

_COUNTER = itertools.count()


def _real(path):
    return os.path.realpath(os.path.abspath(str(path)))


def _load_client(stack):
    """A FRESH client module per call (the sibling loader idiom), so one
    test's binding of the shared module never leaks into the next."""
    path = CLIENTS_DIR / f"{stack}-crucible.py"
    name = f"{stack}_crucible_live_project_guard_{next(_COUNTER)}"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TheClientSuiteCannotReachTheLiveProjectTest(unittest.TestCase):

    def isolation_dir(self):
        """The one directory the five variables name in this process, checked
        to be an existing directory that is not a project. Every failure
        message names only the VARIABLE, never what it holds."""
        unset = [var for var in STACK_VARIABLES.values()
                 if not os.environ.get(var)]
        self.assertEqual(
            unset, [],
            f"{', '.join(unset)} unset in the client suite's process -- the "
            "suite was discovered without importing the tests.client package "
            "(run it as `-s tests/client -t .`, as dotted "
            "`tests.client.<module>` targets, or from `-s tests`); "
            f"{LIVE_REPO_MESSAGE} ({REPO_ROOT})")
        named = {var: _real(os.environ[var]) for var in STACK_VARIABLES.values()}
        distinct = set(named.values())
        self.assertEqual(
            len(distinct), 1,
            "the five <STACK>_CRUCIBLE_PROJECT_DIR variables must name ONE "
            f"directory; they name {len(distinct)} different ones")
        (directory,) = distinct
        self.assertNotEqual(
            directory, _real(REPO_ROOT),
            f"the client suite's project variables name the repo root -- "
            f"{LIVE_REPO_MESSAGE} ({REPO_ROOT})")
        self.assertTrue(
            os.path.isdir(directory),
            f"the isolation directory {directory} does not exist")
        present = [name for name in PROJECT_FILES
                   if os.path.lexists(os.path.join(directory, name))]
        self.assertEqual(
            present, [],
            f"the isolation directory {directory} must hold no project, but "
            f"holds {', '.join(present)}")
        return directory

    # ── the environment the suite's process carries ──────────────────────

    def test_all_five_variables_name_one_existing_directory_that_holds_no_project(self):
        directory = self.isolation_dir()
        for var in STACK_VARIABLES.values():
            self.assertEqual(_real(os.environ[var]), directory,
                             f"{var} must name the isolation directory {directory}")
        for name in PROJECT_FILES:
            self.assertFalse(
                os.path.exists(os.path.join(directory, name)),
                f"the isolation directory {directory} must hold no {name}")

    # ── each client's resolution with no --project-dir ──────────────────

    def assert_resolution_answers_the_isolation_directory(self, stack):
        module = _load_client(stack)
        shared = module._axi()
        self.addCleanup(shared.bind_project_dir, None)

        answered = _real(module._resolve_project_dir(None))

        self.assertNotEqual(
            answered, _real(REPO_ROOT),
            f"{stack}-crucible.py `_resolve_project_dir(None)` answered the "
            f"repo root {REPO_ROOT} -- {LIVE_REPO_MESSAGE}")
        directory = self.isolation_dir()
        self.assertEqual(
            answered, directory,
            f"{stack}-crucible.py `_resolve_project_dir(None)` must answer the "
            f"isolation directory {directory}")
        self.assertEqual(
            _real(shared._PROJECT_DIR), directory,
            f"{stack}-crucible.py must bind the shared module to the isolation "
            f"directory {directory} it resolved")

    def test_the_python_client_with_no_project_dir_resolves_the_isolation_directory(self):
        self.assert_resolution_answers_the_isolation_directory("python")

    def test_the_bun_client_with_no_project_dir_resolves_the_isolation_directory(self):
        self.assert_resolution_answers_the_isolation_directory("bun")

    def test_the_mvn_client_with_no_project_dir_resolves_the_isolation_directory(self):
        self.assert_resolution_answers_the_isolation_directory("mvn")

    def test_the_rust_client_with_no_project_dir_resolves_the_isolation_directory(self):
        self.assert_resolution_answers_the_isolation_directory("rust")

    def test_the_arduino_client_with_no_project_dir_resolves_the_isolation_directory_not_the_working_directory(self):
        """Arduino's `_project_dir(args)` takes the working directory itself,
        with no git step, and refuses (SystemExit naming the directory) a
        directory holding no `.env`. Pointed at the isolation directory it
        therefore REFUSES -- and the directory its refusal names is the one it
        resolved. Either way it must not answer the working directory."""
        module = _load_client("arduino")
        shared = module._axi()
        self.addCleanup(shared.bind_project_dir, None)
        working_dir = _real(os.getcwd())

        try:
            answered = _real(module._project_dir(argparse.Namespace(project_dir=None)))
        except SystemExit as exc:
            refusal = str(exc.code)
            for live in {working_dir, _real(REPO_ROOT)}:
                self.assertNotIn(
                    f" {live} ", f" {refusal} ",
                    f"arduino-crucible.py `_project_dir` resolved the working "
                    f"directory {live} -- {LIVE_REPO_MESSAGE}")
            directory = self.isolation_dir()
            self.assertIn(
                directory, refusal,
                f"arduino-crucible.py `_project_dir` with no --project-dir must "
                f"resolve the isolation directory {directory}")
            self.assertIsNone(
                shared._PROJECT_DIR,
                "a refused project directory must not be bound into the shared "
                "module")
            return

        self.assertNotEqual(
            answered, working_dir,
            f"arduino-crucible.py `_project_dir` with no --project-dir answered "
            f"the working directory {working_dir} -- {LIVE_REPO_MESSAGE}")
        self.assertNotEqual(
            answered, _real(REPO_ROOT),
            f"arduino-crucible.py `_project_dir` answered the repo root "
            f"{REPO_ROOT} -- {LIVE_REPO_MESSAGE}")
        directory = self.isolation_dir()
        self.assertEqual(
            answered, directory,
            f"arduino-crucible.py `_project_dir` with no --project-dir must "
            f"answer the isolation directory {directory}")


if __name__ == "__main__":
    unittest.main()
