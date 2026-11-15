"""A copied client is laid out as an install.

The core derives its install dir from its OWN location: the parent of the
directory it sits in (`_INSTALL_DIR`, clients/_crucible_axi.py). A copy laid
out flat in a scratch directory therefore takes that directory's PARENT as its
install, and reads whatever `crucible.toml` sits there -- under the system
temp dir, a file no test owns and any other process may plant. A copy under
`<install>/clients/` takes `<install>` instead, which the test owns.

Three things are pinned here:

- the danger itself, in process, against a parent this test plants;
- the census module's scratch copies, driven through the census classes' own
  setup with their temp parent pointed at a directory this test owns;
- a static guard over `tests/` (python and TypeScript): every copy of a
  client module lands under a directory named `clients`.

Every test here is unit: files written and modules loaded in process. No
process is spawned, no socket is opened, nothing waits on real time.
"""

import ast
import importlib.util
import itertools
import os
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client import test_client_fleet_envelope_census as census

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
TESTS_DIR = REPO_ROOT / "tests"
THIS_MODULE = Path(__file__).resolve()
CONFIG_NAME = "crucible.toml"
CLIENTS_DIRNAME = "clients"

#: The board a planted parent declares. Never contacted: every check here
#: resolves the address and stops.
PLANTED_BOARD = "http://127.0.0.1:1"
PLANTED_CONFIG = f'[client]\nurl = "{PLANTED_BOARD}"\n'

_COUNTER = itertools.count()


def _core_fleet():
    """The files the core loads by path from its own directory, plus the
    package data it reads beside itself: every `_crucible_*.py`, the TOON
    codec and the shipped `crucible.toml`."""
    return (sorted(CLIENTS_DIR.glob("_crucible_*.py"))
            + [CLIENTS_DIR / "toon.py", CLIENTS_DIR / CONFIG_NAME])


def _copy_core_into(directory):
    """Copy the core's fleet into `directory`; answer the copied core."""
    directory.mkdir(parents=True, exist_ok=True)
    for source in _core_fleet():
        shutil.copyfile(source, directory / source.name)
    return directory / "_crucible_axi.py"


def _load_core(path):
    """Load the core at `path` in process, under a name of its own, so no
    other test's copy is reused and nothing lands in `sys.modules`."""
    spec = importlib.util.spec_from_file_location(
        f"copied_client_core_{next(_COUNTER)}", str(path))
    assert spec is not None and spec.loader is not None, path
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _real(path):
    return os.path.realpath(str(path))


def _planted_parent(test):
    """A parent directory `test` owns, holding a `crucible.toml` that declares
    `PLANTED_BOARD`; removed when the test ends."""
    parent = Path(tempfile.mkdtemp(prefix="copied-client-parent-"))
    test.addCleanup(shutil.rmtree, parent, ignore_errors=True)
    (parent / CONFIG_NAME).write_text(PLANTED_CONFIG, encoding="utf-8")
    return parent


# ── the danger, pinned ──────────────────────────────────────────────────────


class ACopiedCoreTakesTheDirectoryAboveItsOwnAsItsInstallTest(unittest.TestCase):
    """Where a copy is laid out decides which `crucible.toml` it reads."""

    def setUp(self):
        self.parent = _planted_parent(self)

    def test_a_flat_copy_takes_the_parent_it_was_copied_into_and_reads_the_board_planted_there(self):
        core = _load_core(_copy_core_into(self.parent / "flat"))

        self.assertEqual(
            _real(self.parent), _real(core._INSTALL_DIR),
            "a core copied flat into <parent>/flat/ takes <parent> as its install")
        self.assertEqual(
            [_real(self.parent / CONFIG_NAME)],
            [_real(path) for path in core._project_config_candidates()],
            "with no project bound, the planted parent's file is the whole chain")
        self.assertEqual(
            PLANTED_BOARD, core.resolve_base_url(),
            "the flat copy reads the board a file it does not own declares")

    def test_a_copy_under_an_install_clients_directory_takes_that_install_and_never_reads_the_planted_parent(self):
        install = self.parent / "install"
        core = _load_core(_copy_core_into(install / CLIENTS_DIRNAME))

        self.assertEqual(
            _real(install), _real(core._INSTALL_DIR),
            "a core under <install>/clients/ takes <install> as its install")
        chain = [_real(path) for path in core._project_config_candidates()]
        self.assertEqual([_real(install / CONFIG_NAME)], chain)
        self.assertNotIn(_real(self.parent / CONFIG_NAME), chain)

        with self.assertRaises(core.BoardUndeclared) as refused:
            core.resolve_base_url()
        self.assertEqual(
            [(_real(install / CONFIG_NAME), core._BOARD.BOARD_FILE_ABSENT)],
            [(_real(path), reason) for path, reason in refused.exception.chain],
            "the refusal names the install's own absent file and nothing above it")
        self.assertNotIn(PLANTED_BOARD, refused.exception.detail)
        self.assertNotIn(str(self.parent / CONFIG_NAME), refused.exception.detail)


# ── the census module's scratch copies ──────────────────────────────────────


#: The census classes whose setup copies client modules into a scratch dir.
CENSUS_COPY_CLASSES = (
    census.SyntheticSourceEnvelopeDetectorProofTest,
    census.RealClientCopyEnvelopeDetectorProofTest,
)

#: The names a copy of a repo client module carries: every file of `clients/`
#: that is a module, and every reporter.
_REPO_CLIENT_MODULE_NAMES = frozenset(
    [p.name for p in CLIENTS_DIR.glob("*.py")]
    + [p.name for p in (CLIENTS_DIR / "reporters").iterdir() if p.is_file()])


def _drive_census_setup(test, census_class):
    """Run `census_class`'s own `setUpClass` with every temp dir it makes
    landing inside a planted parent `test` owns, and answer that parent.

    The seam is the standard library's: `tempfile.mkdtemp()` with no `dir`
    creates under `tempfile.gettempdir()`, which answers `tempfile.tempdir`
    once it is set. The setup runs on a throwaway subclass, so no attribute
    lands on the census class itself, and its own `tearDownClass` removes what
    it made. Its verb enumeration is replaced by a stub: it loads the
    CHECKOUT's python client, which is not what this test is about."""
    parent = _planted_parent(test)
    probe = type(f"{census_class.__name__}LaidOutProbe", (census_class,), {})
    with mock.patch.object(tempfile, "tempdir", str(parent)), \
            mock.patch.object(census, "enumerate_verbs", lambda *_a, **_k: {}):
        try:
            probe.setUpClass()
        finally:
            test.addCleanup(probe.tearDownClass)
    return parent


def _client_copies_under(root):
    """Every file under `root` named as a repo client module."""
    return sorted(p for p in Path(root).rglob("*")
                  if p.is_file() and p.name in _REPO_CLIENT_MODULE_NAMES)


def _lands_under_clients(path, root):
    """True when a directory named `clients`, inside `root`, holds `path`."""
    relative = Path(path).relative_to(root)
    return CLIENTS_DIRNAME in relative.parts[:-1]


class TheCensusScratchCopiesAreInstallsTest(unittest.TestCase):
    """The census's scratch copies, laid out by its own setup."""

    def test_the_census_real_client_copy_takes_its_scratch_install_never_the_planted_parent(self):
        parent = _drive_census_setup(self, census.RealClientCopyEnvelopeDetectorProofTest)
        cores = [p for p in _client_copies_under(parent) if p.name == "_crucible_axi.py"]
        self.assertEqual(
            1, len(cores),
            f"the census copies the core exactly once inside the parent it was "
            f"given: {[str(p) for p in cores]}")
        core = _load_core(cores[0])

        self.assertNotEqual(
            _real(parent), _real(core._INSTALL_DIR),
            f"the census copied the core flat, to {cores[0]}: its install is the "
            f"planted parent {parent}, so it reads a crucible.toml it does not own")
        self.assertTrue(
            _real(core._INSTALL_DIR).startswith(_real(parent) + os.sep),
            f"the copy's install {core._INSTALL_DIR} is a scratch dir inside {parent}")
        self.assertEqual(
            os.path.join(_real(core._INSTALL_DIR), CLIENTS_DIRNAME),
            _real(cores[0].parent),
            "the copied core sits at <install>/clients/")
        chain = [_real(path) for path in core._project_config_candidates()]
        self.assertNotIn(_real(parent / CONFIG_NAME), chain)
        try:
            board = core.resolve_base_url()
        except core.BoardUndeclared as refused:
            self.assertNotIn(str(parent / CONFIG_NAME), refused.detail)
        else:
            self.assertNotEqual(
                PLANTED_BOARD, board,
                "the copy answers the board its own install declares, never the planted one")

    def test_every_census_scratch_copy_lands_under_a_clients_directory(self):
        for census_class in CENSUS_COPY_CLASSES:
            with self.subTest(census=census_class.__name__):
                parent = _drive_census_setup(self, census_class)
                copies = _client_copies_under(parent)
                self.assertTrue(
                    {"toon.py"} <= {p.name for p in copies},
                    f"the census setup copies the TOON codec at least: {copies}")
                flat = [str(p) for p in copies if not _lands_under_clients(p, parent)]
                self.assertEqual(
                    [], flat,
                    "each census copy of a client module lands under a "
                    "directory named `clients`; these are laid out flat")


# ── the static guard ────────────────────────────────────────────────────────


#: A client module's file name: the core and its siblings, a stack client, the
#: TOON codec, the subtest runner, a reporter.
_CLIENT_MODULE_FILE = re.compile(
    r"^(?:_crucible_\w+\.py|[a-z0-9_]+(?:-[a-z0-9_]+)*-crucible\.(?:py|ts)"
    r"|toon\.py|subtest_runner\.py)$")

#: What a path expression is known to name.
MODULE = "client module"
CLIENTS = "clients directory"
CONTENT = "client module content"
OTHER = "something else"


def _components(text):
    return [part for part in re.split(r"[\\/]", text) if part]


def _literal_kinds(text):
    parts = _components(text)
    if not parts:
        return {OTHER}
    if _CLIENT_MODULE_FILE.match(parts[-1]):
        return {MODULE}
    if parts[-1] == CLIENTS_DIRNAME:
        return {CLIENTS}
    return {OTHER}


def _literal_under_clients(text):
    return CLIENTS_DIRNAME in _components(text)


_PY_FILE_COPIES = frozenset({"copy", "copy2", "copyfile", "copytree"})
_PY_PASSTHROUGH_CALLS = frozenset({
    "str", "fspath", "abspath", "realpath", "normpath", "expanduser", "Path",
    "PurePath", "PosixPath", "resolve", "absolute"})
_PY_CONTAINER_CALLS = frozenset({
    "sorted", "list", "tuple", "set", "frozenset", "dict", "iter", "reversed",
    "enumerate", "items", "values", "keys"})
_PY_BASENAME_ATTRS = frozenset({"name", "stem", "suffix"})


def _callee(func):
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


class _PythonCopyScanner:
    """Resolves what a path expression in one python module names, through
    the module's own assignments (and, for a bare name the module never
    binds, the module-level assignments of the other test modules)."""

    def __init__(self, tree, fallback):
        self.tree = tree
        self.fallback = fallback
        self.assigned = {}
        # What each bound name resolves to, once: a name is reached along
        # many paths, and walking each again is exponential in a long module.
        self._kinds_of = {}
        self._under_of = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    self._bind(target, node.value)
            elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)) and node.value is not None:
                self._bind(node.target, node.value)
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                self._bind(node.target, node.iter)
            elif isinstance(node, ast.withitem) and node.optional_vars is not None:
                self._bind(node.optional_vars, node.context_expr)

    def _bind(self, target, value):
        if isinstance(target, (ast.Tuple, ast.List)):
            paired = (isinstance(value, (ast.Tuple, ast.List))
                      and len(value.elts) == len(target.elts))
            for index, element in enumerate(target.elts):
                self._bind(element, value.elts[index] if paired else value)
            return
        if isinstance(target, ast.Starred):
            self._bind(target.value, value)
            return
        self.assigned.setdefault(ast.unparse(target), []).append(value)
        if isinstance(target, ast.Subscript):
            # An element stored into a container is one of its values.
            self.assigned.setdefault(ast.unparse(target.value), []).append(value)

    def _values(self, node):
        key = ast.unparse(node)
        values = self.assigned.get(key)
        if values is None and isinstance(node, ast.Name):
            values = self.fallback.get(node.id)
        return key, values

    def kinds(self, node, seen=frozenset()):
        if isinstance(node, ast.Constant):
            return _literal_kinds(node.value) if isinstance(node.value, str) else {OTHER}
        if isinstance(node, ast.JoinedStr):
            text = "".join(str(v.value) if isinstance(v, ast.Constant) else "x"
                           for v in node.values)
            found = _literal_kinds(text)
            if any(CONTENT in self.kinds(v.value, seen)
                   for v in node.values if isinstance(v, ast.FormattedValue)):
                found = found | {CONTENT}
            return found
        if isinstance(node, (ast.Name, ast.Attribute, ast.Subscript)):
            key, values = self._values(node)
            if values:
                if key not in self._kinds_of:
                    self._kinds_of[key] = set()  # a cycle resolves to nothing
                    found = set()
                    for value in values:
                        found |= self.kinds(value, seen)
                    self._kinds_of[key] = found
                return self._kinds_of[key]
            if isinstance(node, ast.Attribute):
                base = self.kinds(node.value, seen)
                if node.attr == "parent":
                    return {CLIENTS} if MODULE in base else set()
                return base
            if isinstance(node, ast.Subscript):
                return self.kinds(node.value, seen)
            return set()
        if isinstance(node, ast.BinOp):
            left, right = self.kinds(node.left, seen), self.kinds(node.right, seen)
            if CONTENT in left | right:
                return {CONTENT}
            if not isinstance(node.op, ast.Div):
                return {OTHER}
            return self._joined(left, right)
        if isinstance(node, ast.Call):
            return self._call_kinds(node, seen)
        if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
            found = set()
            for element in node.elts:
                found |= self.kinds(element, seen)
            return found
        if isinstance(node, ast.Dict):
            found = set()
            for value in node.values:
                found |= self.kinds(value, seen)
            return found
        if isinstance(node, (ast.GeneratorExp, ast.ListComp, ast.SetComp)):
            return self.kinds(node.elt, seen)
        if isinstance(node, ast.IfExp):
            return self.kinds(node.body, seen) | self.kinds(node.orelse, seen)
        if isinstance(node, ast.Starred):
            return self.kinds(node.value, seen)
        return set()

    @staticmethod
    def _joined(base, entry):
        """What `<base>/<entry>` names."""
        if MODULE in entry:
            return {MODULE}
        if CLIENTS in entry:
            return {CLIENTS}
        if entry:
            return {OTHER}
        # An entry nothing resolves, inside a clients directory.
        return {MODULE} if CLIENTS in base else set()

    def _call_kinds(self, node, seen):
        name = _callee(node.func)
        receiver = node.func.value if isinstance(node.func, ast.Attribute) else None
        args = list(node.args)
        if name in ("read_text", "read_bytes") and receiver is not None:
            return {CONTENT} if MODULE in self.kinds(receiver, seen) else set()
        if name == "join" and ast.unparse(node.func) == "os.path.join" or (
                name in ("Path", "PurePath", "PosixPath") and len(args) > 1):
            found = self.kinds(args[0], seen) if args else set()
            for arg in args[1:]:
                found = self._joined(found, self.kinds(arg, seen))
            return found
        if name in _PY_PASSTHROUGH_CALLS:
            if args:
                return self.kinds(args[0], seen)
            return self.kinds(receiver, seen) if receiver is not None else set()
        if name in ("glob", "rglob", "iterdir") and receiver is not None:
            return {MODULE} if CLIENTS in self.kinds(receiver, seen) else set()
        if name == "listdir" and args:
            return {MODULE} if CLIENTS in self.kinds(args[0], seen) else set()
        if name in _PY_CONTAINER_CALLS:
            found = set()
            for arg in args + ([receiver] if receiver is not None else []):
                found |= self.kinds(arg, seen)
            return found
        if name.endswith("clients_dir"):
            # An accessor the module cannot see into, named for what it answers
            # (`source_clients_dir()`).
            return {CLIENTS}
        parts = args + [kw.value for kw in node.keywords] + (
            [receiver] if receiver is not None else [])
        if any(CONTENT in self.kinds(part, seen) for part in parts):
            return {CONTENT}
        return set()

    def under_clients(self, node, seen=frozenset()):
        if isinstance(node, ast.Constant):
            return isinstance(node.value, str) and _literal_under_clients(node.value)
        if isinstance(node, ast.JoinedStr):
            return any(isinstance(v, ast.Constant) and _literal_under_clients(v.value)
                       for v in node.values)
        if isinstance(node, (ast.Name, ast.Attribute, ast.Subscript)):
            key, values = self._values(node)
            if values:
                if key not in self._under_of:
                    self._under_of[key] = False  # a cycle lands nowhere
                    self._under_of[key] = any(
                        self.under_clients(v, seen) for v in values)
                return self._under_of[key]
            if isinstance(node, ast.Attribute):
                if node.attr in _PY_BASENAME_ATTRS:
                    return False
                return self.under_clients(node.value, seen)
            if isinstance(node, ast.Subscript):
                return self.under_clients(node.value, seen)
            return False
        if isinstance(node, ast.BinOp):
            return self.under_clients(node.left, seen) or self.under_clients(node.right, seen)
        if isinstance(node, ast.Call):
            name = _callee(node.func)
            if name in ("basename",):
                return False
            if name.endswith("clients_dir"):
                return True
            parts = list(node.args) + [kw.value for kw in node.keywords]
            if isinstance(node.func, ast.Attribute):
                parts.append(node.func.value)
            return any(self.under_clients(part, seen) for part in parts)
        if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
            return any(self.under_clients(e, seen) for e in node.elts)
        return False

    def copies(self):
        """Every `(node, source, destination)` that copies or links a file."""
        for node in ast.walk(self.tree):
            if not isinstance(node, ast.Call):
                continue
            name = _callee(node.func)
            args = node.args
            # `copy(src, dst)`, `symlink(src, dst)`: the source comes first.
            if (name in _PY_FILE_COPIES or name == "symlink") and len(args) >= 2:
                yield node, args[0], args[1]
            # `dst.symlink_to(src)`, `dst.write_text(content)`: the receiver
            # is where it lands.
            elif (name in ("symlink_to", "hardlink_to", "write_text", "write_bytes")
                  and isinstance(node.func, ast.Attribute) and args):
                yield node, args[0], node.func.value

    def offenders(self):
        found = []
        for node, source, destination in self.copies():
            name = _callee(node.func)
            if name in ("write_text", "write_bytes"):
                copies_a_client = CONTENT in self.kinds(source)
            else:
                copies_a_client = bool({MODULE, CLIENTS} & self.kinds(source))
            if copies_a_client and not self.under_clients(destination):
                found.append((node.lineno, ast.unparse(node)))
        return found


def python_copy_offenders(text, fallback=None):
    """`(line, call)` for every copy of a client module in python `text`
    that does not land under a directory named `clients`."""
    return _PythonCopyScanner(ast.parse(text), fallback or {}).offenders()


_TS_COPY_CALL = re.compile(
    r"\b(copyFileSync|cpSync|copyFile|symlinkSync|writeFileSync|Bun\.write)\s*\(")
_TS_READ_CALL = re.compile(r"\b(?:readFileSync|Bun\.file)\s*\(")
_TS_BINDING = re.compile(
    r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(.+?);?\s*$",
    re.M)
_TS_TOKEN = re.compile(
    r"\"((?:[^\"\\]|\\.)*)\"|'((?:[^'\\]|\\.)*)'|`([^`]*)`|([A-Za-z_$][\w$]*)")


def _ts_arguments(text, open_paren):
    """The top-level argument texts of the call whose `(` is at
    `open_paren`, and the offset just past its `)`."""
    depth, quote, start, args = 0, None, open_paren + 1, []
    index = open_paren
    while index < len(text):
        char = text[index]
        if quote:
            if char == "\\":
                index += 1
            elif char == quote:
                quote = None
        elif char in "\"'`":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
            if depth == 0:
                args.append(text[start:index].strip())
                return [a for a in args if a], index + 1
        elif char == "," and depth == 1:
            args.append(text[start:index].strip())
            start = index + 1
        index += 1
    return [], len(text)


def _ts_literals(expression, bindings, seen=frozenset()):
    """The string literals `expression` spells, in order, each identifier
    expanded through the file's own `const`/`let`/`var` bindings."""
    literals = []
    for match in _TS_TOKEN.finditer(expression):
        literal = next((g for g in match.groups()[:3] if g is not None), None)
        if literal is not None:
            literals.append(literal)
            continue
        name = match.group(4)
        if name in bindings and name not in seen:
            literals.extend(_ts_literals(bindings[name], bindings, seen | {name}))
    return literals


def _ts_names_a_client(expression, bindings):
    literals = _ts_literals(expression, bindings)
    if any(_CLIENT_MODULE_FILE.match(_components(lit)[-1])
           for lit in literals if _components(lit)):
        return True
    last = _components(literals[-1]) if literals else []
    return bool(last) and last[-1] == CLIENTS_DIRNAME


def typescript_copy_offenders(text):
    """`(line, call)` for every copy of a client module in TypeScript `text`
    that does not land under a directory named `clients`."""
    bindings = {}
    for match in _TS_BINDING.finditer(text):
        bindings.setdefault(match.group(1), match.group(2))
    found = []
    for match in _TS_COPY_CALL.finditer(text):
        args, end = _ts_arguments(text, match.end() - 1)
        if len(args) < 2:
            continue
        if match.group(1) in ("writeFileSync", "Bun.write"):
            read = _TS_READ_CALL.search(args[1])
            if read is None:
                continue
            inner, _ = _ts_arguments(args[1], read.end() - 1)
            if not inner:
                continue
            source, destination = inner[0], args[0]
        else:
            source, destination = args[0], args[1]
        if not _ts_names_a_client(source, bindings):
            continue
        if any(_literal_under_clients(lit) for lit in _ts_literals(destination, bindings)):
            continue
        line = text.count("\n", 0, match.start()) + 1
        found.append((line, " ".join(text[match.start():end].split())))
    return found


def _scanned(suffix):
    """Every file under `tests/` ending in `suffix`, never descending into a
    `node_modules`, and never this module."""
    found = []
    for directory, subdirs, files in os.walk(TESTS_DIR):
        subdirs[:] = sorted(d for d in subdirs if d != "node_modules")
        for name in files:
            path = Path(directory, name)
            if name.endswith(suffix) and path.resolve() != THIS_MODULE:
                found.append(path)
    return sorted(found)


def _module_level_bindings(trees):
    """Every name a test module binds at its top level, across the suite: what
    a module that imports the name resolves it to."""
    bindings = {}
    for tree in trees:
        for node in tree.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        bindings.setdefault(target.id, []).append(node.value)
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) \
                    and node.value is not None:
                bindings.setdefault(node.target.id, []).append(node.value)
    return bindings


def flat_copies_in_the_suite():
    """Every copy of a client module under `tests/` that does not land under a
    directory named `clients`, as `<path> (line N): <call>`.

    This module is not scanned: it plants a flat copy on purpose, to pin what
    a flat copy reads, and spells the guard's own planted offenders."""
    python = {path: ast.parse(path.read_text(encoding="utf-8"), str(path))
              for path in _scanned(".py")}
    fallback = _module_level_bindings(python.values())
    offenders = []
    for path, tree in python.items():
        for line, call in _PythonCopyScanner(tree, fallback).offenders():
            offenders.append(f"{path.relative_to(REPO_ROOT)} (line {line}): {call}")
    for path in _scanned(".ts"):
        for line, call in typescript_copy_offenders(path.read_text(encoding="utf-8")):
            offenders.append(f"{path.relative_to(REPO_ROOT)} (line {line}): {call}")
    return offenders


_PY_PREAMBLE = '''\
import os
import shutil
import tempfile
from pathlib import Path
from shutil import copyfile

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
TOON_PATH = CLIENTS_DIR / "toon.py"
CLIENT_FILES = {"python": CLIENTS_DIR / "python-crucible.py"}
_FLEET = (CLIENTS_DIR / "_crucible_axi.py", CLIENTS_DIR / "_crucible_run.py")
REPORTER = CLIENTS_DIR / "reporters" / "vitest-crucible.ts"
scratch = Path(tempfile.mkdtemp(prefix="scratch-"))
install = Path(tempfile.mkdtemp(prefix="install-"))
fleet = install / "clients"
'''

#: One planted python copy per idiom the suite spells: the copy laid out flat,
#: then the same copy under `<install>/clients/`.
PYTHON_IDIOMS = {
    "shutil.copy of the core": (
        'shutil.copy(CLIENTS_DIR / "_crucible_axi.py", scratch / "_crucible_axi.py")',
        'shutil.copy(CLIENTS_DIR / "_crucible_axi.py", fleet / "_crucible_axi.py")'),
    "shutil.copy2 of the codec into a directory": (
        "shutil.copy2(TOON_PATH, scratch)",
        "shutil.copy2(TOON_PATH, fleet)"),
    "copyfile over a fleet tuple, by name": (
        "for source in _FLEET:\n"
        "    shutil.copyfile(source, os.path.join(scratch, source.name))",
        "for source in _FLEET:\n"
        "    shutil.copyfile(source, os.path.join(fleet, source.name))"),
    "copyfile imported bare, of a reporter": (
        'copyfile(REPORTER, Path(scratch, "reporters") / REPORTER.name)',
        'copyfile(REPORTER, Path(fleet, "reporters") / REPORTER.name)'),
    "copytree of the whole clients directory": (
        'shutil.copytree(CLIENTS_DIR, os.path.join(scratch, "packaged"))',
        'shutil.copytree(CLIENTS_DIR, os.path.join(install, "clients"))'),
    "write_bytes of a client's bytes": (
        '(scratch / "python-crucible.py").write_bytes(CLIENT_FILES["python"].read_bytes())',
        '(fleet / "python-crucible.py").write_bytes(CLIENT_FILES["python"].read_bytes())'),
    "write_text of a client's patched source": (
        'original = CLIENT_FILES["python"].read_text()\n'
        'patched = original.replace("def main():", "def main():", 1)\n'
        'script = scratch / "scratch-python-crucible.py"\n'
        "script.write_text(patched)",
        'original = CLIENT_FILES["python"].read_text()\n'
        'patched = original.replace("def main():", "def main():", 1)\n'
        'script = fleet / "scratch-python-crucible.py"\n'
        "script.write_text(patched)"),
    "os.symlink of the core": (
        'os.symlink(CLIENTS_DIR / "_crucible_axi.py", scratch / "_crucible_axi.py")',
        'os.symlink(CLIENTS_DIR / "_crucible_axi.py", fleet / "_crucible_axi.py")'),
}

_TS_PREAMBLE = '''\
import * as fs from "node:fs";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const CLIENTS = join(REPO_ROOT, "clients");
const REPORTER = join(CLIENTS, "reporters", "vitest-crucible.ts");
const scratch = mkdtempSync("/tmp/scratch-");
const install = mkdtempSync("/tmp/install-");
const fleet = join(install, "clients");
'''

#: One planted TypeScript copy per idiom, flat then under `<install>/clients/`.
TYPESCRIPT_IDIOMS = {
    "copyFileSync of the core": (
        'copyFileSync(join(CLIENTS, "_crucible_axi.py"), join(scratch, "_crucible_axi.py"));',
        'copyFileSync(join(CLIENTS, "_crucible_axi.py"), join(fleet, "_crucible_axi.py"));'),
    "fs.copyFileSync of a stack client": (
        'fs.copyFileSync(join(REPO_ROOT, "clients", "bun-crucible.py"), join(scratch, "bun-crucible.py"));',
        'fs.copyFileSync(join(REPO_ROOT, "clients", "bun-crucible.py"), join(fleet, "bun-crucible.py"));'),
    "cpSync of the whole clients directory": (
        'cpSync(CLIENTS, join(scratch, "fleet"), { recursive: true });',
        'cpSync(CLIENTS, join(install, "clients"), { recursive: true });'),
    "copyFile of a reporter": (
        'await copyFile(REPORTER, join(scratch, "vitest-crucible.ts"));',
        'await copyFile(REPORTER, join(fleet, "reporters", "vitest-crucible.ts"));'),
    "writeFileSync of a client's bytes": (
        'writeFileSync(join(scratch, "toon.py"), readFileSync(join(CLIENTS, "toon.py")));',
        'writeFileSync(join(fleet, "toon.py"), readFileSync(join(CLIENTS, "toon.py")));'),
    "symlinkSync of the core": (
        'symlinkSync(join(CLIENTS, "_crucible_axi.py"), join(scratch, "_crucible_axi.py"));',
        'symlinkSync(join(CLIENTS, "_crucible_axi.py"), join(fleet, "_crucible_axi.py"));'),
}


class NoTestCopiesAClientModuleFlatTest(unittest.TestCase):
    """A static guard over `tests/`: every copy of a client module lands
    under a directory named `clients`."""

    def _planted_python(self, body):
        text = _PY_PREAMBLE + body + "\n"
        return text, _PY_PREAMBLE.count("\n") + 1

    def _planted_typescript(self, body):
        text = _TS_PREAMBLE + body + "\n"
        return text, _TS_PREAMBLE.count("\n") + 1

    def test_the_guard_flags_a_flat_python_copy_in_each_idiom(self):
        for idiom, (flat, _installed) in PYTHON_IDIOMS.items():
            with self.subTest(idiom=idiom):
                text, first_line = self._planted_python(flat)
                offenders = python_copy_offenders(text)
                self.assertEqual(1, len(offenders),
                                 f"exactly the planted flat copy is flagged: {offenders}")
                line, _call = offenders[0]
                self.assertEqual(first_line + flat.count("\n"), line,
                                 f"the offender is the copy's own line: {offenders}")

    def test_the_guard_passes_a_python_copy_under_an_install_clients_directory(self):
        for idiom, (_flat, installed) in PYTHON_IDIOMS.items():
            with self.subTest(idiom=idiom):
                text, _ = self._planted_python(installed)
                self.assertEqual([], python_copy_offenders(text))

    def test_the_guard_ignores_a_flat_python_copy_of_what_is_not_a_client_module(self):
        for body in (
                'shutil.copyfile(CLIENTS_DIR / "crucible.toml", scratch / "crucible.toml")',
                'shutil.copyfile(TOON_PATH.parent / "crucible.toml", scratch / "crucible.toml")',
                'shutil.copytree(REPO_ROOT / "tests" / "fixtures", scratch / "project")',
                'shutil.copy(scratch / "TEST-a.xml", install)'):
            with self.subTest(body=body):
                text, _ = self._planted_python(body)
                self.assertEqual([], python_copy_offenders(text))

    def test_the_guard_flags_a_flat_typescript_copy_in_each_idiom(self):
        for idiom, (flat, _installed) in TYPESCRIPT_IDIOMS.items():
            with self.subTest(idiom=idiom):
                text, first_line = self._planted_typescript(flat)
                offenders = typescript_copy_offenders(text)
                self.assertEqual(1, len(offenders),
                                 f"exactly the planted flat copy is flagged: {offenders}")
                self.assertEqual(first_line, offenders[0][0],
                                 f"the offender is the copy's own line: {offenders}")

    def test_the_guard_passes_a_typescript_copy_under_an_install_clients_directory(self):
        for idiom, (_flat, installed) in TYPESCRIPT_IDIOMS.items():
            with self.subTest(idiom=idiom):
                text, _ = self._planted_typescript(installed)
                self.assertEqual([], typescript_copy_offenders(text))

    def test_the_guard_ignores_a_flat_typescript_copy_of_what_is_not_a_client_module(self):
        for body in (
                'copyFileSync(join(CLIENTS, "crucible.toml"), join(scratch, "crucible.toml"));',
                'cpSync(join(REPO_ROOT, "src"), join(scratch, "src"), { recursive: true });',
                'writeFileSync(join(scratch, "x.db"), readFileSync(join(REPO_ROOT, "data", "x.db")));'):
            with self.subTest(body=body):
                text, _ = self._planted_typescript(body)
                self.assertEqual([], typescript_copy_offenders(text))

    def test_no_test_copies_a_client_module_anywhere_but_under_a_clients_directory(self):
        offenders = flat_copies_in_the_suite()
        self.assertEqual(
            [], offenders,
            "every copy of a client module lands under `<install>/clients/` "
            "inside a parent the test owns; these copies are laid out flat:\n"
            + "\n".join(offenders))


if __name__ == "__main__":
    unittest.main()
