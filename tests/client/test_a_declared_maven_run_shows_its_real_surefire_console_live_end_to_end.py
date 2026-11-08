"""A declared maven run shows its REAL surefire console live on a REAL board.

The real `clients/mvn-crucible.py`, real maven (`mvn`, offline through the
fixture's `.mvn/maven.config`), real surefire 3.5.4 and JUnit Jupiter, and a
real board (`bun run src/server.ts` on a free port with a throwaway store,
behind a loopback proxy that records every request with its time). The maven
project is the fixture committed at `tests/fixtures/surefire-live-project`:
three classes run alphabetically, each a few seconds long —

  live.AlphaTest   2 tests, both pass
  live.BetaTest    2 tests, `breaks` fails with "beta broke"
  live.GammaTest   3 tests, one `@Disabled`

— each writing `<class>.started` and `<class>.ended` marks into
$SUREFIRE_LIVE_MARKS. It is copied into a `/tmp` scratch and built there,
never in the repository.

The project declares its `unit` console:

    [targets.unit]
    framework = "surefire"
    console = "surefire-console"

and one `test` run is driven (`test` reads `unit`). While it runs, the open
run's live view (`GET /api/v2/runs/<runId>/live`) is read every quarter
second, each read bracketed by the marks present before and after it. The
same run's own JUnit reports are then filed through `auto-ingest` under
another agent: the oracle the stored run is compared with.

What is asserted:
  - while each class after the first runs, the open run already shows the
    counts of every class before it, and a failure as soon as its class has
    ended;
  - every batch goes to the open run's stream route under `surefire-console`;
  - the stored run equals its JUnit (counts and rows) and states framework
    `surefire`;
  - no in-run `running N/M classes` tick is posted while the relay lands; the
    closing count and `ingesting…` are;
  - maven's console still reaches the terminal (the client's stderr).

A missing `mvn`, `java` or `bun` FAILS every test here, naming what is
missing; nothing is skipped.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_declared_maven_run_shows_its_real_surefire_console_live_end_to_end
"""

import glob
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    install_project,
    load_toon,
    scrubbed_env,
)
from tests.client.real_board import RealBoard

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "surefire-live-project"
MVN_CLIENT = CLIENTS / "mvn-crucible.py"
TOON = load_toon()
RUN_TIMEOUT = 600
LIVE_POLL_SECONDS = 0.25
HEARTBEAT = "/api/v2/agents/heartbeat"
VIEW_CODEC = "surefire-console"
FRAMEWORK = "surefire"
DECLARED_ENTRY = f'framework = "{FRAMEWORK}"\nconsole = "{VIEW_CODEC}"\n'
AGENT = "real-surefire-live"
ORACLE_AGENT = "real-surefire-live-oracle"

#: The classes in the order surefire runs them, and each one's tests as
#: surefire counts them: (class, run, failed, skipped).
CLASSES = (("live.AlphaTest", 2, 0, 0), ("live.BetaTest", 2, 1, 0),
           ("live.GammaTest", 3, 0, 1))

_SCRUBBED = ("MVN_CRUCIBLE_PROJECT_DIR", "MVN_CRUCIBLE_MAVEN_DIR", "MVN_CRUCIBLE_COMPOSE_FILE",
             "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_COVERAGE_PROFILE")

_MODULE = {}


def _toolchain_gap():
    """What is missing to run these tests, or None."""
    missing = [f"{tool} ({why})" for tool, why in (
        ("mvn", "the client runs real maven"),
        ("java", "surefire forks a JVM"),
        ("bun", "the real board is `bun run src/server.ts`"))
        if shutil.which(tool) is None]
    return "; ".join(missing) or None


class _RecordingProxy:
    """A loopback HTTP proxy to `upstream` that records every request the
    client makes, its body, and the board's status and answer, with the time
    the answer came back."""

    def __init__(self, upstream):
        self.records = []
        self._lock = threading.Lock()
        proxy = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _forward(self, method):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else None
                request = urllib.request.Request(  # noqa: S310 - loopback board
                    upstream + self.path, data=raw, method=method,
                    headers={"content-type": "application/json"})
                try:
                    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
                        status, answer = response.status, response.read()
                except urllib.error.HTTPError as exc:
                    status, answer = exc.code, exc.read()
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = None
                try:
                    decoded = json.loads(answer)
                except ValueError:
                    decoded = None
                with proxy._lock:
                    proxy.records.append({"at": time.time(), "method": method,
                                          "path": self.path, "body": body,
                                          "status": status, "answer": decoded})
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(answer)))
                self.end_headers()
                self.wfile.write(answer)

            def do_GET(self):
                self._forward("GET")

            def do_POST(self):
                self._forward("POST")

            def do_PATCH(self):
                self._forward("PATCH")

            def log_message(self, format, *args):
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def count(self):
        with self._lock:
            return len(self.records)

    def since(self, start):
        with self._lock:
            return list(self.records[start:])

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()


class _Run:
    """The one drive and everything observed of it."""

    def __init__(self, marks):
        self.marks = marks
        self.result: subprocess.CompletedProcess | None = None
        self.seconds = 0.0
        self.records = []
        self.samples = []
        self.run_id = None

    def where(self):
        result = self.result
        if result is None:
            return "never driven"
        return (f"exit={result.returncode} run={self.run_id} stdout={result.stdout[-600:]!r} "
                f"stderr={result.stderr[-900:]!r}")

    def posts(self, path_pattern):
        return [r for r in self.records if r["method"] == "POST"
                and re.match(path_pattern, r["path"])]

    def stream_batches(self):
        return self.posts(r"^/api/v2/runs/[^/]+/stream$")

    def starts(self):
        return self.posts(r"^/api/v2/runs/start$")

    def closes(self):
        return self.posts(r"^/api/v2/runs$")

    def heartbeats(self):
        return [(r["body"] or {}).get("message") for r in self.posts(rf"^{re.escape(HEARTBEAT)}$")]

    def mark_time(self, cls, phase):
        path = os.path.join(self.marks, f"{cls}.{phase}")
        return os.path.getmtime(path) if os.path.exists(path) else None


def _marks_state(marks):
    return set(os.listdir(marks)) if os.path.isdir(marks) else set()


def _client(argv, *, project, env, timeout=120):
    return subprocess.run([sys.executable, str(MVN_CLIENT), *argv, "--project-dir", project],
                          cwd=project, env=env, capture_output=True, text=True,
                          timeout=timeout, check=False)


def _register(agent, project, env):
    registered = _client(["register", "--agent", agent, "--role", "report"],
                         project=project, env=env)
    if registered.returncode != 0:
        raise RuntimeError(f"register {agent} failed: {registered.stdout[-500:]!r}")


def _drive(project, env, proxy, board, marks):
    run = _Run(marks)
    _register(AGENT, project, env)
    os.makedirs(marks, exist_ok=True)
    start = proxy.count()
    began = time.time()
    proc = subprocess.Popen(
        [sys.executable, str(MVN_CLIENT), "test", "--agent", AGENT, "--project-dir", project],
        cwd=project, env=dict(env, SUREFIRE_LIVE_MARKS=marks),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    holder = {}
    reader = threading.Thread(
        target=lambda: holder.update(out=proc.communicate(timeout=RUN_TIMEOUT)))
    reader.start()
    while reader.is_alive():
        if run.run_id is None:
            for record in proxy.since(start):
                if record["path"] == "/api/v2/runs/start" and isinstance(record["answer"], dict):
                    run.run_id = record["answer"].get("runId")
        if run.run_id is not None:
            before = _marks_state(marks)
            live = board.http(f"/api/v2/runs/{run.run_id}/live")
            after = _marks_state(marks)
            run.samples.append({"at": time.time(), "before": before, "after": after,
                                "live": live})
        reader.join(LIVE_POLL_SECONDS)
    stdout, stderr = holder.get("out", ("", ""))
    run.result = subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)
    run.seconds = time.time() - began
    run.records = proxy.since(start)
    return run


def _oracle(project, env, board):
    """File the run's own `TEST-*.xml` through `auto-ingest` under another
    agent; answer that stored event."""
    reports = os.path.join(project, "test-reports", AGENT)
    target = os.path.join(project, "target", "surefire-reports")
    shutil.rmtree(target, ignore_errors=True)
    os.makedirs(target)
    for path in glob.glob(os.path.join(reports, "TEST-*.xml")):
        shutil.copy(path, target)
    _register(ORACLE_AGENT, project, env)
    filed = _client(["auto-ingest", "--agent", ORACLE_AGENT], project=project, env=env)
    events = board.test_events(ORACLE_AGENT)
    if len(events) != 1:
        return {"error": f"the oracle filed {len(events)} runs: {filed.stdout[-600:]!r} "
                         f"{filed.stderr[-600:]!r}"}
    return board.event(events[0]["id"])


def setUpModule():
    gap = _toolchain_gap()
    if gap:
        _MODULE["gap"] = f"the real surefire console tests need: {gap}"
        return
    began = time.time()
    scratch = tempfile.mkdtemp(prefix="crucible-surefire-live-", dir="/tmp")
    _MODULE["scratch"] = scratch
    project = os.path.join(scratch, "project")
    shutil.copytree(FIXTURE, project)
    board = RealBoard(shutil.which("bun"), "real-surefire-live-runs")
    _MODULE["board"] = board
    proxy = _RecordingProxy(board.base)
    _MODULE["proxy"] = proxy
    install_project(project, proxy.url, board.key, board.name)
    with open(os.path.join(project, "crucible.toml"), "a", encoding="utf-8") as handle:
        handle.write(f"\n[targets.unit]\n{DECLARED_ENTRY}")
    env = scrubbed_env(None)
    for key in _SCRUBBED:
        env.pop(key, None)
    run = _drive(project, env, proxy, board, os.path.join(scratch, "marks"))
    _MODULE["run"] = run
    _MODULE["oracle"] = _oracle(project, env, board)
    _MODULE["seconds"] = time.time() - began
    print(f"[real-surefire-live] module ran in {_MODULE['seconds']:.1f}s; the declared "
          f"test run took {run.seconds:.1f}s", file=sys.stderr)


def tearDownModule():
    proxy = _MODULE.pop("proxy", None)
    if proxy is not None:
        proxy.close()
    board = _MODULE.pop("board", None)
    if board is not None:
        board.close()
    scratch = _MODULE.pop("scratch", None)
    if scratch:
        shutil.rmtree(scratch, ignore_errors=True)


def _rows(tree):
    return sorted(((suite.get("name"), leaf.get("name"), leaf.get("status"))
                   for suite in tree or [] for leaf in suite.get("children") or []),
                  key=lambda row: tuple(str(part) for part in row))


def _counts(event):
    summary = event.get("summary") or event
    return {key: summary.get(key) for key in ("total", "passed", "failed", "pending")}


def _live(sample):
    return ((sample["live"] or {}).get("live")) or {}


def _answers(samples):
    """The distinct answers the live reads got: a state, or an error."""
    return sorted({str((s["live"] or {}).get("state")
                       or (s["live"] or {}).get("error"))[:120] for s in samples})


class _RealRunCase(unittest.TestCase):
    maxDiff = 6000

    def setUp(self):
        gap = _MODULE.get("gap")
        if gap:
            self.fail(gap)
        if "run" not in _MODULE:
            self.fail("the module's real run was never made")
        self.run_ = _MODULE["run"]
        self.board = _MODULE["board"]

    def during(self, cls):
        """The reads of the open run made while `cls` ran: its start mark was
        there before the read, its end mark not yet after it."""
        started, ended = f"{cls}.started", f"{cls}.ended"
        return [s for s in self.run_.samples
                if started in s["before"] and ended not in s["after"]]

    def stored(self):
        events = self.board.test_events(AGENT)
        self.assertEqual(len(events), 1,
                         f"one run is stored for {AGENT}; events={len(events)} "
                         f"{self.run_.where()}")
        return self.board.event(events[0]["id"])


class EachClassShowsOnTheOpenRunBeforeTheNextEndsTest(_RealRunCase):

    def test_while_each_class_runs_the_open_run_already_shows_the_counts_of_every_class_before_it(self):
        for index in range(1, len(CLASSES)):
            cls = CLASSES[index][0]
            before = CLASSES[:index]
            expected = {"completed": sum(c[1] for c in before),
                        "failed": sum(c[2] for c in before),
                        "pending": sum(c[3] for c in before)}
            expected["passed"] = expected["completed"] - expected["failed"] - expected["pending"]
            with self.subTest(running=cls):
                during = self.during(cls)
                self.assertGreaterEqual(len(during), 1,
                                        f"the open run was read while {cls} ran; "
                                        f"samples={len(self.run_.samples)} {self.run_.where()}")
                seen = [{k: _live(s).get(k) for k in expected} for s in during
                        if (s["live"] or {}).get("state") == "open"]
                distinct = sorted({json.dumps(v, sort_keys=True) for v in seen})[:10]
                self.assertIn(expected, seen,
                              f"while {cls} ran, the open run's live view showed the classes "
                              f"before it; distinct open reads={distinct!r} "
                              f"answers={_answers(during)!r}")

    def test_a_failure_shows_on_the_open_run_before_the_next_class_ends(self):
        during = self.during("live.GammaTest")
        self.assertGreaterEqual(len(during), 1, f"the open run was read while GammaTest ran; "
                                                f"{self.run_.where()}")
        shown = [[(f.get("suite"), f.get("name"), "beta broke" in str(f.get("message")))
                  for f in (s["live"] or {}).get("failures") or []] for s in during]
        distinct = sorted({json.dumps(v) for v in shown})[:10]
        self.assertIn([("live.BetaTest", "breaks", True)], shown,
                      f"BetaTest's failure, with its message, showed while GammaTest ran; "
                      f"distinct failures read={distinct!r} answers={_answers(during)!r}")

    def test_a_batch_holding_a_class_end_reached_the_board_before_the_next_class_ended(self):
        ended = self.run_.mark_time("live.BetaTest", "ended")
        self.assertIsNotNone(ended, f"BetaTest ran; {self.run_.where()}")
        early = [b for b in self.run_.stream_batches()
                 if "-- in live.AlphaTest" in ((b["body"] or {}).get("data") or "")
                 and b["at"] < ended and b["status"] == 200]
        self.assertGreaterEqual(len(early), 1,
                                f"AlphaTest's `-- in` line was held by the board before BetaTest "
                                f"ended; batches={len(self.run_.stream_batches())} "
                                f"{self.run_.where()}")


class EveryBatchGoesToTheOpenRunUnderTheViewCodecTest(_RealRunCase):

    def test_every_stream_batch_is_sent_under_surefire_console_to_the_open_runs_stream(self):
        batches = self.run_.stream_batches()
        self.assertGreaterEqual(len(batches), 1, f"the console was relayed; {self.run_.where()}")
        self.assertEqual({(b["body"] or {}).get("codec") for b in batches}, {VIEW_CODEC})
        self.assertEqual({b["path"] for b in batches},
                         {f"/api/v2/runs/{self.run_.run_id}/stream"})
        self.assertEqual({b["status"] for b in batches}, {200},
                         "the board held every batch")

    def test_mavens_console_still_reaches_the_terminal(self):
        stderr = (self.run_.result.stderr if self.run_.result else "") or ""
        positions = [stderr.find(f"Running {cls}") for cls, *_ in CLASSES]
        self.assertTrue(all(p >= 0 for p in positions), f"each class's Running line; "
                                                        f"{self.run_.where()}")
        self.assertEqual(positions, sorted(positions), "in the order maven printed them")
        self.assertIn("live.BetaTest.breaks -- Time elapsed", stderr)


class TheRecordIsTheJUnitWithFrameworkSurefireTest(_RealRunCase):

    def test_the_stored_run_equals_its_junit_and_states_framework_surefire(self):
        stored = self.stored()
        oracle = _MODULE["oracle"]
        self.assertNotIn("error", oracle, oracle.get("error"))
        self.assertEqual(_counts(stored), {"total": 7, "passed": 5, "failed": 1, "pending": 1},
                         self.run_.where())
        self.assertEqual(_counts(stored), _counts(oracle))
        self.assertEqual(_rows(stored.get("tree")), _rows(oracle.get("tree")))
        self.assertIn(("live.BetaTest", "breaks", "fail"), _rows(stored.get("tree")))
        self.assertEqual(stored.get("framework"), FRAMEWORK,
                         "the declared run states framework surefire")
        self.assertEqual(self.run_.result.returncode if self.run_.result else None, 1,
                         "a run with a failure exits 1")

    def test_the_run_is_closed_once_from_its_junit(self):
        closes = self.run_.closes()
        self.assertEqual([((c["body"] or {}).get("codec"), (c["body"] or {}).get("runId"))
                          for c in closes], [("junit", self.run_.run_id)], self.run_.where())


class TheHeartbeatStepsBackWhileTheRelayLandsTest(_RealRunCase):

    def test_no_in_run_tick_is_posted_and_the_closing_count_then_ingesting_are(self):
        messages = [m for m in self.run_.heartbeats() if isinstance(m, str)]
        self.assertEqual([m for m in messages if m.startswith("running ")], [],
                         f"no in-run tick while the relay lands; heartbeats={messages!r}")
        closing = [m for m in messages if m.startswith("ran ") or m == "ingesting\u2026"]
        self.assertEqual(closing, ["ran 3/3 classes", "ingesting\u2026"],
                         f"heartbeats={messages!r}")


if __name__ == "__main__":
    unittest.main()
