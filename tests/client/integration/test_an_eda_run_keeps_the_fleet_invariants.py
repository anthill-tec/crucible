"""An eda run keeps the invariants every client's run keeps.

- **Refused while a cycle is active elsewhere.** Each verb that runs pytest
  -- the five tier verbs, `test`, `regression` and `pre-merge-gate` -- is
  refused, with an agent the board holds bound to no cycle, no `--cycle` and
  no `--release`, while the project has an ACTIVE cycle: `ok: false`, a
  non-zero exit and `help[]` naming `--cycle` and the active cycle's id,
  before any interpreter is spawned (not even the pytest probe), with no run
  opened and no gate milestone posted.
- **The wall-vs-CPU warning.** A `unit` run whose pytest child spends its
  time waiting carries the fleet's one `unit-run-wall-exceeds-cpu` warning,
  naming the eda stack, the tier, both figures and the factor; its `ok`, its
  verdict and its exit are a CPU-bound run's. A CPU-bound `unit` run, and an
  `integration` run that waits, carry no such warning.

`subtests-uncounted` on a tier run, and `--hermetic` on every run verb, are
proven elsewhere: the tier suite (`test_an_eda_tier_runs_each_entry_and_states_its_verdict`)
and the fleet's hermetic suite (`test_hermetic_runs_end_to_end`).

Every drive is the REAL `clients/eda-crucible.py` as an OS subprocess on a
scratch copy of `tests/fixtures/eda-project`, handed a recording interpreter,
against a `RecordingBoard`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_an_eda_run_keeps_the_fleet_invariants
"""

import os
import re
import time
import unittest

from tests.client.an_unattributed_run_is_refused_while_a_cycle_is_active_helpers import (
    cycle_board,
)
from tests.client.eda_project_harness import (
    AGENT,
    PROJECT_KEY,
    EdaProject,
    RecordingInterpreter,
    diagnostics,
    envelope,
    scratch,
)
from tests.client.live_run_harness import RecordingBoard

GATE = "pre-merge-gate"
MILESTONES = "/api/v2/milestones"
ACTIVE_CYCLE = 41
WALL_VS_CPU = "unit-run-wall-exceeds-cpu"
#: The factor the fleet's one definition warns at, as its warning prints it.
WALL_VS_CPU_FACTOR = "2x"
#: How long the waiting gate sleeps, and the CPU-bound gate spins.
BURN_SECONDS = 3.0

# Every verb that runs pytest, as driven: the five tier verbs over a copy that
# declares an entry for each, `test` over one path, `regression` and the gate.
RUN_VERBS = (
    ("unit",),
    ("module",),
    ("integration",),
    ("e2e",),
    ("bdd",),
    ("test", "--tests", "tests/unit"),
    ("regression",),
    (GATE,),
)
EVERY_TIER_DECLARED = "\n".join([
    '[targets."module"]',
    'framework = "eda-pytest"',
    'paths = ["tests/unit"]',
    "",
    '[targets."bdd"]',
    'framework = "eda-pytest"',
    'paths = ["tests/unit"]',
])

_WAIT_CHECK = f'''"""A gate that spends its time waiting on the bench."""

import time


def test_the_bench_settles_before_it_is_read():
    time.sleep({BURN_SECONDS!r})
'''

_SPIN_CHECK = f'''"""A gate that spends its time computing."""

import time


def test_the_netlist_hash_is_stable():
    end = time.monotonic() + {BURN_SECONDS!r}
    value = 0
    while time.monotonic() < end:
        value = (value * 1103515245 + 12345) % 2147483647
    assert value >= 0
'''

WAITING_ENTRIES = "\n".join([
    '[targets."unit"]',
    'framework = "eda-pytest"',
    'paths = ["tests/wait"]',
    "",
    '[targets."integration/wait"]',
    'framework = "eda-pytest"',
    'paths = ["tests/wait"]',
])
SPINNING_ENTRY = "\n".join([
    '[targets."unit"]',
    'framework = "eda-pytest"',
    'paths = ["tests/spin"]',
])

_WALL_AND_CPU = re.compile(r"(\d+(?:\.\d+)?)s of wall time against (\d+(?:\.\d+)?)s of child CPU")


class EachRunVerbIsRefusedWhileACycleIsActiveTest(unittest.TestCase):
    """A board holding the agent bound to no cycle, on a project with an
    active cycle; one drive per verb."""

    maxDiff = 4000

    def setUp(self):
        self.python = RecordingInterpreter(
            os.path.join(scratch(self, "eda-cycle-refusal-python-"), "bin", "python"))

    def drive(self, verb, *argv):
        board = cycle_board(PROJECT_KEY, AGENT, ACTIVE_CYCLE)
        self.addCleanup(board.close)
        project = EdaProject(self, board=board)
        project.declare(EVERY_TIER_DECLARED)
        if os.path.exists(self.python.log):
            os.remove(self.python.log)
        return project, project.drive(verb, *argv, python=self.python.path)

    def test_every_run_verb_is_refused_before_an_interpreter_is_spawned(self):
        for verb, *argv in RUN_VERBS:
            with self.subTest(verb=verb):
                project, result = self.drive(verb, *argv)
                where = diagnostics(result)
                self.assertNotEqual(result.returncode, 0, f"{verb} is refused; {where}")
                axi = envelope(result.stdout) or {}
                self.assertEqual((axi.get("verb"), axi.get("ok")), (verb, False),
                                 f"one ok:false envelope; {where}")
                help_text = " ".join(str(h) for h in axi.get("help") or [])
                self.assertIn("--cycle", help_text, f"the help names the lever; {where}")
                self.assertIn(str(ACTIVE_CYCLE), help_text,
                              f"the help names the active cycle; {where}")
                self.assertEqual(self.python.calls(), [],
                                 f"no interpreter is spawned, not even the probe; {where}")
                self.assertEqual(project.run_route_posts(), [], f"no run is opened; {where}")
                self.assertEqual([p for p, _b in project.posts() if p == MILESTONES], [],
                                 f"no milestone is posted; {where}")


class AUnitRunThatWaitsCarriesTheWallVsCpuWarningTest(unittest.TestCase):
    """Three drives on one `RecordingBoard`: `unit` over a waiting gate,
    `integration` over the same gate, and `unit` over a CPU-bound gate."""

    maxDiff = 4000

    @classmethod
    def setUpClass(cls):
        cls.board = RecordingBoard()
        cls.addClassCleanup(cls.board.close)
        cls.python = RecordingInterpreter(
            os.path.join(scratch(cls, "eda-wall-cpu-python-"), "bin", "python"))
        waiting = cls.copy(WAITING_ENTRIES, "tests/wait/check_wait.py", _WAIT_CHECK)
        spinning = cls.copy(SPINNING_ENTRY, "tests/spin/check_spin.py", _SPIN_CHECK)
        cls.waiting, cls.waited_for = cls.timed(waiting, "unit")
        cls.integration, _ = cls.timed(waiting, "integration")
        cls.spinning, _ = cls.timed(spinning, "unit")

    @classmethod
    def copy(cls, entries, rel, text):
        project = EdaProject(cls, board=cls.board)
        project.declare_only_the_board()
        project.declare(entries)
        project.write(rel, text)
        return project

    @classmethod
    def timed(cls, project, verb):
        started = time.monotonic()
        result = project.drive(verb, python=cls.python.path)
        return result, time.monotonic() - started

    def warnings_of(self, result):
        axi = envelope(result.stdout) or {}
        return [w for w in axi.get("warnings") or []
                if isinstance(w, dict) and w.get("code") == WALL_VS_CPU]

    def test_the_waiting_unit_run_carries_one_warning_naming_the_stack_the_tier_and_the_factor(self):
        warnings = self.warnings_of(self.waiting)
        where = diagnostics(self.waiting)
        self.assertEqual(len(warnings), 1, f"exactly one {WALL_VS_CPU} warning; {where}")
        detail = str((warnings[0] if warnings else {}).get("detail"))
        self.assertIn("eda unit", detail, f"the warning names the stack and tier; {detail!r}")
        self.assertIn(WALL_VS_CPU_FACTOR, detail, f"the warning names the factor; {detail!r}")

    def test_the_warnings_figures_are_the_runs_own(self):
        warnings = self.warnings_of(self.waiting)
        detail = str((warnings[0] if warnings else {}).get("detail"))
        figures = _WALL_AND_CPU.search(detail)
        if figures is None:
            self.fail(f"the warning names its wall and CPU figures; {diagnostics(self.waiting)}")
        wall, cpu = float(figures.group(1)), float(figures.group(2))
        self.assertGreaterEqual(wall, BURN_SECONDS,
                                f"the wall time covers the gate's own wait; {detail!r}")
        self.assertLessEqual(wall, self.waited_for,
                             f"the wall time is no longer than the whole drive's; {detail!r}")
        self.assertLess(cpu * 2, wall, f"the CPU figure is under half the wall; {detail!r}")

    def test_the_warning_leaves_ok_the_verdict_and_the_exit_unchanged(self):
        waited = envelope(self.waiting.stdout) or {}
        spun = envelope(self.spinning.stdout) or {}
        self.assertEqual(
            (waited.get("ok"), waited.get("verdict"), self.waiting.returncode),
            (spun.get("ok"), spun.get("verdict"), self.spinning.returncode),
            f"the run is reported, not refused; waited={diagnostics(self.waiting)} "
            f"spun={diagnostics(self.spinning)}")

    def test_a_cpu_bound_unit_run_carries_no_such_warning(self):
        self.assertEqual(self.warnings_of(self.spinning), [], diagnostics(self.spinning))
        self.assertIsNotNone(envelope(self.spinning.stdout),
                             f"the CPU-bound run answered; {diagnostics(self.spinning)}")

    def test_an_integration_run_that_waits_carries_no_unit_warning(self):
        self.assertEqual(self.warnings_of(self.integration), [], diagnostics(self.integration))
        self.assertIsNotNone(envelope(self.integration.stdout),
                             f"the integration run answered; {diagnostics(self.integration)}")


if __name__ == "__main__":
    unittest.main()
