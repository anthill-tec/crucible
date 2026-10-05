"""Arduino's suite-running verb on the ONE shared run path (the narrator and
the run-opening/live-streaming helpers the CR asks `_crucible_axi.py` to
carry — a `RunNarrator` instance and an `open_run`/`run_streamed` call,
referred to here only by symbol, never by file:line).

Drives the REAL `clients/arduino-crucible.py` `unit` verb (its RED/GREEN
workhorse) as a genuine OS subprocess, against a REAL `make` invoking a tiny
fixture script (mirroring the "native-host `make junit` kept real, only its
own build faked" precedent already used by this stack's existing fixtures),
and the same kind of stand-in HTTP board (`_RecordingBoard`) as the sibling
bun/mvn/python/rust run-lifecycle tests -- never the live :3849/:3850
Crucible server.

── What is pinned, and why it fails today (read from clients/arduino-crucible.py
   at HEAD of this branch) ──

AC1 ("`/runs/start` before the suite starts") -- grepping `_run_native_tests`/
`_run_native_tests_body` for "runs/start" has NO hit: arduino opens no run,
ever (the CR's own census agrees: arduino's START column is "no"). This
assertion fails for the most direct reason possible: the request is simply
never made.

AC3/AC5 ("narration through the ONE shared path, total UNKNOWN until the
end") -- `_run_native_tests_body` has no narrator at all (the CR's census:
arduino's NARRATE column is "no") -- no `running N` heartbeat is ever
posted. Like python, this stack's total is UNKNOWN while in flight: the
Unity test framework's OWN per-test line carries no running/total count at
all, only a PASS/FAIL verdict per test, stated as `"<file>:<line>:<test
name>:<PASS|FAIL|IGNORE>"` (Unity's well-documented default test-runner
output shape), with the aggregate ("N Tests M Failures K Ignored") printed
only in Unity's OWN closing summary line, after every test has already run.
So a correct fix here reads bare `running N` (no denominator) while in
flight and a final `ran N/N` (the resolved count on both sides), exactly
like python.

AC2 ("a line printed before a blocking test is visible on stderr and in
--log before that test ends") -- TWO defects compound here, both read from
`_run_native_tests_body`: (1) it spawns `make <target>` via
`subprocess.run(..., capture_output=True)`, which -- like every sibling
client's pre-shared-path behaviour -- captures the WHOLE run and only prints
it (`sys.stderr.write(run.stdout + run.stderr)`) on the NO-REPORTS failure
path, never while running and never at all on a normal pass; and (2) there
IS NO `--log` flag on this stack's `unit`/`test` verbs at all (confirmed:
neither carries `_add_log_arg`, the helper every other client's test-tier
parser uses) -- §S0 names `--log` as part of what every suite-running verb
must stream to, so this stack is missing the flag the acceptance criterion
needs BEFORE it can even be missing the live-streaming behaviour. This test
drives `--log` as the CR requires devi and shows BOTH gaps in one assertion:
the process cannot even be told where to log, so the marker is invisible on
either channel.

The `ingesting…` ordering assertion is new behaviour too -- no client posts
that literal message today.

Both proofs (RED-for-the-right-reason, and a correct implementation of the
CR's scope CAN pass): every assertion below names the exact string/ordering/
flag missing today, and a client that adds `--log`, opens the run first,
streams live, narrates the bare `running N` shape this stack's unknown
total requires, posts the final `ran N/N` unconditionally, then
`ingesting…`, then ingests, satisfies every assertion here with room to
spare.
"""

import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ARDUINO_SCRIPT = REPO_ROOT / "clients" / "arduino-crucible.py"
SHIPPED_TOML = REPO_ROOT / "clients" / "crucible.toml"

AGENT = "arduino-run-lifecycle-fixture"
PROJECT_KEY = "test-key-arduino-run-lifecycle"
PROJECT_NAME = "arduino-run-lifecycle-fixture-firmware"

ENV_KEYS_TO_SCRUB = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                     "WORKFLOW_CYCLE", "REPORTS_DIR", "COVERAGE_DIR")

# A REAL `make junit` target (no g++/hardware compile) backing a tiny helper
# script, mirroring this stack's own existing native-host fixture precedent:
# the toolchain invocation itself (`make`) is exercised for real, and only
# the build/test work it would normally do is faked. Prints Unity's OWN
# per-test line shape (see the module docstring) and Unity's own closing
# summary, honours `REPORTS_DIR` (the documented `make` contract this
# client's own helpers already set), and -- only when told to -- blocks
# after a named test, until a release file appears.
FAKE_MAKE_RUNNER_TEMPLATE = """import os
import sys
import time

reports_dir = os.environ.get("REPORTS_DIR") or "reports"
os.makedirs(reports_dir, exist_ok=True)

stamp = os.environ.get("FAKE_MAKE_SPAWN_STAMP")
if stamp:
    with open(stamp, "w") as f:
        f.write(repr(time.time()))

total = int(os.environ.get("FAKE_MAKE_TOTAL", "1"))
block_after = int(os.environ.get("FAKE_MAKE_BLOCK_AFTER_INDEX", "0"))
release_file = os.environ.get("FAKE_MAKE_RELEASE_FILE")
marker = os.environ.get("FAKE_MAKE_MARKER_LINE")

cases = []
for i in range(1, total + 1):
    name = "test_native_case_%d" % i
    if i == block_after:
        if marker:
            sys.stdout.write(marker + "\\n")
            sys.stdout.flush()
        deadline = time.time() + 10
        while release_file and not os.path.exists(release_file) and time.time() < deadline:
            time.sleep(0.02)
    sys.stdout.write("test_native.c:%d:%s:PASS\\n" % (10 + i, name))
    sys.stdout.flush()
    cases.append('<testcase classname="native" name="%s" time="0.001"></testcase>' % name)

sys.stdout.write("-----------------------\\n")
sys.stdout.write("%d Tests 0 Failures 0 Ignored\\n" % total)
sys.stdout.write("OK\\n")

content = (
    '<?xml version="1.0"?><testsuite name="native" tests="%d" failures="0">'
    '%s</testsuite>' % (total, "".join(cases))
)
with open(os.path.join(reports_dir, "TEST-native.xml"), "w") as f:
    f.write(content)
"""


class _RecordingBoard:
    """Identical in shape to the sibling run-lifecycle tests' `_RecordingBoard`:
    a real `http.server.ThreadingHTTPServer` on loopback, recording every
    request in wire order with its receipt wall-clock time."""

    def __init__(self):
        self.events = []  # [(wall_clock_received_at, method, path, body)]
        self._lock = threading.Lock()
        self._run_seq = 0
        board = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _body(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    return json.loads(raw.decode() or "null")
                except ValueError:
                    return None

            def _reply(self, payload):
                encoded = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                with board._lock:
                    board.events.append((time.time(), "GET", self.path, None))
                if "/plans" in self.path:
                    self._reply({"ok": True, "plans": []})
                else:
                    self._reply({"ok": True, "agents": []})

            def do_POST(self):
                body = self._body()
                with board._lock:
                    board.events.append((time.time(), "POST", self.path, body))
                if self.path == "/api/v2/runs/start":
                    with board._lock:
                        board._run_seq += 1
                        run_id = f"run-arduino-lifecycle-{board._run_seq}"
                    self._reply({"ok": True, "changed": True, "runId": run_id,
                                 "startedAt": int(time.time() * 1000)})
                else:
                    self._reply({"ok": True, "changed": True})

            def do_PATCH(self):
                self.do_POST()

            def log_message(self, format, *args):
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)

    def posts(self):
        """`[(path, body), ...]` for every POST, in wire order."""
        with self._lock:
            return [(p, b) for _, m, p, b in self.events if m == "POST"]

    def received_at(self, post_index):
        with self._lock:
            post_events = [(t, p, b) for t, m, p, b in self.events if m == "POST"]
        return post_events[post_index][0]


def _first_matching_index(posts, predicate):
    for i, (path, body) in enumerate(posts):
        if predicate(path, body):
            return i
    return None


def _is_heartbeat_message(path, body, message):
    return (path.endswith("/agents/heartbeat")
            and isinstance(body, dict) and body.get("message") == message)


def _install_project(project_dir, board_url):
    with open(os.path.join(project_dir, ".env"), "w") as f:
        f.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n"
                f"CRUCIBLE_PROJECT_NAME={PROJECT_NAME}\n")
    toml_text = SHIPPED_TOML.read_text()
    assert 'url = "http://localhost:3849"' in toml_text, (
        "fixture assumption broken: clients/crucible.toml no longer ships "
        "the default [client] url this fixture patches")
    toml_text = toml_text.replace('url = "http://localhost:3849"',
                                   f'url = "{board_url}"')
    with open(os.path.join(project_dir, "crucible.toml"), "w") as f:
        f.write(toml_text)


def _write_fake_make_junit(project_dir, sub="tests/native"):
    native_dir = os.path.join(project_dir, *sub.split("/"))
    os.makedirs(native_dir, exist_ok=True)
    with open(os.path.join(native_dir, "run_native.py"), "w") as f:
        f.write(FAKE_MAKE_RUNNER_TEMPLATE)
    with open(os.path.join(native_dir, "Makefile"), "w") as f:
        f.write(f"junit:\n\t{sys.executable} run_native.py\n")
    return native_dir


def _scrubbed_env():
    env = os.environ.copy()
    for k in ENV_KEYS_TO_SCRUB:
        env.pop(k, None)
    return env


class NarratedArduinoUnitRunFinalizesThroughTheSharedPathTest(unittest.TestCase):
    """AC1 + AC3/AC5 (unknown total) + the `ingesting…` ordering, arduino's
    `unit` verb."""

    TOTAL = 12

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="arduino-run-lifecycle-")
        self.board = _RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        _write_fake_make_junit(self.tmpdir)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_run_opens_before_the_suite_narrates_unknown_total_and_lands_its_final_count_before_ingesting(self):
        spawn_stamp = os.path.join(self.tmpdir, "spawn-stamp")
        env = _scrubbed_env()
        env["FAKE_MAKE_TOTAL"] = str(self.TOTAL)
        env["FAKE_MAKE_SPAWN_STAMP"] = spawn_stamp
        cmd = [sys.executable, str(ARDUINO_SCRIPT), "unit",
               "--dir", "tests/native",
               "--project-dir", self.tmpdir,
               "--reports", "reports",
               "--agent", AGENT]
        result = subprocess.run(cmd, cwd=self.tmpdir, env=env,
                                 capture_output=True, text=True, timeout=30)
        self.assertEqual(
            result.returncode, 0,
            f"a green wrapped arduino unit run exits 0; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}")

        posts = self.board.posts()
        paths = [p for p, _ in posts]
        all_messages = [b.get("message") for _p, b in posts if isinstance(b, dict)]

        # -- AC1: run opens before the suite, in request order --------------
        start_idx = _first_matching_index(posts, lambda p, b: p == "/api/v2/runs/start")
        ingest_idx = _first_matching_index(posts, lambda p, b: p == "/api/v2/runs/parsed")
        self.assertIsNotNone(
            start_idx, f"AC1: must POST /api/v2/runs/start; got paths={paths!r}")
        self.assertIsNotNone(
            ingest_idx, f"AC1: the run must still ingest; got paths={paths!r}")
        assert start_idx is not None and ingest_idx is not None
        self.assertLess(
            start_idx, ingest_idx,
            f"AC1: the run must be OPENED before it is closed by the ingest; "
            f"paths={paths!r}")
        with open(spawn_stamp) as f:
            spawned_at = float(f.read())
        self.assertLess(
            self.board.received_at(start_idx), spawned_at,
            "AC1: /api/v2/runs/start must reach the board BEFORE the fake "
            "`make junit` process (the suite) is even spawned")

        # -- AC3/AC5: narration is the shared wire shape with an UNKNOWN
        # total -- Unity's own per-test line carries no running count, only a
        # PASS/FAIL verdict, and its aggregate prints only in the closing
        # summary after every test has already run, so narration carries NO
        # denominator while in flight, and the FINAL count is "ran N/N".
        running_msgs = []
        for _path, b in posts:
            msg = b.get("message") if isinstance(b, dict) else None
            if isinstance(msg, str) and msg.startswith("running"):
                running_msgs.append(msg)
        self.assertTrue(
            running_msgs,
            f"AC3/AC5: the shared narration path must have posted at least "
            f"one 'running N' heartbeat while the suite was in flight -- "
            f"arduino's `_run_native_tests_body` has NO narrator at all "
            f"today; posted messages={all_messages!r}")
        for m in running_msgs:
            self.assertRegex(
                m, r"^running \d+$",
                f"AC3/AC5: arduino's total is UNKNOWN until the run ends "
                f"(Unity states its aggregate only in the closing summary "
                f"line), so the shared path's narration must read the bare "
                f"'running N' form with NO denominator; got {m!r}")
            n = int(m.split()[1])
            self.assertTrue(
                1 <= n <= self.TOTAL,
                f"narrated count must be within the run's real range; got {m!r}")

        # -- §S1 + §S2: the final count lands unconditionally, as 'ran N/N',
        # BEFORE 'ingesting…', which precedes the ingest.
        final_message = f"ran {self.TOTAL}/{self.TOTAL}"
        final_idx = _first_matching_index(
            posts, lambda p, b: _is_heartbeat_message(p, b, final_message))
        self.assertIsNotNone(
            final_idx,
            f"§S1: the run must end with the board holding the FINAL count "
            f"{final_message!r} -- arduino's `_run_native_tests_body` has "
            f"no finish()/final post at all today. "
            f"posted messages={all_messages!r}")

        ingesting_idx = _first_matching_index(
            posts, lambda p, b: _is_heartbeat_message(p, b, "ingesting…"))
        self.assertIsNotNone(
            ingesting_idx,
            f"§S2: the message must follow the run to its end -- "
            f"'ingesting…' must be posted while the result is being "
            f"recorded; posted messages={all_messages!r}")
        assert final_idx is not None and ingesting_idx is not None and ingest_idx is not None
        self.assertLess(
            final_idx, ingesting_idx,
            "the final count must land BEFORE 'ingesting…' replaces it on "
            "the board -- never the reverse")
        self.assertLess(
            ingesting_idx, ingest_idx,
            "'ingesting…' must be posted BEFORE the ingest POST itself (§S2)")


class ArduinoUnitRunnerOutputReachesStderrAndLogWhileTheSuiteIsStillRunningTest(unittest.TestCase):
    """AC2 — arduino's `unit` verb, with a fake `make junit` that blocks
    mid-suite. `--log` is passed deliberately: this stack carries NO such
    flag today (no `_add_log_arg` on its test-tier parsers), which is itself
    part of the §S0 gap this test pins -- a correct fix must add the flag
    before it can stream to it."""

    MARKER = "ARDUINO_LIVE_STREAM_MARKER_3360"

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="arduino-run-live-stream-")
        self.board = _RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        _write_fake_make_junit(self.tmpdir)
        self.release_file = os.path.join(self.tmpdir, "release")
        self.log_path = os.path.join(self.tmpdir, "run.log")
        self.stderr_path = os.path.join(self.tmpdir, "stderr.txt")

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_a_line_printed_before_a_blocking_test_is_visible_before_that_test_ends(self):
        env = _scrubbed_env()
        env.update({
            "FAKE_MAKE_TOTAL": "2",
            "FAKE_MAKE_BLOCK_AFTER_INDEX": "1",
            "FAKE_MAKE_RELEASE_FILE": self.release_file,
            "FAKE_MAKE_MARKER_LINE": self.MARKER,
        })
        cmd = [sys.executable, str(ARDUINO_SCRIPT), "unit",
               "--dir", "tests/native",
               "--project-dir", self.tmpdir,
               "--reports", "reports",
               "--agent", AGENT,
               "--log", self.log_path]
        with open(self.stderr_path, "wb") as stderr_file:
            proc = subprocess.Popen(cmd, cwd=self.tmpdir, env=env,
                                     stdout=subprocess.DEVNULL, stderr=stderr_file)
        visible_before_release = False
        try:
            deadline = time.time() + 3.0
            while time.time() < deadline:
                if self._marker_visible():
                    visible_before_release = True
                    break
                time.sleep(0.05)
        finally:
            open(self.release_file, "w").close()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

        stderr_so_far = self._read(self.stderr_path)
        log_so_far = self._read(self.log_path)
        self.assertTrue(
            visible_before_release,
            f"AC2: a line the fake `make junit` printed BEFORE its second "
            f"(blocking) test finished must already be visible on stderr "
            f"AND in --log WHILE that test is still running -- not only "
            f"after the whole run exits. §S0 requires both; today arduino's "
            f"`unit` verb carries NO --log flag at all (no `_add_log_arg` "
            f"on its parser) and `_run_native_tests_body` captures the "
            f"whole run via `subprocess.run(..., capture_output=True)`, so "
            f"neither channel can show a live line. "
            f"stderr so far={stderr_so_far!r} log so far={log_so_far!r}")
        self.assertEqual(
            proc.returncode, 0,
            f"the wrapped run must still finish cleanly once released; "
            f"stderr={self._read(self.stderr_path)!r}")

    def _marker_visible(self):
        return (self.MARKER in self._read(self.stderr_path)
                and self.MARKER in self._read(self.log_path))

    @staticmethod
    def _read(path):
        if not os.path.exists(path):
            return ""
        with open(path, errors="replace") as f:
            return f.read()


if __name__ == "__main__":
    unittest.main()
