"""An eda run files every skip pytest's JUnit holds as `pending`, and lists
only the `SKIPPED` lines of pytest's `-v` output in `skipped[]`.

One scratch copy of `tests/fixtures/eda-project` declares one entry,
`integration/held`, over `tests/held`, which holds:

- a file whose module-level `pytestmark = pytest.mark.skip(...)` skips its
  two tests;
- a file that calls `pytest.skip(..., allow_module_level=True)` while it is
  collected, so none of its tests is collected;
- a file whose one test is `@pytest.mark.xfail` and fails.

The REAL `clients/eda-crucible.py` runs the `integration` verb as an OS
subprocess, in a recording interpreter that hands each call to this suite's
own interpreter (which has pytest 9.1.1), filing to a REAL throwaway board
(`tests/client/real_board.py`) behind a recording proxy. What pytest wrote is
read back through what the board stored and what the envelope states:

- the board stores the run with passed 0, failed 0 and pending 4: each
  marked test, the file skipped while collected, and the expected failure;
- `skipped[]` lists the two marked tests alone, each with the mark's reason:
  the collection skip and the expected failure have no `SKIPPED` line;
- the run's verdict, its entry's and the envelope's, is `skip`, and its
  `tier-skipped` warning counts all 4 as skipped; the verb exits 0.

A missing `bun` FAILS every test here, naming it.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_an_eda_run_files_module_skips_and_xfails_as_pending
"""

import shutil
import unittest
from pathlib import Path

from tests.client.eda_project_harness import (
    BoardDrive,
    EdaProject,
    RecordingInterpreter,
    diagnostics,
    scratch,
)
from tests.client.real_board import RealBoard

_MODULE = {}

AGENT = "eda-held-skips"
TIER_SKIPPED = "tier-skipped"
ENTRY = "integration/held"
HELD_ENTRY = f'[targets."{ENTRY}"]\nframework = "eda-pytest"\npaths = ["tests/held"]\n'

MARKED_REASON = "the bench rig is not wired"
_MARKED_CHECK = f'''"""Two gates skipped by a module-level mark."""

import pytest

pytestmark = pytest.mark.skip(reason={MARKED_REASON!r})


def test_the_rig_powers_the_board():
    assert True


def test_the_rig_reads_the_clock():
    assert True
'''
MARKED_SKIPS = ["tests/held/check_marked.py::test_the_rig_powers_the_board",
                "tests/held/check_marked.py::test_the_rig_reads_the_clock"]

_COLLECTION_SKIP_CHECK = '''"""A file skipped while it is collected."""

import pytest

pytest.skip("the probe library is absent", allow_module_level=True)


def test_the_probe_answers():
    assert True
'''

_XFAIL_CHECK = '''"""One gate expected to fail."""

import pytest


@pytest.mark.xfail(reason="the ERC rule is not written yet")
def test_the_erc_rule_holds():
    assert False
'''


def setUpModule():
    bun = shutil.which("bun")
    if bun is None:
        _MODULE["gap"] = "bun is not on PATH: this run files to a real board"
        return
    _MODULE["board"] = RealBoard(bun, "eda-held-skips", proxy=True)


def tearDownModule():
    board = _MODULE.pop("board", None)
    if board is not None:
        board.close()


class AnEntryOfMarkedCollectionSkippedAndExpectedFailuresTest(unittest.TestCase):
    """`integration` over the one `integration/held` entry, driven once."""

    maxDiff = 8000

    @classmethod
    def setUpClass(cls):
        cls.gap = _MODULE.get("gap")
        if cls.gap:
            return
        cls.board = _MODULE["board"]
        cls.project = EdaProject(cls, board=cls.board, project_key=cls.board.key)
        cls.project.declare_only_the_board()
        cls.project.write("tests/held/check_marked.py", _MARKED_CHECK)
        cls.project.write("tests/held/check_collection_skip.py", _COLLECTION_SKIP_CHECK)
        cls.project.write("tests/held/check_xfail.py", _XFAIL_CHECK)
        cls.project.declare(HELD_ENTRY)
        cls.python = RecordingInterpreter(
            Path(scratch(cls, "eda-held-python-"), "bin", "python"))
        registered = cls.project.drive("register", "--role", "report", agent=AGENT)
        if registered.returncode != 0:
            raise RuntimeError(f"register {AGENT}: {diagnostics(registered)}")
        proxy = cls.board.proxy
        mark = proxy.count()
        result = cls.project.drive("integration", agent=AGENT, python=cls.python.path)
        cls.drive = BoardDrive(result, proxy.since(mark), cls.python.calls(),
                               cls.project.child_env_records())

    def setUp(self):
        if self.gap:
            self.fail(f"missing toolchain: {self.gap}")

    def the_envelope(self):
        if self.drive.axi is None:
            self.fail(f"stdout must be one AXI envelope; {self.drive.diag()}")
        return self.drive.axi

    def test_the_board_stores_every_skip_and_the_expected_failure_as_pending(self):
        stored = self.board.test_events(AGENT)
        self.assertEqual(len(stored), 1, f"one run is stored; {stored!r} {self.drive.diag()}")
        self.assertEqual({k: stored[0].get(k) for k in ("total", "passed", "failed", "pending")},
                         {"total": 4, "passed": 0, "failed": 0, "pending": 4},
                         f"the stored run; {stored[0]!r} {self.drive.diag()}")

    def test_the_envelope_states_the_filed_counts_for_the_run_and_its_entry(self):
        axi = self.the_envelope()
        run = axi.get("run") or {}
        self.assertEqual({k: run.get(k) for k in ("passed", "failed", "pending")},
                         {"passed": 0, "failed": 0, "pending": 4},
                         f"the run block; {self.drive.diag()}")
        self.assertEqual([(e.get("key"), e.get("passed"), e.get("failed"), e.get("pending"))
                          for e in axi.get("entries") or []],
                         [(ENTRY, 0, 0, 4)], self.drive.diag())

    def test_only_the_marked_tests_are_listed_as_skipped(self):
        axi = self.the_envelope()
        self.assertEqual(axi.get("skipped"),
                         [{"test": test, "reason": MARKED_REASON} for test in MARKED_SKIPS],
                         f"the SKIPPED lines alone; {self.drive.diag()}")
        self.assertEqual(axi.get("skippedNotListed"), 0, self.drive.diag())

    def test_the_run_is_a_skip_and_exits_0(self):
        axi = self.the_envelope()
        self.assertEqual(axi.get("verdict"), "skip", f"the envelope's verdict; {self.drive.diag()}")
        self.assertEqual([(e.get("key"), e.get("verdict")) for e in axi.get("entries") or []],
                         [(ENTRY, "skip")], self.drive.diag())
        self.assertEqual(self.drive.result.returncode, 0, self.drive.diag())
        self.assertEqual([w.get("detail") for w in self.drive.warnings_coded(TIER_SKIPPED)],
                         [f"{ENTRY}: all 4 tests skipped"], self.drive.diag())


if __name__ == "__main__":
    unittest.main()
