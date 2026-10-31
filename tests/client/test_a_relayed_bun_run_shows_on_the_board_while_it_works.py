"""A relayed bun run shows on the board while it works (CR-CRU-201 AC5).

The real `clients/bun-crucible.py` runs the real `bun test` against a scratch
board (`RealBoard`, tests/client/real_board.py: `bun run src/server.ts` from
this branch, on a free port over a throwaway store), on a scratch package whose
one test file holds four tests that wait on one another through the board:
each later test waits until this test has seen, on the open run's live view
(`GET /api/v2/runs/<runId>/live`, `handleRunLive` in src/v2.ts), what the
earlier ones did, and this test lets it go on only once it has seen that.

- the first test passes;
- the second waits until the board shows one finished test, then fails with
  a planted message;
- the third waits until the board shows that failure, then passes;
- the fourth waits until the board shows three finished tests.

So `completed` is read at 1, 2 and 3 while the run is open, the failure is
shown with its name, file and message before the run ends, and `total` is the
client's scan of the package (four declarations). A wait that is never
released gives up after `GATE_SECONDS`, under the client's per-test timeout,
so a run whose console never reaches the board still ends, and fails here.

The same four tests are then run again through the same client with
`--no-lifecycle` (no run opened, so nothing relayed), every wait released up
front, and the two stored runs are compared: summary counts, statuses and
leaf names (ids, timestamps and durations aside).

Needs the real `bun`, which both boots the board and runs the tests; it
FAILS, never skips, without it.
"""

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
BUN_SCRIPT = REPO_ROOT / "clients" / "bun-crucible.py"

RELAYED_AGENT = "bun-console-live-agent"
PLAIN_AGENT = "bun-console-unrelayed-agent"
GATE_SECONDS = 25
OBSERVE_SECONDS = 20
RUN_TIMEOUT = 240
RUN_STARTED = re.compile(r"^\[crucible\] run started: (\S+)$", re.MULTILINE)
TEST_FILE = "waits.test.ts"

FIRST = "first passes"
SECOND = "second fails once the board shows the first"
THIRD = "third passes once the board shows the failure"
FOURTH = "fourth ends once the board shows three"
PLANTED = "planted live failure"
DECLARED = 4

WAITING_TESTS = f'''import {{ expect, test }} from "bun:test";
import {{ existsSync }} from "node:fs";
import {{ join }} from "node:path";

async function waitFor(name: string): Promise<void> {{
  const gate = join(process.env.LIVE_GATE_DIR ?? "", name);
  const deadline = Date.now() + {GATE_SECONDS * 1000};
  while (Date.now() < deadline && !existsSync(gate)) {{
    await Bun.sleep(50);
  }}
}}

test("{FIRST}", () => {{
  expect(1 + 1).toBe(2);
}});

test("{SECOND}", async () => {{
  await waitFor("seen-1");
  throw new Error("{PLANTED}");
}});

test("{THIRD}", async () => {{
  await waitFor("seen-2");
}});

test("{FOURTH}", async () => {{
  await waitFor("seen-3");
}});
'''

_SCRUBBED = ("BUN_CRUCIBLE_NO_LIFECYCLE", "BUN_CRUCIBLE_PACKAGE_DIR",
             "BUN_CRUCIBLE_PROJECT_DIR", "BUN_CRUCIBLE_BUN", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY")

GATES = ("seen-1", "seen-2", "seen-3")


def _leaves(nodes):
    """Every leaf of a stored tree as `(name, status)`, sorted."""
    found = []
    for node in nodes or []:
        children = node.get("children") or []
        if children:
            found.extend(_leaves(children))
        else:
            found.append((node.get("name"), node.get("status")))
    return sorted(found, key=lambda leaf: (str(leaf[0]), str(leaf[1])))


def _counts(event):
    summary = event.get("summary") or {}
    return {k: summary.get(k) for k in ("total", "passed", "failed", "pending")}


class ARelayedBunRunShowsOnTheBoardWhileItWorksTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        bun = shutil.which("bun")
        if bun is None:
            raise AssertionError("this test boots the real board and runs the real "
                                 "`bun test`, so it needs `bun`")
        cls.bun = bun
        cls.scratch = Path(tempfile.mkdtemp(prefix="bun-console-live-"))
        cls.board = None
        try:
            cls.board = RealBoard(bun, "bun-console-live")
            cls.project = cls.scratch / "package"
            cls.project.mkdir()
            (cls.project / TEST_FILE).write_text(WAITING_TESTS, encoding="utf-8")
            cls.board.install(str(cls.project))
            cls.seen, cls.relayed = cls._relayed_run()
            cls.plain = cls._unrelayed_run()
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        if cls.board is not None:
            cls.board.close()
            cls.board = None
        shutil.rmtree(cls.scratch, ignore_errors=True)

    @classmethod
    def _command(cls, agent, reports, *flags):
        return [sys.executable, str(BUN_SCRIPT), "test", *flags,
                "--bun", cls.bun, "--project-dir", str(cls.project),
                "--package-dir", str(cls.project), "--reports", str(reports),
                "--agent", agent]

    @classmethod
    def _environment(cls, gates):
        env = scrubbed_env(LIVE_GATE_DIR=gates)
        for key in _SCRUBBED:
            env.pop(key, None)
        return env

    @classmethod
    def _observe(cls, run_id, shown):
        """Poll the open run's live view until `shown(answer)`; answers that
        view, or None when the board never showed it while the run was open."""
        board = cls.board
        assert board is not None
        deadline = time.monotonic() + OBSERVE_SECONDS
        while time.monotonic() < deadline:
            answer = board.http(f"/api/v2/runs/{run_id}/live")
            if answer.get("state") == "open" and shown(answer):
                return answer
            time.sleep(0.1)
        return None

    @classmethod
    def _relayed_run(cls):
        gates = cls.scratch / "gates-relayed"
        gates.mkdir()
        stderr_path = cls.scratch / "relayed-stderr.txt"
        seen = {}
        cmd = cls._command(RELAYED_AGENT, cls.scratch / "reports-relayed")
        with open(stderr_path, "w", encoding="utf-8") as err:
            proc = subprocess.Popen(cmd, cwd=str(cls.project), env=cls._environment(gates),
                                    stdout=subprocess.PIPE, stderr=err, text=True)
            try:
                run_id = None
                deadline = time.monotonic() + 60
                while run_id is None and time.monotonic() < deadline:
                    found = RUN_STARTED.search(stderr_path.read_text(errors="replace"))
                    run_id = found.group(1) if found else None
                    time.sleep(0.05)
                seen["runId"] = run_id
                steps = (
                    ("seen-1", lambda a: (a.get("live") or {}).get("completed", 0) >= 1),
                    ("seen-2", lambda a: any(f.get("name") == SECOND
                                             for f in a.get("failures") or [])),
                    ("seen-3", lambda a: (a.get("live") or {}).get("completed", 0) >= 3),
                )
                for gate, shown in steps:
                    seen[gate] = cls._observe(run_id, shown) if run_id else None
                    (gates / gate).write_text("go", encoding="utf-8")
                stdout, _ = proc.communicate(timeout=RUN_TIMEOUT)
            finally:
                for gate in GATES:
                    (gates / gate).write_text("go", encoding="utf-8")
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        return seen, (proc.returncode, stdout, stderr_path.read_text(errors="replace"))

    @classmethod
    def _unrelayed_run(cls):
        gates = cls.scratch / "gates-unrelayed"
        gates.mkdir()
        for gate in GATES:
            (gates / gate).write_text("go", encoding="utf-8")
        result = subprocess.run(
            cls._command(PLAIN_AGENT, cls.scratch / "reports-unrelayed", "--no-lifecycle"),
            cwd=str(cls.project), env=cls._environment(gates), capture_output=True,
            text=True, timeout=RUN_TIMEOUT, check=False)
        return result.returncode, result.stdout, result.stderr

    def diag(self):
        code, stdout, stderr = self.relayed
        return f"exit={code} stdout={stdout!r} stderr={stderr[-3000:]!r}"

    def stored(self, agent):
        board = self.board
        assert board is not None
        events = board.test_events(agent)
        self.assertEqual(len(events), 1, f"one run filed by {agent}; {self.diag()}")
        return board.event(events[0]["id"])

    def test_completed_rises_batch_by_batch_while_the_run_is_open(self):
        self.assertIsNotNone(self.seen.get("runId"), f"the client opened a run; {self.diag()}")
        for gate, completed in (("seen-1", 1), ("seen-2", 2), ("seen-3", 3)):
            with self.subTest(gate):
                view = self.seen.get(gate)
                self.assertIsNotNone(view, f"the board showed the open run's console "
                                           f"before {gate} was released; {self.diag()}")
                live = (view or {}).get("live") or {}
                self.assertEqual(live.get("completed"), completed,
                                 f"exactly the tests that had finished; {view!r}")
        first = (self.seen.get("seen-1") or {}).get("live") or {}
        self.assertEqual((first.get("passed"), first.get("failed")), (1, 0), first)
        third = (self.seen.get("seen-3") or {}).get("live") or {}
        self.assertEqual((third.get("passed"), third.get("failed")), (2, 1), third)

    def test_the_failure_shows_with_its_name_file_and_message_before_the_run_ends(self):
        view = self.seen.get("seen-2")
        self.assertIsNotNone(view, f"the failure was on the board while the run worked; "
                                   f"{self.diag()}")
        failures = [f for f in (view or {}).get("failures") or [] if f.get("name") == SECOND]
        self.assertEqual(len(failures), 1, view)
        self.assertTrue(str(failures[0].get("file") or "").endswith(TEST_FILE), failures[0])
        self.assertIn(PLANTED, failures[0].get("message") or "", failures[0])
        self.assertEqual(len((view or {}).get("failures") or []), 1, "one failure, no other")

    def test_the_live_total_is_the_clients_scan_of_the_package(self):
        view = self.seen.get("seen-1")
        self.assertIsNotNone(view, f"the board showed the open run; {self.diag()}")
        self.assertEqual(((view or {}).get("live") or {}).get("total"), DECLARED,
                         "the run start's total: the four declarations the client scanned")

    def test_the_stored_run_equals_the_same_tests_junit_run_filed_with_no_relay(self):
        code, _stdout, _stderr = self.relayed
        self.assertEqual(code, 1, f"one test failed; {self.diag()}")
        self.assertEqual(self.plain[0], 1, f"one test failed; plain={self.plain!r}")
        relayed, plain = self.stored(RELAYED_AGENT), self.stored(PLAIN_AGENT)
        self.assertEqual(_counts(relayed),
                         {"total": 4, "passed": 3, "failed": 1, "pending": 0})
        self.assertEqual(_counts(relayed), _counts(plain))
        self.assertEqual(_leaves(relayed.get("tree")), _leaves(plain.get("tree")))
        self.assertEqual(sorted(name for name, _status in _leaves(relayed.get("tree"))),
                         sorted([FIRST, SECOND, THIRD, FOURTH]))


if __name__ == "__main__":
    unittest.main()
