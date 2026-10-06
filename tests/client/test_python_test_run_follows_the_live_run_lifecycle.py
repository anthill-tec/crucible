"""Python's suite-running verb on the ONE shared run path (the narrator and
the run-opening/live-streaming helpers the CR asks `_crucible_axi.py` to
carry — a `RunNarrator` instance and an `open_run`/`run_streamed` call,
referred to here only by symbol, never by file:line).

Drives the REAL `clients/python-crucible.py` `test` verb as a genuine OS
subprocess, against a real (but fake) Python interpreter and the same kind
of stand-in HTTP board (`_RecordingBoard`) as the sibling bun/mvn
run-lifecycle tests -- never the live :3849/:3850 Crucible server.

── What is pinned, and why it fails today (read from clients/python-crucible.py
   at HEAD of this branch) ──

AC1 ("`/runs/start` before the suite starts") -- grepping `_xmlrunner_cmd`
and `cmd_test` for "runs/start" has NO hit: python opens no run, ever (the
CR's own census agrees: python's START column is "no", the measured worst
case -- nothing at all until the run exits). This assertion fails for the
most direct reason possible: the request is simply never made.

AC3/AC5 ("narration through the ONE shared path, total UNKNOWN until the
end") -- `cmd_test` has no `RunNarrator` at all (the CR's census: python's
NARRATE column is "no"), so NO `running N` heartbeat is ever posted. §S0's
own G3 finding is the reason a correct fix reads `running N` with no
denominator: `unittest` (via `xmlrunner`) prints one line per test only in
VERBOSE mode (`-v`), which `_xmlrunner_cmd` does not pass today, and even
with `-v` the total is knowable only once the whole run (and its JUnit XML)
is written -- so this stack's narration never carries a denominator while in
flight, and the final count is `ran N/N` (both sides the same resolved
count), never `ran N/M` with a DIFFERENT M. The per-test line this file's
fake interpreter emits -- "`<name> (<module>.<Class>.<name>) ... ok`" -- is
`unittest.TextTestResult`'s own real verbose-mode line shape (confirmed by
reading the installed interpreter's `unittest` package: `TextTestResult.
startTest`/`addSuccess` write `str(test) + " ... " + "ok"`, and `str(test)`
for a `TestCase` is `"<method> (<module>.<Class>.<method>)"`), printed by the
fixture ONLY when `-v` is in its argv -- exactly like the real tool -- so
this test also proves a correct implementation must add `-v` for its own
recogniser to ever see a line to recognise.

AC2 ("a line printed before a blocking test is visible on stderr and in
--log before that test ends") -- `_run_logged` in clients/python-crucible.py
runs the whole interpreter through `subprocess.run(..., stdout=PIPE,
stderr=STDOUT)`, waits for it to exit, and ONLY THEN writes the captured
`out` to `--log` and echoes it to stderr in one batched write. So a line
printed before a still-running (blocking) test is invisible on either
channel until the whole runner exits -- this file's second test class
proves that by polling for a marker line WHILE the fake interpreter is
deliberately still parked on a release file, with a bounded budget before
giving up.

The `ingesting…` ordering assertion is new behaviour too -- no client posts
that literal message today.

Both proofs (RED-for-the-right-reason, and a correct implementation of the
CR's scope CAN pass): every assertion below names the exact string/ordering
missing today, and a client that opens the run first, streams live, adds
`-v` so its own recogniser has something to read, narrates in the bare
"running N" shape this stack's unknown total requires, posts the final
`ran N/N` unconditionally, then `ingesting…`, then ingests, satisfies every
assertion here with room to spare.
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
PYTHON_SCRIPT = REPO_ROOT / "clients" / "python-crucible.py"
SHIPPED_TOML = REPO_ROOT / "clients" / "crucible.toml"

AGENT = "python-run-lifecycle-fixture"
PROJECT_KEY = "test-key-python-run-lifecycle"

ENV_KEYS_TO_SCRUB = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                     "WORKFLOW_CYCLE", "PY_CRUCIBLE_PYTHON")

# A fake Python interpreter (NOT the real xmlrunner -- this file drives
# `--python <this fixture>` directly): parses the SAME argv shape
# `_xmlrunner_cmd` builds (`-m xmlrunner discover -s ... -p ... -o <dir>
# [-v]`), prints `unittest`'s OWN real verbose-mode per-test line (see the
# module docstring) to stderr ONLY when `-v` is present -- exactly like the
# real tool -- and writes a JUnit report at the `-o` directory. Blocks after
# a named test, when told to, until a release file appears.
FAKE_PYTHON_TEMPLATE = """#!{python}
import os
import sys
import time

argv = sys.argv[1:]
verbose = "-v" in argv
outdir = None
for i, a in enumerate(argv):
    if a == "-o" and i + 1 < len(argv):
        outdir = argv[i + 1]

stamp = os.environ.get("FAKE_PY_SPAWN_STAMP")
if stamp:
    with open(stamp, "w") as f:
        f.write(repr(time.time()))

total = int(os.environ.get("FAKE_PY_TOTAL", "1"))
block_after = int(os.environ.get("FAKE_PY_BLOCK_AFTER_INDEX", "0"))
release_file = os.environ.get("FAKE_PY_RELEASE_FILE")
marker = os.environ.get("FAKE_PY_MARKER_LINE")

cases = []
for i in range(1, total + 1):
    name = "test_case_%d" % i
    if i == block_after:
        if marker:
            sys.stdout.write(marker + "\\n")
            sys.stdout.flush()
        deadline = time.time() + 10
        while release_file and not os.path.exists(release_file) and time.time() < deadline:
            time.sleep(0.02)
    if verbose:
        sys.stderr.write("%s (fake_module.FakeCase.%s) ... ok\\n" % (name, name))
        sys.stderr.flush()
    cases.append(
        '<testcase classname="fake_module.FakeCase" name="%s" time="0.001"></testcase>'
        % name)

if outdir:
    os.makedirs(outdir, exist_ok=True)
    content = (
        '<?xml version="1.0" encoding="UTF-8"?>\\n'
        '<testsuite name="fake_module.FakeCase" tests="%d" errors="0" '
        'failures="0" skipped="0">%s</testsuite>\\n'
        % (total, "".join(cases))
    )
    with open(os.path.join(outdir, "TEST-fake_module.FakeCase.xml"), "w") as f:
        f.write(content)

sys.exit(0)
"""


class _RecordingBoard:
    """A real `http.server.ThreadingHTTPServer` on loopback, port 0 -- a
    genuine stand-in socket, never a mock, since the client runs as a real
    OS subprocess and cannot have its `_post` patched in-process. Answers
    every POST plausibly (a `runId` for `/api/v2/runs/start`, `ok` for
    everything else) and records every request in WIRE order with its
    receipt wall-clock time, so a test can assert both "X happened before Y"
    (index order) and "X happened before this external wall-clock event"
    (the spawn stamp)."""

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
                        run_id = f"run-python-lifecycle-{board._run_seq}"
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
        f.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
    toml_text = SHIPPED_TOML.read_text()
    assert 'url = "http://localhost:3849"' in toml_text, (
        "fixture assumption broken: clients/crucible.toml no longer ships "
        "the default [client] url this fixture patches")
    toml_text = toml_text.replace('url = "http://localhost:3849"',
                                   f'url = "{board_url}"')
    with open(os.path.join(project_dir, "crucible.toml"), "w") as f:
        f.write(toml_text)


def _write_fake_python(project_dir):
    path = os.path.join(project_dir, "fake_python.py")
    with open(path, "w") as f:
        f.write(FAKE_PYTHON_TEMPLATE.format(python=sys.executable))
    os.chmod(path, 0o700)
    return path


def _scrubbed_env():
    env = os.environ.copy()
    for k in ENV_KEYS_TO_SCRUB:
        env.pop(k, None)
    return env


class NarratedPythonTestRunFinalizesThroughTheSharedPathTest(unittest.TestCase):
    """AC1 + AC3/AC5 (unknown total) + the `ingesting…` ordering, python's
    `test` verb."""

    TOTAL = 12

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="python-run-lifecycle-")
        self.board = _RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        self.fake_python = _write_fake_python(self.tmpdir)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_run_opens_before_the_suite_narrates_unknown_total_and_lands_its_final_count_before_ingesting(self):
        spawn_stamp = os.path.join(self.tmpdir, "spawn-stamp")
        log_path = os.path.join(self.tmpdir, "run.log")
        env = _scrubbed_env()
        env["FAKE_PY_TOTAL"] = str(self.TOTAL)
        env["FAKE_PY_SPAWN_STAMP"] = spawn_stamp
        cmd = [sys.executable, str(PYTHON_SCRIPT), "test",
               "--python", self.fake_python,
               "--project-dir", self.tmpdir,
               "--reports", "reports",
               "--agent", AGENT,
               "--log", log_path]
        result = subprocess.run(cmd, cwd=self.tmpdir, env=env,
                                 capture_output=True, text=True, timeout=30)
        self.assertEqual(
            result.returncode, 0,
            f"a green wrapped python run exits 0; "
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
            "interpreter (the suite) is even spawned")

        # -- AC3/AC5: narration is the shared wire shape with an UNKNOWN
        # total -- `unittest` never states its total until the whole run (and
        # its JUnit XML) is written, so the narration carries NO denominator
        # while in flight ("running N", never "running N/M"), and the FINAL
        # count is "ran N/N" (both sides the SAME resolved count).
        running_msgs = []
        for _path, b in posts:
            msg = b.get("message") if isinstance(b, dict) else None
            if isinstance(msg, str) and msg.startswith("running"):
                running_msgs.append(msg)
        self.assertTrue(
            running_msgs,
            f"AC3/AC5: the shared narration path must have posted at least "
            f"one 'running N' heartbeat while the suite was in flight -- "
            f"python's cmd_test has NO RunNarrator at all today; "
            f"posted messages={all_messages!r}")
        for m in running_msgs:
            self.assertRegex(
                m, r"^running \d+$",
                f"AC3/AC5: python's total is UNKNOWN until the run ends "
                f"(unittest states it only in the final JUnit XML), so the "
                f"shared path's narration must read the bare 'running N' "
                f"form with NO denominator; got {m!r}")
            n = int(m.split()[1])
            self.assertTrue(
                1 <= n <= self.TOTAL,
                f"narrated count must be within the run's real range; got {m!r}")

        # -- AC4/§S1 analogue + §S2: the final count lands unconditionally,
        # as 'ran N/N' (the resolved count on both sides, since the total was
        # never known), BEFORE 'ingesting…', which precedes the ingest.
        final_message = f"ran {self.TOTAL}/{self.TOTAL}"
        final_idx = _first_matching_index(
            posts, lambda p, b: _is_heartbeat_message(p, b, final_message))
        self.assertIsNotNone(
            final_idx,
            f"§S1: the run must end with the board holding the FINAL count "
            f"{final_message!r} -- python's cmd_test has no finish()/final "
            f"post at all today. posted messages={all_messages!r}")

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


class PythonTestRunnerOutputReachesStderrAndLogWhileTheSuiteIsStillRunningTest(unittest.TestCase):
    """AC2 — python's `test` verb, with a fake interpreter that blocks
    mid-suite."""

    MARKER = "PYTHON_LIVE_STREAM_MARKER_4471"

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="python-run-live-stream-")
        self.board = _RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        self.fake_python = _write_fake_python(self.tmpdir)
        self.release_file = os.path.join(self.tmpdir, "release")
        self.log_path = os.path.join(self.tmpdir, "run.log")
        self.stderr_path = os.path.join(self.tmpdir, "stderr.txt")

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_a_line_printed_before_a_blocking_test_is_visible_before_that_test_ends(self):
        env = _scrubbed_env()
        env.update({
            "FAKE_PY_TOTAL": "2",
            "FAKE_PY_BLOCK_AFTER_INDEX": "1",
            "FAKE_PY_RELEASE_FILE": self.release_file,
            "FAKE_PY_MARKER_LINE": self.MARKER,
        })
        cmd = [sys.executable, str(PYTHON_SCRIPT), "test",
               "--python", self.fake_python, "--project-dir", self.tmpdir,
               "--reports", "reports",
               "--agent", AGENT, "--log", self.log_path]
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
            f"AC2: a line the fake interpreter printed BEFORE its second "
            f"(blocking) test finished must already be visible on stderr "
            f"AND in --log WHILE that test is still running -- not only "
            f"after the whole run exits. §S0 requires the runner's output "
            f"to stream live; clients/python-crucible.py's `_run_logged` "
            f"runs the WHOLE interpreter via `subprocess.run`, waits for "
            f"exit, and writes stderr/--log in ONE batched write only "
            f"afterwards. stderr so far={stderr_so_far!r} "
            f"log so far={log_so_far!r}")
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
