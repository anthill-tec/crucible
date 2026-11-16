"""No test builds its own path to the checkout's client source.

The suite reaches its clients through ONE place, the `tests.client`
package: the test install's client paths to LOAD or SPAWN a client, and the
checkout's client source directory to READ client source or COPY it into a
test's own install. A module that builds its own path to the checkout's
`clients/` loads or spawns a client whose install is the repo root, and so
reads the operator's root `crucible.toml`.

"Builds a path" means one of:

- a `clients` path segment joined to a base derived from the repo:
  `__file__` (the module's own, or an imported repo module's), `REPO_ROOT`
  and its aliases (any name bound to a repo-derived value, or a conventional
  repo-root name the module does not bind), or `parents[n]`. The joins
  looked at: `/`, `os.path.join`, `Path(base, ...)`, `.joinpath`, an
  f-string, `str(base) + "/..."`, `"%s/..." % base`, `"{}/...".format(base)`,
  and `"/".join([base, ...])` or `os.sep.join([base, ...])`. A `*starred`
  argument is spread into the elements it names;
- a relative `clients/...` used as a spawn argument (`subprocess.*`,
  `os.exec*`/`spawn*`, `asyncio.create_subprocess_exec`), an import path
  (`spec_from_file_location`, `SourceFileLoader`, `runpy.run_path`,
  `sys.path`), or a file read (`open`, `io.open`, `Path(...).read_text`,
  `read_bytes`, `open`).

Exempt: comments and docstrings (the scan reads the syntax tree), assertion
and message text (an f-string or string concatenation inside an `assert`
message, a `raise`, or an `assert*`/`fail`/`print` call, and there a `%`, a
`.format` or a `.join` too), and paths under a
temp base (a base not derived from the repo is never a repo path). The
`tests.client` package itself is the one module allowed to build the path.

The scan follows names through the module's own assignments (including `for`
and comprehension targets), through `from tests... import` to the module
that binds them, and through `..` and `dirname`/`parent`/`parents[n]` to the
repo-relative path the expression names, so `<repo>/crucible_axi/clients`
(the wheel's package data) is not the checkout's `clients/`.
"""

import ast
import itertools
import os
import string
import unittest
from collections import defaultdict
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = TESTS_DIR.parent

#: The one module allowed to build the path: the suite's package.
HELPER_MODULE = "tests.client"

#: Conventional repo-root names, honoured when the module does not bind them.
REPO_ALIASES = frozenset({
    "REPO_ROOT", "_REPO_ROOT", "REPO", "_REPO", "ROOT", "_ROOT", "REPO_DIR",
    "_REPO_DIR", "PROJECT_ROOT", "_PROJECT_ROOT", "CHECKOUT", "CHECKOUT_ROOT",
    "REPOSITORY_ROOT",
})

#: A repo-derived value whose place in the repo the scan cannot tell.
UNKNOWN = "<somewhere in the repo>"

_MAX_LITERALS = 64

_PATH_TYPES = frozenset({"pathlib.Path", "pathlib.PurePath", "pathlib.PosixPath",
                         "pathlib.PurePosixPath", "Path", "PurePath"})
_JOINS = frozenset({"os.path.join", "posixpath.join"})
#: Separators whose `.join` of a list builds a path.
_SEPARATORS = frozenset({"os.sep", "os.path.sep", "posixpath.sep"})
#: The `%` conversions a path base is formatted with.
_PERCENT_FIELDS = ("%s", "%r")
_DIRNAMES = frozenset({"os.path.dirname", "posixpath.dirname"})
_IDENTITIES = frozenset({"str", "os.fspath", "os.path.abspath", "os.path.realpath",
                         "os.path.normpath", "os.path.expanduser"})
_SPAWNS = frozenset({
    "subprocess.run", "subprocess.Popen", "subprocess.call", "subprocess.check_call",
    "subprocess.check_output", "asyncio.create_subprocess_exec", "os.execv",
    "os.execve", "os.execvp", "os.execvpe", "os.execl", "os.execlp", "os.spawnv",
    "os.spawnve", "os.spawnvp", "os.spawnl", "os.spawnlp", "os.posix_spawn",
})
_EVERY_ARG_SPAWNS = frozenset({"asyncio.create_subprocess_exec", "os.execl",
                               "os.execlp", "os.spawnl", "os.spawnlp"})
_READS = frozenset({"open", "io.open", "tokenize.open", "codecs.open"})
_PATH_READS = frozenset({"read_text", "read_bytes", "open"})
_MESSAGE_METHODS = frozenset({"fail", "subTest", "skipTest", "warn", "warning",
                              "error", "info", "debug", "write"})


def _dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def _apply(base, pieces):
    """`base` (repo-relative parts) joined with the string `pieces`."""
    if base is None:
        return None
    if base == UNKNOWN:
        return UNKNOWN
    parts = list(base)
    for piece in pieces:
        if piece.startswith("/"):
            return None
        for component in piece.split("/"):
            if component in ("", "."):
                continue
            if component == "..":
                if not parts:
                    return UNKNOWN
                parts.pop()
            else:
                parts.append(component)
    return tuple(parts)


def _up(base, levels):
    if base is None:
        return None
    if base == UNKNOWN or levels is None or len(base) < levels:
        return UNKNOWN
    return base[:len(base) - levels]


def _suffixes(texts):
    """The path pieces a string CONCATENATED onto a base adds: only a text
    that starts a new component (`/clients/...`) adds one."""
    return sorted(text[1:] for text in texts if text.startswith("/"))


def _leading_components(pieces):
    return [c for piece in pieces for c in piece.split("/") if c not in ("", ".")]


def _is_relative_clients(text):
    if not isinstance(text, str) or text.startswith("/"):
        return False
    components = [c for c in text.split("/") if c not in ("", ".")]
    return components[:1] == ["clients"]


def _module_file(dotted):
    """The repo-relative parts of the file a dotted repo module lives in."""
    base = REPO_ROOT.joinpath(*dotted.split("."))
    for candidate in (base.with_suffix(".py"), base / "__init__.py"):
        if candidate.is_file():
            return candidate.relative_to(REPO_ROOT).parts
    return None


_SCANNERS = {}


def _scanner_for(dotted):
    """The scanner of a repo module, by dotted name, or None."""
    if dotted not in _SCANNERS:
        parts = _module_file(dotted)
        scanner = None
        if parts is not None:
            path = REPO_ROOT.joinpath(*parts)
            try:
                scanner = _ClientsPathScanner(path.read_text(encoding="utf-8"), parts)
            except SyntaxError:
                scanner = None
        _SCANNERS[dotted] = scanner
    return _SCANNERS[dotted]


class _ClientsPathScanner:
    """One module's syntax tree, its bindings and imports, and the builds of a
    path to the checkout's `clients/` it holds."""

    def __init__(self, text, parts):
        self.tree = ast.parse(text)
        self.parts = tuple(parts)
        self.key = ".".join(self.parts).removesuffix(".py")
        self.package = self.parts[:-1]
        self.bindings = defaultdict(list)
        self.imports = {}
        self._name_paths = {}
        self._collect()

    # -- bindings and imports ---------------------------------------------

    def _bind(self, target, kind, node, index=None):
        if isinstance(target, ast.Name):
            self.bindings[target.id].append((kind, node, index))
        elif isinstance(target, (ast.Tuple, ast.List)):
            for position, element in enumerate(target.elts):
                if kind == "expr" and isinstance(node, (ast.Tuple, ast.List)) \
                        and len(node.elts) == len(target.elts):
                    self._bind(element, "expr", node.elts[position])
                elif kind == "iter" and isinstance(element, ast.Name):
                    self.bindings[element.id].append(("item", node, position))

    def _collect(self):
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    self._bind(target, "expr", node.value)
            elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)) and node.value is not None:
                self._bind(node.target, "expr", node.value)
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                self._bind(node.target, "iter", node.iter)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.asname:
                        self.imports[alias.asname] = ("module", alias.name)
                    else:
                        head = alias.name.split(".")[0]
                        self.imports[head] = ("module", head)
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                if node.level:
                    base = self.package[:len(self.package) - (node.level - 1)]
                    module = ".".join([*base, *([module] if module else [])])
                for alias in node.names:
                    self.imports[alias.asname or alias.name] = ("from", module, alias.name)

    def canonical(self, func):
        dotted = _dotted(func)
        if dotted is None:
            return None
        head, _, rest = dotted.partition(".")
        if head in self.bindings and head not in self.imports:
            return "<local>." + dotted
        imported = self.imports.get(head)
        if imported is None:
            return dotted
        target = imported[1] if imported[0] == "module" else f"{imported[1]}.{imported[2]}"
        return f"{target}.{rest}" if rest else target

    # -- repo-relative path an expression names ---------------------------

    def name_path(self, name, seen):
        if (self.key, name) in seen:
            return None
        seen = seen | {(self.key, name)}
        if not seen - {(self.key, name)} and name in self._name_paths:
            return self._name_paths[name]
        found = None
        if name in self.bindings:
            results = [self.path_of(node, seen) for kind, node, _ in self.bindings[name]
                       if kind == "expr"]
            known = [r for r in results if r is not None and r != UNKNOWN]
            found = known[0] if known else (UNKNOWN if UNKNOWN in results else None)
        elif name in self.imports and self.imports[name][0] == "from":
            _, module, attribute = self.imports[name]
            scanner = _scanner_for(module)
            if scanner is not None and attribute in scanner.bindings:
                found = scanner.name_path(attribute, seen)
            elif attribute in REPO_ALIASES:
                found = ()
        elif name in REPO_ALIASES:
            found = ()
        if len(seen) == 1:
            self._name_paths[name] = found
        return found

    def module_file(self, node):
        if isinstance(node, ast.Name):
            imported = self.imports.get(node.id)
            if imported is None:
                return UNKNOWN if node.id in self.bindings else None
            dotted = imported[1] if imported[0] == "module" else f"{imported[1]}.{imported[2]}"
            return _module_file(dotted)
        return None

    def path_of(self, node, seen=frozenset()):
        if isinstance(node, ast.Name):
            if node.id == "__file__":
                return self.parts
            return self.name_path(node.id, seen)
        if isinstance(node, ast.Attribute):
            if node.attr == "__file__":
                return self.module_file(node.value)
            if node.attr in REPO_ALIASES:
                return ()
            if node.attr == "parent":
                return _up(self.path_of(node.value, seen), 1)
            return None
        if isinstance(node, ast.Subscript):
            if isinstance(node.value, ast.Attribute) and node.value.attr == "parents":
                index = node.slice.value if isinstance(node.slice, ast.Constant) else None
                base = self.path_of(node.value.value, seen)
                if base is None:
                    return UNKNOWN if self.unplaceable(node.value.value) else None
                return _up(base, index + 1 if isinstance(index, int) else None)
            return None
        formatted = self.formatted_base(node)
        if formatted is not None:
            base = self.path_of(formatted[0], seen)
            if base is None:
                return None
            suffixes = _suffixes({formatted[1]})
            return _apply(base, suffixes[:1]) if len(suffixes) == 1 else UNKNOWN
        separated = self.separator_joined(node)
        if separated:
            return self.joined(self.path_of(separated[0], seen), separated[1:], seen)
        if isinstance(node, ast.Call):
            name = self.canonical(node.func)
            arguments = self.spread(node.args)
            if name in _IDENTITIES and node.args:
                return self.path_of(node.args[0], seen)
            if name in _DIRNAMES and node.args:
                return _up(self.path_of(node.args[0], seen), 1)
            if (name in _JOINS or name in _PATH_TYPES) and arguments:
                return self.joined(self.path_of(arguments[0], seen), arguments[1:], seen)
            if isinstance(node.func, ast.Attribute):
                if node.func.attr in ("resolve", "absolute", "expanduser"):
                    return self.path_of(node.func.value, seen)
                if node.func.attr == "joinpath":
                    return self.joined(self.path_of(node.func.value, seen), arguments, seen)
            return None
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            return self.joined(self.path_of(node.left, seen), [node.right], seen)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            base = self.path_of(node.left, seen)
            if base is None:
                return None
            suffixes = _suffixes(self.literals(node.right))
            return _apply(base, suffixes[:1]) if len(suffixes) == 1 else UNKNOWN
        if isinstance(node, ast.JoinedStr):
            base, texts = self.fstring_parts(node, seen)
            if base is None:
                return None
            suffixes = _suffixes(texts or ())
            return _apply(base, suffixes[:1]) if len(suffixes) == 1 else UNKNOWN
        return None

    def formatted_base(self, node):
        """`(the value formatted first, the text right after it)` for a `%` or
        `str.format` string whose text starts with that value, else None."""
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
            texts = self.literals(node.left)
            if len(texts) != 1:
                return None
            text = next(iter(texts))
            values = node.right.elts if isinstance(node.right, ast.Tuple) else [node.right]
            if text[:2] not in _PERCENT_FIELDS or not values:
                return None
            return values[0], text[2:].split("%", 1)[0]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr == "format":
            texts = self.literals(node.func.value)
            if len(texts) != 1:
                return None
            try:
                fields = list(string.Formatter().parse(next(iter(texts))))
            except ValueError:
                return None
            if not fields or fields[0][0] or fields[0][1] is None:
                return None
            field = fields[0][1]
            if field.isdigit() or field == "":
                index = int(field or 0)
                value = node.args[index] if index < len(node.args) else None
            else:
                value = next((k.value for k in node.keywords if k.arg == field), None)
            if value is None or isinstance(value, ast.Starred):
                return None
            return value, fields[1][0] if len(fields) > 1 else ""
        return None

    def separator_joined(self, node):
        """The elements a `"/".join([...])` or `os.sep.join([...])` joins, else
        an empty list."""
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "join" and len(node.args) == 1):
            return []
        separator = node.func.value
        if self.canonical(separator) not in _SEPARATORS \
                and self.literals(separator) != frozenset({"/"}):
            return []
        return self.elements(node.args[0])

    def spread(self, arguments):
        """`arguments` with each `*starred` one spread into the elements it
        names; stops at a starred one it cannot spread."""
        out = []
        for argument in arguments:
            if isinstance(argument, ast.Starred):
                elements = self.elements(argument.value)
                if not elements:
                    break
                out.extend(elements)
            else:
                out.append(argument)
        return out

    def unplaceable(self, node):
        """A value the module never binds: a parameter, or an attribute of
        `self`/`cls` -- its place in the repo cannot be told."""
        while isinstance(node, (ast.Attribute, ast.Call)):
            node = node.value if isinstance(node, ast.Attribute) else node.func
        return isinstance(node, ast.Name) and node.id not in self.bindings \
            and node.id not in self.imports and node.id not in REPO_ALIASES

    def joined(self, base, segments, seen):
        if base is None:
            return None
        pieces = []
        for segment in segments:
            texts = self.literals(segment)
            if len(texts) != 1:
                return UNKNOWN
            pieces.append(next(iter(texts)))
        return _apply(base, pieces)

    def fstring_parts(self, node, seen):
        values = node.values
        if not values or not isinstance(values[0], ast.FormattedValue):
            return None, None
        base = self.path_of(values[0].value, seen)
        rest = values[1:]
        if all(isinstance(v, ast.Constant) for v in rest):
            return base, ["".join(v.value for v in rest)]
        return base, None

    # -- the strings an expression can be ----------------------------------

    def literals(self, node, seen=frozenset()):
        if isinstance(node, ast.Constant):
            return frozenset({node.value}) if isinstance(node.value, str) else frozenset()
        if isinstance(node, ast.Name):
            if (self.key, node.id) in seen:
                return frozenset()
            seen = seen | {(self.key, node.id)}
            found = set()
            for kind, value, index in self.bindings.get(node.id, ()):
                if kind == "expr":
                    found |= self.literals(value, seen)
                else:
                    for element in self.elements(value, seen):
                        if kind == "item":
                            if isinstance(element, (ast.Tuple, ast.List)) \
                                    and index < len(element.elts):
                                found |= self.literals(element.elts[index], seen)
                        else:
                            found |= self.literals(element, seen)
            if not self.bindings.get(node.id) and node.id in self.imports \
                    and self.imports[node.id][0] == "from":
                _, module, attribute = self.imports[node.id]
                scanner = _scanner_for(module)
                if scanner is not None:
                    found |= scanner.literals(ast.Name(id=attribute), seen)
            return frozenset(itertools.islice(found, _MAX_LITERALS))
        if isinstance(node, ast.JoinedStr):
            choices = []
            for value in node.values:
                if isinstance(value, ast.Constant):
                    choices.append({value.value})
                elif isinstance(value, ast.FormattedValue):
                    texts = self.literals(value.value, seen)
                    if not texts:
                        return frozenset()
                    choices.append(texts)
            return self._products(choices, "")
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Div)):
            left, right = self.literals(node.left, seen), self.literals(node.right, seen)
            if not left or not right:
                return frozenset()
            joiner = "" if isinstance(node.op, ast.Add) else "/"
            return self._products([left, right], joiner)
        if isinstance(node, ast.Call):
            name = self.canonical(node.func)
            if (name in _JOINS or name in _PATH_TYPES or name in _IDENTITIES) and node.args:
                parts = [self.literals(arg, seen) for arg in node.args]
                if all(parts):
                    return self._products(parts, "/")
        return frozenset()

    @staticmethod
    def _products(choices, joiner):
        out = set()
        for combo in itertools.islice(itertools.product(*choices), _MAX_LITERALS):
            out.add(joiner.join(combo))
        return frozenset(out)

    def elements(self, node, seen=frozenset()):
        if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
            out = []
            for element in node.elts:
                if isinstance(element, ast.Starred):
                    out.extend(self.elements(element.value, seen))
                else:
                    out.append(element)
            return out
        if isinstance(node, ast.Name):
            if (self.key, node.id) in seen:
                return []
            seen = seen | {(self.key, node.id)}
            out = []
            for kind, value, _ in self.bindings.get(node.id, ()):
                if kind == "expr":
                    out.extend(self.elements(value, seen))
            return out
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return self.elements(node.left, seen) + self.elements(node.right, seen)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) \
                and node.func.id in ("sorted", "tuple", "list") and node.args:
            return self.elements(node.args[0], seen)
        return []

    # -- the builds ---------------------------------------------------------

    def _message_nodes(self):
        """Every node that is assertion or message text."""
        marked = set()

        def mark(node):
            for inner in ast.walk(node):
                marked.add(id(inner))
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Assert) and node.msg is not None:
                mark(node.msg)
            elif isinstance(node, ast.Raise) and node.exc is not None:
                mark(node.exc)
            elif isinstance(node, ast.Call):
                func = node.func
                is_message = (
                    (isinstance(func, ast.Attribute)
                     and (func.attr.startswith("assert") or func.attr in _MESSAGE_METHODS))
                    or (isinstance(func, ast.Name) and func.id == "print"))
                if is_message:
                    for argument in [*node.args, *(k.value for k in node.keywords)]:
                        for inner in ast.walk(argument):
                            if isinstance(inner, (ast.JoinedStr, ast.BinOp)) or (
                                    isinstance(inner, ast.Call)
                                    and isinstance(inner.func, ast.Attribute)
                                    and inner.func.attr in ("format", "join")):
                                mark(inner)
        return marked

    def _enters_clients(self, base_node, pieces_choices):
        base = self.path_of(base_node)
        if base is None:
            return False
        for pieces in itertools.islice(itertools.product(*pieces_choices), _MAX_LITERALS):
            if base == UNKNOWN:
                if _leading_components(pieces)[:1] == ["clients"]:
                    return True
                continue
            result = _apply(base, pieces)
            if base[:1] != ("clients",) and isinstance(result, tuple) \
                    and result[:1] == ("clients",):
                return True
        return False

    def _segment_choices(self, segments):
        choices = []
        for segment in segments:
            texts = self.literals(segment)
            if not texts:
                break
            choices.append(sorted(texts))
        return choices

    def _join_build(self, node, messages):
        formatted = self.formatted_base(node)
        if formatted is not None:
            if id(node) in messages:
                return False
            suffixes = _suffixes({formatted[1]})
            return bool(suffixes) and self._enters_clients(formatted[0], [suffixes])
        separated = self.separator_joined(node)
        if separated:
            if id(node) in messages:
                return False
            return self._enters_clients(separated[0], self._segment_choices(separated[1:]))
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            return self._enters_clients(node.left, self._segment_choices([node.right]))
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            if id(node) in messages:
                return False
            suffixes = _suffixes(self.literals(node.right))
            return bool(suffixes) and self._enters_clients(node.left, [suffixes])
        if isinstance(node, ast.JoinedStr):
            if id(node) in messages or not node.values \
                    or not isinstance(node.values[0], ast.FormattedValue):
                return False
            following = node.values[1] if len(node.values) > 1 else None
            if not isinstance(following, ast.Constant):
                return False
            suffixes = _suffixes({following.value})
            return bool(suffixes) and self._enters_clients(node.values[0].value, [suffixes])
        if isinstance(node, ast.Call):
            name = self.canonical(node.func)
            arguments = self.spread(node.args)
            if (name in _JOINS or name in _PATH_TYPES) and len(arguments) > 1:
                return self._enters_clients(arguments[0], self._segment_choices(arguments[1:]))
            if isinstance(node.func, ast.Attribute) and node.func.attr == "joinpath" \
                    and arguments:
                return self._enters_clients(node.func.value, self._segment_choices(arguments))
        return False

    def _relative_clients_in(self, node):
        return any(_is_relative_clients(text) for text in self.literals(node))

    def _relative_use(self, node):
        if not isinstance(node, ast.Call):
            return False
        name = self.canonical(node.func)
        arguments = list(node.args)
        if name in _SPAWNS:
            candidates = arguments if name in _EVERY_ARG_SPAWNS else arguments[:1]
            candidates += [k.value for k in node.keywords if k.arg == "args"]
            for candidate in candidates:
                for element in [candidate, *self.elements(candidate)]:
                    for text in self.literals(element):
                        if any(_is_relative_clients(token) for token in text.split()):
                            return True
            return False
        tail = name.rsplit(".", 1)[-1] if name else None
        if tail in ("spec_from_file_location", "SourceFileLoader"):
            located = arguments[1:2] + [k.value for k in node.keywords
                                        if k.arg in ("location", "path")]
            return any(self._relative_clients_in(a) for a in located)
        if name == "runpy.run_path" and arguments:
            return self._relative_clients_in(arguments[0])
        if name in ("sys.path.insert", "sys.path.append"):
            target = arguments[1:2] if name.endswith("insert") else arguments[:1]
            return any(self._relative_clients_in(a) for a in target)
        if name in _READS and arguments:
            return self._relative_clients_in(arguments[0])
        if isinstance(node.func, ast.Attribute) and node.func.attr in _PATH_READS:
            return self._relative_clients_in(node.func.value)
        return False

    def offenders(self):
        messages = self._message_nodes()
        found = []
        for node in ast.walk(self.tree):
            if self._join_build(node, messages) or self._relative_use(node):
                found.append((getattr(node, "lineno", 0), ast.unparse(node)[:140]))
        return sorted(set(found))


def clients_path_offenders(text, relative_path="tests/client/test_planted.py"):
    """`[(line, spelling)]` for every build of a path to the checkout's
    `clients/` in the module source `text`, scanned as if it lived at
    `relative_path` in the repo."""
    return _ClientsPathScanner(text, Path(relative_path).parts).offenders()


def _python_modules():
    for directory, subdirectories, files in os.walk(TESTS_DIR):
        subdirectories[:] = sorted(d for d in subdirectories
                                   if d not in ("node_modules", "__pycache__"))
        for name in sorted(files):
            if name.endswith(".py"):
                yield Path(directory, name)


def suite_offenders():
    """`(modules scanned, ["<module>:<line>: <spelling>"])` over `tests/`."""
    scanned, offenders = 0, []
    for path in _python_modules():
        parts = path.relative_to(REPO_ROOT).parts
        dotted = ".".join(parts).removesuffix(".py").removesuffix(".__init__")
        if dotted == HELPER_MODULE:
            continue
        scanned += 1
        scanner = _scanner_for(dotted) if _module_file(dotted) == parts else None
        if scanner is None:
            try:
                scanner = _ClientsPathScanner(path.read_text(encoding="utf-8"), parts)
            except SyntaxError:
                continue  # a deliberately broken fixture runs nothing
        for line, spelling in scanner.offenders():
            offenders.append(f"{'/'.join(parts)}:{line}: {spelling}")
    return scanned, offenders


# --------------------------------------------------------------------------- #
# Planted modules: one per spelling, each holding exactly one build
# --------------------------------------------------------------------------- #

_ROOT_PREAMBLE = (
    "import os\nimport subprocess\nimport sys\nfrom pathlib import Path\n"
    "REPO_ROOT = Path(__file__).resolve().parents[2]\n")

PLANTED_BUILDS = {
    "the repo root alias divided by clients":
        _ROOT_PREAMBLE + 'CLIENTS_DIR = REPO_ROOT / "clients"\n',
    "parents[n] of __file__ divided by clients":
        "from pathlib import Path\n"
        'CLIENTS = Path(__file__).resolve().parents[2] / "clients"\n',
    "a parent chain of __file__ divided by clients and a script":
        "from pathlib import Path\n"
        'SCRIPT = Path(__file__).parent.parent.parent / "clients" / "python-crucible.py"\n',
    "os.path.join of a dirname chain of __file__":
        "import os\n"
        "CLIENTS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname("
        'os.path.abspath(__file__)))), "clients")\n',
    "os.path.join climbing out of the module directory":
        "import os\n"
        'SCRIPT = os.path.join(os.path.dirname(__file__), "..", "..", "clients", '
        '"bun-crucible.py")\n',
    "os.path.join of a repo root imported from a harness":
        "import os\nfrom tests.client.live_run_harness import REPO_ROOT\n"
        'SCRIPT = os.path.join(REPO_ROOT, "clients", "python-crucible.py")\n',
    "joinpath on the repo root":
        _ROOT_PREAMBLE + 'SCRIPT = REPO_ROOT.joinpath("clients", "go-crucible.py")\n',
    "Path of the repo root and clients":
        _ROOT_PREAMBLE + 'CLIENTS = Path(REPO_ROOT, "clients")\n',
    "an f-string on the repo root":
        _ROOT_PREAMBLE + 'SCRIPT = f"{REPO_ROOT}/clients/rust-crucible.py"\n',
    "str of the repo root concatenated":
        _ROOT_PREAMBLE + 'SCRIPT = str(REPO_ROOT) + "/clients/mvn-crucible.py"\n',
    "a percent format on the repo root":
        _ROOT_PREAMBLE + 'CLIENTS = "%s/clients" % REPO_ROOT\n',
    "str.format on the repo root":
        _ROOT_PREAMBLE + 'CLIENTS = "{}/clients".format(REPO_ROOT)\n',
    "a slash join of the repo root and clients":
        _ROOT_PREAMBLE + 'CLIENTS = "/".join([REPO_ROOT, "clients"])\n',
    "os.sep.join of the repo root and clients":
        _ROOT_PREAMBLE + 'CLIENTS = os.sep.join([str(REPO_ROOT), "clients"])\n',
    "joinpath of starred parts naming clients":
        _ROOT_PREAMBLE
        + 'PARTS = ("clients", "python-crucible.py")\n'
        "SCRIPT = REPO_ROOT.joinpath(*PARTS)\n",
    "a repo root under a name of the module's own":
        "from pathlib import Path\n"
        "TOP = Path(__file__).resolve().parents[2]\n"
        'CORE = TOP / "clients/_crucible_axi.py"\n',
    "a segment reached through a loop variable":
        _ROOT_PREAMBLE
        + 'SITES = ("clients/_crucible_axi.py", "crucible_axi/install.py")\n'
        "def read_all():\n"
        "    return [(REPO_ROOT / site).read_text() for site in SITES]\n",
    "an imported repo module's __file__":
        "import os\nfrom crucible_axi import manifest\n"
        "CHECKOUT = os.path.join(os.path.dirname(os.path.dirname("
        'os.path.abspath(manifest.__file__))), "clients")\n',
    "parents[n] of a value the module cannot place":
        "def clients_of(here):\n"
        '    return here.parents[1] / "clients"\n',
    "a relative script spawned":
        _ROOT_PREAMBLE
        + 'subprocess.run([sys.executable, "clients/python-crucible.py", "status"], '
        "cwd=REPO_ROOT, check=False)\n",
    "a relative script spawned through an argv variable":
        "import subprocess\nimport sys\n"
        'ARGV = [sys.executable, "./clients/bun-crucible.py", "--help"]\n'
        "subprocess.Popen(ARGV)\n",
    "a relative script spawned by a bare imported runner":
        "from subprocess import check_output\n"
        'check_output(["python3", "clients/go-crucible.py"])\n',
    "a relative script in a shell command":
        "import subprocess\n"
        'subprocess.run("python3 clients/arduino-crucible.py --help", shell=True)\n',
    "a relative module loaded by file location":
        "import importlib.util\n"
        'SPEC = importlib.util.spec_from_file_location("core", "clients/_crucible_axi.py")\n',
    "a relative directory put on sys.path":
        'import sys\nsys.path.insert(0, "clients")\n',
    "a relative module run by path":
        'import runpy\nrunpy.run_path("clients/toon.py")\n',
    "a relative file opened":
        'with open("clients/crucible.toml", "rb") as handle:\n    handle.read()\n',
    "a relative file read through Path":
        "from pathlib import Path\n"
        'TEXT = Path("clients/_crucible_board.py").read_text()\n',
}

PLANTED_CORRECT_USES = {
    "the helper's constants and functions":
        "import subprocess\nimport sys\n"
        "from tests.client import CLIENT_SOURCE_DIR, TEST_INSTALL_CLIENTS, "
        "client_script, load_client\n"
        'SOURCE = (CLIENT_SOURCE_DIR / "_crucible_axi.py").read_text()\n'
        'CONFIG = TEST_INSTALL_CLIENTS / "crucible.toml"\n'
        'subprocess.run([sys.executable, str(client_script("python-crucible.py")), "--help"])\n'
        'CORE = load_client("python-crucible.py")\n',
    "a copy of the source into a temp install":
        "import os\nimport shutil\nimport tempfile\nfrom pathlib import Path\n"
        "from tests.client import CLIENT_SOURCE_DIR\n"
        "install = tempfile.mkdtemp()\n"
        'shutil.copytree(CLIENT_SOURCE_DIR, os.path.join(install, "clients"))\n'
        'SCRATCH = Path(tempfile.mkdtemp()) / "clients" / "python-crucible.py"\n'
        "ROOT = tempfile.mkdtemp()\n"
        'FLEET = Path(ROOT) / "clients"\n',
    "comments and docstrings":
        '"""Reads REPO_ROOT / "clients" and runs clients/python-crucible.py."""\n'
        '# CLIENTS = REPO_ROOT / "clients"\n'
        "def f():\n"
        '    """subprocess.run([sys.executable, "clients/python-crucible.py"])"""\n',
    "assertion and message text":
        "import unittest\nfrom pathlib import Path\n"
        "REPO_ROOT = Path(__file__).resolve().parents[2]\n"
        "class T(unittest.TestCase):\n"
        "    def test_x(self):\n"
        '        text = "x"\n'
        '        self.assertIn("clients/_crucible_axi.py", text, '
        'f"{REPO_ROOT}/clients must hold the core")\n'
        '        assert text, f"see {REPO_ROOT}/clients"\n'
        '        raise AssertionError(str(REPO_ROOT) + "/clients is missing")\n',
    "format, percent and join in message text or under a temp base":
        "import os\nimport tempfile\nimport unittest\nfrom pathlib import Path\n"
        "REPO_ROOT = Path(__file__).resolve().parents[2]\n"
        'SCRATCH = "%s/clients" % tempfile.mkdtemp()\n'
        'OTHER = "/".join([tempfile.gettempdir(), "clients"])\n'
        "class T(unittest.TestCase):\n"
        "    def test_x(self):\n"
        '        self.fail("{}/clients".format(REPO_ROOT))\n'
        '        self.fail("%s/clients" % REPO_ROOT)\n'
        '        print(os.sep.join([str(REPO_ROOT), "clients"]))\n',
    "relative client paths kept as data":
        'OUTSIDE = ("clients/python-crucible.py", "src/server.ts")\n'
        "def classify(path):\n"
        '    return path.startswith("tests/")\n'
        "KINDS = [classify(p) for p in OUTSIDE]\n",
    "a relative clients path under a temp base":
        "import os\nimport tempfile\n"
        'with open(os.path.join(tempfile.gettempdir(), "clients/x.py"), "w") as handle:\n'
        '    handle.write("")\n',
}


class NoTestBuildsItsOwnPathToTheClientSourceTest(unittest.TestCase):

    def test_the_guard_flags_each_planted_spelling_exactly_once(self):
        for spelling, text in PLANTED_BUILDS.items():
            with self.subTest(spelling=spelling):
                offenders = clients_path_offenders(text)
                last_code_line = max(
                    node.lineno for node in ast.walk(ast.parse(text))
                    if isinstance(node, ast.stmt))
                self.assertEqual(len(offenders), 1, f"{spelling}: {offenders}")
                self.assertGreaterEqual(offenders[0][0], last_code_line - 1,
                                        f"{spelling}: flagged the wrong line: {offenders}")

    def test_the_guard_passes_each_planted_correct_use(self):
        for use, text in PLANTED_CORRECT_USES.items():
            with self.subTest(use=use):
                self.assertEqual(clients_path_offenders(text), [], use)

    def test_the_guard_does_not_take_the_wheels_package_data_for_the_checkouts_clients(self):
        text = ("import os\nfrom crucible_axi import manifest\n"
                "PACKAGE = os.path.dirname(os.path.abspath(manifest.__file__))\n"
                'DATA = os.path.join(PACKAGE, "clients")\n'
                'CHECKOUT = os.path.join(os.path.dirname(PACKAGE), "clients")\n')
        offenders = clients_path_offenders(text)
        self.assertEqual([line for line, _ in offenders], [5], offenders)

    def test_the_scan_covers_the_python_suite(self):
        scanned, _offenders = suite_offenders()
        self.assertTrue(150 <= scanned <= 2000,
                        f"the scan read {scanned} python modules under {TESTS_DIR}")

    def test_no_test_module_builds_its_own_path_to_the_client_source(self):
        _scanned, offenders = suite_offenders()
        self.assertEqual(
            offenders, [],
            f"{len(offenders)} build(s) of a path to the checkout's clients/ outside "
            f"the tests.client package; load or spawn through the test install, read "
            f"or copy through the client source constant:\n" + "\n".join(offenders))


if __name__ == "__main__":
    unittest.main()
