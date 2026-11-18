"""CR-CRU-216 AC7 — a test run filed through the python client is read back
through the same client, and what it prints is what the board answers.

Against a fake board (`RecordingBoard`, tests/client/live_run_harness.py). A
fake interpreter (the `--python` idiom of
`test_python_exits_and_files_on_its_runners_exit.py`) writes an event stream
(CR-CRU-224) holding one passing and one failing case, and `python-crucible.py
test --cycle <id>` files that run: the request log shows the agent bound to
the cycle and the stream it sent. The board's answers to the read-back —
`GET /api/v2/events?project=&cycleId=`, `GET /api/v2/events/<id>` and
`GET /api/v2/events/<id>?depth=suites` — are scripted in the server's shapes
as the record of exactly that filing (a minted `evt-<ms>-<seq>` id, the
counts and tree of the stream the client sent, the tier, stack and codec it
filed under), and the verbs must print them.

That the server stores the run so, under the bound cycle, and answers those
three reads with it is the server's half, held in bun by
`events-anchored.test.ts` ("returns ONLY the requested cycle's linked runs
…"), `v2-runs-events.test.ts` ("CR-CRU-094 §S1/AC1 — the cycle binding rides
the run as a column"), `ingest-binding-attach.test.ts` and
`drill-in.test.ts` / `the-suites-read-counts-a-runs-coverage-files.test.ts`
(`?depth=suites`).

The envelope field names (`runs`, `run`, `suites`, `failingTests`) are the
decisions stated in `test_runs_and_run_read_a_projects_stored_runs_back.py`.

Invocation:
    python3 -m unittest tests.client.integration.test_runs_and_run_read_a_filed_run_back_end_to_end
"""

import os
import shutil
import stat
import subprocess
import sys
import unittest
import uuid
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    START,
    STREAM_ROUTE,
    RecordingBoard,
    install_project,
    load_toon,
    new_scratch,
    scrubbed_env,
    stream_sent,
)

TOON = load_toon()
PYTHON_CLIENT = CLIENTS / "python-crucible.py"
TIMEOUT = 180

AGENT = "run-read-back-e2e-red"
ORCHESTRATOR = "run-read-back-e2e-orchestrator"
#: The cycle the run is filed under (an id the board would have given).
CYCLE_ID = 9721

PROBE_CLASS = "read_back_probe.ReadBackProbeCase"
PASSING_CASE = "test_the_order_totals"
FAILING_CASE = "test_the_refund_is_refused_on_purpose"

_SCRUBBED = ("PY_CRUCIBLE_PYTHON", "PYTHON_CRUCIBLE_PROJECT_DIR",
             "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

EMPTY = (None, "")

# A fake interpreter: run as the suite (`… subtest_runner.py`) it writes one
# passing and one failing case as a Crucible event stream to the file
# `CRUCIBLE_STREAM` names, taking the variable out of its own environment
# first, writes no JUnit (CR-CRU-224 section S1), and exits 1, as a runner
# with a failure does. A coverage.py probe (`-c <script>`) answers true.
_FAKE_PYTHON = r'''
import json
import os
import sys

CLASS, CASE, FAILING = ''' + repr((PROBE_CLASS, PASSING_CASE, FAILING_CASE)) + r'''

argv = sys.argv[1:]
if argv[:1] == ["-c"]:
    sys.stdout.write("true\n")
    sys.exit(0)
stream = os.environ.pop("CRUCIBLE_STREAM", None)
sys.stderr.write("Ran 2 tests in 0.002s\n\nFAILED (failures=1)\n")
sys.stderr.flush()
file = CLASS.split(".")[0] + ".py"
if stream:
    with open(stream, "w", encoding="utf-8") as handle:
        for event in (dict(event="run-start", total=2),
                      dict(event="test-end", id=CLASS + "." + CASE, name=CASE,
                           suite=CLASS, file=file, status="pass", duration_ms=1),
                      dict(event="test-end", id=CLASS + "." + FAILING, name=FAILING,
                           suite=CLASS, file=file, status="fail", duration_ms=1,
                           failure=dict(message="2 != 3", type="AssertionError",
                                        trace="AssertionError: 2 != 3")),
                      dict(event="run-end", total=2, passed=1, failed=1, pending=0,
                           duration_ms=2)):
            handle.write(json.dumps(event) + "\n")
            handle.flush()
sys.exit(1)
'''


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout[-3000:]!r} "
            f"stderr={result.stderr[-3000:]!r}")


def _empty_to_none(value):
    return None if value == "" else value


class AFiledRunReadsBackAsTheBoardStoredItEndToEndTest(unittest.TestCase):
    """AC7 — file through the python client, read back through it, compare
    with the board's answer for the record of that filing."""

    @classmethod
    def setUpClass(cls):
        cls.board = RecordingBoard()
        cls.key = str(uuid.uuid4())
        cls.cycle_id = CYCLE_ID
        cls.project = new_scratch("run-read-back-e2e-")
        Path(cls.project, "tests").mkdir()
        cls.fake_python = os.path.join(cls.project, "fake_python.py")
        Path(cls.fake_python).write_text("#!" + sys.executable + "\n" + _FAKE_PYTHON)
        os.chmod(cls.fake_python,
                 os.stat(cls.fake_python).st_mode | stat.S_IXUSR | stat.S_IRUSR)
        install_project(cls.project, cls.board.url, cls.key)
        cls.filed = cls._client("test", "--agent", AGENT,
                                "--python", cls.fake_python,
                                "--reports", "reports",
                                "--cycle", str(cls.cycle_id))
        cls.records = cls._script_the_stored_record()

    @classmethod
    def tearDownClass(cls):
        cls.board.close()
        shutil.rmtree(cls.project, ignore_errors=True)

    @classmethod
    def _script_the_stored_record(cls):
        """Script the board's three read-back answers as the record of the
        run the client just filed: its stream's counts and tree, the tier
        and stack its start named, the codec it closed under, the cycle it
        was bound to, and a minted event id. None when nothing was filed
        (the tests then fail on the request log, naming the drive)."""
        posts = cls.board.posts()
        starts = [b for p, b in posts if p == START and isinstance(b, dict)]
        closes = [b for p, b in posts if p == "/api/v2/runs" and isinstance(b, dict)]
        if len(starts) != 1 or len(closes) != 1:
            return None
        start, close = starts[0], closes[0]
        sent = stream_sent(cls.board, close.get("runId") or "run-live-1")
        summary = sent["summary"]
        event_id = cls.board.mint_event_id()
        brief = {"id": event_id, "projectKey": cls.key, "agentId": AGENT,
                 "kind": "test", "tier": start.get("tier"),
                 "codec": close.get("codec"), "stack": start.get("stack"),
                 "cycleId": cls.cycle_id, **summary}
        tree = [{"name": node["name"], "status": node["status"],
                 "counts": {status: [c["status"] for c in node["children"]].count(
                     "pass" if status == "passed" else
                     "fail" if status == "failed" else "pending")
                     for status in ("passed", "failed", "pending")},
                 "children": node["children"]} for node in sent["tree"]]
        full = {k: v for k, v in brief.items() if k not in summary}
        full.update({"summary": summary, "tree": tree})
        by_suite = dict(full, tree=[{k: v for k, v in node.items() if k != "children"}
                                    for node in tree])
        cls.board.answer("GET", f"/api/v2/events?project={cls.key}&cycleId={cls.cycle_id}",
                         {"ok": True, "events": [brief], "openRuns": []})
        cls.board.answer("GET", f"/api/v2/events/{event_id}",
                         {"ok": True, "event": full})
        cls.board.answer("GET", f"/api/v2/events/{event_id}?depth=suites",
                         {"ok": True, "event": by_suite})
        return {"brief": brief, "full": full, "suites": by_suite,
                "sent": sent, "start": start, "close": close}

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
        """The ONE test run this agent filed under the cycle, as the client
        sent it, and the board's scripted record of it: listed, whole and by
        suite."""
        records = self.records
        self.assertIsNotNone(
            records,
            f"the python client opens and closes exactly one run; posts="
            f"{[p for p, _ in self.board.posts()]!r}; {_diagnostics(self.filed)}")
        assert records is not None
        # `--cycle` binds the run's agent through its opening heartbeat
        # (`GatedIdentity.open_payload`), before the run is opened.
        bound = [(i, b) for i, (p, b) in enumerate(self.board.posts())
                 if p in ("/api/v2/agents/register", "/api/v2/agents/heartbeat")
                 and isinstance(b, dict) and b.get("agentId") == AGENT
                 and b.get("cycleId") is not None]
        opened = next(i for i, (p, _) in enumerate(self.board.posts())
                      if p == START)
        self.assertTrue(
            bound and str(bound[0][1]["cycleId"]) == str(self.cycle_id)
            and bound[0][0] < opened,
            f"the agent is bound to cycle {self.cycle_id} before it opens "
            f"its run; bindings={bound!r}")
        # The fixture's own precondition, so a red below is never a filing
        # that silently did not happen: the fake runner's one pass and one
        # failure, as the client streamed them.
        summary = records["sent"]["summary"]
        self.assertEqual(
            (summary["passed"], summary["failed"]), (1, 1),
            f"the client streamed the fake runner's one pass and one "
            f"failure; sent={records['sent']!r}")
        self.assertTrue(
            any(STREAM_ROUTE.match(p) for p, _ in self.board.posts()),
            "the run's events went up its stream route")
        # A python unittest run is filed from its runner's stream (CR-CRU-224).
        self.assertEqual(records["close"].get("codec"), "crucible-events",
                         f"the run was closed under the stream's codec; "
                         f"close={records['close']!r}")
        return (records["brief"], records["full"],
                records["suites"].get("tree") or [])

    def envelope(self, result):
        heads = [line for line in result.stdout.splitlines()
                 if line.startswith("axi:")]
        self.assertEqual(len(heads), 1,
                         f"one `axi:` envelope on stdout; {_diagnostics(result)}")
        decoded = TOON.decode(result.stdout)
        axi = decoded.get("axi") if isinstance(decoded, dict) else None
        self.assertIsInstance(axi, dict, _diagnostics(result))
        assert axi is not None
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
