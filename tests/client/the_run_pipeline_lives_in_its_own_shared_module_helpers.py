"""The plain helpers of `test_the_run_pipeline_lives_in_its_own_shared_module.py`,
lifted out of that test module so a suite importing them does not import a
test module (CR-CRU-261).

Holds no `TestCase` and no test: the source directory of the shared modules,
the top-level-name scan and the run module's view of the core.
"""

import ast

from tests.client import CLIENT_SOURCE_DIR

CLIENTS = CLIENT_SOURCE_DIR


def _target_names(target):
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [name for element in target.elts for name in _target_names(element)]
    return []


def top_level_definitions(tree):
    """Every name `tree` binds at its top level by `def`, `class` or an
    assignment, in source order and with repeats: imports bind nothing here."""
    names = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                names += _target_names(target)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.append(node.target.id)
    return names


def is_core_view(value, core):
    """`value` is the run module's view of `core`: the core itself, or an
    object or mapping through which `core.post_ingest` is reached."""
    if value is core:
        return True
    if getattr(value, "post_ingest", None) is core.post_ingest:
        return True
    getter = getattr(value, "get", None)
    if callable(getter):
        try:
            return getter("post_ingest") is core.post_ingest
        except (TypeError, AttributeError, KeyError):
            # A `get` that is not a mapping's (a class's unbound method, one
            # taking other arguments) is not a view of the core.
            return False
    return False
