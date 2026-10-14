"""RED -- the two `parse_queue_table` defects (`clients/_crucible_axi.py`),
read directly off the function body:

  1. The header-detection condition only requires a `Wave` cell and a `CR`
     cell (`if "wave" in low and any(c == "cr" or c.startswith("cr ") for c
     in low): header = cells`) -- it never requires `Title` or `Depends on`.
     `idx["title"]`/`idx["depends"]` are then set via `_find_col`, which
     returns `None` for an absent column. On a real data row the function
     reaches `cells[idx["title"]]` (missing-title case) or
     `cells[idx["depends"]]` (missing-depends case) -- `cells[None]` --
     which raises `TypeError: list indices must be integers or slices, not
     NoneType`, never the function's own `QueueParseError`.
  2. When NO line in the text ever satisfies the header condition above,
     `header` stays `None` for the whole loop and every line is
     `continue`d -- the function returns `[]` silently. `cmd_queue_file`
     then POSTs that empty list to the full-replace queue endpoint instead
     of refusing (its own `except QueueParseError` branch, which already
     posts nothing and answers ok:false, is reached only once `parse_queue_
     table` actually raises -- a change this file does NOT need to test,
     since that branch is already correct and already tested elsewhere;
     only the raise itself is missing).

`parse_queue_table` is loaded directly from `clients/_crucible_axi.py` and
called as a pure function -- no client, no HTTP, no board -- since it has
exactly ONE shared implementation (`test_client_fleet_envelope_census.py`'s
own fleet classification confirms this is SHARED, not per-client, logic).
`cmd_queue_file`'s own "posts nothing" half is exercised with a hand-built
duck-typed `ClientOps` recording every POST, following the
`_RecordingOps` idiom already established across this directory (e.g.
`test_gate_respond_records_a_decision.py::_RecordingOps`).

Fixture CR ids are `QT-FIXTURE-NNN` -- not CR-shaped (`CR-[A-Z]+-[0-9]+`),
following the precedent already set by `test_client_fleet_envelope_census.py`
(`QF-CENSUS-NNN`) for the identical reason: a real board's own CR id in a
fixture table would be a claim about that board's queue."""

import importlib.util
import shutil
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AXI_PATH = REPO_ROOT / "clients" / "_crucible_axi.py"


def _load_axi(cache_key):
    spec = importlib.util.spec_from_file_location(cache_key, AXI_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# A header with CR + Wave + Depends on, but NO Title column.
_HEADER_NO_TITLE = ("| CR | Wave | Depends on |\n"
                    "|---|---|---|\n")
_ROW_NO_TITLE = "| [QT-FIXTURE-001](./QT-FIXTURE-001.md) | 3 | \u2014 |\n"

# A header with CR + Title + Wave, but NO Depends-on column.
_HEADER_NO_DEPENDS = ("| CR | Title | Wave |\n"
                      "|---|---|---|\n")
_ROW_NO_DEPENDS = "| [QT-FIXTURE-002](./QT-FIXTURE-002.md) | queued item | 4 |\n"

# A real Markdown table that is simply not the queue's own shape (no CR
# column, no Wave column) -- the text a stray doc table would give.
_NO_QUEUE_TABLE_TEXT = (
    "# Not a queue table\n\n"
    "This document has A table in it, but not the queue's own shape:\n\n"
    "| Name | Value |\n"
    "|---|---|\n"
    "| alpha | 1 |\n"
    "| beta | 2 |\n")


class ParseQueueTableMissingColumnTest(unittest.TestCase):
    """`parse_queue_table` raises `QueueParseError` naming the missing
    column -- never `TypeError` -- for a header without `title` and for one
    without `depends`."""

    def test_header_without_title_column_raises_queue_parse_error_naming_title(self):
        axi = _load_axi("qtable_no_title_axi")
        text = _HEADER_NO_TITLE + _ROW_NO_TITLE
        with self.assertRaises(axi.QueueParseError) as ctx:
            axi.parse_queue_table(text)
        self.assertIn(
            "title", str(ctx.exception).lower(),
            f"the QueueParseError must NAME the missing column -- got "
            f"{ctx.exception!r}")

    def test_header_without_depends_column_raises_queue_parse_error_naming_depends(self):
        axi = _load_axi("qtable_no_depends_axi")
        text = _HEADER_NO_DEPENDS + _ROW_NO_DEPENDS
        with self.assertRaises(axi.QueueParseError) as ctx:
            axi.parse_queue_table(text)
        self.assertIn(
            "depend", str(ctx.exception).lower(),
            f"the QueueParseError must NAME the missing column -- got "
            f"{ctx.exception!r}")

    def test_missing_title_never_raises_plain_typeerror(self):
        """A `TypeError` here is the EXACT defect this behaviour closes
        (`cells[idx["title"]]` == `cells[None]`) -- asserted explicitly
        because a bare `assertRaises(QueueParseError)` would also, less
        informatively, simply fail to catch a TypeError and report it as an
        unittest ERROR rather than naming what went wrong."""
        axi = _load_axi("qtable_no_title_typeerror_axi")
        text = _HEADER_NO_TITLE + _ROW_NO_TITLE
        try:
            axi.parse_queue_table(text)
        except TypeError as exc:
            self.fail(
                f"parse_queue_table raised a bare TypeError ({exc!r}) "
                f"instead of QueueParseError for a header missing its "
                f"Title column")
        except axi.QueueParseError:
            pass


class ParseQueueTableNoTableTest(unittest.TestCase):
    """`parse_queue_table` raises `QueueParseError` for text holding no
    queue table at all, rather than silently returning `[]`."""

    def test_text_with_no_queue_table_raises_queue_parse_error(self):
        axi = _load_axi("qtable_no_table_axi")
        with self.assertRaises(axi.QueueParseError):
            axi.parse_queue_table(_NO_QUEUE_TABLE_TEXT)


class _RecordingQueueOps:
    """The minimal duck-typed `ClientOps` subset `cmd_queue_file` reaches,
    recording every POST so "nothing was posted" is an observed fact, not
    an inference from the envelope alone."""

    def __init__(self):
        self.posts = []
        self.emitted = None

    def project_key(self, _project_dir):
        return "qtable-fixture-project-key"

    def post(self, path, payload):
        self.posts.append((path, payload))
        return {"ok": True, "unknownDependencies": []}

    def context(self, _project_dir, agent_id=None):
        return {}

    def emit(self, verb, ok, result_fields, context, warnings, legacy_line=None):
        self.emitted = {"verb": verb, "ok": ok, "fields": result_fields}


class QueueFileNoTableRefusesToPostTest(unittest.TestCase):
    """`queue-file` given a file with no queue table answers `ok: false`
    and posts nothing -- `cmd_queue_file`'s own `except QueueParseError`
    branch already does both correctly; what is missing is only that
    `parse_queue_table` must actually raise for this input to REACH it
    (today it returns `[]`, so `cmd_queue_file` falls through to its SUCCESS
    path and posts an empty full-replace instead)."""

    def setUp(self):
        self.axi = _load_axi("qtable_cmd_queue_file_axi")
        self.project_dir = tempfile.mkdtemp(prefix="qtable-no-table-project-")

    def tearDown(self):
        shutil.rmtree(self.project_dir, ignore_errors=True)

    def test_queue_file_posts_nothing_for_a_file_with_no_queue_table(self):
        queue_path = Path(self.project_dir) / "not-a-queue-table.md"
        queue_path.write_text(_NO_QUEUE_TABLE_TEXT, encoding="utf-8")
        args = Namespace(from_file=str(queue_path))
        ops = _RecordingQueueOps()

        code = self.axi.cmd_queue_file(args, self.project_dir, ops)

        self.assertEqual(
            ops.posts, [],
            f"queue-file must post NOTHING for a file with no queue table "
            f"-- it posted {ops.posts!r}")
        self.assertEqual(code, 1)
        self.assertIsNotNone(ops.emitted)
        assert ops.emitted is not None
        self.assertFalse(
            ops.emitted["ok"],
            f"queue-file's own envelope must be ok:false -- got "
            f"{ops.emitted!r}")


if __name__ == "__main__":
    unittest.main()
