"""The rust client's `_smoke_refusal` is indented as it runs.

Its disk-guard check is one merged condition --
`if args.all_features and not _disk_guard(...)` -- whose body once sat a
level deeper than the `if`, left over from the two nested `if`s it was
merged from. Python accepts any deeper indent for a block, so the code ran
the same, but it read as nested one level deeper than it is.

The check is made on the parsed source: every block in `_smoke_refusal`
starts exactly one indent level (four columns) inside the statement that
opens it. The checker is proved on synthetic sources first.
"""

import ast
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RUST_CLIENT = REPO_ROOT / "clients" / "rust-crucible.py"
INDENT = 4


def _child_blocks(node):
    """Yield (block statements, opening column) for each block `node` opens.

    An `elif` arrives as an `orelse` holding one `If` at the parent's own
    column; its blocks are checked against that column, not as an `else`.
    """
    for field in ("body", "orelse", "finalbody"):
        block = getattr(node, field, None)
        if not block or not isinstance(block, list):
            continue
        if (field == "orelse" and isinstance(node, ast.If) and len(block) == 1
                and isinstance(block[0], ast.If)
                and block[0].col_offset == node.col_offset):
            continue
        yield block, node.col_offset
    for handler in getattr(node, "handlers", []) or []:
        yield handler.body, handler.col_offset
    for case in getattr(node, "cases", []) or []:
        yield case.body, case.pattern.col_offset - INDENT


def misindented_blocks(function):
    """Return [(line, column, expected column)] for every statement in
    `function` that does not sit exactly one indent level inside the
    statement opening its block."""
    offenders = []
    for node in ast.walk(function):
        if not isinstance(node, ast.stmt):
            continue
        for block, opener_column in _child_blocks(node):
            expected = opener_column + INDENT
            for statement in block:
                if statement.col_offset != expected:
                    offenders.append(
                        (statement.lineno, statement.col_offset, expected))
    return sorted(offenders)


def _function(source, name):
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"no top-level function {name!r}")


def _calls(node, name):
    return any(
        isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name)
        and sub.func.id == name
        for sub in ast.walk(node))


class IndentationCheckerTest(unittest.TestCase):
    """The checker flags a block indented deeper than its opener and
    accepts one indented truly."""

    OVER_INDENTED = textwrap.dedent("""\
        def refusal(args):
            if args.a and not guard(
                                    args):
                    emit(args)
                    return 2
            return None
        """)

    TRUE = textwrap.dedent("""\
        def refusal(args):
            if args.a and not guard(
                                    args):
                emit(args)
                return 2
            elif args.b:
                return 3
            else:
                try:
                    emit(args)
                except OSError:
                    return 4
            return None
        """)

    def test_a_merged_if_body_left_a_level_deep_is_flagged(self):
        self.assertEqual(
            misindented_blocks(_function(self.OVER_INDENTED, "refusal")),
            [(4, 12, 8), (5, 12, 8)])

    def test_blocks_indented_one_level_inside_their_opener_are_clean(self):
        self.assertEqual(misindented_blocks(_function(self.TRUE, "refusal")),
                         [])


class SmokeRefusalIndentationTest(unittest.TestCase):
    """`_smoke_refusal`'s merged disk-guard condition keeps its shape, and
    every block in the function sits one level inside its opener."""

    @classmethod
    def setUpClass(cls):
        cls.function = _function(RUST_CLIENT.read_text(encoding="utf-8"),
                                 "_smoke_refusal")

    def _disk_guard_if(self):
        guards = [node for node in ast.walk(self.function)
                  if isinstance(node, ast.If) and _calls(node.test, "_disk_guard")]
        self.assertEqual(len(guards), 1,
                         "expected exactly one `if` whose condition calls "
                         "_disk_guard in _smoke_refusal")
        return guards[0]

    def test_disk_guard_check_is_one_merged_condition(self):
        guard = self._disk_guard_if()
        condition = guard.test
        if not isinstance(condition, ast.BoolOp):
            self.fail(f"expected one `and` condition, got {ast.dump(condition)}")
        self.assertIsInstance(condition.op, ast.And)
        self.assertEqual(guard.orelse, [])
        last = guard.body[-1]
        if not isinstance(last, ast.Return) or last.value is None:
            self.fail(f"expected the body to end in `return 2`, got {ast.dump(last)}")
        self.assertEqual(ast.literal_eval(last.value), 2)

    def test_disk_guard_body_sits_one_level_inside_its_if(self):
        guard = self._disk_guard_if()
        columns = [statement.col_offset for statement in guard.body]
        self.assertEqual(
            columns, [guard.col_offset + INDENT] * len(guard.body),
            f"the merged disk-guard `if` opens at column {guard.col_offset}; "
            f"its body must sit at column {guard.col_offset + INDENT}, found "
            f"columns {columns}")

    def test_every_block_in_smoke_refusal_sits_one_level_inside_its_opener(self):
        self.assertEqual(
            misindented_blocks(self.function), [],
            "statements in _smoke_refusal as (line, column, expected column)")


if __name__ == "__main__":
    unittest.main()
