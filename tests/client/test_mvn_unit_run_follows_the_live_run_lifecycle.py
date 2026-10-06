"""mvn's suite-running verbs on the ONE shared run path (new C1 symbol,
referred to here only by behaviour: a `RunNarrator` instance and an
`open_run` call the CR asks `_crucible_axi.py` to carry, cited by name
rather than by file:line).

Drives the REAL `clients/mvn-crucible.py` `unit` verb as a genuine OS
subprocess, against a real (but fake) `mvnw` wrapper and the same kind of
stand-in HTTP board (`_RecordingBoard`) as the sibling bun file -- never the
live :3849/:3850 Crucible server.

── What is pinned, and why it fails today (read from clients/mvn-crucible.py
   at HEAD of feature/CR-CRU-157-agent-card-truth) ──

AC1 ("`/runs/start` before the suite starts, asserted on request order") --
grepping clients/mvn-crucible.py for "runs/start" has NO hit at all: mvn
opens no run, ever (the CR's own G1 census agrees: mvn's START column is
"no"). This assertion fails for the most direct reason possible -- the
request is simply never made.

AC3/AC5 ("narration through the ONE shared path -- test behaviour, not
source text") -- mvn's `_Narrator._class_started` posts
`f"running class {count}/{total} · {class_name}"` (`_run_surefire_tier` in
clients/mvn-crucible.py) -- neither the bare `running N/M` shape this file
requires, nor even the same WORD ("class"), nor the same decoration style
("·  <classname>") as bun's. Pinned against the SAME exact-format regex the
sibling bun file uses, so a future implementation is only "the one shared
path" when BOTH clients' wire messages collapse onto the identical shape.

AC4 ("a last completion inside the throttle window still ends with `ran
M/M`") -- mvn's `_Narrator.finish()` exists, unlike bun's, but (a) it posts
`f"finished {count}/{total} test classes — results ingested"`, never the
`ran M/M` string the CR's own prose quotes verbatim, and (b) `finish()` is
only even CALLED AFTER `_emit_tier_run_axi`/`_ingest_junit_dir` --
`_run_surefire_tier`'s own trailing comment says so explicitly: "the final
ingest replaces the narration (strictly after it)". That is the exact bug
the CR names and asks removed: "mvn's current finish() (posted AFTER the
ingest, overwriting the outcome) must go: the final count precedes
`ingesting…`." This test asserts the CORRECT order directly.

The `ingesting…` ordering assertion is new behaviour too -- no client posts
that literal message today.

AC2 ("a line printed before a blocking test is visible on stderr and in
--log before that test ends") -- mvn's `_run_logged` (clients/mvn-crucible.py)
has the SAME batched-write shape as bun's: every streamed line is collected
into a list and stderr/`--log` are written ONLY once `proc.wait()` returns.
Proven the same way as the sibling bun test: a marker line printed before a
class deliberately left blocked on a release file must be invisible on both
channels within a bounded poll, because today nothing is written until the
whole `mvnw` process exits.

Both proofs (RED-for-the-right-reason, and a correct §S0-§S2 implementation
CAN pass): every assertion below names the exact string or ordering that is
missing/wrong on today's code, and a client that opens the run first,
streams live, narrates in the one bare shape, posts `ran M/M`
unconditionally BEFORE `ingesting…`, which precedes the ingest, satisfies
every assertion with room to spare.
"""

import http.server
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MVN_SCRIPT = REPO_ROOT / "clients" / "mvn-crucible.py"
SHIPPED_TOML = REPO_ROOT / "clients" / "crucible.toml"

AGENT = "mvn-run-lifecycle-fixture"
PROJECT_KEY = "test-key-mvn-run-lifecycle"

ENV_KEYS_TO_SCRUB = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                    "WORKFLOW_CYCLE")

# A fake `mvnw`: pre-writes EVERY class's surefire XML up front (a
# deliberate simplification of real Surefire's write-as-it-finishes
# ordering -- the completion SIGNAL narration counts is the "[INFO]
# Running <class>" line on stdout, never the filesystem, so pre-writing
# only changes when the narrator's xml-backed total resolves, giving a
# KNOWN, deterministic M from the very first line instead of one that
# always trails the count by one), then prints "[INFO] Running <class>"
# for each class in order -- blocking after a named class, if asked, until
# a release file appears.
FAKE_MVNW_TEMPLATE = """#!{python}
import json
import os
import sys
import time

args = sys.argv[1:]
reports_dir = next((a.split('=', 1)[1] for a in args
                     if a.startswith('-Dsurefire.reportsDirectory=')),
                    os.path.join('target', 'surefire-reports'))
os.makedirs(reports_dir, exist_ok=True)

classes = json.loads(os.environ['FAKE_MVNW_CLASSES'])
release_file = os.environ.get('FAKE_MVNW_RELEASE_FILE')
block_after = os.environ.get('FAKE_MVNW_BLOCK_AFTER')
marker = os.environ.get('FAKE_MVNW_MARKER', '')

for name in classes:
    xml = ('<?xml version="1.0"?><testsuite name="%s" tests="1" failures="0">'
           '<testcase name="t" time="0.001"/></testsuite>' % name)
    with open(os.path.join(reports_dir, "TEST-%s.xml" % name), "w") as f:
        f.write(xml)

for name in classes:
    sys.stdout.write("[INFO] Running %s\\n" % name)
    sys.stdout.flush()
    if name == block_after:
        if marker:
            sys.stdout.write(marker + "\\n")
            sys.stdout.flush()
        deadline = time.time() + 10
        while release_file and not os.path.exists(release_file) and time.time() < deadline:
            time.sleep(0.02)

sys.stdout.write("[INFO] BUILD SUCCESS\\n")
sys.exit(0)
"""


class _RecordingBoard:
    """Identical in shape to the sibling bun test's `_RecordingBoard`: a
    real `http.server.ThreadingHTTPServer` on loopback, recording every
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
                        run_id = f"run-mvn-lifecycle-{board._run_seq}"
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


def _write_fake_mvnw(maven_dir):
    path = os.path.join(maven_dir, "mvnw")
    with open(path, "w") as f:
        f.write(FAKE_MVNW_TEMPLATE.format(python=sys.executable))
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IEXEC)
    return path


def _scrubbed_env():
    env = os.environ.copy()
    for k in ENV_KEYS_TO_SCRUB:
        env.pop(k, None)
    return env


class NarratedMvnUnitRunFinalizesThroughTheSharedPathTest(unittest.TestCase):
    """AC1 + AC3/AC5 + AC4 + the `ingesting…` ordering, mvn's `unit` verb."""

    CLASSES = [f"com.acme.NarrationCase{i}Test" for i in range(1, 12)]  # 11
    TOTAL = len(CLASSES)

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="mvn-run-lifecycle-")
        self.board = _RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        _write_fake_mvnw(self.tmpdir)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_run_opens_before_the_suite_narrates_and_lands_its_final_count_before_ingesting(self):
        log_path = os.path.join(self.tmpdir, "run.log")
        env = _scrubbed_env()
        env["FAKE_MVNW_CLASSES"] = json.dumps(self.CLASSES)
        cmd = [sys.executable, str(MVN_SCRIPT), "unit",
               "--test", "NarrationCase*",
               "--project-dir", self.tmpdir,
               "--reports", "reports",
               "--agent", AGENT,
               "--log", log_path]
        result = subprocess.run(cmd, cwd=self.tmpdir, env=env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(
            result.returncode, 0,
            f"a green wrapped mvn unit run exits 0; "
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

        # -- AC3/AC5: narration is EXACTLY the shared wire shape -------------
        running_msgs = []
        for _path, b in posts:
            msg = b.get("message") if isinstance(b, dict) else None
            if isinstance(msg, str) and msg.startswith("running"):
                running_msgs.append(msg)
        self.assertTrue(
            running_msgs,
            f"AC3/AC5: the shared narration path must have posted at least "
            f"one 'running N/M' heartbeat while the suite was in flight; "
            f"posted messages={all_messages!r}")
        for m in running_msgs:
            self.assertRegex(
                m, rf"^running \d+/{self.TOTAL} classes$",
                f"AC3/AC5: narration goes through the ONE shared path in "
                f"_crucible_axi.py; mvn counts test CLASSES, so its wire "
                f"message names that unit after the count (user ruling "
                f"2026-10-05) -- 'running N/{self.TOTAL} classes', "
                f"never mvn's own private _Narrator wording ('running "
                f"class N/M · <classname>'); got {m!r}")
            n = int(m.split()[1].split("/")[0])
            self.assertTrue(
                1 <= n <= self.TOTAL,
                f"narrated count must be within the run's real range; got {m!r}")

        # -- AC4 + §S1: the final count lands, whatever the throttle allowed -
        final_message = f"ran {self.TOTAL}/{self.TOTAL} classes"
        final_idx = _first_matching_index(
            posts, lambda p, b: _is_heartbeat_message(p, b, final_message))
        self.assertIsNotNone(
            final_idx,
            f"AC4/§S1: the run must end with the board holding the FINAL "
            f"count {final_message!r} -- this run's last completion (#11) "
            f"lands inside the >=10-completion throttle window and would "
            f"never trigger a post of its own. mvn's _Narrator.finish() "
            f"posts a DIFFERENT string ('finished N/M test classes — "
            f"results ingested') today, never {final_message!r}. "
            f"posted messages={all_messages!r}")

        # -- §S2: 'ingesting…' follows the final count, precedes the ingest,
        #    and BOTH precede the ingest POST -- the exact ordering bug the
        #    CR names for mvn's finish() (posted AFTER the ingest today).
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
            "'ingesting…' must be posted BEFORE the ingest POST itself "
            "(§S2); mvn's finish() today runs the OPPOSITE way -- strictly "
            "AFTER _emit_tier_run_axi's ingest -- which is the exact ordering "
            "bug the CR asks removed")


class MvnUnitRunnerOutputReachesStderrAndLogWhileTheSuiteIsStillRunningTest(unittest.TestCase):
    """AC2 — mvn's `unit` verb, with a fake mvnw that blocks mid-suite."""

    MARKER = "MVN_LIVE_STREAM_MARKER_7733"
    CLASSES = ["com.acme.NarrationLiveCase1Test", "com.acme.NarrationLiveCase2Test"]

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="mvn-run-live-stream-")
        self.board = _RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        _write_fake_mvnw(self.tmpdir)
        self.release_file = os.path.join(self.tmpdir, "release")
        self.log_path = os.path.join(self.tmpdir, "run.log")
        self.stderr_path = os.path.join(self.tmpdir, "stderr.txt")

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_a_line_printed_before_a_blocking_test_is_visible_before_that_test_ends(self):
        env = _scrubbed_env()
        env.update({
            "FAKE_MVNW_CLASSES": json.dumps(self.CLASSES),
            "FAKE_MVNW_BLOCK_AFTER": self.CLASSES[0],
            "FAKE_MVNW_RELEASE_FILE": self.release_file,
            "FAKE_MVNW_MARKER": self.MARKER,
        })
        cmd = [sys.executable, str(MVN_SCRIPT), "unit",
               "--test", "NarrationLiveCase*",
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
            f"AC2: the marker line the fake mvnw printed BEFORE its first "
            f"(blocking) class finished must already be visible on stderr "
            f"AND in --log WHILE that class is still running -- not only "
            f"after the whole run exits. §S0 requires the runner's output "
            f"to stream live; clients/mvn-crucible.py's `_run_logged` "
            f"collects every line and writes stderr/--log only once AFTER "
            f"proc.wait() returns, exactly like bun's. "
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
