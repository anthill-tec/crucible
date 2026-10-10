"""Rust's suite-running verb on the ONE shared run path (the narrator and
the run-opening/live-streaming helpers the CR asks `_crucible_axi.py` to
carry — a `RunNarrator` instance and an `open_run`/`run_streamed` call,
referred to here only by symbol, never by file:line).

Drives the REAL `clients/rust-crucible.py` `test` verb as a genuine OS
subprocess, against a real (but fake) `cargo` executable placed first on
`PATH`, and the same kind of stand-in HTTP board (`_RecordingBoard`) as the
sibling bun/mvn/python run-lifecycle tests -- never the live :3849/:3850
Crucible server, and never a real `cargo`/`nextest` toolchain run.

── What is pinned, and why it fails today (read from clients/rust-crucible.py
   at HEAD of this branch) ──

AC1 ("`/runs/start` before the suite starts") -- grepping `cmd_test` for
"runs/start" has NO hit: rust opens no run, ever (the CR's own census
agrees: rust's START column is "no"). This assertion fails for the most
direct reason possible: the request is simply never made.

AC3/AC5 ("narration through the ONE shared path, total KNOWN from the
runner's own start line") -- `cmd_test` has NO narrator at all (the CR's
census: rust's NARRATE column is "no") -- no `running N/M` heartbeat is ever
posted. §S0's own G3 finding is why this stack is the ONE of the three where
a correct fix narrates a KNOWN denominator from the very first line: unlike
python/arduino, `cargo nextest run`'s own human-reporter STARTS by printing
its total before any test completes. This file's fake `cargo` prints that
same shape -- `"    Starting N tests across 1 binary (run ID: ..., nextest
profile: ...)"` -- followed by nextest's own per-test completion line shape,
`"        PASS [   0.001s] <crate> <test::name>"` (both confirmed against
the public cargo-nextest human-reporter format: a start line stating the
total test count up front, then one PASS/FAIL line per completed test).

AC2 ("a line printed before a blocking test is visible on stderr and in
--log before that test ends") -- rust's `_run_logged` (clients/rust-crucible.py)
has the SAME batched-write shape as bun's and python's: with a `--log` path
it collects the ENTIRE combined output via `subprocess.run(..., stdout=PIPE,
stderr=STDOUT)`, waits for the child to exit, and only THEN writes `--log`
and echoes stderr in one shot (its own doc comment even names
`python-crucible.py`'s `_run_logged` as "the reference" it copies). Proven
the same way as the sibling tests: a marker line printed before a
deliberately-blocked test must be invisible on both channels within a
bounded poll, because nothing is written until the whole `cargo` process
exits.

The `ingesting…` ordering assertion is new behaviour too -- no client posts
that literal message today.

Both proofs (RED-for-the-right-reason, and a correct implementation of the
CR's scope CAN pass): every assertion below names the exact string/ordering
missing today, and a client that opens the run first, streams live, narrates
the KNOWN `running N/M` shape from nextest's own start line, posts the final
`ran M/M` unconditionally, then `ingesting…`, then ingests, satisfies every
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
RUST_SCRIPT = REPO_ROOT / "clients" / "rust-crucible.py"
SHIPPED_TOML = REPO_ROOT / "clients" / "crucible.toml"

AGENT = "rust-run-lifecycle-fixture"
PROJECT_KEY = "test-key-rust-run-lifecycle"

ENV_KEYS_TO_SCRUB = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                     "WORKFLOW_CYCLE")

# A fake `cargo`, resolved via PATH (the client spawns the literal string
# "cargo" -- it takes no `--cargo-bin`/similar override): understands only
# `nextest run [--workspace|-p <crate>] [...] -P <profile>`, prints
# cargo-nextest's OWN real human-reporter shape (see the module docstring --
# the start line stating N up front, then one PASS line per completed test),
# writes the client's expected junit.xml under `target/nextest/<profile>/`,
# and -- only when told to -- blocks after a named test, until a release
# file appears.
FAKE_CARGO_TEMPLATE = """#!{python}
import os
import sys
import time

args = sys.argv[1:]  # ["nextest", "run", "--workspace"/"-p", ..., "-P", profile, ...]
profile = "ci"
for i, a in enumerate(args):
    if a == "-P" and i + 1 < len(args):
        profile = args[i + 1]

stamp = os.environ.get("FAKE_CARGO_SPAWN_STAMP")
if stamp:
    with open(stamp, "w") as f:
        f.write(repr(time.time()))

total = int(os.environ.get("FAKE_CARGO_TOTAL", "1"))
block_after = int(os.environ.get("FAKE_CARGO_BLOCK_AFTER_INDEX", "0"))
release_file = os.environ.get("FAKE_CARGO_RELEASE_FILE")
marker = os.environ.get("FAKE_CARGO_MARKER_LINE")

sys.stdout.write(
    "    Starting %d tests across 1 binary (run ID: deadbeef, nextest profile: %s)\\n"
    % (total, profile))
sys.stdout.flush()

cases = []
for i in range(1, total + 1):
    name = "tests::narration_case_%d" % i
    if i == block_after:
        if marker:
            sys.stdout.write(marker + "\\n")
            sys.stdout.flush()
        deadline = time.time() + 10
        while release_file and not os.path.exists(release_file) and time.time() < deadline:
            time.sleep(0.02)
    sys.stdout.write("        PASS [   0.001s] fake-crate %s\\n" % name)
    sys.stdout.flush()
    cases.append('<testcase name="%s" classname="fake-crate" time="0.001"></testcase>' % name)

sys.stdout.write("------------\\n")
sys.stdout.write("     Summary [   0.010s] %d tests run: %d passed, 0 skipped\\n" % (total, total))
sys.stdout.flush()

junit_dir = os.path.join(os.getcwd(), "target", "nextest", profile)
os.makedirs(junit_dir, exist_ok=True)
content = (
    '<?xml version="1.0"?><testsuites><testsuite name="fake-crate" tests="%d" '
    'failures="0">%s</testsuite></testsuites>' % (total, "".join(cases))
)
with open(os.path.join(junit_dir, "junit.xml"), "w") as f:
    f.write(content)

sys.exit(0)
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
                        run_id = f"run-rust-lifecycle-{board._run_seq}"
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


def _write_fake_cargo(bin_dir):
    path = os.path.join(bin_dir, "cargo")
    with open(path, "w") as f:
        f.write(FAKE_CARGO_TEMPLATE.format(python=sys.executable))
    os.chmod(path, 0o700)
    return path


def _scrubbed_env(fake_bin_dir):
    env = os.environ.copy()
    for k in ENV_KEYS_TO_SCRUB:
        env.pop(k, None)
    env["PATH"] = fake_bin_dir + os.pathsep + env.get("PATH", "")
    return env


class NarratedRustTestRunFinalizesThroughTheSharedPathTest(unittest.TestCase):
    """AC1 + AC3/AC5 (known total) + the `ingesting…` ordering, rust's `test`
    verb."""

    TOTAL = 12

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="rust-run-lifecycle-")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="rust-run-lifecycle-bin-")
        self.board = _RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        _write_fake_cargo(self.fake_bin_dir)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)

    def test_run_opens_before_the_suite_narrates_known_total_and_lands_its_final_count_before_ingesting(self):
        spawn_stamp = os.path.join(self.tmpdir, "spawn-stamp")
        log_path = os.path.join(self.tmpdir, "run.log")
        env = _scrubbed_env(self.fake_bin_dir)
        env["FAKE_CARGO_TOTAL"] = str(self.TOTAL)
        env["FAKE_CARGO_SPAWN_STAMP"] = spawn_stamp
        cmd = [sys.executable, str(RUST_SCRIPT), "test",
               "--crate", "fake-crate",
               "--project-dir", self.tmpdir,
               "--reports", "reports",
               "--agent", AGENT,
               "--log", log_path]
        result = subprocess.run(cmd, cwd=self.tmpdir, env=env,
                                 capture_output=True, text=True, timeout=30)
        self.assertEqual(
            result.returncode, 0,
            f"a green wrapped rust test run exits 0; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}")

        posts = self.board.posts()
        paths = [p for p, _ in posts]
        all_messages = [b.get("message") for _p, b in posts if isinstance(b, dict)]

        # -- AC1: run opens before the suite, in request order --------------
        start_idx = _first_matching_index(posts, lambda p, b: p == "/api/v2/runs/start")
        ingest_idx = _first_matching_index(posts, lambda p, b: p == "/api/v2/runs")
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
            "cargo process (the suite) is even spawned")

        # -- AC3/AC5: narration is the shared wire shape with a KNOWN total --
        # unlike python/arduino, nextest states its total on its OWN start
        # line before any test completes, so this stack's narration carries
        # a denominator from the very first heartbeat.
        running_msgs = []
        for _path, b in posts:
            msg = b.get("message") if isinstance(b, dict) else None
            if isinstance(msg, str) and msg.startswith("running"):
                running_msgs.append(msg)
        self.assertTrue(
            running_msgs,
            f"AC3/AC5: the shared narration path must have posted at least "
            f"one 'running N/M' heartbeat while the suite was in flight -- "
            f"rust's cmd_test has NO narrator at all today; "
            f"posted messages={all_messages!r}")
        for m in running_msgs:
            self.assertRegex(
                m, rf"^running \d+/{self.TOTAL}$",
                f"AC3/AC5: rust's total is KNOWN from nextest's own start "
                f"line, so the shared path's narration must read "
                f"'running N/{self.TOTAL}' -- never the bare 'running N' "
                f"form python/arduino use for an unknown total; got {m!r}")
            n = int(m.split()[1].split("/")[0])
            self.assertTrue(
                1 <= n <= self.TOTAL,
                f"narrated count must be within the run's real range; got {m!r}")

        # -- §S1 + §S2: the final count lands unconditionally, BEFORE
        # 'ingesting…', which precedes the ingest.
        final_message = f"ran {self.TOTAL}/{self.TOTAL}"
        final_idx = _first_matching_index(
            posts, lambda p, b: _is_heartbeat_message(p, b, final_message))
        self.assertIsNotNone(
            final_idx,
            f"§S1: the run must end with the board holding the FINAL count "
            f"{final_message!r} -- rust's cmd_test has no finish()/final "
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


class RustTestRunnerOutputReachesStderrAndLogWhileTheSuiteIsStillRunningTest(unittest.TestCase):
    """AC2 — rust's `test` verb, with a fake `cargo` that blocks mid-suite."""

    MARKER = "RUST_LIVE_STREAM_MARKER_9142"

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="rust-run-live-stream-")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="rust-run-live-stream-bin-")
        self.board = _RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        _write_fake_cargo(self.fake_bin_dir)
        self.release_file = os.path.join(self.tmpdir, "release")
        self.log_path = os.path.join(self.tmpdir, "run.log")
        self.stderr_path = os.path.join(self.tmpdir, "stderr.txt")

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)

    def test_a_line_printed_before_a_blocking_test_is_visible_before_that_test_ends(self):
        env = _scrubbed_env(self.fake_bin_dir)
        env.update({
            "FAKE_CARGO_TOTAL": "2",
            "FAKE_CARGO_BLOCK_AFTER_INDEX": "1",
            "FAKE_CARGO_RELEASE_FILE": self.release_file,
            "FAKE_CARGO_MARKER_LINE": self.MARKER,
        })
        cmd = [sys.executable, str(RUST_SCRIPT), "test",
               "--crate", "fake-crate",
               "--project-dir", self.tmpdir,
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
            f"AC2: a line the fake cargo printed BEFORE its second "
            f"(blocking) test finished must already be visible on stderr "
            f"AND in --log WHILE that test is still running -- not only "
            f"after the whole run exits. §S0 requires the runner's output "
            f"to stream live; clients/rust-crucible.py's `_run_logged` "
            f"collects every line and writes stderr/--log only once AFTER "
            f"the child exits, exactly like python's and bun's. "
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
