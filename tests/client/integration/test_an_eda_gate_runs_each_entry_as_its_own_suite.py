"""An eda `pre-merge-gate` runs each eda entry as a suite of its own.

The gate composes its declared suites through the shared composition: one
suite per eda entry, `(key, None, "eda-pytest")`, each run here by the eda
client as its tier verb runs that entry. So:

- every gated entry is a `suites[]` row of its own, `client: eda-crucible.py`,
  with its own run on the board, its counts (`pending` included) and its
  outcome; `e2e` and `e2e/<label>` entries are listed and excluded;
- no entry is covered by a whole-suite run: the envelope states that the
  whole eda suite was skipped, and no run is filed under `regression`;
- a failing entry fails only its own row, and a row whose tests are all
  skipped puts its `tier-skipped` warning in the gate's `warnings`;
- `--suites unit` runs only `unit`, and the envelope and the milestone say
  the gate was scoped; `--suites nosuch` is refused before anything runs;
- every suite's pytest child runs headless, whatever display the client had;
- a project with no eda entry is refused, naming the declaration, before
  anything runs -- and, like every gate refused before its runner started,
  it records nothing: no run and no pre-merge-gate milestone.

The gate's copy declares, in key order: `e2e` and `e2e/bench` over
`tests/bench` (all skipped), `integration/net` over `tests/integ` (1 passes,
1 fails), `integration/sim` over `tests/sim` (2 skipped) and `unit` over three
node ids of `tests/unit` (2 pass, 1 is skipped), so `unit` passes and only
`integration/net` fails.

Every run drives the REAL `clients/eda-crucible.py` as an OS subprocess on a
scratch copy of `tests/fixtures/eda-project`, with a recording interpreter,
filing to a REAL throwaway board behind a recording proxy; the refusal with no
eda entry is driven against a `RecordingBoard`. A missing `bun` FAILS every
real-board test here, naming it.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_an_eda_gate_runs_each_entry_as_its_own_suite
"""

import os
import shutil
import unittest
from pathlib import Path

from tests.client import load_client
from tests.client.an_unattributed_run_is_refused_while_a_cycle_is_active_helpers import (
    _call,
)
from tests.client.eda_project_harness import (
    FRAMEWORK,
    BoardDrive,
    EdaProject,
    RecordingInterpreter,
    diagnostics,
    envelope,
    pytest_selections,
    said,
    scratch,
)
from tests.client.real_board import RealBoard

AXI = load_client("_crucible_axi.py")

_MODULE = {}

GATE = "pre-merge-gate"
MILESTONES = "/api/v2/milestones"
RUN_START = "/api/v2/runs/start"
TIER_SKIPPED = "tier-skipped"
GATE_SUITE_FAILED = "gate-suite-failed"
#: The reason every stack's gate lists `e2e` excluded.
E2E_EXCLUDED = AXI.GATE_UNCOVERED_TIERS["e2e"]
#: What the client is handed as its own display, which no pytest child may see.
CLIENT_DISPLAY = ":77"
CLIENT_WAYLAND_DISPLAY = "wayland-77"

UNIT_NODES = ["tests/unit/check_board.py::test_the_netlist_names_every_part",
              "tests/unit/check_board.py::test_the_supply_rail_is_five_volts",
              "tests/unit/check_board.py::test_the_populated_board_answers_its_probe"]
FAILING_NET_TEST = "test_the_layout_matches_the_schematic"
GATED = ("integration/net", "integration/sim", "unit")
EXCLUDED = ("e2e", "e2e/bench")

GATE_DECLARATION = "\n".join([
    '[targets."unit"]',
    'framework = "eda-pytest"',
    "paths = [" + ", ".join(f'"{node}"' for node in UNIT_NODES) + "]",
    "",
    '[targets."integration/net"]',
    'framework = "eda-pytest"',
    'paths = ["tests/integ"]',
    "",
    '[targets."integration/sim"]',
    'framework = "eda-pytest"',
    'paths = ["tests/sim"]',
    "",
    '[targets."e2e"]',
    'framework = "eda-pytest"',
    'paths = ["tests/bench"]',
    "",
    '[targets."e2e/bench"]',
    'framework = "eda-pytest"',
    'paths = ["tests/bench"]',
])


def setUpModule():
    bun = shutil.which("bun")
    if bun is None:
        _MODULE["gap"] = "bun is not on PATH: these gates file to a real board"
        return
    _MODULE["board"] = RealBoard(bun, "eda-gate-suites", proxy=True)


def tearDownModule():
    board = _MODULE.pop("board", None)
    if board is not None:
        board.close()


def rows_by_suite(axi):
    """The envelope's `suites[]` rows, keyed by `suite`."""
    return {str(row.get("suite")): row
            for row in (axi or {}).get("suites") or [] if isinstance(row, dict)}


def figures(row):
    return {key: (row or {}).get(key) for key in ("passed", "failed", "pending")}


def gate_milestones(drive):
    return [body for body in drive.posted(MILESTONES)
            if isinstance(body, dict) and body.get("type") == GATE]


def finished_cycle(board, name):
    """A plan of this board's project whose one cycle has run and is done:
    `(plan id, cycle id)`. A gate names it with `--cycle`; being done, it
    leaves no cycle active for any other drive on this board."""
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
    path = f"/api/v2/projects/{board.key}/plans/{plan_id}/cycles/{cycle_id}"
    for status in ("active", "done"):
        moved = _call(board.base, path, {"status": status, "agentId": orchestrator},
                      method="PATCH")
        if not moved.get("ok"):
            raise RuntimeError(f"cycle {status} failed: {moved!r}")
    return plan_id, cycle_id


class _EdaGateOnARealBoard(unittest.TestCase):
    """One scratch copy declaring the gate's five entries and one recording
    interpreter per class, on the module's real board; each class drives its
    gate once, in `drive_all`."""

    maxDiff = 8000
    AGENT = "eda-gate"

    @classmethod
    def setUpClass(cls):
        cls.gap = _MODULE.get("gap")
        if cls.gap:
            return
        cls.board = _MODULE["board"]
        cls.project = EdaProject(cls, board=cls.board, project_key=cls.board.key)
        cls.project.declare_only_the_board()
        cls.project.declare(GATE_DECLARATION)
        cls.python = RecordingInterpreter(
            Path(scratch(cls, "eda-gate-python-"), "bin", "python"))
        cls.drive = cls.drive_all()

    @classmethod
    def drive_all(cls):
        return cls.drive_gate()

    @classmethod
    def drive_gate(cls, *argv):
        """Register the class's agent, then drive the gate once with `argv`,
        the client holding a display of its own."""
        registered = cls.project.drive("register", "--role", "report", agent=cls.AGENT)
        if registered.returncode != 0:
            raise RuntimeError(f"register {cls.AGENT}: {diagnostics(registered)}")
        proxy = cls.board.proxy
        mark = proxy.count()
        calls_before = len(cls.python.calls())
        envs_before = len(cls.project.child_env_records())
        result = cls.project.drive(
            GATE, *argv, agent=cls.AGENT, python=cls.python.path,
            env=cls.project.env(DISPLAY=CLIENT_DISPLAY,
                                WAYLAND_DISPLAY=CLIENT_WAYLAND_DISPLAY))
        return BoardDrive(result, proxy.since(mark), cls.python.calls()[calls_before:],
                          cls.project.child_env_records()[envs_before:])

    def setUp(self):
        if self.gap:
            self.fail(f"missing toolchain: {self.gap}")

    # ── readers ────────────────────────────────────────────────────────────
    def the_envelope(self):
        if self.drive.axi is None:
            self.fail(f"stdout must be one AXI envelope; {self.drive.diag()}")
        return self.drive.axi

    def stored(self):
        """Every test run the class's agent filed, as the board's list holds
        it, oldest first."""
        return sorted(self.board.test_events(self.AGENT),
                      key=lambda e: (e.get("timestamp") or 0, str(e.get("id"))))

    def selections(self):
        return pytest_selections(self.drive.calls, self.project.dir)


class AFullGateRunsEachEntryAsItsOwnSuiteTest(_EdaGateOnARealBoard):
    """The full gate over the five entries."""

    AGENT = "eda-gate-full"

    def test_each_gated_entry_is_a_row_run_by_the_eda_client_with_its_counts_and_outcome(self):
        rows = rows_by_suite(self.the_envelope())
        self.assertEqual(sorted(rows), sorted(GATED + EXCLUDED),
                         f"one row per declared entry; {self.drive.diag()}")
        expected = {"unit": ({"passed": 2, "failed": 0, "pending": 1}, "pass"),
                    "integration/net": ({"passed": 1, "failed": 1, "pending": 0}, "fail"),
                    "integration/sim": ({"passed": 0, "failed": 0, "pending": 2}, "pass")}
        for suite, (counts, outcome) in expected.items():
            with self.subTest(suite=suite):
                row = rows.get(suite) or {}
                self.assertEqual((row.get("client"), row.get("stack"), row.get("gated")),
                                 ("eda-crucible.py", "eda", True),
                                 f"the row is the eda client's own suite; row={row!r}")
                self.assertEqual(figures(row), counts, f"the row's own counts; row={row!r}")
                self.assertEqual(row.get("outcome"), outcome, f"row={row!r}")
                self.assertNotIn("coveredBy", row,
                                 f"no other run covers an eda entry; row={row!r}")

    def test_each_gated_entry_has_its_own_run_on_the_board_and_nothing_else_runs(self):
        stored = self.stored()
        self.assertEqual(sorted((e.get("tier"), e.get("passed"), e.get("failed"), e.get("pending"))
                                for e in stored),
                         [("integration", 0, 0, 2), ("integration", 1, 1, 0), ("unit", 2, 0, 1)],
                         f"one stored run per gated entry, under its tier; {stored!r}")
        self.assertEqual({e.get("framework") for e in stored}, {FRAMEWORK},
                         f"every run is an eda-pytest run; {stored!r}")
        self.assertEqual(sorted(tuple(s) for s in self.selections()),
                         sorted([("tests/integ",), ("tests/sim",), tuple(UNIT_NODES)]),
                         f"one pytest per gated entry, over that entry's paths alone; "
                         f"calls={self.drive.calls!r}")
        axi = self.the_envelope()
        self.assertEqual(sorted(str(e) for e in axi.get("events") or []),
                         sorted(str(e.get("id")) for e in stored),
                         f"the gate's events are its three runs'; {self.drive.diag()}")

    def test_the_e2e_entries_are_listed_and_excluded(self):
        rows = rows_by_suite(self.the_envelope())
        for suite in EXCLUDED:
            with self.subTest(suite=suite):
                self.assertEqual(rows.get(suite),
                                 {"suite": suite, "stack": "eda", "gated": False,
                                  "excluded": E2E_EXCLUDED},
                                 f"listed, excluded, with the reason; {self.drive.diag()}")
        self.assertNotIn(("tests/bench",), [tuple(s) for s in self.selections()],
                         f"no e2e entry runs; calls={self.drive.calls!r}")

    def test_the_whole_suite_run_is_skipped_and_says_so(self):
        axi = self.the_envelope()
        statement = axi.get("wholeSuite")
        self.assertIsInstance(statement, str, f"a whole-suite statement; {self.drive.diag()}")
        self.assertIn("the whole eda suite was skipped", str(statement), self.drive.diag())
        self.assertNotIn(AXI.whole_suite_label("eda"), rows_by_suite(axi),
                         f"no row for a whole-suite run; {self.drive.diag()}")
        self.assertEqual(len(self.drive.posted(RUN_START)), 3,
                         f"exactly three runs open, one per gated entry; {self.drive.diag()}")
        self.assertNotIn("regression", [(s or {}).get("tier") for s in self.drive.posted(RUN_START)],
                         f"no whole-suite run is opened; {self.drive.diag()}")

    def test_the_failing_entry_fails_only_its_own_row_and_the_gate(self):
        axi = self.the_envelope()
        self.assertIs(axi.get("ok"), False, self.drive.diag())
        self.assertNotEqual(self.drive.result.returncode, 0, self.drive.diag())
        self.assertEqual({suite: rows_by_suite(axi).get(suite, {}).get("outcome") for suite in GATED},
                         {"integration/net": "fail", "integration/sim": "pass", "unit": "pass"},
                         self.drive.diag())
        failed = [w.get("detail") for w in self.drive.warnings_coded(GATE_SUITE_FAILED)]
        self.assertEqual(len(failed), 1, f"one failed suite is named; {failed!r}")
        self.assertIn("`integration/net`", str(failed[0]) if failed else "", f"{failed!r}")

    def test_the_milestone_fails_on_the_failing_entry_alone(self):
        milestones = gate_milestones(self.drive)
        self.assertEqual(len(milestones), 1, f"one gate milestone; {self.drive.diag()}")
        milestone = milestones[0] if milestones else {}
        self.assertEqual((milestone.get("outcome"), milestone.get("scope")), ("fail", "full"),
                         f"milestone={milestone!r}")
        entries = {str(e.get("target")): e for e in milestone.get("suites") or []
                   if isinstance(e, dict)}
        self.assertEqual({t: (e.get("outcome"), e.get("passed"), e.get("failed"))
                          for t, e in entries.items()},
                         {"integration/net": ("fail", 1, 1), "integration/sim": ("pass", 0, 0),
                          "unit": ("pass", 2, 0)},
                         f"one result per gated entry; milestone={milestone!r}")
        failing = milestone.get("failingTests") or []
        self.assertEqual(len(failing), 1, f"one failing test; milestone={milestone!r}")
        self.assertIn(FAILING_NET_TEST, str(failing), f"milestone={milestone!r}")

    def test_the_all_skipped_rows_tier_skipped_warning_reaches_the_gate(self):
        self.assertEqual([w.get("detail") for w in self.drive.warnings_coded(TIER_SKIPPED)],
                         ["integration/sim: all 2 tests skipped"],
                         f"one {TIER_SKIPPED} warning, naming integration/sim and no other "
                         f"entry; {self.drive.diag()}")

    def test_every_suites_pytest_child_runs_headless(self):
        self.assertEqual(len(self.drive.child_envs), 3,
                         f"one pytest child per gated entry recorded its environment; "
                         f"{self.drive.diag()}")
        for child in self.drive.child_envs:
            self.assertEqual(
                (child.get("QT_QPA_PLATFORM"), child.get("DISPLAY"), child.get("WAYLAND_DISPLAY")),
                ("offscreen", None, None),
                f"a gate suite's pytest child runs headless whatever display the client "
                f"had; child={child!r}")
        for call in self.drive.calls:
            self.assertEqual(
                (call["env"].get("QT_QPA_PLATFORM"), call["set"].get("DISPLAY"),
                 call["set"].get("WAYLAND_DISPLAY")),
                ("offscreen", False, False),
                f"every interpreter call of the gate (the probe included) runs headless; "
                f"call={call!r}")


class AGateScopedToUnitRunsOnlyUnitTest(_EdaGateOnARealBoard):
    """`--suites unit --cycle <a done cycle>`."""

    AGENT = "eda-gate-scoped"

    @classmethod
    def drive_all(cls):
        _plan, cls.cycle_id = finished_cycle(cls.board, "eda-gate-scoped")
        return cls.drive_gate("--suites", "unit", "--cycle", str(cls.cycle_id))

    def test_only_the_unit_entry_runs_and_is_stored(self):
        self.assertEqual(self.selections(), [UNIT_NODES],
                         f"one pytest, over the unit entry alone; calls={self.drive.calls!r}")
        stored = self.stored()
        self.assertEqual([(e.get("tier"), e.get("passed"), e.get("failed"), e.get("pending"))
                          for e in stored], [("unit", 2, 0, 1)],
                         f"one run, the unit entry's; {stored!r}")

    def test_the_envelope_says_the_gate_was_scoped_to_unit(self):
        axi = self.the_envelope()
        self.assertEqual(axi.get("scope"), "scoped", self.drive.diag())
        rows = rows_by_suite(axi)
        self.assertEqual(sorted(rows), ["unit"], f"only the named suite is a row; {self.drive.diag()}")
        row = rows.get("unit") or {}
        self.assertEqual((row.get("client"), figures(row), row.get("outcome")),
                         ("eda-crucible.py", {"passed": 2, "failed": 0, "pending": 1}, "pass"),
                         f"row={row!r}")
        self.assertIs(axi.get("ok"), True, self.drive.diag())
        self.assertEqual(self.drive.result.returncode, 0, self.drive.diag())

    def test_the_milestone_is_scoped_with_the_unit_result_only(self):
        milestones = gate_milestones(self.drive)
        self.assertEqual(len(milestones), 1, f"one gate milestone; {self.drive.diag()}")
        milestone = milestones[0] if milestones else {}
        self.assertEqual((milestone.get("outcome"), milestone.get("scope")), ("pass", "scoped"),
                         f"milestone={milestone!r}")
        self.assertEqual([e.get("target") for e in milestone.get("suites") or []
                          if isinstance(e, dict)], ["unit"], f"milestone={milestone!r}")


class AGateScopedToAnUndeclaredSuiteIsRefusedTest(_EdaGateOnARealBoard):
    """`--suites nosuch --cycle <a done cycle>`."""

    AGENT = "eda-gate-nosuch"

    @classmethod
    def drive_all(cls):
        _plan, cls.cycle_id = finished_cycle(cls.board, "eda-gate-nosuch")
        return cls.drive_gate("--suites", "nosuch", "--cycle", str(cls.cycle_id))

    def test_it_is_refused_naming_the_undeclared_suite_before_anything_runs(self):
        axi = self.the_envelope()
        self.assertIs(axi.get("ok"), False, self.drive.diag())
        self.assertNotEqual(self.drive.result.returncode, 0, self.drive.diag())
        self.assertIn("`nosuch`", said(axi), f"the refusal names the suite; {self.drive.diag()}")
        self.assertEqual(self.drive.run_route_posts(), [],
                         f"no run is opened; {self.drive.diag()}")
        self.assertEqual(self.drive.calls, [],
                         f"no interpreter is spawned, not even the probe; {self.drive.diag()}")
        self.assertEqual(gate_milestones(self.drive), [],
                         f"no gate milestone is posted; {self.drive.diag()}")


class AGateWithNoEdaEntryIsRefusedAndRecordsNothingTest(unittest.TestCase):
    """A copy that names its board and declares no eda entry, against a
    `RecordingBoard`."""

    def setUp(self):
        self.python = RecordingInterpreter(
            os.path.join(scratch(self, "eda-gate-undeclared-python-"), "bin", "python"))
        self.project = EdaProject(self)
        self.project.declare_only_the_board()
        self.result = self.project.drive(GATE, python=self.python.path)

    def test_it_is_refused_before_anything_runs_and_no_gate_milestone_is_posted(self):
        # That the refusal names the declaration is the declaration suite's
        # (`test_an_eda_declaration_is_read_or_refused`); this is what it records.
        where = diagnostics(self.result)
        self.assertNotEqual(self.result.returncode, 0, f"the gate is refused; {where}")
        axi = envelope(self.result.stdout) or {}
        self.assertEqual((axi.get("verb"), axi.get("ok")), (GATE, False),
                         f"one ok:false envelope; {where}")
        self.assertEqual(self.project.run_route_posts(), [], f"no run is opened; {where}")
        self.assertEqual(self.python.calls(), [],
                         f"no interpreter is spawned, not even the probe; {where}")
        milestones = [b for p, b in self.project.posts()
                      if p == MILESTONES and isinstance(b, dict) and b.get("type") == GATE]
        self.assertEqual(milestones, [],
                         f"a gate refused before its runner started ran nothing, so it "
                         f"records nothing: no {GATE} milestone; {where}")


# The shared base drives no gate of its own: out of the module's namespace, so
# unittest's loader collects only the concrete classes above.
del _EdaGateOnARealBoard

if __name__ == "__main__":
    unittest.main()
