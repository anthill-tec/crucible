"""A python coverage run names its least covered files, on a real board.

A scratch python project declares its coverage source as one package of
twelve source files, with its tests outside that package. The real
`python-crucible.py regression --coverage` runs it with the repo's own
interpreter and its real coverage.py, against a real scratch board
(`tests/client/real_board.py`), which keeps the run's coverage file by file.

  * The run's envelope states the `coverage` block with `fileCount: 12`, ten
    rows and `moreFiles: 2`.
  * Its rows are the first ten files the board answers for that event on its
    `?depth=coverage` read, in the board's order, each figure the board's own.
  * `run <that event> --files all` lists the twelve.

Nothing here is scripted: the files, their figures and their order are what
the board stored, read back over HTTP.

Each source file has twelve one-line functions and the tests call a different
number of them in each file, so no two files are covered alike. The package
holds those twelve files and nothing else: it has no `__init__.py`, which the
board would keep as a thirteenth file.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_python_coverage_run_names_its_files_on_a_real_board
"""

import contextlib
import io
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.kept_coverage_answer import ROW_KEYS
from tests.client.live_run_harness import load_client, load_toon
from tests.client.python_coverage_project import drive, scrubbed_coverage_env
from tests.client.real_board import RealBoard

TOON = load_toon()

PACKAGE = "shop"
SOURCE_FILES = 12
FUNCTIONS_PER_FILE = 12
MODULES = ("basket", "catalogue", "checkout", "coupons", "customers",
           "delivery", "invoices", "pricing", "refunds", "returns", "stock",
           "taxes")
DECLARED_SOURCE = f'[tool.coverage.run]\nsource = ["{PACKAGE}"]\n'


def _source(module):
    return "\n\n".join(
        f"def {module}_step_{step}(amount):\n    return amount + {step}\n"
        for step in range(FUNCTIONS_PER_FILE))


def _tests():
    """One test per source file: the file at position `n` has its first `n`
    functions called."""
    lines = ["import os", "import sys", "import unittest", "",
             "sys.path.insert(0, os.path.dirname(os.path.dirname("
             "os.path.abspath(__file__))))", ""]
    lines += [f"from {PACKAGE} import {module}  # noqa: E402" for module in MODULES]
    lines += ["", "", "class ShopTest(unittest.TestCase):"]
    for position, module in enumerate(MODULES):
        lines.append(f"    def test_{module}(self):")
        lines.append(f"        self.assertEqual({position}, {position})")
        for step in range(position):
            lines.append(f"        self.assertEqual({module}.{module}_step_{step}(1), "
                         f"{step + 1})")
        lines.append("")
    return "\n".join(lines)


def project_files():
    files = {"pyproject.toml": DECLARED_SOURCE,
             "tests/__init__.py": "", "tests/test_shop.py": _tests()}
    for module in MODULES:
        files[f"{PACKAGE}/{module}.py"] = _source(module)
    return files


def listed_as_a_row(kept):
    """One file the board answers, as the block lists it."""
    lines = kept.get("lines") or {}
    functions = kept.get("functions") or {}
    return {"file": kept.get("path"), "linesPercent": lines.get("percent"),
            "linesCovered": lines.get("covered"), "linesTotal": lines.get("total"),
            "functionsPercent": functions.get("percent"),
            "functionsCovered": functions.get("covered"),
            "functionsTotal": functions.get("total")}


_BOARD: RealBoard | None = None


def setUpModule():
    global _BOARD
    bun = shutil.which("bun")
    if bun is None:
        raise unittest.SkipTest(
            "the board that keeps a run's coverage file by file is a real "
            "server, and without `bun` there is none to boot: a missing "
            "toolchain, not a passing assertion")
    _BOARD = RealBoard(bun, "python-coverage-files-e2e")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


class APythonCoverageRunNamesItsFilesOnARealBoardTest(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        board = _BOARD
        if board is None:
            raise AssertionError("the module's real board was never booted")
        cls.board = board
        cls.project = tempfile.mkdtemp(prefix="python-coverage-files-")
        cls.addClassCleanup(shutil.rmtree, cls.project, ignore_errors=True)
        for rel, text in project_files().items():
            path = Path(cls.project, rel)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        board.install(cls.project)
        # One coverage run for the whole class: every test reads what it filed.
        cls.run_drive = drive(cls.project, board, ("regression", "--coverage"))

    def block(self):
        """The `coverage` block of the coverage run's own envelope."""
        run = self.run_drive
        self.assertEqual(run.code, 0, f"the fixture's run is green; {run.describe()}")
        self.assertIsInstance(run.axi, dict, run.describe())
        axi = run.axi if isinstance(run.axi, dict) else {}
        self.assertIs(axi.get("ok"), True, run.describe())
        self.assertEqual((axi.get("run") or {}).get("passed"), SOURCE_FILES,
                         f"one passing test per source file; {run.describe()}")
        self.assertIn("coverage", axi,
                      f"a green coverage run states its block; {run.describe()}")
        return axi["coverage"]

    def stored_files(self, event, limit=None):
        """The files the board answers for `event`, in its order."""
        suffix = "?depth=coverage" + ("" if limit is None else f"&files={limit}")
        read = self.board.http(f"/api/v2/events/{event}{suffix}")
        self.assertIs(read.get("ok"), True, f"the board's coverage read; {read!r}")
        kept = read["event"]
        self.assertEqual(kept.get("coverageFileCount"), SOURCE_FILES,
                         f"the board kept the twelve declared source files; "
                         f"{kept.get('coverageFiles')!r}")
        return kept["coverageFiles"]

    def run_verb(self, event, *extra):
        """`run <event> …` through the real client against the real board:
        `(exit code, envelope, stderr)`."""
        module = load_client("python-crucible.py")
        argv = ["python-crucible.py", "run", event, *extra,
                "--project-dir", self.project]
        out, err = io.StringIO(), io.StringIO()
        with scrubbed_coverage_env(), mock.patch.object(sys, "argv", argv), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                module.main()
                code = 0
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else (
                    0 if exc.code is None else 1)
        text = out.getvalue()
        decoded = TOON.decode(text) if text.strip() else {}
        axi = decoded.get("axi") if isinstance(decoded, dict) else None
        return code, axi if isinstance(axi, dict) else {}, err.getvalue()

    def test_the_run_states_twelve_files_ten_rows_and_two_more(self):
        block = self.block()
        self.assertEqual(
            (block.get("fileCount"), len(block.get("files") or []),
             block.get("moreFiles")),
            (12, 10, 2), f"block={block!r}")
        self.assertEqual(list(block),
                         ["lines", "functions", "event", "fileCount", "moreFiles",
                          "files"], f"block={block!r}")
        for row in block["files"]:
            self.assertEqual(list(row), list(ROW_KEYS), f"row={row!r}")

    def test_the_runs_rows_are_the_first_ten_files_the_board_answers_in_its_order(self):
        block = self.block()
        event = block.get("event")
        self.assertIsInstance(event, str, f"the block names its run; block={block!r}")
        stored = self.stored_files(event)
        self.assertEqual(len(stored), 12, f"stored={stored!r}")
        self.assertEqual(block.get("files"),
                         [listed_as_a_row(kept) for kept in stored[:10]],
                         "the rows are the board's first ten, in its order, "
                         "each figure the board's own")
        self.assertEqual(block.get("files"),
                         [listed_as_a_row(kept)
                          for kept in self.stored_files(event, limit=10)])

    def test_the_twelve_files_are_the_declared_source_and_none_of_the_tests(self):
        stored = self.stored_files(self.block().get("event"))
        names = sorted(Path(kept["path"]).name for kept in stored)
        self.assertEqual(names, sorted(f"{module}.py" for module in MODULES),
                         f"the package's twelve modules and none of its "
                         f"tests; stored={stored!r}")
        self.assertEqual({Path(kept["path"]).parent.name for kept in stored},
                         {PACKAGE})
        percents = [kept["lines"]["percent"] for kept in stored]
        self.assertEqual(percents, sorted(percents),
                         "the board answers the least covered first")
        self.assertEqual(len(set(percents)), 12, "no two files are covered alike")

    def test_run_with_files_all_lists_the_twelve(self):
        block = self.block()
        event = block.get("event")
        stored = self.stored_files(event)
        code, axi, err = self.run_verb(event, "--files", "all")
        self.assertNotIn("unrecognized arguments", err,
                         f"the `run` verb takes `--files`; stderr={err[-800:]!r}")
        self.assertEqual(code, 0, f"envelope={axi!r} stderr={err[-800:]!r}")
        self.assertIs(axi.get("ok"), True, f"envelope={axi!r}")
        self.assertIn("coverage", axi,
                      f"`run` states the stored run's block; keys={list(axi)!r}")
        listed = axi["coverage"]
        self.assertEqual(
            (listed.get("event"), listed.get("fileCount"), listed.get("moreFiles")),
            (event, 12, 0), f"block={listed!r}")
        self.assertEqual(listed.get("files"),
                         [listed_as_a_row(kept) for kept in stored],
                         "every file the board holds for the run, in its order")
        self.assertEqual((listed.get("lines"), listed.get("functions")),
                         (block.get("lines"), block.get("functions")),
                         "the percents are the ones the run itself stated")

    def test_run_by_default_lists_the_ten_the_run_itself_stated(self):
        block = self.block()
        code, axi, err = self.run_verb(block.get("event"))
        self.assertEqual(code, 0, f"envelope={axi!r} stderr={err[-800:]!r}")
        self.assertEqual(axi.get("coverage"), block,
                         "read back, the run's block is the one its own "
                         "envelope stated")


if __name__ == "__main__":
    unittest.main()
