"""CR-CRU-216 AC7 — through the real board: a test run filed through the python
client is read back through the same client, and what it prints is what the
board stored.

End to end against a REAL scratch board (`tests/client/real_board.py`: `bun run
src/server.ts` on an OS-assigned free port over a `mkdtemp` store — never the
live 3850/3849 and never the installer probe's 39877, so nothing here writes
to a live board, CR-CRU-214). One plan with one active cycle is filed; a fake
interpreter (the `--python` idiom of
`test_python_exits_and_files_on_its_runners_exit.py`) writes a JUnit report
holding one passing and one failing case, and `python-crucible.py test --cycle
<it>` files that run. The comparison target is the board's OWN answer —
`GET /api/v2/events/<id>` and `GET /api/v2/events/<id>?depth=suites` — never a
value this test derives from what it told the fake to write.

RED today: `python-crucible.py` has no `runs` and no `run` verb, so both
read-back drives die in argparse (`invalid choice`, exit 2, nothing on stdout)
after the filing half of the test has already succeeded.

The envelope field names (`runs`, `run`, `suites`, `failingTests`) are the
decisions stated in `test_runs_and_run_read_a_projects_stored_runs_back.py`.

Invocation:
    python3 -m unittest tests.client.test_runs_and_run_read_a_filed_run_back_end_to_end
"""

import os
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    load_toon,
    new_scratch,
    scrubbed_env,
)
from tests.client.real_board import RealBoard
from tests.client.test_an_unattributed_run_is_refused_while_a_cycle_is_active import (
    _call,
)

TOON = load_toon()
PYTHON_CLIENT = CLIENTS / "python-crucible.py"
TIMEOUT = 180

AGENT = "run-read-back-e2e-red"
ORCHESTRATOR = "run-read-back-e2e-orchestrator"
CR = "CR-RUN-READ-BACK-E2E-FIXTURE"

PROBE_CLASS = "read_back_probe.ReadBackProbeCase"
PASSING_CASE = "test_the_order_totals"
FAILING_CASE = "test_the_refund_is_refused_on_purpose"

_SCRUBBED = ("PY_CRUCIBLE_PYTHON", "PYTHON_CRUCIBLE_PROJECT_DIR",
             "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

EMPTY = (None, "")

# A fake interpreter: run as the suite (`… -o <dir>`) it writes one passing
# and one failing JUnit case and exits 1, as a runner with a failure does. A
# coverage.py probe (`-c <script>`) answers true.
_FAKE_PYTHON = r'''
import os
import sys

CLASS, CASE, FAILING = ''' + repr((PROBE_CLASS, PASSING_CASE, FAILING_CASE)) + r'''

argv = sys.argv[1:]
if argv[:1] == ["-c"]:
    sys.stdout.write("true\n")
    sys.exit(0)
outdir = None
for i, arg in enumerate(argv):
    if arg == "-o" and i + 1 < len(argv):
        outdir = argv[i + 1]
sys.stderr.write("Ran 2 tests in 0.002s\n\nFAILED (failures=1)\n")
sys.stderr.flush()
if outdir:
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "TEST-%s.xml" % CLASS), "w") as handle:
        handle.write(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<testsuite name="%s" tests="2" errors="0" failures="1" skipped="0">'
            '<testcase classname="%s" name="%s" time="0.001"></testcase>'
            '<testcase classname="%s" name="%s" time="0.001">'
            '<failure type="AssertionError" message="2 != 3">AssertionError: 2 != 3'
            '</failure></testcase></testsuite>\n'
            % (CLASS, CLASS, CASE, CLASS, FAILING))
sys.exit(1)
'''


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout[-3000:]!r} "
            f"stderr={result.stderr[-3000:]!r}")


def _empty_to_none(value):
    return None if value == "" else value


_BOARD = None


def setUpModule():
    global _BOARD
    bun = shutil.which("bun")
    if bun is None:
        raise unittest.SkipTest(
            "the run is filed on, and read back from, a REAL board, and "
            "without `bun` there is none to boot — a missing toolchain, not a "
            "passing assertion")
    _BOARD = RealBoard(bun, "run-read-back-e2e")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


class AFiledRunReadsBackAsTheBoardStoredItEndToEndTest(unittest.TestCase):
    """AC7 — file through the python client, read back through it, compare
    with the board's own stored record."""

    @classmethod
    def setUpClass(cls):
        if _BOARD is None:
            raise AssertionError("the module's real board was never booted")
        cls.board = _BOARD
        cls.project = new_scratch("run-read-back-e2e-")
        Path(cls.project, "tests").mkdir()
        cls.fake_python = os.path.join(cls.project, "fake_python.py")
        Path(cls.fake_python).write_text("#!" + sys.executable + "\n" + _FAKE_PYTHON)
        os.chmod(cls.fake_python,
                 os.stat(cls.fake_python).st_mode | stat.S_IXUSR | stat.S_IRUSR)
        cls.board.install(cls.project)
        cls.cycle_id = cls._an_active_cycle()
        cls.filed = cls._client("test", "--agent", AGENT,
                                "--python", cls.fake_python,
                                "--reports", "reports",
                                "--cycle", str(cls.cycle_id))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.project, ignore_errors=True)

    @classmethod
    def _an_active_cycle(cls):
        board = cls.board
        reg = board.http("/api/v2/agents/register",
                         {"projectKey": board.key, "agentId": ORCHESTRATOR,
                          "role": "ORCHESTRATOR"})
        assert reg.get("ok"), f"orchestrator registration failed: {reg!r}"
        filed = board.http(f"/api/v2/projects/{board.key}/plans",
                           {"cr": CR, "cycles": [{"label": "read-back"}],
                            "agentId": ORCHESTRATOR})
        assert filed.get("ok"), f"plan-file failed: {filed!r}"
        plan_id, cycle_id = filed["planId"], filed["cycles"][0]["id"]
        moved = _call(board.base,
                      f"/api/v2/projects/{board.key}/plans/{plan_id}/cycles/{cycle_id}",
                      {"status": "active", "agentId": ORCHESTRATOR},
                      method="PATCH")
        assert moved.get("ok"), f"cycle activation failed: {moved!r}"
        return cycle_id

    @classmethod
    def _client(cls, verb, *argv):
        env = scrubbed_env(None)
        for key in _SCRUBBED:
            env.pop(key, None)
        return subprocess.run(
            [sys.executable, str(PYTHON_CLIENT), verb, *argv,
             "--project-dir", cls.project],
            cwd=cls.project, env=env, capture_output=True, text=True,
            timeout=TIMEOUT, check=False)

    # ── the board's own record ─────────────────────────────────────────────

    def stored_run(self):
        """The ONE test run this agent filed under the cycle, as the board's
        cycle list answers it, then read whole and by suite."""
        listed = self.board.http(
            f"/api/v2/events?project={self.board.key}&cycleId={self.cycle_id}")
        self.assertTrue(listed.get("ok"), f"cycle list read failed: {listed!r}")
        mine = [e for e in listed.get("events") or []
                if e.get("agentId") == AGENT and e.get("kind") == "test"]
        self.assertEqual(
            len(mine), 1,
            f"the python client files exactly one test run under cycle "
            f"{self.cycle_id}; events={listed.get('events')!r}; "
            f"{_diagnostics(self.filed)}")
        brief = mine[0]
        full = self.board.event(brief["id"])
        # The fixture's own precondition, so a red below is never a filing
        # that silently did not happen: the fake runner's one pass and one
        # failure, stored under this cycle.
        self.assertEqual(
            (full["summary"]["passed"], full["summary"]["failed"]), (1, 1),
            f"the stored run holds the fake runner's one pass and one "
            f"failure; event={full!r}")
        self.assertEqual(brief.get("cycleId"), self.cycle_id, f"{brief!r}")
        suites = self.board.http(f"/api/v2/events/{brief['id']}?depth=suites")
        self.assertTrue(suites.get("ok"), f"suites read failed: {suites!r}")
        return brief, full, suites["event"].get("tree") or []

    def envelope(self, result):
        heads = [line for line in result.stdout.splitlines()
                 if line.startswith("axi:")]
        self.assertEqual(len(heads), 1,
                         f"one `axi:` envelope on stdout; {_diagnostics(result)}")
        decoded = TOON.decode(result.stdout)
        axi = decoded.get("axi") if isinstance(decoded, dict) else None
        self.assertIsInstance(axi, dict, _diagnostics(result))
        return axi

    def test_runs_for_the_cycle_prints_the_stored_runs_values(self):
        brief, _full, _suites = self.stored_run()
        result = self._client("runs", "--cycle", str(self.cycle_id))
        self.assertEqual(result.returncode, 0,
                         f"`runs --cycle {self.cycle_id}` reads the cycle's "
                         f"runs back (RED: no such verb); {_diagnostics(result)}")
        axi = self.envelope(result)
        self.assertIs(axi.get("ok"), True, f"{axi!r}")
        rows = axi.get("runs")
        self.assertIsInstance(rows, list, f"{axi!r}")
        self.assertEqual(
            [r.get("event") for r in rows], [brief["id"]],
            f"the cycle holds exactly the one run this test filed; rows={rows!r}")
        row = rows[0]
        expected = {
            "event": brief["id"], "kind": "test", "tier": brief.get("tier"),
            "codec": brief.get("codec"), "stack": brief.get("stack"),
            "passed": brief["passed"], "failed": brief["failed"],
            "pending": brief["pending"], "total": brief["total"],
            "agent": AGENT, "cycleId": self.cycle_id,
            "release": brief.get("release"),
        }
        self.assertEqual(
            {k: _empty_to_none(row.get(k)) for k in expected}, expected,
            f"every printed value is the stored one; row={row!r} "
            f"stored={brief!r}")
        self.assertEqual((row.get("passed"), row.get("failed")), (1, 1),
                         f"the printed counts are the run's real ones; {row!r}")
        self.assertIn(row.get("errors"), EMPTY, f"a test row: {row!r}")
        self.assertIn(row.get("warnings"), EMPTY, f"a test row: {row!r}")
        self.assertEqual(axi.get("totalCount"), 1, f"{axi!r}")

    def test_run_prints_the_stored_brief_suites_and_failing_test(self):
        brief, full, stored_suites = self.stored_run()
        result = self._client("run", brief["id"])
        self.assertEqual(result.returncode, 0,
                         f"`run {brief['id']}` reads the stored run back (RED: "
                         f"no such verb); {_diagnostics(result)}")
        axi = self.envelope(result)
        self.assertIs(axi.get("ok"), True, f"{axi!r}")

        shown = axi.get("run")
        self.assertIsInstance(shown, dict, f"{axi!r}")
        summary = full["summary"]
        for key, value in (("kind", "test"), ("tier", full.get("tier")),
                           ("codec", full.get("codec")),
                           ("stack", full.get("stack")),
                           ("passed", summary["passed"]),
                           ("failed", summary["failed"]),
                           ("pending", summary["pending"]),
                           ("total", summary["total"]),
                           ("cycleId", self.cycle_id), ("agent", AGENT)):
            self.assertEqual(_empty_to_none(shown.get(key)), value,
                             f"the brief's {key!r} is the stored value; "
                             f"brief={shown!r} stored={full!r}")

        expected_suites = [
            {"name": s.get("name"), "browser": s.get("browser"),
             "passed": s["counts"]["passed"], "failed": s["counts"]["failed"],
             "pending": s["counts"]["pending"]} for s in stored_suites]
        self.assertEqual(len(expected_suites), 1,
                         f"the board stored one suite; {stored_suites!r}")
        self.assertEqual(
            [{k: _empty_to_none(v) for k, v in row.items()}
             for row in axi.get("suites") or []],
            expected_suites,
            f"the per-suite counts are the board's ?depth=suites answer; "
            f"printed={axi.get('suites')!r} stored={stored_suites!r}")

        stored_failing = [f"{s.get('name')} > {leaf.get('name')}"
                          for s in full.get("tree") or []
                          for leaf in s.get("children") or []
                          if leaf.get("status") == "fail"]
        self.assertEqual(len(stored_failing), 1, f"{full.get('tree')!r}")
        self.assertIn(FAILING_CASE, stored_failing[0])
        self.assertEqual(
            axi.get("failingTests"), stored_failing,
            f"the failing test is named as the board's stored tree names it; "
            f"{axi!r}")


if __name__ == "__main__":
    unittest.main()
