"""The helpers of `test_cr054_fleet_inventory.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import ast
from tests.client import TEST_INSTALL_CLIENTS


CLIENTS_DIR = TEST_INSTALL_CLIENTS

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}


def _defined_function_names(path):
    """Every FunctionDef/AsyncFunctionDef name defined anywhere in `path`
    (top-level or nested), via ast.parse -- returns a dict name -> occurrence
    count so a caller can also detect an accidental duplicate top-level def."""
    tree = ast.parse(path.read_text(), filename=str(path))
    counts = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            counts[node.name] = counts.get(node.name, 0) + 1
    return counts


def _add_parser_verb_names(path):
    """Every string literal a file passes as the FIRST positional argument of
    an `add_parser(...)` call -- the verb names that file registers. Read from
    the AST rather than by grep, so a name inside a docstring or a help string
    can never be mistaken for a registration."""
    names = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "add_parser"):
            continue
        if node.args and isinstance(node.args[0], ast.Constant) \
                and isinstance(node.args[0].value, str):
            names.add(node.args[0].value)
    return names


def _single_verb_registrar_delegator(path, registrar):
    """The delegator a file hands a SHARED one-verb registrar
    (`add_next_verb(...)`, `add_cr_depends_verb(...)`), read from the call's
    second positional argument. A one-verb registrar takes a plain callable
    where `add_roadmap_verbs` takes a verb-name -> delegator dict -- the
    registration a client owns is still exactly this one name, read from the
    AST rather than by grep."""
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == registrar):
            continue
        if len(node.args) >= 2 and isinstance(node.args[1], ast.Name):
            return node.args[1].id
    return None


def _status_verb_registration(path):
    """The (verb names, help text) argparse advertises for the status/plans
    verb PAIR in `path`. All five clients register the pair with one loop
    (`for _name in ("status", "plans"): sub.add_parser(_name, help=...)`), so
    the extraction keys off that idiom rather than a line number: find the
    `for` whose iterable is a literal tuple naming `status`, and return its
    `add_parser(help=...)` constant. Returns (None, None) when a client stops
    using the shared idiom -- reported as a failure below, never as a silent
    pass on a surface that moved."""
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.For):
            continue
        try:
            names = ast.literal_eval(node.iter)
        except (ValueError, SyntaxError):
            continue
        if not isinstance(names, (tuple, list)) or "status" not in names:
            continue
        for call in ast.walk(node):
            if not (isinstance(call, ast.Call)
                    and isinstance(call.func, ast.Attribute)
                    and call.func.attr == "add_parser"):
                continue
            for kw in call.keywords:
                if kw.arg == "help" and isinstance(kw.value, ast.Constant):
                    return tuple(names), kw.value.value
    return None, None
