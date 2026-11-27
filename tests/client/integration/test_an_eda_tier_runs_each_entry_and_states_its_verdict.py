"""An eda tier runs each of its entries as its own pytest run, files it, and
states its verdict and its skips in one envelope.

Every run drives the REAL `clients/eda-crucible.py` as an OS subprocess on a
scratch copy of `tests/fixtures/eda-project`, in a recording interpreter that
hands each call to this suite's own interpreter (which has pytest), filing to
a REAL throwaway board (`tests/client/real_board.py`) behind a recording
proxy. What a run filed is read back from the board (its stored counts, tier,
stack, codec and framework) and from the bodies the proxy saw; what pytest
was asked to run is read from the interpreter's own log; what environment
the pytest child had is read from the record the fixture's root `conftest.py`
writes from inside it.

The fixture's entries: `unit` over `tests/unit` (2 pass, 1 fails, 1 is
skipped "board not populated"), `integration/net` over `tests/integ` (1 pass,
1 fails) and `e2e` over `tests/bench` (2 skipped "bench not connected"); a
class that needs `integration/sim` (`tests/sim`, 2 skipped "simulator not
installed") declares it in its own copy.

- `unit` opens one run, `tier: unit`, `stack: eda`, `codec: junit`,
  `framework: eda-pytest`, filed 2/1/1 with no case of another entry; it
  exits 1 with `verdict: fail` and lists its skip with its node id and reason;
- `integration` with two entries opens one run per entry in key order and
  writes one envelope: `entries[]`, their summed `run`, `events[]`, a `fail`
  verdict, and a `tier-skipped` warning naming the all-skipped entry;
  `--entry` narrows it to one entry, and refuses a key outside the tier or
  not declared before any run is opened;
- `e2e`, every test skipped, exits 0 with `verdict: skip`;
- a skip reason of 240 characters arrives whole; 25 skips list 20 and count
  5 not listed; a run with passing subtests says they went uncounted;
- `regression` files every test of the three entries once, in one run;
- `test --tests` runs one pytest over its selection, filed under no tier;
- every pytest child runs with `COLUMNS` set to the client's wide constant and
  headless, whatever `DISPLAY` and `WAYLAND_DISPLAY` the client was given;
- `auto-ingest` files a directory of existing reports as one `eda-pytest`
  run under no tier.

A missing `bun` FAILS every test here, naming it.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_an_eda_tier_runs_each_entry_and_states_its_verdict
"""

import os
import shutil
import unittest
from pathlib import Path

from tests.client import load_client
from tests.client.eda_project_harness import (
    EDA_CLIENT,
    FRAMEWORK,
    EdaProject,
    RecordingInterpreter,
    diagnostics,
    envelope,
    said,
    scratch,
)
from tests.client.pytest_project_harness import sent_cases
from tests.client.real_board import RealBoard

_MODULE = {}

RUN_START = "/api/v2/runs/start"
RUN_INGEST = "/api/v2/runs"
TIER_SKIPPED = "tier-skipped"
SUBTESTS_UNCOUNTED = "subtests-uncounted"
#: What the client is handed as its own display, which no pytest child may see.
CLIENT_DISPLAY = ":77"
CLIENT_WAYLAND_DISPLAY = "wayland-77"
#: A narrow terminal width the client inherits, which no pytest child may keep.
CLIENT_COLUMNS = "80"

UNIT_SKIP = "tests/unit/check_board.py::test_the_populated_board_answers_its_probe"
BENCH_SKIPS = ["tests/bench/check_bench.py::test_the_bench_supply_powers_the_board",
               "tests/bench/check_bench.py::test_the_bench_scope_sees_the_clock"]
SIM_SKIPS = ["tests/sim/check_sim.py::test_the_transient_run_settles_the_rail",
             "tests/sim/check_sim.py::test_the_ac_sweep_keeps_the_filter_corner"]
#: Every test of the three committed entries, as `(classname, name)`.
FIXTURE_CASES = {
    ("tests.unit.check_board", "test_the_netlist_names_every_part"),
    ("tests.unit.check_board", "test_the_supply_rail_is_five_volts"),
    ("tests.unit.check_board", "test_the_erc_finds_no_unconnected_pin"),
    ("tests.unit.check_board", "test_the_populated_board_answers_its_probe"),
    ("tests.integ.check_net", "test_the_ground_net_joins_every_ground_pin"),
    ("tests.integ.check_net", "test_the_layout_matches_the_schematic"),
    ("tests.bench.check_bench", "test_the_bench_supply_powers_the_board"),
    ("tests.bench.check_bench", "test_the_bench_scope_sees_the_clock"),
}

SIM_ENTRY = '[targets."integration/sim"]\nframework = "eda-pytest"\npaths = ["tests/sim"]\n'

# A skip whose reason is exactly 240 characters long, with no parenthesis.
LONG_REASON = ("bench rig not wired " + "".join(f"net{n:03d}-" for n in range(40)))[:240]
_LONG_REASON_CHECK = f'''"""One gate skipped with a long reason."""

import pytest


def test_the_long_bench_rig_is_wired():
    pytest.skip({LONG_REASON!r})
'''
LONG_SKIP = "tests/long/check_long.py::test_the_long_bench_rig_is_wired"

MANY_SKIPS = 25
_MANY_SKIPS_CHECK = f'''"""{MANY_SKIPS} gates, each skipped with its own reason."""

import pytest


@pytest.mark.parametrize("rig", range({MANY_SKIPS}))
def test_the_rig_answers(rig):
    pytest.skip(f"rig {{rig}} absent")
'''
MANY_SKIP_IDS = {f"tests/many/check_many.py::test_the_rig_answers[{n}]": f"rig {n} absent"
                 for n in range(MANY_SKIPS)}

_SUBTESTS_CHECK = '''"""A gate with three passing native subtests."""


def test_three_passing_native_subtests(subtests):
    for i in range(3):
        with subtests.test(msg="native", i=i):
            assert i < 3
'''

# An existing pytest JUnit report: one passed, one failed, one skipped case.
_EXISTING_REPORT = '''<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" time="0.05">
<testcase classname="tests.unit.check_board" name="test_the_netlist_names_every_part" file="tests/unit/check_board.py" time="0.01"/>
<testcase classname="tests.unit.check_board" name="test_the_erc_finds_no_unconnected_pin" file="tests/unit/check_board.py" time="0.01"><failure message="ERC: 1 unconnected pin(s)">assert ['U1.7'] == []</failure></testcase>
<testcase classname="tests.unit.check_board" name="test_the_populated_board_answers_its_probe" file="tests/unit/check_board.py" time="0.00"><skipped type="pytest.skip" message="board not populated">board not populated</skipped></testcase>
</testsuite></testsuites>
'''


def setUpModule():
    bun = shutil.which("bun")
    if bun is None:
        _MODULE["gap"] = "bun is not on PATH: these runs file to a real board"
        return
    _MODULE["board"] = RealBoard(bun, "eda-tier-runs", proxy=True)


def tearDownModule():
    board = _MODULE.pop("board", None)
    if board is not None:
        board.close()


class Drive:
    """One client run: its result and envelope, and what it sent the board,
    asked the interpreter to run, and handed its pytest children."""

    def __init__(self, result, records, calls, child_envs):
        self.result = result
        self.axi = envelope(result.stdout)
        self.records = records
        self.calls = calls
        self.child_envs = child_envs

    def posted(self, path):
        return [r.get("body") for r in self.records
                if r.get("method") == "POST" and r.get("path") == path]

    def run_route_posts(self):
        return [r for r in self.records
                if r.get("method") == "POST" and str(r.get("path")).startswith("/api/v2/runs")]

    def envelope_lines(self):
        return [line for line in self.result.stdout.splitlines() if line.startswith("axi:")]

    def warnings_coded(self, code):
        return [w for w in (self.axi or {}).get("warnings") or []
                if isinstance(w, dict) and w.get("code") == code]

    def diag(self):
        return diagnostics(self.result)


class _EdaRunOnARealBoard(unittest.TestCase):
    """One scratch copy and one recording interpreter per class, on the
    module's real board; each class drives its runs once, in `drive_all`."""

    maxDiff = 8000

    @classmethod
    def setUpClass(cls):
        cls.gap = _MODULE.get("gap")
        if cls.gap:
            return
        cls.board = _MODULE["board"]
        cls.project = EdaProject(cls, board=cls.board, project_key=cls.board.key)
        cls.python = RecordingInterpreter(
            Path(scratch(cls, "eda-run-python-"), "bin", "python"))
        cls.prepare()
        cls.drives = {}
        cls.drive_all()

    @classmethod
    def prepare(cls):
        """Shape this class's copy before any run."""

    @classmethod
    def drive_all(cls):
        """Drive this class's runs, each kept in `cls.drives`."""

    @classmethod
    def client_env(cls):
        """The client's own environment: a display and a narrow terminal it
        must not hand its pytest children."""
        return cls.project.env(DISPLAY=CLIENT_DISPLAY,
                               WAYLAND_DISPLAY=CLIENT_WAYLAND_DISPLAY,
                               COLUMNS=CLIENT_COLUMNS)

    @classmethod
    def drive(cls, name, verb, *argv, agent, python=True):
        """Register `agent`, then drive `verb` once and keep it as `name`."""
        registered = cls.project.drive("register", "--role", "report", agent=agent)
        if registered.returncode != 0:
            raise RuntimeError(f"register {agent}: {diagnostics(registered)}")
        proxy = cls.board.proxy
        mark = proxy.count()
        calls_before = len(cls.python.calls())
        envs_before = len(cls.project.child_env_records())
        result = cls.project.drive(verb, *argv, agent=agent,
                                   python=cls.python.path if python else None,
                                   env=cls.client_env())
        cls.drives[name] = Drive(result, proxy.since(mark),
                                 cls.python.calls()[calls_before:],
                                 cls.project.child_env_records()[envs_before:])
        return cls.drives[name]

    def setUp(self):
        if self.gap:
            self.fail(f"missing toolchain: {self.gap}")

    # ── readers ────────────────────────────────────────────────────────────
    def stored(self, agent):
        """Every test run `agent` filed, as the board's list holds it, oldest
        first."""
        return sorted(self.board.test_events(agent),
                      key=lambda e: (e.get("timestamp") or 0, str(e.get("id"))))

    def the_envelope(self, drive):
        if drive.axi is None:
            self.fail(f"stdout must be one AXI envelope; {drive.diag()}")
        return drive.axi

    def pytest_selections(self, drive):
        """What each pytest call of `drive` was asked to run, as paths (or
        node ids) relative to the copy, in call order."""
        selections = []
        for call in drive.calls:
            argv = call["argv"]
            if not any(argv[i:i + 2] == ["-m", "pytest"] for i in range(len(argv))):
                continue
            picked, skip_next = [], False
            for arg in argv[argv.index("pytest") + 1:]:
                if skip_next:
                    skip_next = False
                    continue
                if arg in ("-o", "-p", "-c", "--rootdir"):
                    skip_next = True
                    continue
                if arg.startswith("-"):
                    continue
                path, sep, node = arg.partition("::")
                rel = os.path.relpath(os.path.realpath(os.path.join(call["cwd"], path)),
                                      os.path.realpath(self.project.dir))
                picked.append(rel + sep + node)
            selections.append(picked)
        return selections

    def assert_children_headless(self, drive):
        self.assertEqual(len(drive.child_envs), 1,
                         f"one pytest child recorded its environment; {drive.diag()}")
        child = drive.child_envs[0]
        self.assertEqual(
            (child.get("QT_QPA_PLATFORM"), child.get("DISPLAY"), child.get("WAYLAND_DISPLAY")),
            ("offscreen", None, None),
            f"the pytest child runs headless whatever display the client had; "
            f"child={child!r} {drive.diag()}")
        for call in drive.calls:
            self.assertEqual(
                (call["env"].get("QT_QPA_PLATFORM"), call["set"].get("DISPLAY"),
                 call["set"].get("WAYLAND_DISPLAY")),
                ("offscreen", False, False),
                f"every interpreter call (the probe included) runs headless; call={call!r}")


class AUnitTierRunsItsOneEntryTest(_EdaRunOnARealBoard):
    """`unit` on the committed fixture: one entry, one run."""

    AGENT = "eda-tier-unit"

    @classmethod
    def drive_all(cls):
        cls.drive("unit", "unit", agent=cls.AGENT)

    def test_it_opens_one_run_under_unit_on_stack_eda_with_framework_eda_pytest(self):
        drive = self.drives["unit"]
        starts = drive.posted(RUN_START)
        self.assertEqual(len(starts), 1, f"exactly one run is opened; {drive.diag()}")
        self.assertEqual({k: (starts[0] or {}).get(k) for k in ("tier", "stack", "framework")},
                         {"tier": "unit", "stack": "eda", "framework": FRAMEWORK},
                         f"the run start; {drive.diag()}")
        ingests = drive.posted(RUN_INGEST)
        self.assertEqual(len(ingests), 1, f"exactly one filing; {drive.diag()}")
        self.assertEqual((ingests[0] or {}).get("codec"), "junit",
                         f"the run is filed as JUnit; {drive.diag()}")
        stored = self.stored(self.AGENT)
        self.assertEqual(len(stored), 1, f"one run is stored; {stored!r} {drive.diag()}")
        self.assertEqual({k: stored[0].get(k) for k in ("tier", "stack", "codec", "framework")},
                         {"tier": "unit", "stack": "eda", "codec": "junit",
                          "framework": FRAMEWORK},
                         f"the stored run; {stored[0]!r}")

    def test_the_board_files_two_passed_one_failed_and_one_pending(self):
        drive = self.drives["unit"]
        stored = self.stored(self.AGENT)
        self.assertEqual(len(stored), 1, f"one run is stored; {stored!r} {drive.diag()}")
        self.assertEqual({k: stored[0].get(k) for k in ("total", "passed", "failed", "pending")},
                         {"total": 4, "passed": 2, "failed": 1, "pending": 1},
                         f"the stored counts; {stored[0]!r}")

    def test_no_case_of_another_entry_is_run_or_filed(self):
        drive = self.drives["unit"]
        self.assertEqual(self.pytest_selections(drive), [["tests/unit"]],
                         f"one pytest over the unit entry's paths alone; calls={drive.calls!r}")
        ingests = drive.posted(RUN_INGEST)
        self.assertEqual(len(ingests), 1, f"exactly one filing; {drive.diag()}")
        groups = {group for group, _n, _s, _f in sent_cases(ingests[0])}
        self.assertEqual(groups, {"tests.unit.check_board"},
                         f"only the unit entry's cases are filed (none from tests/integ); "
                         f"{sent_cases(ingests[0])!r}")

    def test_it_exits_1_with_verdict_fail_in_one_envelope(self):
        drive = self.drives["unit"]
        self.assertEqual(len(drive.envelope_lines()), 1, f"one envelope; {drive.diag()}")
        axi = self.the_envelope(drive)
        self.assertEqual(axi.get("verdict"), "fail", f"a failing test fails the run; {drive.diag()}")
        self.assertEqual(drive.result.returncode, 1, drive.diag())

    def test_the_envelope_names_the_one_entry_its_counts_and_its_event(self):
        drive = self.drives["unit"]
        axi = self.the_envelope(drive)
        stored = self.stored(self.AGENT)
        self.assertEqual(len(stored), 1, f"one run is stored; {stored!r} {drive.diag()}")
        event = stored[0].get("id")
        self.assertEqual(axi.get("entries"),
                         [{"key": "unit", "verdict": "fail", "passed": 2, "failed": 1,
                           "pending": 1, "event": event}],
                         f"the entry the tier ran; {drive.diag()}")
        run = axi.get("run") or {}
        self.assertEqual({k: run.get(k) for k in ("passed", "failed", "pending")},
                         {"passed": 2, "failed": 1, "pending": 1}, f"the run block; {drive.diag()}")
        self.assertEqual(axi.get("events"), [event], f"the run's event; {drive.diag()}")

    def test_the_skip_is_listed_with_its_node_id_and_reason(self):
        drive = self.drives["unit"]
        axi = self.the_envelope(drive)
        self.assertEqual(axi.get("skipped"), [{"test": UNIT_SKIP, "reason": "board not populated"}],
                         f"the one skip, as pytest named it; {drive.diag()}")
        self.assertIn(axi.get("skippedNotListed", 0), (0, None),
                      f"nothing is left out of a one-skip list; {drive.diag()}")

    def test_the_pytest_child_runs_with_the_clients_wide_columns(self):
        drive = self.drives["unit"]
        columns = getattr(load_client(EDA_CLIENT.name), "EDA_PYTEST_COLUMNS", None)
        if not isinstance(columns, int):
            self.fail(f"the client names its pytest width EDA_PYTEST_COLUMNS, an int; "
                      f"found {columns!r}")
        self.assertGreaterEqual(columns, 1000, "the pytest width is at least 1000")
        self.assertEqual(len(drive.child_envs), 1, f"one pytest child recorded; {drive.diag()}")
        self.assertEqual(drive.child_envs[0].get("COLUMNS"), str(columns),
                         f"the child's COLUMNS is the client's constant, not the "
                         f"{CLIENT_COLUMNS} the client inherited; child={drive.child_envs[0]!r}")

    def test_the_pytest_child_and_the_probe_run_headless(self):
        self.assert_children_headless(self.drives["unit"])


class AnIntegrationTierWithTwoEntriesTest(_EdaRunOnARealBoard):
    """`integration` over `integration/net` (one fails) and `integration/sim`
    (all skipped)."""

    WHOLE = "eda-tier-integration"
    NARROWED = "eda-tier-integration-net"
    OUTSIDE = "eda-tier-integration-unit"
    UNDECLARED = "eda-tier-integration-nosuch"

    @classmethod
    def prepare(cls):
        cls.project.declare(SIM_ENTRY)

    @classmethod
    def drive_all(cls):
        cls.drive("whole", "integration", agent=cls.WHOLE)
        cls.drive("narrowed", "integration", "--entry", "integration/net", agent=cls.NARROWED)
        cls.drive("outside", "integration", "--entry", "unit", agent=cls.OUTSIDE)
        cls.drive("undeclared", "integration", "--entry", "integration/nosuch",
                  agent=cls.UNDECLARED)

    def test_each_entry_is_its_own_run_under_integration_in_key_order(self):
        drive = self.drives["whole"]
        starts = drive.posted(RUN_START)
        self.assertEqual([(s or {}).get("tier") for s in starts], ["integration", "integration"],
                         f"two runs open under integration; {drive.diag()}")
        self.assertEqual(self.pytest_selections(drive), [["tests/integ"], ["tests/sim"]],
                         f"one pytest per entry, integration/net first; calls={drive.calls!r}")
        stored = self.stored(self.WHOLE)
        self.assertEqual([(e.get("tier"), e.get("passed"), e.get("failed"), e.get("pending"))
                          for e in stored],
                         [("integration", 1, 1, 0), ("integration", 0, 0, 2)],
                         f"both runs are stored, net then sim; {stored!r}")

    def test_one_envelope_holds_both_entries_their_sum_and_their_events(self):
        drive = self.drives["whole"]
        self.assertEqual(len(drive.envelope_lines()), 1, f"one envelope; {drive.diag()}")
        axi = self.the_envelope(drive)
        stored = self.stored(self.WHOLE)
        self.assertEqual(len(stored), 2, f"two runs are stored; {stored!r} {drive.diag()}")
        net, sim = stored[0].get("id"), stored[1].get("id")
        self.assertEqual(axi.get("entries"),
                         [{"key": "integration/net", "verdict": "fail", "passed": 1,
                           "failed": 1, "pending": 0, "event": net},
                          {"key": "integration/sim", "verdict": "skip", "passed": 0,
                           "failed": 0, "pending": 2, "event": sim}],
                         f"both entries, in key order; {drive.diag()}")
        run = axi.get("run") or {}
        self.assertEqual({k: run.get(k) for k in ("passed", "failed", "pending")},
                         {"passed": 1, "failed": 1, "pending": 2},
                         f"the run block sums the entries; {drive.diag()}")
        self.assertEqual(axi.get("events"), [net, sim], f"both events; {drive.diag()}")

    def test_a_failing_entry_fails_the_tier_and_the_skipped_entry_is_named(self):
        drive = self.drives["whole"]
        axi = self.the_envelope(drive)
        self.assertEqual(axi.get("verdict"), "fail", f"the tier verdict; {drive.diag()}")
        self.assertEqual(drive.result.returncode, 1, drive.diag())
        self.assertEqual(len(drive.posted(RUN_START)), 2,
                         f"the failing entry does not stop the next; {drive.diag()}")
        self.assertEqual([w.get("detail") for w in drive.warnings_coded(TIER_SKIPPED)],
                         ["integration/sim: all 2 tests skipped"],
                         f"one {TIER_SKIPPED} warning, naming integration/sim; {drive.diag()}")

    def test_the_tier_envelope_lists_the_skips_of_every_entry(self):
        drive = self.drives["whole"]
        axi = self.the_envelope(drive)
        self.assertEqual(axi.get("skipped"),
                         [{"test": test, "reason": "simulator not installed"} for test in SIM_SKIPS],
                         f"the skips of the tier's runs; {drive.diag()}")

    def test_entry_narrows_the_tier_to_that_one_entry(self):
        drive = self.drives["narrowed"]
        self.assertEqual([(s or {}).get("tier") for s in drive.posted(RUN_START)], ["integration"],
                         f"one run opens; {drive.diag()}")
        self.assertEqual(self.pytest_selections(drive), [["tests/integ"]],
                         f"only integration/net runs; calls={drive.calls!r}")
        axi = self.the_envelope(drive)
        self.assertEqual([e.get("key") for e in axi.get("entries") or []], ["integration/net"],
                         f"the envelope holds the one entry; {drive.diag()}")
        self.assertEqual(axi.get("verdict"), "fail", drive.diag())

    def assert_refused_with_no_run(self, name, key):
        drive = self.drives[name]
        axi = self.the_envelope(drive)
        self.assertIs(axi.get("ok"), False, drive.diag())
        self.assertNotEqual(drive.result.returncode, 0, drive.diag())
        self.assertIn(key, said(axi), f"the refusal names {key!r}; {drive.diag()}")
        self.assertEqual(drive.run_route_posts(), [], f"no run is opened; {drive.diag()}")
        self.assertEqual(self.pytest_selections(drive), [], f"no pytest runs; {drive.diag()}")

    def test_an_entry_of_another_tier_is_refused_with_no_run_opened(self):
        self.assert_refused_with_no_run("outside", "unit")

    def test_an_undeclared_entry_is_refused_with_no_run_opened(self):
        self.assert_refused_with_no_run("undeclared", "integration/nosuch")


class AnAllSkippedTierIsASkipTest(_EdaRunOnARealBoard):
    """`e2e` over `tests/bench`, where every test is skipped."""

    AGENT = "eda-tier-e2e"

    @classmethod
    def drive_all(cls):
        cls.drive("e2e", "e2e", agent=cls.AGENT)

    def test_it_exits_0_with_verdict_skip_and_a_warning_naming_e2e(self):
        drive = self.drives["e2e"]
        axi = self.the_envelope(drive)
        self.assertEqual(axi.get("verdict"), "skip", f"an all-skipped run; {drive.diag()}")
        self.assertEqual(drive.result.returncode, 0, drive.diag())
        self.assertEqual([w.get("detail") for w in drive.warnings_coded(TIER_SKIPPED)],
                         ["e2e: all 2 tests skipped"],
                         f"one {TIER_SKIPPED} warning naming e2e; {drive.diag()}")
        self.assertEqual([(e.get("key"), e.get("verdict")) for e in axi.get("entries") or []],
                         [("e2e", "skip")], drive.diag())

    def test_the_boards_run_has_pending_equal_to_its_total(self):
        drive = self.drives["e2e"]
        stored = self.stored(self.AGENT)
        self.assertEqual(len(stored), 1, f"one run is stored; {stored!r} {drive.diag()}")
        self.assertEqual({k: stored[0].get(k) for k in ("total", "passed", "failed", "pending")},
                         {"total": 2, "passed": 0, "failed": 0, "pending": 2},
                         f"every test of the run is pending; {stored[0]!r}")

    def test_both_skips_are_listed_with_the_benchs_reason(self):
        drive = self.drives["e2e"]
        self.assertEqual(self.the_envelope(drive).get("skipped"),
                         [{"test": test, "reason": "bench not connected"} for test in BENCH_SKIPS],
                         drive.diag())


class TheSkipListAndSubtestsTest(_EdaRunOnARealBoard):
    """A copy declaring only `module` (one skip with a 240-character reason),
    `bdd` (25 skips) and `integration/sub` (passing native subtests)."""

    LONG = "eda-skips-long"
    MANY = "eda-skips-many"
    SUB = "eda-subtests"

    @classmethod
    def prepare(cls):
        if len(LONG_REASON) != 240 or "(" in LONG_REASON or ")" in LONG_REASON:
            raise RuntimeError(f"fixture broken: the long reason is {len(LONG_REASON)} chars")
        cls.project.declare_only_the_board()
        cls.project.write("tests/long/check_long.py", _LONG_REASON_CHECK)
        cls.project.write("tests/many/check_many.py", _MANY_SKIPS_CHECK)
        cls.project.write("tests/sub/check_sub.py", _SUBTESTS_CHECK)
        cls.project.declare('[targets."module"]\nframework = "eda-pytest"\npaths = ["tests/long"]\n')
        cls.project.declare('[targets."bdd"]\nframework = "eda-pytest"\npaths = ["tests/many"]\n')
        cls.project.declare(
            '[targets."integration/sub"]\nframework = "eda-pytest"\npaths = ["tests/sub"]\n')

    @classmethod
    def drive_all(cls):
        cls.drive("long", "module", agent=cls.LONG)
        cls.drive("many", "bdd", agent=cls.MANY)
        cls.drive("sub", "integration", agent=cls.SUB)

    def test_a_240_character_reason_arrives_whole(self):
        drive = self.drives["long"]
        self.assertEqual(self.the_envelope(drive).get("skipped"),
                         [{"test": LONG_SKIP, "reason": LONG_REASON}],
                         f"the whole reason, uncut; {drive.diag()}")

    def test_25_skips_list_20_and_count_5_not_listed(self):
        drive = self.drives["many"]
        axi = self.the_envelope(drive)
        listed = axi.get("skipped") or []
        self.assertEqual(len(listed), 20, f"20 skips are listed; {drive.diag()}")
        self.assertEqual(axi.get("skippedNotListed"), 5, f"5 are left out; {drive.diag()}")
        tests = [item.get("test") for item in listed]
        self.assertEqual(len(set(tests)), 20, f"each listed skip once; {tests!r}")
        for item in listed:
            self.assertIn(item.get("test"), MANY_SKIP_IDS, f"a real skip's node id; {item!r}")
            self.assertEqual(item.get("reason"), MANY_SKIP_IDS[item.get("test")],
                             f"each skip carries its own reason; {item!r}")

    def test_a_run_whose_subtests_pass_says_they_went_uncounted(self):
        drive = self.drives["sub"]
        self.the_envelope(drive)
        self.assertEqual(len(drive.warnings_coded(SUBTESTS_UNCOUNTED)), 1,
                         f"one {SUBTESTS_UNCOUNTED} warning; {drive.diag()}")
        self.assertEqual(self.the_envelope(drive).get("verdict"), "pass", drive.diag())

    def test_a_run_without_subtests_says_nothing_of_them(self):
        drive = self.drives["long"]
        self.assertEqual(self.the_envelope(drive).get("verdict"), "skip",
                         f"the run without subtests was filed; {drive.diag()}")
        self.assertEqual(drive.warnings_coded(SUBTESTS_UNCOUNTED), [], drive.diag())


class ARegressionRunHoldsEveryEntryOnceTest(_EdaRunOnARealBoard):
    """`regression` on the committed fixture's three entries."""

    AGENT = "eda-regression"

    @classmethod
    def drive_all(cls):
        cls.drive("regression", "regression", agent=cls.AGENT)

    def test_one_pytest_passes_each_declared_path_once(self):
        drive = self.drives["regression"]
        selections = self.pytest_selections(drive)
        self.assertEqual(len(selections), 1, f"one pytest; calls={drive.calls!r}")
        self.assertEqual(sorted(selections[0]), ["tests/bench", "tests/integ", "tests/unit"],
                         f"each entry's path, once; calls={drive.calls!r}")

    def test_one_run_under_regression_files_every_test_of_the_three_entries_once(self):
        drive = self.drives["regression"]
        starts = drive.posted(RUN_START)
        self.assertEqual([(s or {}).get("tier") for s in starts], ["regression"], drive.diag())
        ingests = drive.posted(RUN_INGEST)
        self.assertEqual(len(ingests), 1, f"one filing; {drive.diag()}")
        ids = [(group, name) for group, name, _s, _f in sent_cases(ingests[0])]
        self.assertEqual(len(ids), len(set(ids)), f"no test is filed twice; {ids!r}")
        self.assertEqual(set(ids), FIXTURE_CASES, f"every test of the three entries; {ids!r}")
        stored = self.stored(self.AGENT)
        self.assertEqual(
            [{k: e.get(k) for k in ("tier", "framework", "total", "passed", "failed", "pending")}
             for e in stored],
            [{"tier": "regression", "framework": FRAMEWORK, "total": 8, "passed": 3,
              "failed": 2, "pending": 3}],
            f"one stored regression run; {stored!r}")

    def test_regression_states_one_verdict(self):
        drive = self.drives["regression"]
        self.assertEqual(self.the_envelope(drive).get("verdict"), "fail", drive.diag())
        self.assertNotEqual(drive.result.returncode, 0, drive.diag())

    def test_the_regression_child_runs_headless(self):
        self.assert_children_headless(self.drives["regression"])


class ATestRunFilesItsSelectionUnderNoTierTest(_EdaRunOnARealBoard):
    """`test --tests tests/integ <a unit node id>`."""

    AGENT = "eda-test-selection"
    NODE = "tests/unit/check_board.py::test_the_netlist_names_every_part"

    @classmethod
    def drive_all(cls):
        cls.drive("test", "test", "--tests", "tests/integ", cls.NODE, agent=cls.AGENT)

    def test_one_pytest_runs_the_selection_and_is_filed_under_no_tier(self):
        drive = self.drives["test"]
        self.assertEqual(self.pytest_selections(drive), [["tests/integ", self.NODE]],
                         f"one pytest over the selection; calls={drive.calls!r}")
        starts = drive.posted(RUN_START)
        self.assertEqual(len(starts), 1, f"one run opens; {drive.diag()}")
        self.assertIsNone((starts[0] or {}).get("tier"), f"no tier; {starts[0]!r}")
        ingests = drive.posted(RUN_INGEST)
        self.assertEqual(len(ingests), 1, f"one filing; {drive.diag()}")
        self.assertIsNone((ingests[0] or {}).get("tier"), f"filed under no tier; {drive.diag()}")
        # The board stores a run that states no tier under its own default, so
        # the stored record is read for what was filed, not for a tier.
        stored = self.stored(self.AGENT)
        self.assertEqual(
            [{k: e.get(k) for k in ("stack", "framework", "total", "passed", "failed",
                                    "pending")} for e in stored],
            [{"stack": "eda", "framework": FRAMEWORK, "total": 3, "passed": 2,
              "failed": 1, "pending": 0}],
            f"one stored run; {stored!r}")

    def test_a_run_with_no_skip_lists_none_and_states_its_verdict(self):
        drive = self.drives["test"]
        axi = self.the_envelope(drive)
        self.assertEqual(axi.get("skipped"), [], f"no skip, an empty list; {drive.diag()}")
        self.assertIn(axi.get("skippedNotListed", 0), (0, None), drive.diag())
        self.assertEqual(axi.get("verdict"), "fail", drive.diag())

    def test_the_test_child_runs_headless(self):
        self.assert_children_headless(self.drives["test"])


class AutoIngestFilesExistingReportsTest(_EdaRunOnARealBoard):
    """`auto-ingest --reports <dir>` over one existing pytest JUnit report."""

    AGENT = "eda-auto-ingest"

    @classmethod
    def drive_all(cls):
        reports = Path(scratch(cls, "eda-existing-reports-"))
        (reports / "TEST-pytest.xml").write_text(_EXISTING_REPORT, encoding="utf-8")
        cls.drive("ingest", "auto-ingest", "--reports", str(reports), agent=cls.AGENT,
                  python=False)

    def test_the_reports_are_filed_as_one_eda_pytest_run_under_no_tier(self):
        drive = self.drives["ingest"]
        ingests = drive.posted(RUN_INGEST)
        self.assertEqual(len(ingests), 1, f"one filing; {drive.diag()}")
        body = ingests[0] or {}
        self.assertEqual({k: body.get(k) for k in ("codec", "stack", "framework", "tier")},
                         {"codec": "junit", "stack": "eda", "framework": FRAMEWORK,
                          "tier": None}, f"the filing; {drive.diag()}")
        # The board stores a run that states no tier under its own default, so
        # the stored record is read for what was filed, not for a tier.
        stored = self.stored(self.AGENT)
        self.assertEqual(
            [{k: e.get(k) for k in ("stack", "framework", "total", "passed", "failed",
                                    "pending")} for e in stored],
            [{"stack": "eda", "framework": FRAMEWORK, "total": 3, "passed": 1,
              "failed": 1, "pending": 1}],
            f"one stored run; {stored!r}")
        self.assertEqual(self.pytest_selections(drive), [], "auto-ingest runs no pytest")

    def test_the_envelope_states_the_filed_runs_verdict(self):
        drive = self.drives["ingest"]
        self.assertEqual(self.the_envelope(drive).get("verdict"), "fail", drive.diag())


# The shared base drives no run of its own: out of the module's namespace, so
# unittest's loader collects only the concrete classes above.
del _EdaRunOnARealBoard

if __name__ == "__main__":
    unittest.main()
