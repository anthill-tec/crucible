"""An eda run files under the cycle its `--cycle` names, and warns `no-cycle`
without one.

One scratch copy of `tests/fixtures/eda-project` (its `unit` entry over
`tests/unit`) files to a REAL throwaway board (`tests/client/real_board.py`)
behind a recording proxy, through the REAL `clients/eda-crucible.py` run as an
OS subprocess in a recording interpreter that hands each call to this suite's
own interpreter (which has pytest). One agent, registered bound to no cycle,
drives in this order:

1. `test --tests tests/unit/check_board.py` and `unit`, each with no
   `--cycle`, while the project has no active cycle: each envelope carries
   the `no-cycle` warning, and neither the opened run, nor its ingest, nor the
   stored run names a cycle;
2. one plan is filed and its one cycle made active;
3. the same `test` and `unit`, each with `--cycle <that cycle>`: the run each
   opens and the ingest that files it carry `context.cycleId` = that cycle,
   the board stores the run under it, and the envelope carries no `no-cycle`
   warning.

A missing `bun` FAILS every test here, naming it.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_an_eda_run_files_under_the_cycle_its_cycle_flag_names
"""

import shutil
import unittest
from pathlib import Path

from tests.client import load_client
from tests.client.an_unattributed_run_is_refused_while_a_cycle_is_active_helpers import (
    _call,
)
from tests.client.eda_project_harness import (
    BoardDrive,
    EdaProject,
    RecordingInterpreter,
    diagnostics,
    scratch,
)
from tests.client.real_board import RealBoard

AXI = load_client("_crucible_axi.py")

_MODULE = {}

AGENT = "eda-cycle-filing"
NO_CYCLE = AXI.MISSING_CYCLE_CODE
RUN_START = "/api/v2/runs/start"
RUN_INGEST = "/api/v2/runs"
TEST_SELECTION = "tests/unit/check_board.py"


def setUpModule():
    bun = shutil.which("bun")
    if bun is None:
        _MODULE["gap"] = "bun is not on PATH: these runs file to a real board"
        return
    _MODULE["board"] = RealBoard(bun, "eda-cycle-filing", proxy=True)


def tearDownModule():
    board = _MODULE.pop("board", None)
    if board is not None:
        board.close()


def active_cycle(board, name):
    """A plan of this board's project whose one cycle is active: its cycle
    id."""
    orchestrator = f"{name}-orchestrator"
    registered = board.http("/api/v2/agents/register",
                            {"projectKey": board.key, "agentId": orchestrator,
                             "role": "ORCHESTRATOR"})
    if not registered.get("ok"):
        raise RuntimeError(f"orchestrator registration failed: {registered!r}")
    filed = board.http(f"/api/v2/projects/{board.key}/plans",
                       {"cr": f"{name}-plan", "cycles": [{"label": "solo"}],
                        "agentId": orchestrator})
    if not filed.get("ok"):
        raise RuntimeError(f"plan filing failed: {filed!r}")
    plan_id, cycle_id = filed["planId"], filed["cycles"][0]["id"]
    moved = _call(board.base,
                  f"/api/v2/projects/{board.key}/plans/{plan_id}/cycles/{cycle_id}",
                  {"status": "active", "agentId": orchestrator}, method="PATCH")
    if not moved.get("ok"):
        raise RuntimeError(f"cycle activation failed: {moved!r}")
    return cycle_id


class AnEdaRunAndTheCycleItIsFiledUnderTest(unittest.TestCase):
    """`test` and `unit`, each driven once with no `--cycle` and once with
    one, by one agent bound to no cycle, on the module's real board."""

    maxDiff = 8000

    @classmethod
    def setUpClass(cls):
        cls.gap = _MODULE.get("gap")
        if cls.gap:
            return
        cls.board = _MODULE["board"]
        cls.project = EdaProject(cls, board=cls.board, project_key=cls.board.key)
        cls.python = RecordingInterpreter(
            Path(scratch(cls, "eda-cycle-python-"), "bin", "python"))
        registered = cls.project.drive("register", "--role", "report", agent=AGENT)
        if registered.returncode != 0:
            raise RuntimeError(f"register {AGENT}: {diagnostics(registered)}")
        cls.unfiled = {"test": cls.drive("test", "--tests", TEST_SELECTION),
                       "unit": cls.drive("unit")}
        cls.cycle_id = active_cycle(cls.board, "eda-cycle-filing")
        cycle = ("--cycle", str(cls.cycle_id))
        cls.filed = {"test": cls.drive("test", "--tests", TEST_SELECTION, *cycle),
                     "unit": cls.drive("unit", *cycle)}

    @classmethod
    def drive(cls, verb, *argv):
        proxy = cls.board.proxy
        mark = proxy.count()
        calls_before = len(cls.python.calls())
        envs_before = len(cls.project.child_env_records())
        result = cls.project.drive(verb, *argv, agent=AGENT, python=cls.python.path)
        return BoardDrive(result, proxy.since(mark), cls.python.calls()[calls_before:],
                          cls.project.child_env_records()[envs_before:])

    def setUp(self):
        if self.gap:
            self.fail(f"missing toolchain: {self.gap}")

    # ── readers ────────────────────────────────────────────────────────────
    def the_envelope(self, drive):
        if drive.axi is None:
            self.fail(f"stdout must be one AXI envelope; {drive.diag()}")
        return drive.axi

    def the_one_body(self, drive, path):
        bodies = drive.posted(path)
        self.assertEqual(len(bodies), 1, f"one POST {path}; {bodies!r} {drive.diag()}")
        self.assertIsInstance(bodies[0], dict, drive.diag())
        return bodies[0]

    def cycle_of(self, body):
        return (body.get("context") or {}).get("cycleId")

    def stored_runs(self, drive):
        """The runs this drive's envelope names, as the board stores them."""
        events = self.the_envelope(drive).get("events") or []
        self.assertEqual(len(events), 1, f"one run is named; {drive.diag()}")
        return [self.board.event(str(event_id)) for event_id in events]

    # ── with --cycle ───────────────────────────────────────────────────────
    def test_the_run_each_verb_opens_carries_the_cycle(self):
        for verb, drive in self.filed.items():
            with self.subTest(verb=verb):
                body = self.the_one_body(drive, RUN_START)
                self.assertEqual(self.cycle_of(body), self.cycle_id,
                                 f"{verb}: the opened run; {body!r} {drive.diag()}")

    def test_the_ingest_of_each_verb_carries_the_cycle(self):
        for verb, drive in self.filed.items():
            with self.subTest(verb=verb):
                body = self.the_one_body(drive, RUN_INGEST)
                self.assertEqual(self.cycle_of(body), self.cycle_id,
                                 f"{verb}: the ingest; {drive.diag()}")

    def test_the_board_stores_each_run_under_the_cycle(self):
        for verb, drive in self.filed.items():
            with self.subTest(verb=verb):
                self.assertEqual([run.get("cycleId") for run in self.stored_runs(drive)],
                                 [self.cycle_id], f"{verb}: the stored run; {drive.diag()}")

    def test_no_envelope_warns_no_cycle(self):
        for verb, drive in self.filed.items():
            with self.subTest(verb=verb):
                self.the_envelope(drive)
                self.assertEqual(drive.warnings_coded(NO_CYCLE), [],
                                 f"{verb}: a run filed under its cycle; {drive.diag()}")

    # ── without --cycle ────────────────────────────────────────────────────
    def test_each_envelope_warns_no_cycle(self):
        for verb, drive in self.unfiled.items():
            with self.subTest(verb=verb):
                self.the_envelope(drive)
                self.assertEqual(len(drive.warnings_coded(NO_CYCLE)), 1,
                                 f"{verb}: a run filed under no cycle; {drive.diag()}")

    def test_neither_the_opened_run_nor_its_ingest_names_a_cycle(self):
        for verb, drive in self.unfiled.items():
            with self.subTest(verb=verb):
                opened = self.the_one_body(drive, RUN_START)
                ingested = self.the_one_body(drive, RUN_INGEST)
                self.assertEqual((self.cycle_of(opened), self.cycle_of(ingested)),
                                 (None, None), f"{verb}: {drive.diag()}")

    def test_the_board_stores_each_run_under_no_cycle(self):
        for verb, drive in self.unfiled.items():
            with self.subTest(verb=verb):
                self.assertEqual([run.get("cycleId") for run in self.stored_runs(drive)],
                                 [None], f"{verb}: the stored run; {drive.diag()}")


if __name__ == "__main__":
    unittest.main()
