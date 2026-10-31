"""A streamed python run reaches the board while it works (CR-CRU-224 AC3).

The real `clients/python-crucible.py` runs the real runner
(`clients/subtest_runner.py`, under the repo's own interpreter) against a
scratch board (`RealBoard`: `bun run src/server.ts` over a throwaway store),
on a fixture suite whose tests wait on one another through the board: each
later test waits until the board's live view of the OPEN run
(`GET /api/v2/runs/<runId>/live`, `handleRunLive` in src/v2.ts) shows what
the earlier ones did, and this test lets it go on only once it has seen that.

- test 1 passes;
- test 2 waits until the board shows test 1 finished, then fails;
- test 3 waits until the board shows test 2's failure, then passes;
- test 4 waits until the board shows three finished tests.

So each finished test and each failure is shown before the run ends. A wait
that is never released gives up after `GATE_SECONDS`, so a run whose stream
never reaches the board still ends, and fails here.
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.live_run_harness import scrubbed_env
from tests.client.real_board import RealBoard

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON_SCRIPT = REPO_ROOT / "clients" / "python-crucible.py"
REAL_VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"

AGENT = "python-live-stream-agent"
GATE_SECONDS = 20
OBSERVE_SECONDS = 25
RUN_TIMEOUT = 240
RUN_STARTED = re.compile(r"^\[crucible\] run started: (\S+)$", re.MULTILINE)

FIRST = "test_1_passes"
SECOND = "test_2_fails_once_the_board_shows_the_first"
THIRD = "test_3_passes_once_the_board_shows_the_failure"
FOURTH = "test_4_ends_once_the_board_shows_three"
PLANTED = "planted live failure"

WAITING_SUITE = f'''\
import os
import time
import unittest


def wait_for(name):
    path = os.path.join(os.environ["LIVE_GATE_DIR"], name)
    deadline = time.monotonic() + {GATE_SECONDS}
    while time.monotonic() < deadline and not os.path.exists(path):
        time.sleep(0.05)


class WaitsOnTheBoardCase(unittest.TestCase):
    def {FIRST}(self):
        self.assertTrue(True)

    def {SECOND}(self):
        wait_for("seen-1")
        self.fail("{PLANTED}")

    def {THIRD}(self):
        wait_for("seen-2")

    def {FOURTH}(self):
        wait_for("seen-3")
'''


class AStreamedPythonRunReachesTheBoardWhileItWorksTest(unittest.TestCase):

    def setUp(self):
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "this test boots the real board with `bun`")
        self.assertTrue(REAL_VENV_PYTHON.exists(), f"needs {REAL_VENV_PYTHON}")
        assert bun is not None
        self.scratch = Path(tempfile.mkdtemp(prefix="python-live-stream-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.board = RealBoard(bun, "python-live-stream")
        self.addCleanup(self.board.close)
        self.project = self.scratch / "project"
        (self.project / "tests").mkdir(parents=True)
        (self.project / "tests" / "__init__.py").write_text("", encoding="utf-8")
        (self.project / "tests" / "test_waits.py").write_text(WAITING_SUITE, encoding="utf-8")
        self.board.install(str(self.project))
        self.gates = self.scratch / "gates"
        self.gates.mkdir()

    def live(self, run_id):
        return self.board.http(f"/api/v2/runs/{run_id}/live")

    def observe(self, run_id, shown):
        """Poll the open run's live view until `shown(answer)`; answers that
        live view, or None when the board never showed it while the run was
        open."""
        deadline = time.monotonic() + OBSERVE_SECONDS
        while time.monotonic() < deadline:
            answer = self.live(run_id)
            if answer.get("state") == "open" and shown(answer):
                return answer
            time.sleep(0.1)
        return None

    def test_each_finished_test_and_each_failure_is_on_the_board_before_the_run_ends(self):
        stderr_path = self.scratch / "client-stderr.txt"
        env = scrubbed_env(LIVE_GATE_DIR=self.gates)
        env.pop("CRUCIBLE_STREAM", None)
        cmd = [sys.executable, str(PYTHON_SCRIPT), "test",
               "--python", str(REAL_VENV_PYTHON), "--project-dir", str(self.project),
               "--reports", str(self.scratch / "reports"), "--agent", AGENT]
        seen = {}
        with open(stderr_path, "w") as err:
            proc = subprocess.Popen(cmd, cwd=str(self.project), env=env,
                                    stdout=subprocess.PIPE, stderr=err, text=True)
            try:
                run_id = None
                deadline = time.monotonic() + 60
                while run_id is None and time.monotonic() < deadline:
                    found = RUN_STARTED.search(stderr_path.read_text(errors="replace"))
                    run_id = found.group(1) if found else None
                    time.sleep(0.05)
                self.assertIsNotNone(run_id, stderr_path.read_text(errors="replace"))
                steps = (
                    ("seen-1", lambda a: (a.get("live") or {}).get("passed", 0) >= 1),
                    ("seen-2", lambda a: any(f.get("name") == SECOND
                                             for f in a.get("failures") or [])),
                    ("seen-3", lambda a: (a.get("live") or {}).get("completed", 0) >= 3),
                )
                for gate, shown in steps:
                    seen[gate] = self.observe(run_id, shown)
                    (self.gates / gate).write_text("go")
                proc.communicate(timeout=RUN_TIMEOUT)
            finally:
                for gate in ("seen-1", "seen-2", "seen-3"):
                    (self.gates / gate).write_text("go")
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        diag = f"exit={proc.returncode} stderr={stderr_path.read_text(errors='replace')[-3000:]!r}"
        self.assertIsNotNone(seen["seen-1"],
                             f"the first finished test is on the board while the run "
                             f"works; {diag}")
        first = seen["seen-1"] or {}
        self.assertEqual((first.get("live") or {}).get("failed"), 0, first)
        failure_view = seen["seen-2"]
        self.assertIsNotNone(failure_view, f"the failure is on the board while the run "
                                           f"works; {diag}")
        failures = [f for f in (failure_view or {}).get("failures") or []
                    if f.get("name") == SECOND]
        self.assertEqual(len(failures), 1, failure_view)
        self.assertIn(PLANTED, failures[0].get("message") or "", failures[0])
        self.assertEqual(failures[0].get("suite"), "test_waits.WaitsOnTheBoardCase")
        third = seen["seen-3"]
        self.assertIsNotNone(third, f"the third finished test is on the board while "
                                    f"the run works; {diag}")
        counts = (third or {}).get("live") or {}
        self.assertEqual((counts.get("completed"), counts.get("passed"), counts.get("failed")),
                         (3, 2, 1), third)
        self.assertEqual(counts.get("total"), 4, "run-start states countTestCases()")
        self.assertEqual(proc.returncode, 1, f"one test failed; {diag}")
        events = self.board.test_events(AGENT)
        self.assertEqual(len(events), 1, json.dumps(events)[:2000])
        summary = self.board.event(events[0]["id"]).get("summary") or {}
        self.assertEqual({k: summary.get(k) for k in ("total", "passed", "failed")},
                         {"total": 4, "passed": 3, "failed": 1})


if __name__ == "__main__":
    unittest.main()
