"""Every client the suite loads takes the suite's own test install.

A client derives its install dir from its own location (`_INSTALL_DIR` is
the parent of the directory its core sits in). Loaded from the checkout, it
takes the REPO ROOT as its install and reads the operator's git-ignored root
`crucible.toml`: its board, its limits, its `[lint]` and `[run]` tables.

The `tests.client` package therefore lays down a test install it owns: a
temporary directory holding `clients` (a symlink to the checkout's client
source, so edits stay live) and its own `crucible.toml`, which declares no
board, no `[lint]` or `[run]` table and no limits. A client loaded through
the package takes that directory as its install, so with no project board it
refuses with `BoardUndeclared` naming the test install's file -- never the
operator's.

The package's surface, as these tests use it:

- `TEST_INSTALL_DIR`      the test install's root
- `TEST_INSTALL_CLIENTS`  `<root>/clients`, a symlink to the checkout's source
- `TEST_INSTALL_CONFIG`   `<root>/crucible.toml`
- `TEST_INSTALL_MARKER`   the variable naming the root for child processes
- `CLIENT_SOURCE_DIR`     the checkout's client source, for reads and copies
- `client_script(name)`   `<root>/clients/<name>`, to spawn a client
- `load_client(name)`     a FRESH module loaded from `<root>/clients/<name>`

Everything here is in process: no spawn, no socket, no board.
"""

# pi-lens-ignore: I001 -- pi-lens lints with its own ruff configuration, which sets no target version, so ruff files tomllib as third-party
import os  # noqa: I001
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

from crucible_axi import cli, manifest
from tests import client as suite

REPO_ROOT = Path(__file__).resolve().parents[3]

#: The six stack clients, by file name.
CLIENT_SCRIPTS = (
    "python-crucible.py",
    "bun-crucible.py",
    "mvn-crucible.py",
    "rust-crucible.py",
    "go-crucible.py",
    "arduino-crucible.py",
)

MISSING_SURFACE = ("the tests.client package exposes no `{name}`: the suite has "
                   "no test install helper yet")


def _abs(path):
    """The path as a client derives it: absolute, symlinks NOT resolved."""
    return os.path.abspath(str(path))


def _real(path):
    return os.path.realpath(os.path.abspath(str(path)))


def _shown(path):
    """`path` home-abbreviated, as the board refusal prints it."""
    path = str(path)
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home + os.sep) else path


def surface(case, name):
    """The package's helper attribute `name`; the test FAILS (never errors)
    naming it when the package does not expose it."""
    if not hasattr(suite, name):
        case.fail(MISSING_SURFACE.format(name=name))
    return getattr(suite, name)


class TheTestInstallIsLaidOutTest(unittest.TestCase):

    def test_the_test_install_is_a_directory_outside_the_repo(self):
        root = surface(self, "TEST_INSTALL_DIR")
        self.assertTrue(os.path.isdir(root), f"the test install {root} does not exist")
        real_root, real_repo = _real(root), _real(REPO_ROOT)
        self.assertNotEqual(real_root, real_repo, "the test install is the repo root")
        self.assertFalse(
            real_root.startswith(real_repo + os.sep),
            f"the test install {root} lies inside the repo {REPO_ROOT}")
        self.assertNotEqual(
            real_root, _real(suite.ISOLATION_DIR),
            "the test install must not be the project isolation directory, "
            "which holds no crucible.toml")

    def test_the_clients_entry_is_a_symlink_to_the_checkouts_client_source(self):
        root = surface(self, "TEST_INSTALL_DIR")
        clients = surface(self, "TEST_INSTALL_CLIENTS")
        source = surface(self, "CLIENT_SOURCE_DIR")
        self.assertEqual(_abs(clients), os.path.join(_abs(root), "clients"))
        self.assertTrue(os.path.islink(clients),
                        f"{clients} must be a symlink, so edits to the source stay live")
        self.assertEqual(_real(clients), _real(source))
        self.assertEqual(Path(source).name, "clients")
        self.assertEqual(Path(source).resolve().parent, REPO_ROOT,
                         "the client source is the checkout's own")
        self.assertTrue((Path(source) / "_crucible_axi.py").is_file())

    def test_the_install_file_declares_no_board_no_lint_or_run_table_and_no_limits(self):
        root = surface(self, "TEST_INSTALL_DIR")
        config = surface(self, "TEST_INSTALL_CONFIG")
        self.assertEqual(_abs(config), os.path.join(_abs(root), "crucible.toml"))
        self.assertTrue(os.path.isfile(config), f"the test install has no {config}")
        with open(config, "rb") as handle:
            parsed = tomllib.load(handle)
        client_table = parsed.get("client", {})
        self.assertIsInstance(client_table, dict)
        self.assertNotIn("url", client_table, "the test install declares a board")
        for table in ("lint", "run", "limits"):
            self.assertNotIn(table, parsed,
                             f"the test install's crucible.toml declares a [{table}] table")

    def test_the_marker_names_the_test_install_for_child_processes(self):
        root = surface(self, "TEST_INSTALL_DIR")
        marker = surface(self, "TEST_INSTALL_MARKER")
        self.assertNotEqual(marker, suite.ISOLATION_MARKER)
        self.assertEqual(os.environ.get(marker), str(root))

    def test_client_script_answers_the_test_installs_copy_of_a_client(self):
        client_script = surface(self, "client_script")
        clients = surface(self, "TEST_INSTALL_CLIENTS")
        script = client_script("python-crucible.py")
        self.assertEqual(_abs(script), os.path.join(_abs(clients), "python-crucible.py"))
        self.assertTrue(os.path.isfile(script))

    def test_load_client_answers_a_fresh_module_per_call(self):
        load_client = surface(self, "load_client")
        first = load_client("python-crucible.py")
        second = load_client("python-crucible.py")
        self.assertIsNot(first, second,
                         "two loads share one module, so one test's binding leaks into the next")
        self.assertIsNot(first._axi(), second._axi())


class EveryClientTakesTheTestInstallTest(unittest.TestCase):
    """Each of the six clients, loaded through the helper in process."""

    def core_of(self, script):
        load_client = surface(self, "load_client")
        module = load_client(script)
        clients = surface(self, "TEST_INSTALL_CLIENTS")
        self.assertEqual(os.path.dirname(_abs(module.__file__)), _abs(clients),
                         f"{script} was not loaded from the test install")
        core = module._axi()
        self.addCleanup(core.bind_project_dir, core._PROJECT_DIR)
        return core

    def assert_takes_the_test_install(self, script):
        root = surface(self, "TEST_INSTALL_DIR")
        core = self.core_of(script)
        self.assertNotEqual(_real(core._INSTALL_DIR), _real(REPO_ROOT),
                            f"{script} takes the repo root as its install")
        self.assertEqual(_abs(core._INSTALL_DIR), _abs(root),
                         f"{script} must take the test install as its install")

    def assert_refuses_naming_the_test_install_file(self, script):
        config = surface(self, "TEST_INSTALL_CONFIG")
        core = self.core_of(script)
        core.bind_project_dir(None)
        with self.assertRaises(core.BoardUndeclared) as caught:
            core.resolve_base_url()
        self.assertEqual(caught.exception.chain,
                         [(_abs(config), core.BOARD_FILE_NO_URL)])
        self.assertIn(_shown(_abs(config)), caught.exception.detail)
        self.assertNotIn(str(REPO_ROOT) + os.sep + "crucible.toml", caught.exception.detail)

    def assert_refuses_for_an_empty_bound_project(self, script):
        config = surface(self, "TEST_INSTALL_CONFIG")
        core = self.core_of(script)
        project = tempfile.mkdtemp(prefix="test-install-empty-project-")
        self.addCleanup(os.rmdir, project)
        core.bind_project_dir(project)
        with self.assertRaises(core.BoardUndeclared) as caught:
            core.resolve_base_url()
        self.assertEqual(
            caught.exception.chain,
            [(os.path.join(project, "crucible.toml"), core.BOARD_FILE_ABSENT),
             (_abs(config), core.BOARD_FILE_NO_URL)])

    def test_the_python_client_takes_the_test_install(self):
        self.assert_takes_the_test_install("python-crucible.py")

    def test_the_bun_client_takes_the_test_install(self):
        self.assert_takes_the_test_install("bun-crucible.py")

    def test_the_mvn_client_takes_the_test_install(self):
        self.assert_takes_the_test_install("mvn-crucible.py")

    def test_the_rust_client_takes_the_test_install(self):
        self.assert_takes_the_test_install("rust-crucible.py")

    def test_the_go_client_takes_the_test_install(self):
        self.assert_takes_the_test_install("go-crucible.py")

    def test_the_arduino_client_takes_the_test_install(self):
        self.assert_takes_the_test_install("arduino-crucible.py")

    def test_every_client_with_no_project_bound_refuses_naming_the_test_install_file(self):
        for script in CLIENT_SCRIPTS:
            with self.subTest(client=script):
                self.assert_refuses_naming_the_test_install_file(script)

    def test_every_client_bound_to_an_empty_project_refuses_naming_both_files(self):
        for script in CLIENT_SCRIPTS:
            with self.subTest(client=script):
                self.assert_refuses_for_an_empty_bound_project(script)


class TheOrchestratorCliVendorsTheTestInstallCoreTest(unittest.TestCase):
    """`crucible_axi.cli` vendors the shared core from
    `manifest.source_clients_dir()`, which answers the checkout's client
    source in a checkout. A test that drives the CLI points the candidates at
    the test install's `clients`."""

    def vendored_core(self):
        clients = surface(self, "TEST_INSTALL_CLIENTS")
        with mock.patch.object(manifest, "_CLIENTS_CANDIDATES", (str(clients),)):
            self.assertEqual(manifest.source_clients_dir(), str(clients))
            return cli._load_client_module("_crucible_axi")

    def test_the_vendored_core_takes_the_test_install(self):
        root = surface(self, "TEST_INSTALL_DIR")
        core = self.vendored_core()
        self.assertNotEqual(_real(core._INSTALL_DIR), _real(REPO_ROOT))
        self.assertEqual(_abs(core._INSTALL_DIR), _abs(root))

    def test_the_vendored_core_with_no_project_refuses_naming_the_test_install_file(self):
        config = surface(self, "TEST_INSTALL_CONFIG")
        core = self.vendored_core()
        self.assertIsNone(core._PROJECT_DIR)
        with self.assertRaises(core.BoardUndeclared) as caught:
            core.resolve_base_url()
        self.assertEqual(caught.exception.chain,
                         [(_abs(config), core.BOARD_FILE_NO_URL)])


if __name__ == "__main__":
    unittest.main()
