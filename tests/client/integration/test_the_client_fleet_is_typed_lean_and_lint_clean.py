"""The client fleet's shared modules are typed, lean and lint-clean, and no
installer test declares a port in the shipped window.

Four rules, each pinned by a test that reads the tree or runs the project's own
linter (always as `python -m ruff` from this interpreter, never a ruff found on
PATH):

  * **the run module's late-bound core is typed.** `clients/_crucible_run.py`
    declares its `_core` slot with a type a checker can resolve the core's
    names through (`Any`, or the core's module type under `TYPE_CHECKING`),
    never `None` alone. The slot is still bound to `None` until the core binds
    it, and once the core loads it is a live view of the core's namespace. The
    declaration is read with `ast`, never by importing the module; a type
    checker cannot run inside the suite;
  * **the manifest stage stays under the complexity ceiling.** Ruff's McCabe
    check (`C901`, `max-complexity` 10) reports nothing for
    `run_manifest_stage` in `crucible_axi/manifest.py`;
  * **no installer test declares a port in the shipped window.** Every test
    helper that writes a server template (it reads or copies the shipped
    `src/crucible.toml` into a scratch install) rewrites `port`,
    `port_range_min` and `port_range_max`, and nothing it can reach declares a
    value in 3800-3899, the window the boards of a development workstation
    listen in. The helpers are found by reading the syntax trees of `tests/`,
    so the guard runs no install and binds no socket; the reader is proved on
    synthetic sources before it is pointed at the real tree;
  * **ruff passes on the project's own rule set.** `pyproject.toml` pins
    `[tool.ruff.lint] select = ["E4", "E7", "E9", "F"]` and names `ruff` in its
    `dev` dependency group, and `ruff check clients crucible_axi tests`, run
    from the repo root with no other configuration, finds nothing.

Invocation:
    python3 clients/python-crucible.py test \\
        --tests tests.client.integration.test_the_client_fleet_is_typed_lean_and_lint_clean
"""

import ast
import json
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import tomllib
import unittest
from pathlib import Path
from typing import Any, NamedTuple
from unittest import mock

from tests.client.live_run_harness import load_client
from tests.client import CLIENT_SOURCE_DIR

REPO_ROOT = Path(__file__).resolve().parents[3]
TESTS_DIR = REPO_ROOT / "tests"
RUN_MODULE = CLIENT_SOURCE_DIR / "_crucible_run.py"
MANIFEST_MODULE = REPO_ROOT / "crucible_axi" / "manifest.py"
PYPROJECT = REPO_ROOT / "pyproject.toml"

#: The run module's slot for the core it is bound to.
CORE_SLOT = "_core"

#: The manifest stage the complexity ceiling is pinned on, and the ceiling.
MANIFEST_STAGE = "run_manifest_stage"
MAX_COMPLEXITY = 10

#: The rule set the project pins: ruff's classic default set.
PROJECT_RULE_SET = ["E4", "E7", "E9", "F"]

#: What the project's own linter is run over.
LINTED_TREES = ("clients", "crucible_axi", "tests")


def _top_level_dir(top_level_name):
    """A top-level tree of the checkout; its client source through the one
    constant the suite reads it by."""
    if top_level_name == "clients":
        return CLIENT_SOURCE_DIR
    return REPO_ROOT / top_level_name

#: The shipped port window: a development workstation's boards listen in it.
WINDOW_LOW = 3800
WINDOW_HIGH = 3899

#: The three server-table keys a template-writing helper must rewrite.
LISTENER_KEYS = ("port", "port_range_min", "port_range_max")

#: Ruff runs at most this long.
RUFF_TIMEOUT_SECONDS = 180

#: How many findings a failure message lists before it summarises.
FINDINGS_SHOWN = 25


# ── running the project's own ruff ─────────────────────────────────────────

def run_ruff(*args, cwd=REPO_ROOT):
    """`python -m ruff check --no-cache --output-format json <args>` from this
    interpreter, so the ruff the project's environment installs is the one
    that runs. Returns the completed process."""
    return subprocess.run(
        [sys.executable, "-m", "ruff", "check", "--no-cache",
         "--output-format", "json", *args],
        cwd=cwd, capture_output=True, text=True,
        timeout=RUFF_TIMEOUT_SECONDS, check=False)


def ruff_findings(test, completed):
    """The findings of one ruff run, after asserting ruff itself ran: exit 0
    (nothing found) or 1 (something found), and a JSON list on stdout. Exit 2
    is ruff refusing its own invocation, which is never a pass."""
    test.assertIn(
        completed.returncode, (0, 1),
        f"ruff must RUN (exit 0 or 1); exit {completed.returncode} means it "
        "refused the invocation or is not installed in this interpreter's "
        f"environment.\nstdout: {completed.stdout[:2000]}\n"
        f"stderr: {completed.stderr[:2000]}")
    findings = None
    try:
        findings = json.loads(completed.stdout or "[]")
    except json.JSONDecodeError as error:
        test.fail(f"ruff's JSON output does not parse ({error}): "
                  f"{completed.stdout[:2000]!r}")
    test.assertIsInstance(findings, list, "ruff's JSON output is a list")
    return findings if isinstance(findings, list) else []


def describe_findings(findings):
    """A failure message's account of `findings`: the count, then the first
    `FINDINGS_SHOWN`, each as `<file> <code> <message>`."""
    lines = [f"{len(findings)} finding(s)"]
    for finding in findings[:FINDINGS_SHOWN]:
        name = Path(finding.get("filename") or "?")
        if name.is_relative_to(REPO_ROOT):
            name = name.relative_to(REPO_ROOT)
        lines.append(f"  {name} {finding.get('code')} {finding.get('message')}")
    if len(findings) > FINDINGS_SHOWN:
        lines.append(f"  ... and {len(findings) - FINDINGS_SHOWN} more")
    return "\n".join(lines)


def _source(path):
    return Path(path).read_text(encoding="utf-8")


# ── the core slot's declaration, read off the syntax tree ───────────────────

def _is_type_checking_guard(test):
    """`test` is `TYPE_CHECKING` or `typing.TYPE_CHECKING`."""
    if isinstance(test, ast.Name):
        return test.id == "TYPE_CHECKING"
    return isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING"


def _targets(node):
    if isinstance(node, ast.Assign):
        return [target.id for target in node.targets
                if isinstance(target, ast.Name)]
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        return [node.target.id]
    return []


def core_slot_declarations(source, slot=CORE_SLOT):
    """The slot's module-level annotations and runtime bindings in `source`.

    Returns `(annotations, bindings)`: each annotation expression the module
    declares for `slot`, at its top level or inside a top-level
    `if TYPE_CHECKING:` block, and each value expression it binds `slot` to at
    its top level outside such a block."""
    annotations, bindings = [], []
    for node in ast.parse(source).body:
        if isinstance(node, ast.If) and _is_type_checking_guard(node.test):
            for inner in node.body:
                if isinstance(inner, ast.AnnAssign) and slot in _targets(inner):
                    annotations.append(inner.annotation)
            continue
        if slot not in _targets(node):
            continue
        if isinstance(node, ast.AnnAssign):
            annotations.append(node.annotation)
            if node.value is not None:
                bindings.append(node.value)
        elif isinstance(node, ast.Assign):
            bindings.append(node.value)
    return annotations, bindings


def _annotation_expression(annotation):
    """A string annotation (`"Any"`) parsed to the expression it names."""
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        return ast.parse(annotation.value, mode="eval").body
    return annotation


def resolves_no_names(annotation):
    """`annotation` is a type no attribute can be resolved through: `None`
    alone, or `object`."""
    expression = _annotation_expression(annotation)
    if isinstance(expression, ast.Constant) and expression.value is None:
        return True
    return isinstance(expression, ast.Name) and expression.id in ("None", "object")


def is_none(expression):
    return isinstance(expression, ast.Constant) and expression.value is None


class TheRunModulesLateBoundCoreIsTypedTest(unittest.TestCase):
    """The run module's `_core` slot is declared with a type a checker can
    resolve the core's names through, and it is still bound late."""

    def test_the_declaration_reader_accepts_a_resolvable_type_and_refuses_none_alone(self):
        typed = core_slot_declarations("from typing import Any\n_core: Any = None\n")
        self.assertEqual(len(typed[0]), 1)
        self.assertFalse(resolves_no_names(typed[0][0]))
        self.assertEqual(len(typed[1]), 1)
        self.assertTrue(is_none(typed[1][0]))

        guarded = core_slot_declarations(textwrap.dedent("""\
            from typing import TYPE_CHECKING
            if TYPE_CHECKING:
                import types
                _core: types.ModuleType
            _core = None
            """))
        self.assertEqual(len(guarded[0]), 1)
        self.assertFalse(resolves_no_names(guarded[0][0]))
        self.assertEqual(len(guarded[1]), 1)

        quoted = core_slot_declarations('_core: "Any" = None\n')
        self.assertFalse(resolves_no_names(quoted[0][0]))

        self.assertEqual(core_slot_declarations("_core = None\n")[0], [])
        for refused in ("_core: None = None\n", "_core: object = None\n",
                        '_core: "None" = None\n'):
            with self.subTest(source=refused):
                annotations, _ = core_slot_declarations(refused)
                self.assertEqual(len(annotations), 1)
                self.assertTrue(resolves_no_names(annotations[0]))

    def test_the_core_slot_is_declared_with_a_type_a_checker_can_resolve_names_through(self):
        annotations, _ = core_slot_declarations(_source(RUN_MODULE))
        self.assertTrue(
            annotations,
            "clients/_crucible_run.py declares `_core` with no type, so a type "
            "checker infers `None` from its `_core = None` binding and types "
            "every `_core.<name>` read as an attribute of `None`. Declare it "
            "with a type the core's names resolve through (`Any`, or the "
            "core's module type under `TYPE_CHECKING`).")
        unresolvable = [ast.unparse(annotation) for annotation in annotations
                        if resolves_no_names(annotation)]
        self.assertEqual(
            unresolvable, [],
            "a `_core` annotation of `None` alone or `object` leaves every "
            "`_core.<name>` read unresolved; annotations="
            f"{[ast.unparse(annotation) for annotation in annotations]!r}")

    def test_the_core_slot_is_still_bound_to_none_until_the_core_binds_it(self):
        _, bindings = core_slot_declarations(_source(RUN_MODULE))
        self.assertEqual(
            len(bindings), 1,
            "the run module binds `_core` exactly once at its top level; "
            f"bindings={[ast.unparse(value) for value in bindings]!r}")
        self.assertTrue(
            is_none(bindings[0]),
            "the run module binds `_core` to `None` until the core binds it, "
            f"never to a copy of the core; it binds {ast.unparse(bindings[0])!r}")

    def test_once_the_core_loads_the_slot_is_a_live_view_of_the_cores_namespace(self):
        core = load_client("_crucible_axi.py")
        namespace = core.ingest_reports.__globals__
        self.assertEqual(namespace.get("__name__"), f"{core.__name__}_run",
                         "the core's `ingest_reports` runs in its run module")
        view = namespace.get(CORE_SLOT)
        self.assertIsNotNone(view, "the core binds the run module's `_core`")
        self.assertIs(view.post_ingest, core.post_ingest,
                      "a core name read through `_core` is the core's own")

        replacement = mock.Mock(name="patched_post_ingest")
        with mock.patch.object(core, "post_ingest", replacement):
            self.assertIs(
                view.post_ingest, replacement,
                "`_core` reads the core's namespace at call time, so a patch "
                "of the core is seen through it")
        self.assertIs(view.post_ingest, core.post_ingest,
                      "the patch is undone through the view as well")

        added = object()
        with mock.patch.object(core, "late_added_core_name", added, create=True):
            self.assertIs(view.late_added_core_name, added,
                          "a name the core gains after loading is reached")
        with self.assertRaises(AttributeError):
            _ = view.late_added_core_name


# ── the manifest stage's complexity ─────────────────────────────────────────

def mccabe_findings(test, path):
    """Ruff's McCabe findings for `path` at the ceiling, with every
    configuration file ignored."""
    return ruff_findings(test, run_ruff(
        "--isolated", "--select", "C901",
        "--config", f"lint.mccabe.max-complexity={MAX_COMPLEXITY}",
        str(path)))


def _names_function(finding, name):
    return re.search(f"`{re.escape(name)}`",
                     finding.get("message") or "") is not None


class TheManifestStageStaysUnderTheComplexityCeilingTest(unittest.TestCase):

    def test_the_mccabe_check_flags_a_function_over_the_ceiling_by_name(self):
        scratch = tempfile.mkdtemp(prefix="mccabe-control-")
        self.addCleanup(shutil.rmtree, scratch, ignore_errors=True)
        branches = "".join(f"    if value == {n}:\n        return {n}\n"
                           for n in range(MAX_COMPLEXITY + 2))
        control = Path(scratch, "control.py")
        control.write_text(
            "def over_the_ceiling(value):\n" + branches + "    return -1\n\n\n"
            "def under_the_ceiling(value):\n    return value\n",
            encoding="utf-8")

        findings = mccabe_findings(self, control)

        flagged = [f for f in findings if _names_function(f, "over_the_ceiling")]
        self.assertEqual(len(flagged), 1, describe_findings(findings))
        self.assertEqual(flagged[0].get("code"), "C901")
        self.assertFalse(
            [f for f in findings if _names_function(f, "under_the_ceiling")],
            describe_findings(findings))

    def test_ruff_mccabe_finds_no_excess_complexity_in_run_manifest_stage(self):
        defined = [node.name for node in ast.parse(_source(MANIFEST_MODULE)).body
                   if isinstance(node, ast.FunctionDef)]
        self.assertIn(MANIFEST_STAGE, defined,
                      "crucible_axi/manifest.py still defines the stage runner")

        findings = mccabe_findings(self, MANIFEST_MODULE)

        over = [f for f in findings if _names_function(f, MANIFEST_STAGE)]
        self.assertEqual(
            [f.get("message") for f in over], [],
            f"`{MANIFEST_STAGE}` is over McCabe complexity {MAX_COMPLEXITY}: "
            "its server-file 'lay down or fill' branch belongs in a helper of "
            f"its own.\n{describe_findings(over)}")


# ── installer-test helpers that write a server template ─────────────────────
#
# The reader walks the syntax trees of `tests/`, so it runs nothing. A helper
# WRITES A SERVER TEMPLATE when it is not itself a test (its name does not
# start with `test`), it names the shipped server file (`src/crucible.toml`
# under the repo root, directly, through a constant, or through a module-level
# function it calls), and it writes a file (`copyfile`, `copy`, `copy2`,
# `write_text`, `write_bytes`, or `open` for writing), in its own body or in a
# module-level function it calls.
#
# Such a helper is CLEAN when what it can reach rewrites all three listener
# keys and declares no value in the shipped window. What it can reach is its
# own body and default arguments, every module constant it names (imported
# ones too), every module-level function it calls, and every method it calls
# on `self` (its class or a base the tree defines), transitively. A comparison
# and an assertion are checks rather than declarations, so a value inside one
# is not counted: a helper may assert its ports lie outside the window.

SHIPPED_SERVER_PARTS = ("<repo>", "src", "crucible.toml")
_WRITE_CALLS = frozenset({"copyfile", "copy", "copy2", "copytree",
                          "write_text", "write_bytes"})
_JOIN_CALLS = frozenset({"join", "Path", "PurePath", "PosixPath", "joinpath"})
_KEY_ASSIGNMENT = re.compile(
    r"(?m)^\s*(" + "|".join(LISTENER_KEYS) + r")\s*=\s*(\d+)")
_KEY_NAMED = {key: re.compile(r"(?m)^\s*" + re.escape(key) + r"\s*=")
              for key in LISTENER_KEYS}


def _in_window(value):
    return (isinstance(value, int) and not isinstance(value, bool)
            and WINDOW_LOW <= value <= WINDOW_HIGH)


def _call_name(func):
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _self_method_name(func):
    """The method name of a `self.<name>` callee, else None."""
    if (isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name)
            and func.value.id == "self"):
        return func.attr
    return None


def _is_check(node):
    """A comparison, or a `self.assert*` / `self.fail` call: a check, never a
    declaration."""
    if isinstance(node, ast.Compare):
        return True
    if not isinstance(node, ast.Call):
        return False
    method = _self_method_name(node.func)
    return method is not None and (
        method.startswith("assert") or method in ("fail", "skipTest", "subTest"))


def _writes_directly(function):
    for node in ast.walk(function):
        if not isinstance(node, ast.Call):
            continue
        name = _call_name(node.func)
        if name in _WRITE_CALLS:
            return True
        if name == "open" and isinstance(node.func, ast.Name):
            modes = list(node.args[1:2]) + [
                keyword.value for keyword in node.keywords
                if keyword.arg == "mode"]
            if any(isinstance(mode, ast.Constant) and isinstance(mode.value, str)
                   and set(mode.value) & set("wax") for mode in modes):
                return True
    return False


class _Module:
    """One parsed module's top-level names."""

    def __init__(self, name, tree, is_package=False):
        self.name = name
        self.tree = tree
        self.package = name if is_package else name.rpartition(".")[0]
        self.assigns, self.functions, self.classes, self.imports = {}, {}, {}, {}
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.functions[node.name] = node
            elif isinstance(node, ast.ClassDef):
                self.classes[node.name] = node
            elif (isinstance(node, (ast.Assign, ast.AnnAssign))
                  and node.value is not None):
                for target in _targets(node):
                    self.assigns[target] = node.value
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    parts = self.package.split(".")
                    parts = parts[:len(parts) - (node.level - 1)]
                    base = ".".join(part for part in parts + [base] if part)
                for alias in node.names:
                    self.imports[alias.asname or alias.name] = (base, alias.name)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.asname:
                        self.imports[alias.asname] = (alias.name, None)


class _Found(NamedTuple):
    """What a name resolves to: an `assign` (its value expression), a
    `function` or `class` (its definition), or a `module` (no node)."""

    kind: str
    module: Any
    node: Any


class TemplateHelperScan:
    """The test helpers among `sources` that write a server template, and
    whether each declares a listener outside the shipped window.

    `sources` maps a dotted module name to its source text."""

    def __init__(self, sources):
        self.modules = {}
        for name, source in sources.items():
            try:
                tree = ast.parse(source)
            except SyntaxError:
                continue
            self.modules[name] = _Module(name, tree,
                                         is_package=name.endswith("__init__"))

    # -- resolution ------------------------------------------------------

    def resolve(self, module, name, depth=0):
        """What `name` names in `module`, as a `_Found`, or None."""
        if depth > 8:
            return None
        if name in module.assigns:
            return _Found("assign", module, module.assigns[name])
        if name in module.functions:
            return _Found("function", module, module.functions[name])
        if name in module.classes:
            return _Found("class", module, module.classes[name])
        if name in module.imports:
            base, attr = module.imports[name]
            if attr is None:
                target = self.modules.get(base)
                return _Found("module", target, None) if target else None
            whole = self.modules.get(f"{base}.{attr}" if base else attr)
            if whole is not None:
                return _Found("module", whole, None)
            target = self.modules.get(base)
            if target is not None:
                return self.resolve(target, attr, depth + 1)
        return None

    def resolve_expr(self, module, node):
        if isinstance(node, ast.Name):
            return self.resolve(module, node.id)
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            owner = self.resolve(module, node.value.id)
            if owner is not None and owner.kind == "module":
                return self.resolve(owner.module, node.attr)
        return None

    def resolve_kind(self, module, node, kind):
        """`resolve_expr`, kept only when it names a `kind`."""
        found = self.resolve_expr(module, node)
        return found if found is not None and found.kind == kind else None

    # -- the shipped server file -----------------------------------------

    def path_parts(self, module, node, depth=0):
        if depth > 16:
            return ("?",)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return tuple(part for part in node.value.split("/") if part)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            return (self.path_parts(module, node.left, depth + 1)
                    + self.path_parts(module, node.right, depth + 1))
        if isinstance(node, ast.Call) and _call_name(node.func) in _JOIN_CALLS:
            parts = ()
            if (_call_name(node.func) == "joinpath"
                    and isinstance(node.func, ast.Attribute)):
                parts = self.path_parts(module, node.func.value, depth + 1)
            for arg in node.args:
                parts += self.path_parts(module, arg, depth + 1)
            return parts
        if isinstance(node, (ast.Name, ast.Attribute)):
            found = self.resolve_kind(module, node, "assign")
            if found is not None:
                return self.path_parts(found.module, found.node, depth + 1)
        if any(isinstance(inner, ast.Name) and inner.id == "__file__"
               for inner in ast.walk(node)):
            return ("<repo>",)
        return ("?",)

    def names_shipped_directly(self, module, function):
        for node in ast.walk(function):
            if (isinstance(node, (ast.Name, ast.Attribute, ast.BinOp, ast.Call))
                    and self.path_parts(module, node) == SHIPPED_SERVER_PARTS):
                return True
        return False

    def _called_functions(self, module, function):
        for node in ast.walk(function):
            if (isinstance(node, ast.Call)
                    and _self_method_name(node.func) is None):
                found = self.resolve_kind(module, node.func, "function")
                if found is not None:
                    yield found.module, found.node

    def names_shipped(self, module, function):
        if self.names_shipped_directly(module, function):
            return True
        return any(self.names_shipped_directly(owner, called)
                   for owner, called in self._called_functions(module, function))

    def writes(self, module, function, seen=None):
        seen = set() if seen is None else seen
        if id(function) in seen:
            return False
        seen.add(id(function))
        if _writes_directly(function):
            return True
        return any(self.writes(owner, called, seen)
                   for owner, called in self._called_functions(module, function))

    # -- the helpers -----------------------------------------------------

    def _candidates(self):
        for module in self.modules.values():
            for function in module.functions.values():
                yield module, None, function
            for cls in module.classes.values():
                for node in cls.body:
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        yield module, cls, node

    def helpers(self):
        """`{qualified name: (module, class, function)}` of every helper that
        writes a server template."""
        found = {}
        for module, cls, function in self._candidates():
            if function.name.startswith("test"):
                continue
            if self.names_shipped(module, function) and self.writes(module, function):
                qualified = ".".join(part for part in (
                    module.name, cls.name if cls else None, function.name) if part)
                found[qualified] = (module, cls, function)
        return found

    # -- what a helper can reach -----------------------------------------

    def _method(self, module, cls, name, depth=0):
        if depth > 8 or cls is None:
            return None
        for node in cls.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) \
                    and node.name == name:
                return module, cls, node
        for base in cls.bases:
            found = self.resolve_kind(module, base, "class")
            if found is not None:
                hit = self._method(found.module, found.node, name, depth + 1)
                if hit:
                    return hit
        return None

    def reach(self, module, cls, function):
        """Every node `function` can reach, each with its module, checks
        aside."""
        reached, stack, seen = [], [(module, cls, function)], set()
        while stack:
            owner, owner_cls, root = stack.pop()
            if id(root) in seen:
                continue
            seen.add(id(root))
            nodes = [root]
            while nodes:
                node = nodes.pop()
                if _is_check(node):
                    continue
                reached.append((owner, node))
                if isinstance(node, (ast.Name, ast.Attribute)):
                    found = self.resolve_kind(owner, node, "assign")
                    if found is not None:
                        stack.append((found.module, None, found.node))
                if isinstance(node, ast.Call):
                    method = _self_method_name(node.func)
                    if method is not None:
                        hit = self._method(owner, owner_cls, method)
                        if hit:
                            stack.append(hit)
                    else:
                        found = self.resolve_kind(owner, node.func, "function")
                        if found is not None:
                            stack.append((found.module, None, found.node))
                nodes.extend(ast.iter_child_nodes(node))
        return reached

    def offences(self, module, cls, function):
        """Why the helper is not clean: an empty list when it is."""
        problems, named = [], set()
        for _owner, node in self.reach(module, cls, function):
            if not isinstance(node, ast.Constant):
                continue
            value = node.value
            if _in_window(value):
                problems.append(f"declares {value}, inside the shipped "
                                f"{WINDOW_LOW}-{WINDOW_HIGH} window")
            elif isinstance(value, str):
                if value in LISTENER_KEYS:
                    named.add(value)
                for key, pattern in _KEY_NAMED.items():
                    if pattern.search(value):
                        named.add(key)
                for key, number in _KEY_ASSIGNMENT.findall(value):
                    if _in_window(int(number)):
                        problems.append(
                            f"writes `{key} = {number}`, inside the shipped "
                            f"{WINDOW_LOW}-{WINDOW_HIGH} window")
        missing = [key for key in LISTENER_KEYS if key not in named]
        if missing:
            problems.append(
                f"never rewrites {', '.join(f'`{key}`' for key in missing)}, "
                f"so the shipped template's own {WINDOW_LOW}-{WINDOW_HIGH} "
                "window stays in the template it writes")
        return sorted(set(problems))


def scan_of(sources):
    """A scan of synthetic `sources`, every one of which must parse: a
    source the scan skipped would make its answer vacuous."""
    dedented = {name: textwrap.dedent(source) for name, source in sources.items()}
    for name, source in dedented.items():
        ast.parse(source, filename=name)
    return TemplateHelperScan(dedented)


def _tests_tree_sources():
    sources = {}
    for path in sorted(TESTS_DIR.rglob("*.py")):
        if "__pycache__" in path.parts or "node_modules" in path.parts:
            continue
        relative = path.relative_to(REPO_ROOT).with_suffix("")
        sources[".".join(relative.parts)] = path.read_text(encoding="utf-8")
    return sources


_TREE_SCAN = None


def tests_tree_scan():
    global _TREE_SCAN
    if _TREE_SCAN is None:
        _TREE_SCAN = TemplateHelperScan(_tests_tree_sources())
    return _TREE_SCAN


#: The installed-deployment suite's provisioning helper, by qualified name.
INSTALLED_DEPLOYMENT_PROVISIONING = (
"tests.client.integration.test_an_installed_deployment_resolves_its_configuration"
"._InstalledDeploymentCase.provision_server")

_SYNTHETIC_HEADER = """\
    import shutil
    from pathlib import Path
    REPO_ROOT = Path(__file__).resolve().parents[2]
    CONFIG_NAME = "crucible.toml"
    SHIPPED = REPO_ROOT / "src" / CONFIG_NAME
    """


def synthetic(body):
    """A synthetic test module: the shared header, then `body`."""
    return textwrap.dedent(_SYNTHETIC_HEADER) + textwrap.dedent(body)


class TheTemplateHelperScanIsProvedOnSyntheticSourcesTest(unittest.TestCase):
    """The reader, on sources whose answer is known, before the real tree."""

    def test_a_helper_copying_the_shipped_template_verbatim_is_found_and_flagged(self):
        scan = scan_of({"suite.copies": synthetic("""\
            class Case:
                def provision(self, package):
                    shutil.copyfile(SHIPPED, Path(package, "src", CONFIG_NAME))
            """)})
        helpers = scan.helpers()
        self.assertEqual(sorted(helpers), ["suite.copies.Case.provision"])
        problems = scan.offences(*helpers["suite.copies.Case.provision"])
        self.assertEqual(len(problems), 1, problems)
        for key in LISTENER_KEYS:
            self.assertIn(f"`{key}`", problems[0])

    def test_a_helper_rewriting_all_three_keys_to_claimed_ports_is_clean(self):
        scan = scan_of({"suite.rewrites": synthetic("""\
            RANGE_MIN_KEY = "port_range_min"
            RANGE_MAX_KEY = "port_range_max"

            def claim(count):
                return list(range(40000, 40000 + count))

            def server_table(port, low, high):
                return ("[server]\\n" "port = %d\\n" "%s = %d\\n" "%s = %d\\n"
                        % (port, RANGE_MIN_KEY, low, RANGE_MAX_KEY, high))

            class Case:
                def provision(self, package):
                    ports = claim(3)
                    assert not 3800 <= ports[0] <= 3899
                    self.assertFalse(3849 in ports)
                    text = SHIPPED.read_text(encoding="utf-8")
                    text += server_table(ports[2], ports[0], ports[1])
                    Path(package, CONFIG_NAME).write_text(text)
            """)})
        helpers = scan.helpers()
        self.assertEqual(sorted(helpers), ["suite.rewrites.Case.provision"])
        self.assertEqual(scan.offences(*helpers["suite.rewrites.Case.provision"]), [])

    def test_a_helper_whose_default_port_lies_in_the_window_is_flagged(self):
        scan = scan_of({"suite.defaults": synthetic("""\
            DEFAULT_PORT = 3849

            class Case:
                def provision(self, package, low, high, port=DEFAULT_PORT):
                    text = SHIPPED.read_text(encoding="utf-8")
                    text += "port = %d\\nport_range_min = %d\\nport_range_max = %d\\n" % (
                        port, low, high)
                    Path(package, CONFIG_NAME).write_text(text)
            """)})
        problems = scan.offences(*scan.helpers()["suite.defaults.Case.provision"])
        self.assertEqual(
            problems, ["declares 3849, inside the shipped 3800-3899 window"])

    def test_a_template_text_naming_a_window_port_is_flagged(self):
        scan = scan_of({"suite.literal": synthetic("""\
            def provision(package):
                text = SHIPPED.read_text(encoding="utf-8")
                text += "[server]\\nport = 3850\\nport_range_min = 41000\\n" \\
                        "port_range_max = 41001\\n"
                Path(package, CONFIG_NAME).write_text(text)
            """)})
        problems = scan.offences(*scan.helpers()["suite.literal.provision"])
        self.assertEqual(
            problems, ["writes `port = 3850`, inside the shipped 3800-3899 window"])

    def test_a_reader_that_writes_nothing_and_a_test_method_are_not_helpers(self):
        scan = scan_of({"suite.readers": synthetic("""\
            def shipped_table():
                return SHIPPED.read_text(encoding="utf-8")

            class Case:
                def test_copies_the_template(self):
                    shutil.copyfile(SHIPPED, "/tmp/elsewhere")

                def unrelated_writer(self, path):
                    Path(path).write_text("[limits]\\n")
            """)})
        self.assertEqual(scan.helpers(), {})

    def test_a_helper_reading_through_a_called_function_and_an_imported_constant_is_found(self):
        scan = scan_of({
            "suite.shared": _SYNTHETIC_HEADER,
            "suite.importer": """\
                from pathlib import Path
                from suite.shared import SHIPPED

                def shipped_text():
                    return SHIPPED.read_text(encoding="utf-8")

                class Case:
                    def provision(self, package):
                        Path(package, "crucible.toml").write_text(shipped_text())
                """,
        })
        helpers = scan.helpers()
        self.assertEqual(sorted(helpers), ["suite.importer.Case.provision"])
        self.assertTrue(scan.offences(*helpers["suite.importer.Case.provision"]))

    def test_a_scratch_destination_named_like_the_shipped_file_is_not_the_shipped_file(self):
        scan = scan_of({"suite.scratch": """\
            import os
            from pathlib import Path

            class Case:
                def place(self, package):
                    Path(os.path.join(package, "src", "crucible.toml")).write_text("x")
            """})
        self.assertEqual(scan.helpers(), {})


class NoInstallerTestDeclaresAPortInTheShippedWindowTest(unittest.TestCase):
    """Every test helper that writes a server template rewrites the listener
    keys, and nothing it reaches declares a value in 3800-3899."""

    def test_the_scan_finds_the_installed_deployment_suites_provisioning_helper(self):
        helpers = tests_tree_scan().helpers()
        self.assertIn(
            INSTALLED_DEPLOYMENT_PROVISIONING, helpers,
            "the scan must find the installed-deployment suite's "
            "`provision_server`, which writes the provisioned server's "
            f"template; found {sorted(helpers)!r}")

    def test_the_installed_deployment_suites_template_declares_no_port_in_the_window(self):
        scan = tests_tree_scan()
        helpers = scan.helpers()
        self.assertIn(INSTALLED_DEPLOYMENT_PROVISIONING, helpers)
        problems = scan.offences(*helpers[INSTALLED_DEPLOYMENT_PROVISIONING])
        self.assertEqual(
            problems, [],
            "`provision_server` writes the shipped template, whose window is "
            f"{WINDOW_LOW}-{WINDOW_HIGH}, so the suite's fresh installs probe "
            "the ports a workstation's boards listen on. It must write "
            "ephemeral ports, claimed as the installer-connection suite "
            "claims them, for `port`, `port_range_min` and `port_range_max`: "
            + "; ".join(problems))

    def test_every_helper_that_writes_a_server_template_declares_ports_outside_the_window(self):
        scan = tests_tree_scan()
        helpers = scan.helpers()
        self.assertTrue(helpers, "the scan of tests/ finds no template-writing "
                                 "helper at all, so it is reading nothing")
        offenders = {}
        for name, found in sorted(helpers.items()):
            problems = scan.offences(*found)
            if problems:
                offenders[name] = problems
        self.assertEqual(
            sorted(offenders), [],
            "no installer test may declare a port in the shipped "
            f"{WINDOW_LOW}-{WINDOW_HIGH} window. Helpers checked: {', '.join(sorted(helpers))}.\n"
            "Offenders:\n"
            + "\n".join(f"  {name}: {'; '.join(problems)}"
                        for name, problems in offenders.items()))


# ── the project's own ruff rule set ─────────────────────────────────────────

def _pyproject():
    with PYPROJECT.open("rb") as handle:
        return tomllib.load(handle)


def _requirement_name(requirement):
    match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", requirement)
    return re.sub(r"[-_.]+", "-", match.group(1)).lower() if match else None


class TheProjectDeclaresItsOwnRuffRuleSetTest(unittest.TestCase):

    def test_pyproject_pins_ruffs_classic_default_rule_set(self):
        lint = _pyproject().get("tool", {}).get("ruff", {}).get("lint")
        self.assertIsInstance(
            lint, dict,
            "pyproject.toml declares no `[tool.ruff.lint]`, so `ruff check` "
            "falls back to whatever rule set the machine's ruff defaults to")
        self.assertEqual(lint.get("select"), PROJECT_RULE_SET)

    def test_the_dev_dependency_group_names_ruff_beside_the_toolchain_it_keeps(self):
        dev = _pyproject().get("project", {}).get(
            "optional-dependencies", {}).get("dev", [])
        names = [_requirement_name(requirement) for requirement in dev]
        self.assertEqual(
            names.count("ruff"), 1,
            "`ruff` joins the `dev` group exactly once, so `pip install "
            f"'.[dev]'` installs the linter the suite runs; dev={dev!r}")
        for kept in ("coverage", "build", "pytest"):
            self.assertIn(kept, names, f"the `dev` group keeps {kept}")

    def test_ruff_on_the_projects_own_rule_set_finds_nothing_in_the_python_trees(self):
        for tree in LINTED_TREES:
            self.assertTrue(_top_level_dir(tree).is_dir(), f"{tree} exists")
        completed = run_ruff(*LINTED_TREES)
        findings = ruff_findings(self, completed)
        self.assertEqual(
            (completed.returncode, len(findings)), (0, 0),
            f"`ruff check {' '.join(LINTED_TREES)}` from the repo root, on the "
            "rule set pyproject.toml declares, must find nothing:\n"
            + describe_findings(findings))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
