"""A declared arduino target streams a REAL native run to a REAL board.

The real `clients/arduino-crucible.py`, real `make` and `g++`, and a real
board (`bun run src/server.ts` on a free port with a throwaway store, behind a
loopback proxy that records every request with its time). The native harness
is the fixture committed at `tests/fixtures/arduino-native` (`crucible_native.h`
and its test sources, with `Makefile.in`), copied into a scratch project under
/tmp and built there. It writes one `crucible-events` `test-end` line per test
to `$CRUCIBLE_STREAM` as each test ends (append, one write, flush), prints no
Unity verdict line, and writes its `TEST-<suite>.xml` into `$REPORTS_DIR`.

The scratch project's own `crucible.toml` declares, keyed by native dir and
make target, `framework = "arduino-native"` and `stream = { codec =
"crucible-events", path = "env:CRUCIBLE_STREAM" }` for:

  - `tests/native/junit`: two binaries, passes, a failure and an ignored test;
  - `tests/native-green/junit`: two green binaries, writing an lcov on a
    coverage run (none with NATIVE_NO_LCOV);
  - `tests/native-tier/junit-integration`: a declared `integration` target;
  - `tests/native-crash/junit`: a binary killed by SIGSEGV after two tests,
    halfway through a stream line, and a later binary that never runs;
  - `tests/native-short/junit`: the mixed binaries, the second one leaving its
    last test out of its JUnit (a stream that disagrees with its JUnit);
  - `tests/native-silent/junit`: green binaries whose Makefile never hands
    `CRUCIBLE_STREAM` on, so no stream is written.

`tests/native-plain/junit` (the green binaries) is not declared: its run is
the JUnit path a declared run is compared with. A run's JUnit oracle is that
run's own `TEST-*.xml` filed through `auto-ingest` under another agent.

What is proved:
  - each test reaches the open run before the next one ends; every test verb
    relays while `make` runs; the heartbeat counts the stream's `test-end`s;
  - the stored run states framework `arduino-native`, its counts and failures
    equal its JUnit's, the client's `run-end` states the JUnit's totals, and a
    stream that disagrees with its JUnit is stored incomplete;
  - a coverage run's stored coverage equals the JUnit path's; no lcov is the
    `coverage-not-measured` warning;
  - a crash is filed red and incomplete, from the tests before it, with the
    `exit <n>` leaf and the cut line counted undecodable;
  - a declared run whose harness wrote no stream is filed from its JUnit with
    one warning naming the declared key.

A missing `g++`, `make` or `bun` FAILS every test here, naming what is missing.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_an_arduino_declared_target_streams_a_real_native_run_end_to_end
"""

import http.server
import json
import os
import re
import shutil
import stat
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

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "arduino-native"
ARDUINO_CLIENT = CLIENTS / "arduino-crucible.py"
TOON = load_toon()
RUN_TIMEOUT = 300
LIVE_POLL_SECONDS = 0.25
HEARTBEAT = "/api/v2/agents/heartbeat"
STREAM_CODEC = "crucible-events"
FRAMEWORK = "arduino-native"
DECLARED_ENTRY = ('framework = "arduino-native"\n'
                  'stream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }\n')

_SCRUBBED = ("ARDUINO_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "CRUCIBLE_URL", "CRUCIBLE_STREAM", "AGENT_ID", "TESTS", "TEST_NAME",
             "NATIVE_TEST_DELAY_MS", "NATIVE_TEST_MARK_DIR", "NATIVE_NO_LCOV",
             "NATIVE_JUNIT_DROP_LAST", "ARDUINO_FQBN")

# Each native dir: the sources it holds, its make target, and whether the
# project declares it. `silent` is a Makefile that never exports the stream.
NATIVE_DIRS = {
    "tests/native": (("test_alpha", "test_beta"), "junit", True),
    "tests/native-green": (("test_green_one", "test_green_two"), "junit", True),
    "tests/native-plain": (("test_green_one", "test_green_two"), "junit", False),
    "tests/native-tier": (("test_green_one", "test_green_two"), "junit-integration", True),
    "tests/native-crash": (("test_crash_first", "test_crash_later"), "junit", True),
    "tests/native-short": (("test_alpha", "test_beta"), "junit", True),
    "tests/native-silent": (("test_green_one", "test_green_two"), "junit", True),
}

# The tests of the mixed binaries, in the order they run.
MIXED_ORDER = (("test_alpha", "adds"), ("test_alpha", "subtracts"),
               ("test_alpha", "waits_for_board"), ("test_beta", "parses"),
               ("test_beta", "rounds"))
GREEN_ORDER = (("test_green_one", "boots"), ("test_green_one", "reads"),
               ("test_green_two", "writes"))

# The board's own leaf for a runner that exited non-zero over no failure.
RUNNER_EXIT_MESSAGE = "the runner exited 2 but its report records no failure"

# (label, argv, extra env, marks): every drive, in the order it is made.
LIVE_DELAY_MS = "3500"
RELAY_DELAY_MS = "1500"
DRIVES = (
    ("test", ("test",), {"NATIVE_TEST_DELAY_MS": LIVE_DELAY_MS}, True),
    ("unit", ("unit",), {"NATIVE_TEST_DELAY_MS": RELAY_DELAY_MS}, True),
    ("integration", ("integration", "--dir", "tests/native-tier"),
     {"NATIVE_TEST_DELAY_MS": RELAY_DELAY_MS}, True),
    ("regression", ("regression", "--coverage", "--dir", "tests/native-green"),
     {"NATIVE_TEST_DELAY_MS": RELAY_DELAY_MS}, True),
    ("pre-merge-gate", ("pre-merge-gate", "--dir", "tests/native-green"),
     {"NATIVE_TEST_DELAY_MS": RELAY_DELAY_MS}, True),
    ("plain", ("regression", "--coverage", "--dir", "tests/native-plain"), {}, False),
    ("no-lcov", ("regression", "--coverage", "--dir", "tests/native-green"),
     {"NATIVE_NO_LCOV": "1"}, False),
    ("crash", ("test", "--dir", "tests/native-crash"), {}, False),
    ("short", ("test", "--dir", "tests/native-short"),
     {"NATIVE_JUNIT_DROP_LAST": "test_beta"}, False),
    ("silent", ("test", "--dir", "tests/native-silent"), {}, False),
)
# The verbs whose relay is proved to run while `make` runs.
RELAYED_VERBS = ("test", "unit", "integration", "regression", "pre-merge-gate")
# The runs whose JUnit is filed again as their oracle.
ORACLE_OF = {"test": "tests/native", "regression": "tests/native-green"}


def _toolchain_gap():
    """What is missing to run these tests, or None."""
    missing = [f"{tool} ({why})" for tool, why in (
        ("g++", "the native harness is built with g++"),
        ("make", "the client runs the native Makefile"),
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
    """One drive and everything observed of it."""

    def __init__(self, label, agent, marks):
        self.label = label
        self.agent = agent
        self.marks = marks
        self.result: subprocess.CompletedProcess | None = None
        self.seconds = 0.0
        self.records = []
        self.samples = []
        self.run_id = None

    def where(self):
        result = self.result
        if result is None:
            return f"{self.label}: never driven"
        return (f"{self.label}: exit={result.returncode} stdout={result.stdout[-600:]!r} "
                f"stderr={result.stderr[-600:]!r}")

    def posts(self, path_pattern):
        return [r for r in self.records if r["method"] == "POST"
                and re.match(path_pattern, r["path"])]

    def stream_batches(self):
        return self.posts(r"^/api/v2/runs/[^/]+/stream$")

    def ingests(self):
        return self.posts(r"^/api/v2/runs(/parsed|/compile)?$")

    def starts(self):
        return self.posts(r"^/api/v2/runs/start$")

    def heartbeats(self):
        return [(r["at"], (r["body"] or {}).get("message"))
                for r in self.posts(rf"^{re.escape(HEARTBEAT)}$")]

    def streamed_text(self):
        """The stream as the board was sent it: each batch's data at its
        `from` offset, in UTF-8 bytes."""
        held = b""
        for batch in self.stream_batches():
            body = batch["body"] or {}
            start = body.get("from")
            data = (body.get("data") or "").encode()
            if isinstance(start, int) and data:
                held = held[:start] + data
        return held.decode("utf-8", "replace")

    def mark_time(self, suite, name, phase):
        path = os.path.join(self.marks or "", f"{suite}.{name}.{phase}")
        return os.path.getmtime(path) if self.marks and os.path.exists(path) else None


_MODULE = {}


def _write_executable(path, text):
    Path(path).write_text(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


def _build_project(scratch):
    """The scratch project: every native dir with its sources, the harness
    and its Makefile, and the project's own `crucible.toml` declarations."""
    project = os.path.join(scratch, "project")
    template = (FIXTURE / "Makefile.in").read_text(encoding="utf-8")
    declarations = []
    for sub, (stems, target, declared) in NATIVE_DIRS.items():
        native = os.path.join(project, *sub.split("/"))
        os.makedirs(native)
        shutil.copy(FIXTURE / "crucible_native.h", native)
        for stem in stems:
            shutil.copy(FIXTURE / f"{stem}.cpp", native)
        makefile = template.replace("@TARGET@", target)
        if sub.endswith("-silent"):
            makefile = "unexport CRUCIBLE_STREAM\n" + makefile
        Path(native, "Makefile").write_text(makefile, encoding="utf-8")
        if declared:
            declarations.append(f'\n[targets."{sub}/{target}"]\n{DECLARED_ENTRY}')
    return project, "".join(declarations)


def _register(agent, project, env):
    registered = subprocess.run(
        [sys.executable, str(ARDUINO_CLIENT), "register", "--agent", agent, "--role",
         "report", "--project-dir", project], cwd=project, env=env,
        capture_output=True, text=True, timeout=60, check=False)
    if registered.returncode != 0:
        raise RuntimeError(f"register {agent} failed: {registered.stdout[-500:]!r}")


def _marks_state(marks):
    return set(os.listdir(marks)) if marks and os.path.isdir(marks) else set()


def _drive(label, argv, extra, marks, *, project, env, proxy, board):
    agent = "real-arduino-" + re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    run = _Run(label, agent, marks)
    _register(agent, project, env)
    drive_env = dict(env, **extra)
    if marks:
        os.makedirs(marks, exist_ok=True)
        drive_env["NATIVE_TEST_MARK_DIR"] = marks
    start = proxy.count()
    began = time.time()
    proc = subprocess.Popen(
        [sys.executable, str(ARDUINO_CLIENT), *argv, "--agent", agent,
         "--project-dir", project], cwd=project, env=drive_env,
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
        if run.run_id is not None and marks:
            before = _marks_state(marks)
            live = board.http(f"/api/v2/runs/{run.run_id}/live")
            after = _marks_state(marks)
            run.samples.append({"before": before, "after": after, "live": live})
        reader.join(LIVE_POLL_SECONDS)
    stdout, stderr = holder.get("out", ("", ""))
    run.result = subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)
    run.seconds = time.time() - began
    run.records = proxy.since(start)
    return run


def _oracle(run, sub, *, project, env, board):
    """File the run's own `TEST-*.xml` through `auto-ingest` under another
    agent; answer that stored event."""
    agent = "real-arduino-oracle-" + re.sub(r"[^a-z0-9]+", "-", run.label)
    _register(agent, project, env)
    reports = os.path.join(project, "test-reports", run.agent)
    filed = subprocess.run(
        [sys.executable, str(ARDUINO_CLIENT), "auto-ingest", "--reports", reports,
         "--dir", sub, "--agent", agent, "--project-dir", project], cwd=project,
        env=env, capture_output=True, text=True, timeout=120, check=False)
    events = board.test_events(agent)
    if len(events) != 1:
        return {"error": f"the oracle filed {len(events)} runs: {filed.stdout[-600:]!r} "
                         f"{filed.stderr[-600:]!r}"}
    return board.event(events[0]["id"])


def setUpModule():
    gap = _toolchain_gap()
    if gap:
        _MODULE["gap"] = f"the real native-run tests need: {gap}"
        return
    began = time.time()
    scratch = tempfile.mkdtemp(prefix="crucible-arduino-native-", dir="/tmp")
    _MODULE["scratch"] = scratch
    project, declarations = _build_project(scratch)
    board = RealBoard(shutil.which("bun"), "real-arduino-native-runs")
    _MODULE["board"] = board
    proxy = _RecordingProxy(board.base)
    _MODULE["proxy"] = proxy
    install_project(project, proxy.url, board.key, board.name)
    with open(os.path.join(project, "crucible.toml"), "a", encoding="utf-8") as handle:
        handle.write(declarations)
    bin_dir = os.path.join(scratch, "bin")
    os.makedirs(bin_dir)
    cli = os.path.join(bin_dir, "arduino-cli")
    _write_executable(cli, "#!/bin/sh\necho 'Sketch uses 1024 bytes'\nexit 0\n")
    env = scrubbed_env(None, ARDUINO_CLI=cli)
    for key in _SCRUBBED:
        env.pop(key, None)
    runs = {}
    for label, argv, extra, marked in DRIVES:
        marks = os.path.join(scratch, "marks", label) if marked else None
        runs[label] = _drive(label, argv, extra, marks, project=project, env=env,
                             proxy=proxy, board=board)
    _MODULE["oracles"] = {label: _oracle(runs[label], sub, project=project, env=env,
                                         board=board)
                          for label, sub in ORACLE_OF.items()}
    _MODULE["runs"] = runs
    _MODULE["seconds"] = time.time() - began
    print(f"[real-arduino-native] module built and drove every run in "
          f"{_MODULE['seconds']:.1f}s: "
          + ", ".join(f"{r.label}={r.seconds:.1f}s" for r in runs.values()), file=sys.stderr)


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
    return sorted(((suite.get("name"), leaf.get("name"), leaf.get("status"),
                    (leaf.get("failure") or {}).get("message"))
                   for suite in tree or [] for leaf in suite.get("children") or []),
                  key=lambda row: (str(row[0]), str(row[1])))


def _counts(event):
    summary = event.get("summary") or event
    return {key: summary.get(key) for key in ("total", "passed", "failed", "pending")}


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _warnings(run):
    axi = _envelope(run.result.stdout) or {}
    return [w for w in axi.get("warnings") or [] if isinstance(w, dict)]


def _stream_lines(text):
    lines = []
    for line in text.split("\n"):
        if not line:
            continue
        try:
            lines.append(json.loads(line))
        except ValueError:
            lines.append({"undecodable": line})
    return lines


class _RealRunCase(unittest.TestCase):
    maxDiff = 6000

    def setUp(self):
        gap = _MODULE.get("gap")
        if gap:
            self.fail(gap)
        if "runs" not in _MODULE:
            self.fail("the module's real runs were never made")
        self.runs = _MODULE["runs"]
        self.board = _MODULE["board"]

    def stored(self, run):
        events = self.board.test_events(run.agent)
        self.assertEqual(len(events), 1,
                         f"one run is stored for {run.agent}; events={len(events)} {run.where()}")
        return self.board.event(events[0]["id"])

    def oracle(self, label):
        event = _MODULE["oracles"][label]
        self.assertNotIn("error", event, event.get("error"))
        return event


class EachTestReachesTheOpenRunBeforeTheNextEndsTest(_RealRunCase):

    def test_while_each_test_runs_the_open_run_already_holds_every_test_before_it(self):
        run = self.runs["test"]
        for index in range(1, len(MIXED_ORDER)):
            suite, name = MIXED_ORDER[index]
            started, ended = f"{suite}.{name}.started", f"{suite}.{name}.ended"
            with self.subTest(running=f"{suite}.{name}"):
                during = [s for s in run.samples
                          if started in s["before"] and ended not in s["after"]
                          and (s["live"] or {}).get("state") == "open"]
                self.assertGreaterEqual(len(during), 1,
                                        f"the open run was read while {name} ran; "
                                        f"samples={len(run.samples)} {run.where()}")
                completed = [(s["live"].get("live") or {}).get("completed") for s in during]
                self.assertIn(index, completed,
                              f"while {name} ran, the open run held the {index} tests "
                              f"before it; completed read={completed!r}")

    def test_every_test_verb_relays_a_test_end_before_its_last_test_ends(self):
        for label in RELAYED_VERBS:
            with self.subTest(verb=label):
                run = self.runs[label]
                order = MIXED_ORDER if label in ("test", "unit") else GREEN_ORDER
                last = run.mark_time(*order[-1], "ended")
                self.assertIsNotNone(last, f"the last test ran; {run.where()}")
                early = [b for b in run.stream_batches()
                         if '"test-end"' in ((b["body"] or {}).get("data") or "")
                         and b["at"] < last]
                self.assertGreaterEqual(
                    len(early), 1,
                    f"a stream batch holding a test-end reached the board while make "
                    f"ran; batches={len(run.stream_batches())} {run.where()}")

    def test_every_stream_batch_carries_codec_crucible_events(self):
        for label in RELAYED_VERBS + ("crash", "short", "no-lcov"):
            with self.subTest(verb=label):
                run = self.runs[label]
                codecs = {(b["body"] or {}).get("codec") for b in run.stream_batches()}
                self.assertEqual(codecs, {STREAM_CODEC}, run.where())

    def test_the_heartbeat_counts_the_streams_test_ends(self):
        run = self.runs["test"]
        messages = [message for _at, message in run.heartbeats()]
        closing = [m for m in messages if isinstance(m, str) and m.startswith("ran ")]
        self.assertEqual(closing, ["ran 5/5"],
                         f"the one closing count is the stream's five test-ends (the "
                         f"harness prints no Unity line); heartbeats={messages!r}")


class TheStreamIsTheRecordAndTheJUnitChecksItTest(_RealRunCase):

    def test_the_mixed_run_states_framework_arduino_native_on_its_start_and_stored_run(self):
        run = self.runs["test"]
        self.assertEqual([(s["body"] or {}).get("framework") for s in run.starts()],
                         [FRAMEWORK], run.where())
        self.assertEqual(self.stored(run).get("framework"), FRAMEWORK, run.where())

    def test_the_mixed_run_is_closed_from_its_stream_and_posts_no_junit(self):
        run = self.runs["test"]
        bodies = [r["body"] or {} for r in run.ingests()]
        self.assertEqual([(r["path"], body.get("codec")) for r, body in
                          zip(run.ingests(), bodies, strict=True)],
                         [("/api/v2/runs", STREAM_CODEC)], run.where())
        self.assertNotIn("data", bodies[0] if bodies else {}, "a stream close sends no data")

    def test_the_mixed_runs_counts_and_failures_equal_its_junits(self):
        run = self.runs["test"]
        stored, oracle = self.stored(run), self.oracle("test")
        self.assertEqual(stored.get("framework"), FRAMEWORK, "the run is the declared stream's")
        self.assertEqual(_rows(stored.get("tree")), _rows(oracle.get("tree")), run.where())
        self.assertEqual(_counts(stored), _counts(oracle))
        self.assertEqual(_counts(stored), {"total": 5, "passed": 3, "failed": 1, "pending": 1})
        self.assertIn(("test_alpha", "subtracts", "fail", "expected 3 got 4"),
                      _rows(stored.get("tree")))
        self.assertIsNone(stored.get("incomplete"), run.where())
        self.assertEqual(run.result.returncode, 1, "a run with a failure exits 1")

    def test_the_client_writes_one_run_end_last_stating_the_junits_totals(self):
        for label, totals in (("test", (5, 3, 1, 1)), ("regression", (3, 3, 0, 0))):
            with self.subTest(run=label):
                run = self.runs[label]
                lines = _stream_lines(run.streamed_text())
                ends = [line for line in lines if line.get("event") == "run-end"]
                self.assertEqual(len(ends), 1, f"one run-end; lines={lines[-3:]!r}")
                self.assertEqual(lines[-1].get("event"), "run-end", "the run-end is last")
                self.assertEqual(tuple(ends[0].get(k) for k in
                                       ("total", "passed", "failed", "pending")), totals)
                self.assertEqual([line for line in lines if line.get("event") == "run-start"],
                                 [], "no run-start is written")

    def test_a_green_declared_run_of_two_binaries_exits_zero_and_is_complete(self):
        run = self.runs["regression"]
        stored = self.stored(run)
        self.assertEqual(run.result.returncode, 0, run.where())
        self.assertIsNone(stored.get("incomplete"), run.where())
        self.assertEqual(stored.get("framework"), FRAMEWORK)
        self.assertEqual(_rows(stored.get("tree")),
                         _rows(self.oracle("regression").get("tree")))
        self.assertEqual(_counts(stored), {"total": 3, "passed": 3, "failed": 0, "pending": 0})

    def test_a_stream_whose_count_differs_from_its_junit_is_stored_incomplete(self):
        run = self.runs["short"]
        stored = self.stored(run)
        self.assertIn("run-end states", stored.get("incomplete") or "",
                      f"the client's run-end (the JUnit's four tests) disagrees with the "
                      f"stream's five; {run.where()}")
        self.assertEqual(_counts(stored)["total"], 5, "the stored run is the stream's")
        self.assertNotEqual(run.result.returncode, 0, run.where())


class CoverageRidesTheCloseTest(_RealRunCase):

    def test_a_declared_coverage_runs_stored_coverage_equals_the_junit_paths(self):
        plain = self.stored(self.runs["plain"]).get("coverage")
        self.assertTrue(plain, f"the JUnit path stored coverage; {self.runs['plain'].where()}")
        for label in ("regression", "pre-merge-gate"):
            with self.subTest(verb=label):
                run = self.runs[label]
                closes = [r["body"] or {} for r in run.ingests()]
                self.assertEqual([(c.get("codec"), (c.get("coverage") or {}).get("codec"))
                                  for c in closes], [(STREAM_CODEC, "lcov")], run.where())
                self.assertEqual(self.stored(run).get("coverage"), plain, run.where())

    def test_a_declared_coverage_run_with_no_lcov_carries_coverage_not_measured(self):
        run = self.runs["no-lcov"]
        codes = [w.get("code") for w in _warnings(run)]
        self.assertEqual(codes.count("coverage-not-measured"), 1, run.where())
        self.assertEqual([(r["body"] or {}).get("codec") for r in run.ingests()],
                         [STREAM_CODEC], run.where())
        self.assertIsNone(self.stored(run).get("coverage"))


class ACrashIsFiledRedAndIncompleteTest(_RealRunCase):

    def test_the_crash_is_filed_from_the_tests_before_it_with_the_exit_leaf(self):
        run = self.runs["crash"]
        stored = self.stored(run)
        self.assertEqual(_rows(stored.get("tree")), [
            ("runner", "exit 2", "fail", RUNNER_EXIT_MESSAGE),
            ("test_crash_first", "boots", "pass", None),
            ("test_crash_first", "reads", "pass", None),
        ], run.where())
        self.assertNotEqual(run.result.returncode, 0, run.where())

    def test_the_crash_is_incomplete_with_no_run_end_and_its_cut_line_undecodable(self):
        run = self.runs["crash"]
        incomplete = self.stored(run).get("incomplete") or ""
        self.assertIn("no run-end", incomplete, run.where())
        self.assertIn("1 undecodable line", incomplete, run.where())
        self.assertNotIn('"run-end"', run.streamed_text(),
                         "no run-end is written for a crash that left no JUnit")

    def test_the_binary_after_the_crash_never_ran_and_is_absent(self):
        run = self.runs["crash"]
        suites = [s.get("name") for s in self.stored(run).get("tree") or []]
        self.assertIn("test_crash_first", suites, run.where())
        self.assertNotIn("test_crash_later", suites)
        self.assertNotIn("test_crash_later", run.streamed_text())


class ADeclaredRunWithNoStreamIsFiledFromItsJUnitTest(_RealRunCase):

    def test_a_declared_run_whose_harness_wrote_no_stream_is_filed_from_its_junit(self):
        run = self.runs["silent"]
        stored = self.stored(run)
        self.assertEqual([(s["body"] or {}).get("framework") for s in run.starts()],
                         [FRAMEWORK], f"a declared run states its framework; {run.where()}")
        self.assertEqual(_counts(stored), {"total": 3, "passed": 3, "failed": 0, "pending": 0},
                         run.where())
        self.assertEqual(_rows(stored.get("tree")),
                         _rows(self.oracle("regression").get("tree")))
        self.assertEqual(run.result.returncode, 0, run.where())

    def test_it_carries_one_warning_naming_the_declared_key_and_the_missing_stream(self):
        run = self.runs["silent"]
        named = [w for w in _warnings(run)
                 if "tests/native-silent/junit" in str(w.get("detail"))]
        self.assertEqual(len(named), 1, f"warnings={_warnings(run)!r}")
        self.assertIn("stream", str(named[0].get("detail")).lower())


class AnUndeclaredTargetStaysOnTheJUnitPathTest(_RealRunCase):

    def test_the_undeclared_run_streams_nothing_and_files_its_junit(self):
        run = self.runs["plain"]
        self.assertEqual(run.stream_batches(), [], run.where())
        self.assertEqual([(r["body"] or {}).get("codec") for r in run.ingests()],
                         ["junit"], run.where())
        stored = self.stored(run)
        self.assertNotEqual(stored.get("framework"), FRAMEWORK)
        self.assertEqual(_counts(stored), {"total": 3, "passed": 3, "failed": 0, "pending": 0})


if __name__ == "__main__":
    unittest.main()
