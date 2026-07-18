"""CR-CRU-013 C4 — `clients/toon.py`: a fleet-shared Python TOON codec ported
from the MIT `@toon-format/toon` TS reference, pinned against OUR narrow
4-construct subset (docs/research/DN-crucible-toon-subset.md), NOT the full
upstream spec (no delimiter variants, no key-path expansion, no inline
primitive-array short form — those are outside the pinned subset).

Contract: `encode(obj) -> str` (Python dict/list -> TOON text) and
`decode(text) -> obj` (TOON text -> Python dict/list), mirroring
`toToon()` in src/toon.ts construct-for-construct:
  1. Scalar line            `key: val`
  2. Nested object          `key:` + 2-space-indented child lines
  3. Uniform object array   `name[N]{col1,col2}:` + comma-joined rows
  4. List array             `name[N]:` + one indented line per item

RED phase: clients/toon.py does not exist yet (confirmed — `ls clients/`
shows no toon.py). Every test below fails via FileNotFoundError raised by
`_load_toon_module()`'s `exec_module()` call — a missing-SUT-module error,
a valid RED per the CR-CRU-013 RED-agent dispatch instructions.

Invocation:
    python3 -m pytest tests/client/test_toon.py -q      (fallback)
    python3 -m xmlrunner tests.client.test_toon           (crucible harness)
"""

import importlib.util
import json
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TOON_PATH = REPO_ROOT / "clients" / "toon.py"
FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "no-mistakes-axi-status.toon"


def _load_toon_module():
    """Load clients/toon.py by file path (mirrors the existing
    tests/client/test_bun_crucible_context.py loader pattern used for the
    other hyphenated client scripts). Deliberately does NOT skip when the
    file is missing — a FileNotFoundError from exec_module() during RED is
    the expected failure, not something to swallow."""
    spec = importlib.util.spec_from_file_location("toon_under_test", TOON_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ToonModuleTestCase(unittest.TestCase):
    def setUp(self):
        self.toon = _load_toon_module()


# --------------------------------------------------------------------------
# Construct 1 — scalar line: `key: val`
# --------------------------------------------------------------------------
class ScalarLineConstructTest(ToonModuleTestCase):
    def test_encode_bool_and_int_scalars_join_with_newline(self):
        result = self.toon.encode({"ok": True, "n": 3})
        self.assertEqual(result, "ok: true\nn: 3")
        # negative: must not fall back to JSON-ish `true`/`True` casing errors
        self.assertNotIn("True", result)

    def test_encode_null_renders_as_bare_null_literal(self):
        self.assertEqual(self.toon.encode({"note": None}), "note: null")

    def test_decode_scalar_line_parses_bool_int_null_with_real_types(self):
        result = self.toon.decode("ok: true\nn: 3\nnote: null")
        self.assertEqual(result, {"ok": True, "n": 3, "note": None})
        self.assertIsInstance(result["n"], int)
        self.assertIsInstance(result["ok"], bool)
        self.assertIsNone(result["note"])

    def test_round_trip_scalar_construct(self):
        original = {"ok": True, "n": 3, "note": None}
        self.assertEqual(self.toon.decode(self.toon.encode(original)), original)

    def test_round_trip_empty_object(self):
        # toToon({}) === "" in src/toon.ts — the degenerate scalar-construct case.
        self.assertEqual(self.toon.decode(self.toon.encode({})), {})


# --------------------------------------------------------------------------
# Construct 2 — nested object: `key:` + 2-space-indented child lines
# --------------------------------------------------------------------------
class NestedObjectConstructTest(ToonModuleTestCase):
    def test_encode_nested_object_indents_child_lines_two_spaces(self):
        result = self.toon.encode({"store": {"path": "crucible.db", "open": True}})
        self.assertEqual(result, "store:\n  path: crucible.db\n  open: true")

    def test_decode_nested_object(self):
        result = self.toon.decode("store:\n  path: crucible.db\n  open: true")
        self.assertEqual(result, {"store": {"path": "crucible.db", "open": True}})
        self.assertIsInstance(result["store"], dict)

    def test_round_trip_deeply_nested_object(self):
        original = {"a": {"b": {"c": "deep"}}}
        self.assertEqual(self.toon.decode(self.toon.encode(original)), original)
        # bound: no extra top-level keys leak in from the nesting walk
        self.assertEqual(set(self.toon.decode(self.toon.encode(original)).keys()), {"a"})


# --------------------------------------------------------------------------
# Construct 3 — uniform object array (table form):
# `name[N]{col1,col2}:` + one comma-joined row per item
# --------------------------------------------------------------------------
class UniformTableConstructTest(ToonModuleTestCase):
    def test_encode_uniform_table_matches_dn_example(self):
        result = self.toon.encode({"events": [{"id": "a", "n": 1}, {"id": "b", "n": 2}]})
        self.assertEqual(result, "events[2]{id,n}:\n  a,1\n  b,2")

    def test_decode_uniform_table_matches_dn_example(self):
        result = self.toon.decode("events[2]{id,n}:\n  a,1\n  b,2")
        self.assertEqual(result, {"events": [{"id": "a", "n": 1}, {"id": "b", "n": 2}]})
        self.assertEqual(len(result["events"]), 2)

    def test_round_trip_uniform_table_construct(self):
        original = {"events": [{"id": "a", "n": 1}, {"id": "b", "n": 2}]}
        self.assertEqual(self.toon.decode(self.toon.encode(original)), original)

    def test_decode_uniform_table_mixed_int_and_float_columns(self):
        # Adapted from @toon-format/toon-python's own decode/arrays-tabular.json
        # fixture ("parses tabular arrays of uniform objects") — within our
        # subset (scalar-only cells, table form).
        result = self.toon.decode("items[2]{sku,qty,price}:\n  A1,2,9.99\n  B2,1,14.5")
        self.assertEqual(
            result,
            {"items": [{"sku": "A1", "qty": 2, "price": 9.99}, {"sku": "B2", "qty": 1, "price": 14.5}]},
        )
        self.assertIsInstance(result["items"][0]["qty"], int)
        self.assertIsInstance(result["items"][0]["price"], float)

    def test_decode_uniform_table_null_and_quoted_cell(self):
        # Adapted from the same upstream fixture family ("parses nulls and
        # quoted values in tabular rows").
        result = self.toon.decode('items[2]{id,value}:\n  1,null\n  2,"test"')
        self.assertEqual(result, {"items": [{"id": 1, "value": None}, {"id": 2, "value": "test"}]})
        self.assertIsNone(result["items"][0]["value"])

    def test_round_trip_table_cell_with_comma_is_quoted(self):
        original = {"events": [{"id": "a,b", "n": 1}]}
        encoded = self.toon.encode(original)
        self.assertEqual(encoded, f'events[1]{{id,n}}:\n  {json.dumps("a,b")},1')
        self.assertEqual(self.toon.decode(encoded), original)

    def test_round_trip_table_cell_with_double_quote_is_quoted(self):
        original = {"events": [{"id": 'a"b', "n": 1}]}
        encoded = self.toon.encode(original)
        quoted_cell = json.dumps('a"b')
        self.assertEqual(encoded, f'events[1]{{id,n}}:\n  {quoted_cell},1')
        self.assertEqual(self.toon.decode(encoded), original)


# --------------------------------------------------------------------------
# Construct 4 — list array: `name[N]:` + one indented line per item
# --------------------------------------------------------------------------
class ListArrayConstructTest(ToonModuleTestCase):
    def test_encode_string_list_matches_dn_example(self):
        result = self.toon.encode({"help": ["do x", "see y"]})
        self.assertEqual(result, "help[2]:\n  do x\n  see y")

    def test_decode_string_list_matches_dn_example(self):
        result = self.toon.decode("help[2]:\n  do x\n  see y")
        self.assertEqual(result, {"help": ["do x", "see y"]})
        self.assertEqual(len(result["help"]), 2)

    def test_round_trip_string_list_construct(self):
        original = {"help": ["do x", "see y"]}
        self.assertEqual(self.toon.decode(self.toon.encode(original)), original)

    def test_encode_empty_array_matches_dn_example(self):
        self.assertEqual(self.toon.encode({"items": []}), "items[0]:")

    def test_decode_empty_array_matches_dn_example(self):
        result = self.toon.decode("items[0]:")
        self.assertEqual(result, {"items": []})
        self.assertEqual(len(result["items"]), 0)

    def test_round_trip_empty_array(self):
        original = {"items": []}
        self.assertEqual(self.toon.decode(self.toon.encode(original)), original)

    def test_round_trip_list_item_with_quoted_special_chars(self):
        original = {"help": ["a,b", "c:d"]}
        encoded = self.toon.encode(original)
        self.assertEqual(encoded, f'help[2]:\n  {json.dumps("a,b")}\n  {json.dumps("c:d")}')
        self.assertEqual(self.toon.decode(encoded), original)


# --------------------------------------------------------------------------
# DN quoting-rule table — scalar-line vs table-cell trigger sets differ
# (scalar: `\n : , { } [ ]`; table cell: `" , \n`). Both are documented
# subset edge cases, not upstream-generic behavior.
# --------------------------------------------------------------------------
class QuotingRuleEdgeCaseTest(ToonModuleTestCase):
    def test_plain_string_scalar_stays_unquoted(self):
        self.assertEqual(self.toon.encode({"msg": "hello world"}), "msg: hello world")

    def test_comma_containing_scalar_is_json_quoted(self):
        original = {"msg": "a,b"}
        encoded = self.toon.encode(original)
        self.assertEqual(encoded, f'msg: {json.dumps("a,b")}')
        self.assertEqual(self.toon.decode(encoded), original)

    def test_newline_containing_scalar_is_json_quoted(self):
        original = {"msg": "a\nb"}
        encoded = self.toon.encode(original)
        self.assertEqual(encoded, f'msg: {json.dumps("a\nb")}')
        self.assertEqual(self.toon.decode(encoded), original)

    def test_colon_containing_scalar_is_json_quoted(self):
        original = {"msg": "a:b"}
        encoded = self.toon.encode(original)
        self.assertEqual(encoded, f'msg: {json.dumps("a:b")}')
        self.assertEqual(self.toon.decode(encoded), original)

    def test_brace_containing_scalar_is_json_quoted(self):
        original = {"msg": "a{b}c"}
        encoded = self.toon.encode(original)
        self.assertEqual(encoded, f'msg: {json.dumps("a{b}c")}')
        self.assertEqual(self.toon.decode(encoded), original)

    def test_bracket_containing_scalar_is_json_quoted(self):
        original = {"msg": "a[b]c"}
        encoded = self.toon.encode(original)
        self.assertEqual(encoded, f'msg: {json.dumps("a[b]c")}')
        self.assertEqual(self.toon.decode(encoded), original)

    def test_scalar_containing_only_a_bare_double_quote_stays_unquoted(self):
        # Asymmetry pinned by the DN table: `"` triggers quoting for TABLE
        # CELLS but is absent from the scalar-line special-char set — a
        # scalar with only an embedded quote (no comma/colon/brace/bracket/
        # newline) must render bare, unlike the equivalent table cell.
        original = {"msg": 'he said "hi"'}
        encoded = self.toon.encode(original)
        self.assertEqual(encoded, 'msg: he said "hi"')
        self.assertNotEqual(encoded[5], '"')  # not quoted at the value boundary
        self.assertEqual(self.toon.decode(encoded), original)


# --------------------------------------------------------------------------
# Decode of the REAL captured no-mistakes sample (DN §S5 — "confirms it is
# exactly the 4-construct subset src/toon.ts encodes").
# --------------------------------------------------------------------------
class DecodeNoMistakesFixtureTest(ToonModuleTestCase):
    EXPECTED_STEPS = [
        {"step": "intent", "status": "completed", "findings": 0, "duration_ms": 18310},
        {"step": "rebase", "status": "completed", "findings": 0, "duration_ms": 2111},
        {"step": "review", "status": "completed", "findings": 1, "duration_ms": 1141578},
        {"step": "test", "status": "completed", "findings": 0, "duration_ms": 433639},
        {"step": "document", "status": "completed", "findings": 0, "duration_ms": 585974},
        {"step": "lint", "status": "completed", "findings": 0, "duration_ms": 105771},
        {"step": "push", "status": "completed", "findings": 0, "duration_ms": 3104},
        {"step": "pr", "status": "skipped", "findings": 0, "duration_ms": 724},
        {"step": "ci", "status": "skipped", "findings": 0, "duration_ms": 675},
    ]

    def test_decode_no_mistakes_fixture_yields_run_step_ladder_and_outcome(self):
        raw = FIXTURE_PATH.read_text()
        result = self.toon.decode(raw)

        self.assertIsInstance(result, dict)
        self.assertIn("run", result)
        run = result["run"]
        self.assertIsInstance(run, dict)

        self.assertEqual(run["id"], "01KXHKJ76N6S25M46XRCTCNT61")
        self.assertEqual(run["branch"], "develop")
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["head"], "66cda00c")
        self.assertEqual(run["findings"], "1 info")

        steps = run["steps"]
        self.assertEqual(len(steps), 9)
        self.assertEqual(steps, self.EXPECTED_STEPS)
        for step in steps:
            self.assertIsInstance(step["findings"], int)
            self.assertIsInstance(step["duration_ms"], int)

        # outcome is a TOP-LEVEL sibling of `run`, not nested under it.
        self.assertEqual(result["outcome"], "passed")
        self.assertNotIn("outcome", run)

        # bound: exactly these two top-level keys, nothing stray leaked in.
        self.assertEqual(set(result.keys()), {"run", "outcome"})


# --------------------------------------------------------------------------
# Decode error paths — adapted from @toon-format/toon-python's own
# decode/validation-errors.json fixture (row/column count mismatch), the
# reference test-vector source the CR names for pinning C4 against.
# --------------------------------------------------------------------------
class DecodeErrorPathTest(ToonModuleTestCase):
    def test_decode_raises_on_tabular_row_with_too_few_cells(self):
        # header declares 2 columns {id,name}; the second row supplies only 1 cell.
        with self.assertRaises(Exception):
            self.toon.decode("items[2]{id,name}:\n  1,Ada\n  2")

    def test_decode_raises_on_tabular_row_count_mismatch(self):
        # header declares [2] items; only 1 row is actually supplied.
        with self.assertRaises(Exception):
            self.toon.decode("items[2]{id}:\n  1")


if __name__ == "__main__":
    unittest.main()
