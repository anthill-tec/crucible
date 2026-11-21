"""Every test that drives the orchestrator CLI binds the test install.

`crucible_axi.cli` vendors the shared client core through
`_load_client_module`, which resolves the clients directory through
`crucible_axi.manifest` (`_CLIENTS_CANDIDATES`, `source_clients_dir()`). In
a checkout that is the checkout's `clients/`, so a core the CLI loads takes the
REPO ROOT as its install and reads the operator's git-ignored root
`crucible.toml` (CR-CRU-260 AC10, "including the `_crucible_axi` the
orchestrator CLI vendors").

The guard is STATIC (UNIT: an AST scan of `tests/`, no import of the modules
it reads). A module DRIVES the CLI when it imports `crucible_axi.cli` --

- `from crucible_axi import cli [as x]`, `import crucible_axi.cli`,
  `from crucible_axi.cli import <name>`, or
- a call carrying the literal `"crucible_axi.cli"` (`importlib.import_module`,
  a fresh-import helper) whose result is bound to a name or a `self.` attribute

-- AND calls into it: a call through the bound module (`cli.main(...)`,
`self.cli._load_client_module(...)`, a name imported from `crucible_axi.cli`),
or a call handed the bound module itself (`_run_cli(cli, ...)`). Introspection
(`hasattr`, `getattr`, `isinstance`, `self.assert*`) is not a call into it.

A driving module BINDS the test install when, in its code:

- it calls the helper `install_clients_candidates` (`tests.client`), or
- it stores to `<x>._CLIENTS_CANDIDATES` or `<x>._INSTALL_DIR`, or
- it patches one of `_CLIENTS_CANDIDATES`, `_INSTALL_DIR` or
  `source_clients_dir` (`mock.patch.object(<x>, "<name>", ...)`,
  `mock.patch("<...>.<name>", ...)`, `setattr(<x>, "<name>", ...)`) -- each to a
  scratch install of the test's own (AC2's guard refuses a path built to the
  checkout's `clients/`); or
- the helper it imports the CLI through is IMPORTED from another test module
  whose definition of that helper binds (followed one level: the exporting
  module's definition decides).

Limits (stated, not hidden): the bind is checked module-wide, not per test
class; a module that reaches the CLI only through an inherited fixture
(`self.cli` set by a base class from another module) does not import it and is
the base module's to bind.
"""

import ast
import os
import unittest
from pathlib import Path

# Imported so the suite's isolation in tests/client/__init__.py applies even when a run
# imports this module top-level (the gate's discovery without -t).
import tests.client  # noqa: F401

TESTS_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = TESTS_DIR.parent

#: The dotted name of the orchestrator CLI module.
CLI_MODULE = "crucible_axi.cli"

#: The package the CLI module lives in, and the CLI's own name in it.
CLI_PACKAGE, _, CLI_NAME = CLI_MODULE.rpartition(".")

#: The helper that points `manifest._CLIENTS_CANDIDATES` at the test install.
BIND_HELPER = "install_clients_candidates"

#: The bindings a test may set to steer the vendored core to a scratch install.
BIND_ATTRIBUTES = frozenset({"_CLIENTS_CANDIDATES", "_INSTALL_DIR", "source_clients_dir"})

#: The bindings a STORE steers (`manifest._CLIENTS_CANDIDATES = ...`).
STORE_ATTRIBUTES = frozenset({"_CLIENTS_CANDIDATES", "_INSTALL_DIR"})

#: A call whose callee ends in one of these and names a bind attribute
#: patches it.
PATCHERS = frozenset({"object", "patch", "setattr"})

#: Calls that only look at the module.
INTROSPECTION = frozenset({"hasattr", "getattr", "isinstance", "id", "type", "repr",
                           "str", "print", "vars", "dir"})


def _callee(func):
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _is_self_attr(node):
    return (isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
            and node.value.id == "self")


def _str_args(call):
    return [arg.value for arg in call.args
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str)]


def binds_the_test_install(tree):
    """Whether the code under `tree` binds the vendored core to a test
    install: the helper called, a bind attribute stored, or one patched."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = _callee(node.func)
            if name == BIND_HELPER:
                return True
            if name in PATCHERS:
                for text in _str_args(node):
                    if text.rpartition(".")[2] in BIND_ATTRIBUTES:
                        return True
        targets = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            targets = [node.target]
        for target in targets:
            for part in ast.walk(target):
                if (isinstance(part, ast.Attribute) and isinstance(part.ctx, ast.Store)
                        and part.attr in STORE_ATTRIBUTES):
                    return True
    return False


def _resolve(importer, module, level, modules):
    """The relative path of the test module `from <module> import ...` names,
    seen from `importer`, or None when it is not one of `modules`."""
    parts = module.split(".") if module else []
    bases = []
    if level:
        base = Path(importer).parent
        for _ in range(level - 1):
            base = base.parent
        bases.append(base)
    else:
        bases.extend([Path("."), Path(importer).parent, Path("tests")])
    for base in bases:
        stem = base.joinpath(*parts) if parts else base
        for candidate in (stem.with_suffix(".py") if parts else None,
                          stem / "__init__.py"):
            if candidate is None:
                continue
            text = os.path.normpath(str(candidate))
            if text in modules:
                return text
    return None


class _CliDriving:
    """How one module reaches `crucible_axi.cli`."""

    def __init__(self, relative_path, tree, modules):
        self.path = relative_path
        self.tree = tree
        self.modules = modules
        self.names = set()        # local names bound to the CLI module
        self.attrs = set()        # `self.<attr>` bound to the CLI module
        self.functions = set()    # names imported FROM the CLI module
        self.through = set()      # helpers the CLI is imported through
        self.imported = {}        # local name -> (exporting module, its name)
        self._read_imports()
        self._read_import_calls()

    def _read_imports(self):
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == CLI_MODULE:
                        self.names.add(alias.asname or alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.level == 0 and node.module == CLI_PACKAGE:
                    for alias in node.names:
                        if alias.name == CLI_NAME:
                            self.names.add(alias.asname or alias.name)
                elif node.level == 0 and node.module == CLI_MODULE:
                    for alias in node.names:
                        self.functions.add(alias.asname or alias.name)
                else:
                    exporter = _resolve(self.path, node.module, node.level, self.modules)
                    if exporter is not None:
                        for alias in node.names:
                            self.imported[alias.asname or alias.name] = (exporter, alias.name)

    @staticmethod
    def _cli_position(call):
        positions = [index for index, arg in enumerate(call.args)
                     if isinstance(arg, ast.Constant) and arg.value == CLI_MODULE]
        return positions[0] if positions else None

    def _bind_target(self, target):
        if isinstance(target, ast.Name):
            self.names.add(target.id)
        elif _is_self_attr(target):
            self.attrs.add(target.attr)

    def _read_import_calls(self):
        for node in ast.walk(self.tree):
            if not isinstance(node, ast.Assign):
                continue
            value = node.value
            index = None
            if isinstance(value, ast.Subscript) and isinstance(value.slice, ast.Constant):
                index, value = value.slice.value, value.value
            if not isinstance(value, ast.Call):
                continue
            position = self._cli_position(value)
            if position is None:
                continue
            helper = _callee(value.func)
            if helper is not None:
                self.through.add(helper)
            for target in node.targets:
                if index is not None:
                    if index == position:
                        self._bind_target(target)
                elif isinstance(target, (ast.Tuple, ast.List)):
                    if position < len(target.elts):
                        self._bind_target(target.elts[position])
                else:
                    self._bind_target(target)

    def _is_cli(self, node):
        if isinstance(node, ast.Name):
            return node.id in self.names
        return _is_self_attr(node) and node.attr in self.attrs

    def _root(self, node):
        while isinstance(node, ast.Attribute):
            if self._is_cli(node):
                return node
            node = node.value
        return node

    def calls_into_it(self):
        for node in ast.walk(self.tree):
            if not isinstance(node, ast.Call):
                continue
            name = _callee(node.func)
            if name in INTROSPECTION or (name or "").startswith("assert"):
                continue
            if isinstance(node.func, ast.Name) and node.func.id in self.functions:
                return True
            if isinstance(node.func, ast.Attribute) and self._is_cli(self._root(node.func.value)):
                return True
            arguments = list(node.args) + [keyword.value for keyword in node.keywords]
            if any(self._is_cli(argument) for argument in arguments):
                return True
        return False

    def drives(self):
        bound = self.names or self.attrs or self.functions
        return bool(bound) and self.calls_into_it()

    def binds_through_an_imported_helper(self):
        for helper in self.through:
            if helper not in self.imported:
                continue
            exporter, exported = self.imported[helper]
            exporter_tree = self.modules[exporter]
            for node in exporter_tree.body:
                if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                        and node.name == exported and binds_the_test_install(node)):
                    return True
        return False


def unbound_cli_drivers(texts):
    """`(drivers, offenders)` for `texts` (relative path -> module source):
    every module that drives `crucible_axi.cli`, and the ones among them that
    never bind the vendored core to a test install, each sorted."""
    modules = {}
    for path, text in texts.items():
        modules[os.path.normpath(path)] = ast.parse(text, filename=path)
    drivers, offenders = [], []
    for path, tree in sorted(modules.items()):
        driving = _CliDriving(path, tree, modules)
        if not driving.drives():
            continue
        drivers.append(path)
        if binds_the_test_install(tree) or driving.binds_through_an_imported_helper():
            continue
        offenders.append(path)
    return drivers, offenders


def suite_cli_drivers():
    """`unbound_cli_drivers` over every python module under `tests/`."""
    texts = {}
    for path in sorted(TESTS_DIR.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        texts[str(path.relative_to(REPO_DIR))] = path.read_text(encoding="utf-8")
    drivers, offenders = unbound_cli_drivers(texts)
    return len(texts), drivers, offenders


# -- planted modules -----------------------------------------------------------

_HERE = "tests/client/test_planted_driver.py"
_EXPORTER = "tests/client/test_planted_exporter.py"

_FRESH_IMPORT_UNBOUND = (
    "import importlib\nimport sys\n"
    "def _import_fresh(*names):\n"
    "    for name in list(sys.modules):\n"
    "        if name.startswith('crucible_axi'):\n"
    "            del sys.modules[name]\n"
    "    return tuple(importlib.import_module(name) for name in names)\n")

_FRESH_IMPORT_BOUND = (
    "import importlib\nimport sys\n"
    "from tests.client import install_clients_candidates\n"
    "def _import_fresh(*names):\n"
    "    for name in list(sys.modules):\n"
    "        if name.startswith('crucible_axi'):\n"
    "            del sys.modules[name]\n"
    "    modules = tuple(importlib.import_module(name) for name in names)\n"
    "    manifest = importlib.import_module('crucible_axi.manifest')\n"
    "    manifest._CLIENTS_CANDIDATES = install_clients_candidates(manifest)\n"
    "    return modules\n")

#: Each drives the CLI and never binds the test install: each is flagged.
PLANTED_UNBOUND = {
    "the CLI imported from its package and its main called": {
        _HERE: "from crucible_axi import cli\n"
               "def test_install():\n"
               "    return cli.main(['install', '--target-dir', '/tmp/x'])\n",
    },
    "a fresh-import helper of its own, the CLI handed to a runner": {
        _HERE: _FRESH_IMPORT_UNBOUND
               + "def _run_cli(cli, argv):\n"
                 "    return cli.main(argv)\n"
                 "def test_install():\n"
                 "    install, cli = _import_fresh('crucible_axi.install', 'crucible_axi.cli')\n"
                 "    return _run_cli(cli, ['install'])\n",
    },
    "the CLI bound to a fixture attribute through import_module": {
        _HERE: "import importlib\nimport unittest\n"
               "class T(unittest.TestCase):\n"
               "    def setUp(self):\n"
               "        self.cli = importlib.import_module('crucible_axi.cli')\n"
               "    def test_serve(self):\n"
               "        self.cli.main(['serve'])\n",
    },
    "a fresh-import helper imported from a module whose helper binds nothing": {
        _EXPORTER: _FRESH_IMPORT_UNBOUND,
        _HERE: "from tests.client.test_planted_exporter import _import_fresh\n"
               "def test_uninstall():\n"
               "    cli = _import_fresh('crucible_axi.cli')[0]\n"
               "    return cli.main(['uninstall'])\n",
    },
    "a function imported from the CLI module and called": {
        _HERE: "from crucible_axi.cli import main\n"
               "def test_serve():\n"
               "    return main(['serve'])\n",
    },
    "the bind attributes only read, never set": {
        _HERE: "from crucible_axi import cli, manifest\n"
               "def test_install():\n"
               "    print(manifest._CLIENTS_CANDIDATES)\n"
               "    getattr(manifest, '_INSTALL_DIR', None)\n"
               "    return cli._load_client_module('_crucible_axi')\n",
    },
}

#: Each drives the CLI and binds the test install, or never drives it: none is
#: flagged.
PLANTED_BOUND = {
    "the candidates patched through the helper": {
        _HERE: "from unittest import mock\n"
               "from crucible_axi import cli, manifest\n"
               "from tests.client import install_clients_candidates\n"
               "def test_install():\n"
               "    with mock.patch.object(manifest, '_CLIENTS_CANDIDATES',\n"
               "                           install_clients_candidates(manifest)):\n"
               "        return cli.main(['install'])\n",
    },
    "a fresh-import helper of its own that stores the helper's candidates": {
        _HERE: _FRESH_IMPORT_BOUND
               + "def test_install():\n"
                 "    install, cli = _import_fresh('crucible_axi.install', 'crucible_axi.cli')\n"
                 "    return cli.main(['install'])\n",
    },
    "the vendored core's install dir patched to a scratch install": {
        _HERE: "import tempfile\nfrom unittest import mock\n"
               "from crucible_axi import cli\n"
               "def test_install():\n"
               "    core = cli._load_client_module('_crucible_axi')\n"
               "    with mock.patch.object(core, '_INSTALL_DIR', tempfile.mkdtemp()):\n"
               "        return cli.main(['install'])\n",
    },
    "the resolver patched to a scratch install's clients": {
        _HERE: "import tempfile\nfrom unittest import mock\n"
               "from crucible_axi import cli, manifest\n"
               "def test_loader():\n"
               "    with mock.patch.object(manifest, 'source_clients_dir',\n"
               "                           return_value=tempfile.mkdtemp()):\n"
               "        return cli._load_client_module('_crucible_axi')\n",
    },
    "a fresh-import helper imported from a module whose helper binds": {
        _EXPORTER: _FRESH_IMPORT_BOUND,
        _HERE: "from tests.client.test_planted_exporter import _import_fresh\n"
               "def test_uninstall():\n"
               "    cli = _import_fresh('crucible_axi.cli')[0]\n"
               "    return cli.main(['uninstall'])\n",
    },
    "the CLI imported only to be inspected": {
        _HERE: "import unittest\n"
               "from crucible_axi import cli\n"
               "class T(unittest.TestCase):\n"
               "    def test_no_private_resolver(self):\n"
               "        self.assertFalse(hasattr(cli, '_clients_dir'))\n",
    },
    "the CLI named only in comments, docstrings and patch targets": {
        _HERE: '"""Drives `crucible_axi.cli` through cli.main([\'install\'])."""\n'
               "from unittest import mock\n"
               "# from crucible_axi import cli; cli.main(['install'])\n"
               "def test_patch_target():\n"
               "    with mock.patch('crucible_axi.cli.subprocess.run'):\n"
               "        pass\n",
    },
}


class EveryTestDrivingTheOrchestratorCliBindsTheTestInstallTest(unittest.TestCase):

    def test_the_guard_flags_each_planted_unbound_driver(self):
        for shape, texts in PLANTED_UNBOUND.items():
            with self.subTest(shape=shape):
                drivers, offenders = unbound_cli_drivers(texts)
                self.assertEqual(drivers, [_HERE], f"{shape}: the drivers found")
                self.assertEqual(offenders, [_HERE], f"{shape}: the offenders found")

    def test_the_guard_passes_each_planted_bound_or_non_driving_module(self):
        for shape, texts in PLANTED_BOUND.items():
            with self.subTest(shape=shape):
                _drivers, offenders = unbound_cli_drivers(texts)
                self.assertEqual(offenders, [], shape)

    def test_the_guard_counts_a_bound_module_as_a_driver(self):
        texts = PLANTED_BOUND["the candidates patched through the helper"]
        drivers, offenders = unbound_cli_drivers(texts)
        self.assertEqual((drivers, offenders), ([_HERE], []))

    def test_the_scan_covers_the_suite_and_finds_its_cli_drivers(self):
        scanned, drivers, _offenders = suite_cli_drivers()
        self.assertTrue(150 <= scanned <= 2000,
                        f"the scan read {scanned} python modules under {TESTS_DIR}")
        self.assertTrue(10 <= len(drivers) <= 60,
                        f"the scan found {len(drivers)} modules driving {CLI_MODULE}: "
                        f"{drivers}")

    def test_every_test_module_driving_the_orchestrator_cli_binds_the_test_install(self):
        _scanned, _drivers, offenders = suite_cli_drivers()
        self.assertEqual(
            offenders, [],
            f"{len(offenders)} module(s) drive {CLI_MODULE} without pointing "
            f"`manifest._CLIENTS_CANDIDATES` at the test install (call "
            f"`tests.client.{BIND_HELPER}`) or patching `_INSTALL_DIR` / the "
            f"candidates to a scratch install; the core the CLI vendors then "
            f"takes the repo root as its install:\n" + "\n".join(offenders))


if __name__ == "__main__":
    unittest.main()
