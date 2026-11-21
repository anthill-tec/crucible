"""No test loads or spawns a client from a source path it imported.

The AC2 guard (`test_no_test_builds_its_own_path_to_the_client_source`)
refuses a module that BUILDS its own path to the checkout's `clients/`, and
lets every module use the helper's `CLIENT_SOURCE_DIR` to READ client source or
COPY it into a test's own install. A path built from `CLIENT_SOURCE_DIR` in
one module and imported by another passes that guard -- and if the importer
then LOADS or SPAWNS it, the client runs from the checkout and takes the repo
root as its install (CR-CRU-260 AC2, AC10; GREEN 961's open question 3:
`test_cr128_flag_help_census` loads `test_client_tier_surface`'s
`CLIENT_FILES` / `AXI_MODULE_PATH`).

This module is the AC2 guard's second leg. It is STATIC (UNIT: an AST scan of
`tests/`, nothing imported or run). The rule:

1. A SOURCE CONSTANT is a module-level binding derived from the helper's
   `CLIENT_SOURCE_DIR`. The EXPORTING module's own binding decides: a name a
   module imports from the helper, or a module-level name it derives from one
   (`CLIENTS_DIR = CLIENT_SOURCE_DIR`, `AXI = CLIENTS_DIR / "x.py"`,
   `FILES = {"py": CLIENTS_DIR / "y.py"}`), is one. Imports are followed ONE
   level: a name the exporter itself imported from a third test module is not.
2. In the importing module the value is followed through its own code, scope
   by scope: assignments, `for` targets, comprehensions, `dict(...)` /
   `sorted(...)` / `.items()` / `.values()` / subscripts, a parameter default,
   and a mapping filled in place. A mapping's KEYS are not paths. A file name
   taken off a path (`.name`, `.stem`, `.suffix`), the helper's own
   `client_script(...)` / `load_client(...)`, and a copy's destination
   (`shutil.copy*(src, dst)`) are not source paths.
3. It is LOADED or SPAWNED when it reaches the path argument of
   `spec_from_file_location`, `runpy.run_path`, `SourceFileLoader`, the argv of
   a `subprocess` / `os.exec*` / `os.spawn*` / `asyncio` spawn, or any argument
   of a test helper that itself loads or spawns (a function whose body makes
   such a call, followed to a fixpoint across `tests/`).

Exempt by construction: comments, docstrings and message text (never code);
reads and copies of the source (not a load or spawn); the helper itself.

Limits (stated, not hidden): values stored on attributes (`self.x = ...`) or
passed into a function that is not itself a loader are not followed.
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

#: The helper package, and the source constant it exports for reads/copies.
HELPER_PATH = os.path.normpath("tests/client/__init__.py")
SOURCE_CONSTANT = "CLIENT_SOURCE_DIR"

#: Value kinds: a path (or a collection whose items are paths), a mapping
#: whose VALUES are paths, and a sequence of (key, path) pairs.
PATH, MAPPING, PAIRS = "path", "mapping", "pairs"
CLEAN = frozenset()

#: Calls whose result is never a source path.
SANITIZERS = frozenset({"client_script", "load_client", "len", "bool", "int",
                        "isinstance", "hasattr", "id", "type", "repr"})

#: Attributes that take a file NAME off a path.
NAME_ATTRIBUTES = frozenset({"name", "stem", "suffix"})

#: `shutil` copies: the result is the destination.
COPIERS = frozenset({"copy", "copy2", "copyfile", "copytree", "move"})

#: Calls that turn a collection into a sequence of its items.
SEQUENCE_CALLS = frozenset({"tuple", "list", "sorted", "set", "frozenset", "reversed", "iter"})

#: Stdlib loaders, with the position of their path argument.
LOADERS = {"spec_from_file_location": 1, "run_path": 0, "SourceFileLoader": 1,
           "load_source": 1}

#: Stdlib spawners, by the module they are called on.
SPAWNERS = {
    "subprocess": frozenset({"run", "Popen", "call", "check_call", "check_output"}),
    "asyncio": frozenset({"create_subprocess_exec"}),
    "os": frozenset({"execv", "execve", "execvp", "execvpe", "execl", "execle",
                     "execlp", "execlpe", "spawnv", "spawnve", "spawnvp",
                     "spawnvpe", "spawnl", "spawnle", "spawnlp", "spawnlpe",
                     "posix_spawn", "posix_spawnp", "system", "popen"}),
}
SPAWNER_NAMES = frozenset({"Popen", "check_output", "check_call", "create_subprocess_exec"})

#: `python -m <runner>` modules that run the script they are handed.
SCRIPT_RUNNERS = frozenset({"coverage", "runpy", "trace", "pdb", "cProfile", "profile"})

#: Calls whose result is a path built from their arguments (the receiver, for
#: a method). Any other call's result is not a path: a value computed FROM a
#: source path (its text, a census of it) is not the path.
PATH_CALLS = frozenset({"Path", "PurePath", "PosixPath", "PurePosixPath", "str",
                        "fspath", "join", "abspath", "realpath", "normpath",
                        "dirname", "expanduser", "resolve", "absolute",
                        "with_name", "with_suffix", "joinpath", "format"})

#: Names too generic to stand for a loading test helper.
GENERIC_NAMES = frozenset({"run", "main", "call", "setUp", "setUpClass", "setUpModule",
                           "tearDown", "__init__"})


def _callee(func):
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _is_interpreter(node):
    """`sys.executable`: the spawn runs a python script."""
    return (isinstance(node, ast.Attribute) and node.attr == "executable"
            and isinstance(node.value, ast.Name) and node.value.id == "sys")


def _script_elements(elements):
    """The argv elements that name what an argv RUNS: its program, or the
    script an interpreter runs (`sys.executable <script>`, or a script runner
    such as `-m coverage run <script>`). A path handed as an argument to some
    other program (a linter, a bun script) is read, not run."""
    if not elements:
        return []
    if not _is_interpreter(elements[0]):
        return [elements[0]]
    rest = elements[1:]
    if (len(rest) >= 2 and isinstance(rest[0], ast.Constant) and rest[0].value == "-m"):
        runner = rest[1].value if isinstance(rest[1], ast.Constant) else None
        return list(rest[2:]) if runner in SCRIPT_RUNNERS else []
    return rest[:1]


def _stdlib_sink(call):
    """`(name, [argument nodes])` when `call` is a stdlib load or spawn: the
    arguments are the ones that name what is loaded or run. `None` when it is
    neither."""
    func = call.func
    name = _callee(func)
    if name in LOADERS:
        index = LOADERS[name]
        arguments = [call.args[index]] if len(call.args) > index else []
        arguments += [k.value for k in call.keywords if k.arg in ("location", "path", "path_name")]
        return name, arguments
    module = func.value.id if (isinstance(func, ast.Attribute)
                               and isinstance(func.value, ast.Name)) else None
    spawner = module is not None and name in SPAWNERS.get(module, ())
    if not (spawner or (isinstance(func, ast.Name) and name in SPAWNER_NAMES)):
        return None
    if name == "create_subprocess_exec" or (module == "os" and name not in ("system", "popen")):
        # The argv is spread over the positional arguments (after the path
        # argument `os.exec*`/`os.spawn*` take first).
        positional = list(call.args)
        if module == "os" and (name or "").startswith("spawn"):
            positional = positional[1:]
        return name, _script_elements(positional)
    argv = call.args[0] if call.args else next(
        (k.value for k in call.keywords if k.arg == "args"), None)
    if argv is None:
        return name, []
    if isinstance(argv, (ast.List, ast.Tuple)):
        return name, _script_elements(list(argv.elts))
    return name, [argv]


def _runs_python(function):
    """Whether `function` loads a module by path, or spawns with an argv led
    by the interpreter: a loading helper's own sink."""
    spawns = interpreter = False
    for node in ast.walk(function):
        if isinstance(node, ast.Call):
            name = _callee(node.func)
            if name in LOADERS:
                return True
            if _stdlib_sink(node) is not None:
                spawns = True
        elif (isinstance(node, (ast.List, ast.Tuple)) and node.elts
              and _is_interpreter(node.elts[0])):
            interpreter = True
    return spawns and interpreter


def _own_nodes(node):
    """Every node of `node`'s own scope: nested functions, classes, lambdas
    and comprehensions are not entered."""
    stack = list(ast.iter_child_nodes(node))
    while stack:
        current = stack.pop()
        yield current
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef,
                                ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp,
                                ast.GeneratorExp)):
            continue
        stack.extend(ast.iter_child_nodes(current))


def loading_helpers(trees):
    """The names of every test function that loads or spawns: its body makes
    a stdlib load or spawn, or calls such a helper (a fixpoint)."""
    functions = []
    for tree in trees:
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions.append(node)
    helpers = set()
    changed = True
    while changed:
        changed = False
        for function in functions:
            if (function.name in helpers or function.name in SANITIZERS
                    or function.name in GENERIC_NAMES):
                continue
            if _runs_python(function) or any(
                    isinstance(node, ast.Call) and _callee(node.func) in helpers
                    for node in ast.walk(function)):
                helpers.add(function.name)
                changed = True
    return frozenset(helpers)


def _resolve(importer, module, level, modules):
    """The relative path of the test module an import names, seen from
    `importer`; the helper's path for the helper package; else None."""
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
        candidates = [stem / "__init__.py"]
        if parts:
            candidates.insert(0, stem.with_suffix(".py"))
        for candidate in candidates:
            text = os.path.normpath(str(candidate))
            if text == HELPER_PATH or text in modules:
                return text
    return None


class _Scope:
    def __init__(self, parent=None, is_class=False):
        self.parent = parent
        self.is_class = is_class
        self.locals = set()
        self.kinds = {}

    def lookup(self, name):
        scope = self
        while scope is not None:
            if name in scope.locals:
                return scope.kinds.get(name, CLEAN)
            scope = scope.parent
        return CLEAN

    def add(self, name, kinds):
        before = self.kinds.get(name, CLEAN)
        after = before | kinds
        self.kinds[name] = after
        return after != before


def _as_path(kinds):
    return frozenset({PATH}) if kinds else CLEAN


def _items_of(kinds):
    """The kind of one item of a collection of `kinds`: a mapping yields its
    KEYS, never paths."""
    out = set()
    if PATH in kinds or PAIRS in kinds:
        out.add(PATH)
    return frozenset(out)


class _ModuleAnalysis:
    """One module's source-path values, and where they are loaded or spawned."""

    def __init__(self, path, tree, analyser, follow):
        self.path = path
        self.tree = tree
        self.analyser = analyser
        self.follow = follow
        self.helper_aliases = set()
        self.offenders = []
        self.module_scope = None
        # Module-level functions that RETURN a source path: a call to one is one.
        self.returning = set()

    # -- imports ---------------------------------------------------------------

    def import_kinds(self, node):
        """`[(local name, kinds)]` an import statement binds."""
        out = []
        if isinstance(node, ast.Import):
            for alias in node.names:
                local = alias.asname or alias.name.split(".")[0]
                if alias.asname and _resolve(self.path, alias.name, 0, self.analyser.modules) == HELPER_PATH:
                    self.helper_aliases.add(local)
                out.append((local, CLEAN))
            return out
        exporter = _resolve(self.path, node.module, node.level, self.analyser.modules)
        for alias in node.names:
            local = alias.asname or alias.name
            kinds = CLEAN
            if exporter == HELPER_PATH:
                if alias.name == SOURCE_CONSTANT:
                    kinds = frozenset({PATH})
            elif exporter is not None and self.follow:
                kinds = self.analyser.exported(exporter).get(alias.name, CLEAN)
            elif (exporter is None and node.module and node.level == 0
                  and _resolve(self.path, f"{node.module}.{alias.name}", 0,
                               self.analyser.modules) == HELPER_PATH):
                # `from tests import client` -> the helper package itself.
                self.helper_aliases.add(local)
            out.append((local, kinds))
        return out

    # -- values ----------------------------------------------------------------

    def kind(self, node, scope):
        if node is None:
            return CLEAN
        if isinstance(node, ast.Name):
            return scope.lookup(node.id)
        if isinstance(node, ast.Constant):
            return CLEAN
        if isinstance(node, ast.Attribute):
            if node.attr in NAME_ATTRIBUTES:
                return CLEAN
            if (node.attr == SOURCE_CONSTANT and isinstance(node.value, ast.Name)
                    and node.value.id in self.helper_aliases):
                return frozenset({PATH})
            return _as_path(self.kind(node.value, scope))
        if isinstance(node, ast.Subscript):
            base = self.kind(node.value, scope)
            return frozenset({PATH}) if base else CLEAN
        if isinstance(node, ast.Call):
            return self.call_kind(node, scope)
        if isinstance(node, ast.Dict):
            out = set()
            for key, value in zip(node.keys, node.values, strict=True):
                value_kinds = self.kind(value, scope)
                if key is None:
                    out |= value_kinds & {MAPPING}
                elif value_kinds:
                    out.add(MAPPING)
            return frozenset(out)
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return _as_path(frozenset().union(*(self.kind(e, scope) for e in node.elts)))
        if isinstance(node, ast.Starred):
            return self.kind(node.value, scope)
        if isinstance(node, ast.DictComp):
            inner = self.comprehension_scope(node, scope)
            return frozenset({MAPPING}) if self.kind(node.value, inner) else CLEAN
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
            inner = self.comprehension_scope(node, scope)
            return _as_path(self.kind(node.elt, inner))
        if isinstance(node, ast.IfExp):
            return self.kind(node.body, scope) | self.kind(node.orelse, scope)
        if isinstance(node, ast.Lambda):
            return CLEAN
        if isinstance(node, ast.NamedExpr):
            return self.kind(node.value, scope)
        children = [c for c in ast.iter_child_nodes(node) if isinstance(c, ast.expr)]
        return _as_path(frozenset().union(*(self.kind(c, scope) for c in children)))

    def call_kind(self, node, scope):
        func = node.func
        name = _callee(func)
        if name in SANITIZERS:
            return CLEAN
        if (name in COPIERS and isinstance(func, ast.Attribute)
                and isinstance(func.value, ast.Name) and func.value.id == "shutil"):
            destination = node.args[1] if len(node.args) > 1 else next(
                (k.value for k in node.keywords if k.arg == "dst"), None)
            return _as_path(self.kind(destination, scope))
        arguments = list(node.args) + [k.value for k in node.keywords]
        argument_kinds = frozenset().union(*(self.kind(a, scope) for a in arguments)) \
            if arguments else CLEAN
        if isinstance(func, ast.Attribute):
            receiver = self.kind(func.value, scope)
            if name == "items":
                return frozenset({PAIRS}) if MAPPING in receiver or PAIRS in receiver \
                    else _as_path(receiver)
            if name == "values":
                return _as_path(receiver)
            if name == "keys":
                return CLEAN
            if name in ("get", "pop", "setdefault"):
                return _as_path(receiver | (self.kind(node.args[1], scope)
                                            if len(node.args) > 1 else CLEAN))
            if name == "copy":
                return receiver
            if name in PATH_CALLS:
                return _as_path(receiver | argument_kinds)
            return CLEAN
        if name == "dict":
            first = self.kind(node.args[0], scope) if node.args else CLEAN
            keyword_values = frozenset().union(
                *(self.kind(k.value, scope) for k in node.keywords)) if node.keywords else CLEAN
            return frozenset({MAPPING}) if (first or keyword_values) else CLEAN
        if name in SEQUENCE_CALLS and node.args:
            inner = self.kind(node.args[0], scope)
            out = set()
            if PATH in inner:
                out.add(PATH)
            if PAIRS in inner:
                out.add(PAIRS)
            return frozenset(out)
        if name == "enumerate" and node.args:
            return frozenset({PAIRS}) if _items_of(self.kind(node.args[0], scope)) else CLEAN
        if isinstance(func, ast.Name) and func.id in self.returning:
            return frozenset({PATH})
        if name in PATH_CALLS:
            return _as_path(argument_kinds)
        return CLEAN

    # -- binding -----------------------------------------------------------------

    def bind(self, target, kinds, scope):
        changed = False
        if isinstance(target, ast.Name):
            scope.locals.add(target.id)
            changed |= scope.add(target.id, kinds)
        elif isinstance(target, (ast.Tuple, ast.List)):
            elements = target.elts
            if PAIRS in kinds and len(elements) == 2:
                changed |= self.bind(elements[0], _as_path(kinds & {PATH}), scope)
                changed |= self.bind(elements[1], frozenset({PATH}), scope)
            else:
                for element in elements:
                    changed |= self.bind(element, _as_path(kinds), scope)
        elif isinstance(target, ast.Starred):
            changed |= self.bind(target.value, _as_path(kinds), scope)
        elif isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name):
            if kinds:
                owner = self._owner(target.value.id, scope)
                changed |= owner.add(target.value.id, frozenset({MAPPING}))
        return changed

    @staticmethod
    def _owner(name, scope):
        current = scope
        while current is not None:
            if name in current.locals:
                return current
            current = current.parent
        return scope

    def bind_items(self, target, iterable_kinds, scope):
        """Bind a `for` / comprehension target to one item of a collection."""
        if (PAIRS in iterable_kinds and isinstance(target, (ast.Tuple, ast.List))
                and len(target.elts) == 2):
            changed = self.bind(target.elts[0], _as_path(iterable_kinds & {PATH}), scope)
            changed |= self.bind(target.elts[1], frozenset({PATH}), scope)
            return changed
        return self.bind(target, _items_of(iterable_kinds), scope)

    def comprehension_scope(self, node, scope):
        inner = _Scope(parent=scope)
        for generator in node.generators:
            for name_node in ast.walk(generator.target):
                if isinstance(name_node, ast.Name):
                    inner.locals.add(name_node.id)
        for _ in range(4):
            changed = False
            for generator in node.generators:
                changed |= self.bind_items(generator.target, self.kind(generator.iter, inner), inner)
            if not changed:
                break
        return inner

    def _declare_locals(self, owner, scope):
        for node in _own_nodes(owner):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                scope.locals.add(node.name)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    scope.locals.add(alias.asname or alias.name.split(".")[0])
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                scope.locals.add(node.id)
            elif isinstance(node, ast.Global):
                for name in node.names:
                    scope.locals.discard(name)

    def _settle(self, owner, scope):
        statements = list(_own_nodes(owner))
        for _ in range(20):
            changed = False
            for node in statements:
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    for local, kinds in self.import_kinds(node):
                        changed |= scope.add(local, kinds)
                elif isinstance(node, ast.Assign):
                    value = node.value
                    for target in node.targets:
                        if (isinstance(target, (ast.Tuple, ast.List))
                                and isinstance(value, (ast.Tuple, ast.List))
                                and len(target.elts) == len(value.elts)):
                            for element, item in zip(target.elts, value.elts, strict=True):
                                changed |= self.bind(element, self.kind(item, scope), scope)
                        else:
                            changed |= self.bind(target, self.kind(value, scope), scope)
                elif (isinstance(node, ast.AugAssign)
                      or (isinstance(node, ast.AnnAssign) and node.value is not None)):
                    changed |= self.bind(node.target, self.kind(node.value, scope), scope)
                elif isinstance(node, (ast.For, ast.AsyncFor)):
                    changed |= self.bind_items(node.target, self.kind(node.iter, scope), scope)
                elif isinstance(node, (ast.With, ast.AsyncWith)):
                    for item in node.items:
                        if item.optional_vars is not None:
                            changed |= self.bind(item.optional_vars,
                                                 self.kind(item.context_expr, scope), scope)
                elif isinstance(node, ast.NamedExpr):
                    changed |= self.bind(node.target, self.kind(node.value, scope), scope)
                elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                      and isinstance(node.func.value, ast.Name)):
                    method = node.func.attr
                    filled = frozenset().union(*(self.kind(a, scope) for a in node.args)) \
                        if node.args else CLEAN
                    if method in ("append", "extend", "add", "insert") and filled:
                        owner_scope = self._owner(node.func.value.id, scope)
                        changed |= owner_scope.add(node.func.value.id, frozenset({PATH}))
                    elif method in ("update", "setdefault") and filled:
                        owner_scope = self._owner(node.func.value.id, scope)
                        changed |= owner_scope.add(node.func.value.id, frozenset({MAPPING}))
            if not changed:
                break

    # -- scopes ----------------------------------------------------------------

    def analyse_module(self):
        scope = _Scope()
        self.module_scope = scope
        self._declare_locals(self.tree, scope)
        self._settle(self.tree, scope)
        functions = [node for node in self.tree.body
                     if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
        for _ in range(4):
            before = len(self.returning)
            for function in functions:
                if function.name not in self.returning and self._returns_a_source_path(
                        function, scope):
                    self.returning.add(function.name)
            if len(self.returning) == before:
                break
            self._settle(self.tree, scope)
        return scope

    def _returns_a_source_path(self, function, module_scope):
        inner = self._function_scope(function, module_scope)
        return any(isinstance(node, ast.Return) and self.kind(node.value, inner)
                   for node in _own_nodes(function))

    def scan(self):
        scope = self.analyse_module()
        for child in ast.iter_child_nodes(self.tree):
            self._scan(child, scope)
        return self.offenders

    def _function_scope(self, function, parent):
        scope = _Scope(parent=parent)
        arguments = function.args
        positional = arguments.posonlyargs + arguments.args
        defaults = [None] * (len(positional) - len(arguments.defaults)) + list(arguments.defaults)
        for argument, default in zip(positional, defaults, strict=True):
            scope.locals.add(argument.arg)
            scope.add(argument.arg, _as_path(self.kind(default, parent)) if default else CLEAN)
        for argument, default in zip(arguments.kwonlyargs, arguments.kw_defaults, strict=True):
            scope.locals.add(argument.arg)
            scope.add(argument.arg, _as_path(self.kind(default, parent)) if default else CLEAN)
        for extra in (arguments.vararg, arguments.kwarg):
            if extra is not None:
                scope.locals.add(extra.arg)
        self._declare_locals(function, scope)
        self._settle(function, scope)
        return scope

    def _scan(self, node, scope):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for decorator in node.decorator_list:
                self._scan(decorator, scope)
            parent = scope.parent if scope.is_class else scope
            inner = self._function_scope(node, parent)
            for child in node.body:
                self._scan(child, inner)
            return
        if isinstance(node, ast.ClassDef):
            for expression in node.decorator_list + node.bases:
                self._scan(expression, scope)
            inner = _Scope(parent=scope, is_class=True)
            self._declare_locals(node, inner)
            self._settle(node, inner)
            for child in node.body:
                self._scan(child, inner)
            return
        if isinstance(node, ast.Lambda):
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            inner = self.comprehension_scope(node, scope)
            for generator in node.generators:
                self._scan(generator.iter, scope)
                for condition in generator.ifs:
                    self._scan(condition, inner)
            for part in ((node.key, node.value) if isinstance(node, ast.DictComp) else (node.elt,)):
                self._scan(part, inner)
            return
        if isinstance(node, ast.Call):
            self._check(node, scope)
        for child in ast.iter_child_nodes(node):
            self._scan(child, scope)

    def _argv_kinds(self, argument, scope):
        if isinstance(argument, (ast.List, ast.Tuple)):
            return frozenset().union(*(self.kind(e, scope) for e in argument.elts)) \
                if argument.elts else CLEAN
        return self.kind(argument, scope)

    def _check(self, call, scope):
        sink = _stdlib_sink(call)
        if sink is not None:
            name, arguments = sink
        else:
            name = _callee(call.func)
            if name not in self.analyser.helpers:
                return
            arguments = list(call.args) + [k.value for k in call.keywords]
        for argument in arguments:
            if self._argv_kinds(argument, scope):
                self.offenders.append((call.lineno, name))
                return


class _SuiteAnalyser:
    def __init__(self, modules):
        self.modules = modules
        self.helpers = loading_helpers(modules.values())
        self._exports = {}

    def exported(self, path):
        """The source-path kinds of `path`'s module-level names, its own
        binding deciding (its imports from other test modules not followed)."""
        if path not in self._exports:
            self._exports[path] = {}
            analysis = _ModuleAnalysis(path, self.modules[path], self, follow=False)
            scope = analysis.analyse_module()
            self._exports[path] = {name: kinds for name, kinds in scope.kinds.items() if kinds}
        return self._exports[path]


def imported_source_path_offenders(texts):
    """Every load or spawn of a client source path a module imported, over
    `texts` (relative path -> module source): sorted `(path, line, call)`."""
    modules = {os.path.normpath(path): ast.parse(text, filename=path)
               for path, text in texts.items()}
    analyser = _SuiteAnalyser(modules)
    offenders = []
    for path, tree in sorted(modules.items()):
        if path == HELPER_PATH:
            continue
        analysis = _ModuleAnalysis(path, tree, analyser, follow=True)
        offenders.extend((path, line, name) for line, name in analysis.scan())
    return sorted(set(offenders))


def suite_imported_source_path_offenders():
    """`(modules scanned, offenders)` over every python module under `tests/`."""
    texts = {}
    for path in sorted(TESTS_DIR.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        texts[str(path.relative_to(REPO_DIR))] = path.read_text(encoding="utf-8")
    return len(texts), imported_source_path_offenders(texts)


# -- planted modules -----------------------------------------------------------

_EXPORTER = "tests/client/test_planted_surface.py"
_IMPORTER = "tests/client/test_planted_census.py"

#: The tier-surface shape: source constants derived from the helper's.
_SOURCE_EXPORTER = (
    "from tests.client import CLIENT_SOURCE_DIR, client_script\n"
    "CLIENTS_DIR = CLIENT_SOURCE_DIR\n"
    "AXI_MODULE_PATH = CLIENTS_DIR / '_crucible_axi.py'\n"
    "CLIENT_FILES = {\n"
    "    'python': CLIENTS_DIR / 'python-crucible.py',\n"
    "    'bun': CLIENTS_DIR / 'bun-crucible.py',\n"
    "}\n"
    "CLIENTS = tuple(CLIENT_FILES)\n")

#: The same names bound to the test install: not source constants.
_INSTALL_EXPORTER = (
    "from tests.client import client_script\n"
    "AXI_MODULE_PATH = client_script('_crucible_axi.py')\n"
    "CLIENT_FILES = {'python': client_script('python-crucible.py')}\n")

_LOADER = (
    "import importlib.util\n"
    "def _load_module_by_path(path, key):\n"
    "    spec = importlib.util.spec_from_file_location(key, path)\n"
    "    module = importlib.util.module_from_spec(spec)\n"
    "    spec.loader.exec_module(module)\n"
    "    return module\n")

#: Each loads or spawns an imported source path exactly once.
PLANTED_LOADS = {
    "the cr128 shape: a copied table, a default, items, a loader helper": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: _LOADER
            + "from pathlib import Path\n"
              "from test_planted_surface import AXI_MODULE_PATH, CLIENT_FILES\n"
              "FLAG_HELP_CLIENTS = dict(CLIENT_FILES)\n"
              "CENSUS_SOURCES = dict(FLAG_HELP_CLIENTS)\n"
              "CENSUS_SOURCES['axi'] = AXI_MODULE_PATH\n"
              "def census(sources=None):\n"
              "    sources = CENSUS_SOURCES if sources is None else sources\n"
              "    for source, path in sources.items():\n"
              "        path = Path(path)\n"
              "        _load_module_by_path(path, 'census_%s' % source)\n",
    },
    "a sorted table's values handed to a helper that loads through another": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: _LOADER
            + "from tests.client.test_planted_surface import CLIENT_FILES\n"
              "def enumerate_verbs(client, path):\n"
              "    return _load_module_by_path(path, 'enum_' + client)\n"
              "def test_verbs():\n"
              "    for client, path in sorted(CLIENT_FILES.items()):\n"
              "        enumerate_verbs(client, path)\n",
    },
    "an imported path spawned with the interpreter": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: "import subprocess\nimport sys\n"
                   "from .test_planted_surface import AXI_MODULE_PATH\n"
                   "def test_help():\n"
                   "    subprocess.run([sys.executable, str(AXI_MODULE_PATH), '--help'])\n",
    },
    "an imported path run with runpy, through a comprehension": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: "import runpy\n"
                   "from tests.client.test_planted_surface import CLIENT_FILES\n"
                   "def test_all():\n"
                   "    return [runpy.run_path(str(path)) for path in CLIENT_FILES.values()]\n",
    },
    "an imported path run as a script under coverage": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: "import subprocess\nimport sys\n"
                   "from test_planted_surface import AXI_MODULE_PATH\n"
                   "def test_coverage():\n"
                   "    subprocess.run([sys.executable, '-m', 'coverage', 'run', str(AXI_MODULE_PATH)])\n",
    },
    "a local function returning a path off an imported source table": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: "import importlib.util\n"
                   "from test_planted_surface import CLIENT_FILES\n"
                   "def _source(name):\n"
                   "    return CLIENT_FILES['python'].parent / name\n"
                   "def test_toon():\n"
                   "    return importlib.util.spec_from_file_location('toon', _source('toon.py'))\n",
    },
    "the helper's source constant loaded directly": {
        _IMPORTER: "import importlib.util\n"
                   "from tests.client import CLIENT_SOURCE_DIR\n"
                   "TOON = CLIENT_SOURCE_DIR / 'toon.py'\n"
                   "def test_toon():\n"
                   "    spec = importlib.util.spec_from_file_location('toon', TOON)\n"
                   "    return spec\n",
    },
}

#: Each imports a client path and never loads or spawns a source path: clean.
PLANTED_CLEAN = {
    "an imported source path only read and parsed": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: "import ast\n"
                   "from test_planted_surface import AXI_MODULE_PATH, CLIENT_FILES\n"
                   "TREES = {c: ast.parse(p.read_text()) for c, p in CLIENT_FILES.items()}\n"
                   "AXI_TEXT = AXI_MODULE_PATH.read_text()\n",
    },
    "an imported source path's file name loaded from the test install": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: _LOADER
            + "import subprocess\nimport sys\n"
              "from tests.client import client_script, load_client\n"
              "from test_planted_surface import AXI_MODULE_PATH, CLIENT_FILES\n"
              "def test_registrar():\n"
              "    _load_module_by_path(client_script(AXI_MODULE_PATH.name), 'axi')\n"
              "    load_client(AXI_MODULE_PATH.name)\n"
              "    for client, path in CLIENT_FILES.items():\n"
              "        subprocess.run([sys.executable, str(client_script(path.name))])\n",
    },
    "an imported source path copied into a temp install, the copy loaded": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: _LOADER
            + "import os\nimport shutil\nimport tempfile\n"
              "from test_planted_surface import AXI_MODULE_PATH\n"
              "def test_copy():\n"
              "    clients = os.path.join(tempfile.mkdtemp(), 'install', 'clients')\n"
              "    os.makedirs(clients)\n"
              "    copied = shutil.copy2(AXI_MODULE_PATH, clients)\n"
              "    _load_module_by_path(copied, 'copied_axi')\n",
    },
    "the exporter binds the names to the test install": {
        _EXPORTER: _INSTALL_EXPORTER,
        _IMPORTER: _LOADER
            + "from test_planted_surface import AXI_MODULE_PATH, CLIENT_FILES\n"
              "def test_load():\n"
              "    _load_module_by_path(AXI_MODULE_PATH, 'axi')\n"
              "    for client, path in CLIENT_FILES.items():\n"
              "        _load_module_by_path(path, client)\n",
    },
    "a source table's keys driving a spawner through the test install": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: "import subprocess\nimport sys\n"
                   "from tests.client import client_script\n"
                   "from test_planted_surface import CLIENTS, CLIENT_FILES\n"
                   "def _drive_help(client):\n"
                   "    return subprocess.run([sys.executable, str(client_script(client + '.py'))])\n"
                   "def test_help():\n"
                   "    for client in CLIENTS:\n"
                   "        _drive_help(client)\n"
                   "    for client in CLIENT_FILES:\n"
                   "        _drive_help(client)\n"
                   "    for client in sorted(CLIENT_FILES.keys()):\n"
                   "        _drive_help(client)\n",
    },
    "an imported source path handed to a linter, not run": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: "import subprocess\nimport sys\n"
                   "from test_planted_surface import AXI_MODULE_PATH, CLIENT_FILES\n"
                   "RUFF = [sys.executable, '-m', 'ruff']\n"
                   "def test_lint():\n"
                   "    subprocess.run([*RUFF, 'check', *(str(p) for p in CLIENT_FILES.values())])\n"
                   "    subprocess.run([sys.executable, '-m', 'ruff', 'check', str(AXI_MODULE_PATH)])\n",
    },
    "a value computed from a source path, not the path": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: _LOADER
            + "from test_planted_surface import CLIENT_FILES\n"
              "def census(paths):\n"
              "    return [p.name for p in paths]\n"
              "def test_census():\n"
              "    names = census(CLIENT_FILES.values())\n"
              "    text = CLIENT_FILES['python'].read_text()\n"
              "    _load_module_by_path(names, text)\n",
    },
    "a source path named only in comments, docstrings and messages": {
        _EXPORTER: _SOURCE_EXPORTER,
        _IMPORTER: '"""Loads AXI_MODULE_PATH with spec_from_file_location."""\n'
                   "import unittest\n"
                   "from test_planted_surface import AXI_MODULE_PATH\n"
                   "# spec_from_file_location('axi', AXI_MODULE_PATH)\n"
                   "class T(unittest.TestCase):\n"
                   "    def test_x(self):\n"
                   "        self.assertTrue(AXI_MODULE_PATH.name, f'see {AXI_MODULE_PATH}')\n",
    },
}


class NoTestLoadsAClientFromASourcePathItImportedTest(unittest.TestCase):

    def test_the_guard_flags_each_planted_load_of_an_imported_source_path(self):
        for shape, texts in PLANTED_LOADS.items():
            with self.subTest(shape=shape):
                offenders = imported_source_path_offenders(texts)
                self.assertEqual(
                    [path for path, _line, _call in offenders],
                    [os.path.normpath(_IMPORTER)],
                    f"{shape}: exactly one load or spawn, in the importer: {offenders}")

    def test_the_guard_names_the_line_and_the_call_that_loads(self):
        texts = PLANTED_LOADS["an imported path spawned with the interpreter"]
        self.assertEqual(
            imported_source_path_offenders(texts),
            [(os.path.normpath(_IMPORTER), 5, "run")])

    def test_the_guard_passes_each_planted_clean_use(self):
        for shape, texts in PLANTED_CLEAN.items():
            with self.subTest(shape=shape):
                self.assertEqual(imported_source_path_offenders(texts), [], shape)

    def test_the_scan_covers_the_python_suite(self):
        scanned, _offenders = suite_imported_source_path_offenders()
        self.assertTrue(150 <= scanned <= 2000,
                        f"the scan read {scanned} python modules under {TESTS_DIR}")

    def test_no_test_module_loads_or_spawns_a_client_source_path_it_imported(self):
        _scanned, offenders = suite_imported_source_path_offenders()
        self.assertEqual(
            offenders, [],
            f"{len(offenders)} load(s) or spawn(s) of a client SOURCE path imported "
            f"from another test module; load or spawn through the test install "
            f"(`client_script`, `load_client`), keep the source for reads and "
            f"copies:\n" + "\n".join(f"{path}:{line} {call}"
                                     for path, line, call in offenders))


if __name__ == "__main__":
    unittest.main()
