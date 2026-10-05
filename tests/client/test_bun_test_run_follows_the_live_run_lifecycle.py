"""Bun's suite-running verbs on the ONE shared run path (new C1 symbol,
referred to here only by behaviour: a `RunNarrator` instance and an
`open_run` call the CR asks `_crucible_axi.py` to carry, cited by name
rather than by file:line).

Drives the REAL `clients/bun-crucible.py` `test` verb as a genuine OS
subprocess, against a real (but fake) `bun` executable and a stand-in HTTP
board (`_RecordingBoard`, a real `http.server.ThreadingHTTPServer` on
loopback) -- never the live :3849/:3850 Crucible server, per project
convention.

── What is pinned, and why it fails today (read from clients/bun-crucible.py
   and clients/mvn-crucible.py at HEAD of feature/CR-CRU-157-agent-card-truth) ──

AC1 ("`/runs/start` before the suite starts, asserted on request order") --
bun's own `_start_run` ALREADY does this (confirmed by reading `cmd_test`),
so by itself this half would pass today. It is folded into the one
comprehensive test below together with AC4/ingesting, which DO fail today,
so the proof that the test fails for the real defect still holds end to end.

AC3/AC5 ("narration through the ONE shared path -- test behaviour, not
source text") -- F19 state 1 (storyboard, `.lavish/crucible-v2-design.html`)
is the approved visual contract: `running 1843/2936 · roadmap.test.ts` --
a stack that KNOWS its current file/class KEEPS that suffix; only the
FINAL `ran M/M` (F19 state 2) drops it. bun's private `_Narrator.observe`
already posts `f"running {count}/{total} · {current_file}"`
(`_Narrator._completed` in clients/bun-crucible.py) -- the SAME shape, so
this sub-assertion can already hold for bun today (like AC1's half above);
the sibling mvn test pins mvn's actual mismatch (`running class N/M ·
<class>` -- the wrong WORD, "class", not merely a suffix question).
Folded into the one comprehensive test below together with AC4/ingesting,
which DO fail today, so the test fails for the real defect end to end.

AC4 ("a last completion inside the throttle window still ends with `ran
M/M`") -- bun's `_Narrator` class has NO `finish`/final-post method at all
(confirmed: the CR's own G1 census says so, and the class body has no such
method) -- `cmd_test` never posts a final count. This assertion fails today
for the most direct possible reason: the exact string `ran 12/12` is never
on the wire.

The `ingesting…` ordering assertion is new behaviour too -- no client posts
that literal message today (grepped clients/*.py for `ingesting`: no hit).

AC2 ("a line printed before a blocking test is visible on stderr and in
--log before that test ends") -- `_run_logged` in clients/bun-crucible.py
collects every streamed line into a list and writes stderr/`--log` ONLY
after `proc.wait()` returns (one batched `sys.stderr.write(out)` / `f.write(out)`
at the end), even though the SAME loop already feeds the narrator live. So
a line printed before a still-running (blocking) test is invisible on
either channel until the whole runner exits -- this file's second test class
proves that by polling for it WHILE the fake runner is deliberately still
blocked, with a bounded budget before giving up.

Both proofs (RED-for-the-right-reason, and a correct §S0-§S2 implementation
CAN pass): the assertions name the exact defect that fires (no `ran 12/12`
string on the wire; the marker never reaches stderr/log while the fake bun
is parked on its release file), and a client that opens the run first,
streams live, narrates in the one unified shape, posts the final count
unconditionally, then `ingesting…`, then ingests, satisfies every assertion
here with room to spare (the throttle-N assertion is intentionally loose on
the exact intermediate count, since the CR pins the OUTCOME — the final
count landing — not a specific tick).
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
BUN_SCRIPT = REPO_ROOT / "clients" / "bun-crucible.py"
SHIPPED_TOML = REPO_ROOT / "clients" / "crucible.toml"

AGENT = "bun-run-lifecycle-fixture"
PROJECT_KEY = "test-key-bun-run-lifecycle"

ENV_KEYS_TO_SCRUB = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                    "WORKFLOW_CYCLE")

# A fake `bun`: prints bun's real piped completion-line shape
# (`(pass) suite > name [Nms]`, the uncoloured §S1b wire form
# `_COMPLETION_LINE` in clients/bun-crucible.py also accepts), writes a
# JUnit report at `--reporter-outfile=`, and — only when told to — blocks
# after printing a marker line, until a release file appears.
FAKE_BUN_TEMPLATE = """#!{python}
import os
import sys
import time

stamp = os.environ.get("FAKE_BUN_SPAWN_STAMP")
if stamp:
    with open(stamp, "w") as f:
        f.write(repr(time.time()))

outfile = None
for a in sys.argv[1:]:
    if a.startswith("--reporter-outfile="):
        outfile = a.split("=", 1)[1]

# bun's real piped output starts each file's block with a bare
# "<file>:" header line (`_FILE_HEADER_LINE` in clients/bun-crucible.py) --
# printed here too so the old narrator's per-file `current_file` state (and
# therefore its " \u00b7 <file>" suffix) is genuinely exercised, not merely
# absent because this fixture never triggered it.
sys.stdout.write("narration.test.ts:\\n")
sys.stdout.flush()

total = int(os.environ.get("FAKE_BUN_TOTAL", "1"))
block_after = int(os.environ.get("FAKE_BUN_BLOCK_AFTER_INDEX", "0"))
release_file = os.environ.get("FAKE_BUN_RELEASE_FILE")
marker = os.environ.get("FAKE_BUN_MARKER_LINE")

cases = []
for i in range(1, total + 1):
    name = "narration_case_%d" % i
    if i == block_after:
        if marker:
            sys.stdout.write(marker + "\\n")
            sys.stdout.flush()
        deadline = time.time() + 10
        while release_file and not os.path.exists(release_file) and time.time() < deadline:
            time.sleep(0.02)
    sys.stdout.write("(pass) narration.test.ts > %s [0.01ms]\\n" % name)
    sys.stdout.flush()
    cases.append('<testcase name="%s" file="narration.test.ts" time="0.001"></testcase>' % name)

content = (
    '<?xml version="1.0" encoding="UTF-8"?>\\n<testsuites>\\n'
    '<testsuite name="narration.test.ts" tests="%d" failures="0">\\n%s\\n</testsuite>\\n</testsuites>\\n'
    % (total, "\\n".join(cases))
)
if outfile:
    d = os.path.dirname(outfile)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(outfile, "w") as f:
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
                        run_id = f"run-bun-lifecycle-{board._run_seq}"
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


def _write_fake_bun(project_dir):
    path = os.path.join(project_dir, "fake_bun.py")
    with open(path, "w") as f:
        f.write(FAKE_BUN_TEMPLATE.format(python=sys.executable))
    os.chmod(path, 0o700)
    return path


def _write_test_source(project_dir, n):
    """`n` real `test(...)` declarations in a `.test.ts` file under the
    package dir, so bun's own `_prescan_test_total` resolves a KNOWN,
    deterministic M -- the narration's denominator stays `/n` throughout,
    never the "total unknown" bare `running N` form this file does not
    exercise (that is covered at the unit level, against the shared
    narrator directly)."""
    lines = "\n".join(f'test("case{i}", () => {{}});' for i in range(1, n + 1))
    with open(os.path.join(project_dir, "narration.test.ts"), "w") as f:
        f.write(lines + "\n")


def _scrubbed_env():
    env = os.environ.copy()
    for k in ENV_KEYS_TO_SCRUB:
        env.pop(k, None)
    return env


class NarratedBunTestRunFinalizesThroughTheSharedPathTest(unittest.TestCase):
    """AC1 + AC3/AC5 + AC4 + the `ingesting…` ordering, bun's `test` verb."""

    TOTAL = 12

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="bun-run-lifecycle-")
        self.board = _RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        self.fake_bun = _write_fake_bun(self.tmpdir)
        _write_test_source(self.tmpdir, self.TOTAL)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_run_opens_before_the_suite_narrates_and_lands_its_final_count_before_ingesting(self):
        spawn_stamp = os.path.join(self.tmpdir, "spawn-stamp")
        log_path = os.path.join(self.tmpdir, "run.log")
        env = _scrubbed_env()
        env["FAKE_BUN_TOTAL"] = str(self.TOTAL)
        env["FAKE_BUN_SPAWN_STAMP"] = spawn_stamp
        cmd = [sys.executable, str(BUN_SCRIPT), "test",
               "--bun", self.fake_bun,
               "--project-dir", self.tmpdir,
               "--package-dir", self.tmpdir,
               "--reports", "reports",
               "--agent", AGENT,
               "--log", log_path]
        result = subprocess.run(cmd, cwd=self.tmpdir, env=env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(
            result.returncode, 0,
            f"a green wrapped bun run exits 0; "
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
            "bun process (the suite) is even spawned")

        # -- AC3/AC5: narration is the shared wire shape -- F19 state 1 is
        # `running 1843/2936 \u00b7 roadmap.test.ts`: the base `running N/M` is
        # the SAME bare shape every stack posts, but a stack that KNOWS its
        # current file/class (bun does) keeps that " \u00b7 <label>" suffix --
        # it is part of the approved visual contract, not a per-stack
        # decoration to strip. Only the FINAL `ran M/M` (F19 state 2) drops it.
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
                m, rf"^running \d+/{self.TOTAL} \u00b7 narration\.test\.ts$",
                f"AC3/AC5: narration goes through the ONE shared path in "
                f"_crucible_axi.py, so bun's wire message must be the SAME "
                f"shape F19 state 1 draws -- 'running N/{self.TOTAL} \u00b7 "
                f"<current file>' (bun KNOWS its current file, so the "
                f"storyboard keeps the suffix; only the FINAL 'ran M/M' "
                f"drops it); got {m!r}")
            n = int(m.split()[1].split("/")[0])
            self.assertTrue(
                1 <= n <= self.TOTAL,
                f"narrated count must be within the run's real range; got {m!r}")

        # -- AC4 + §S1: the final count lands, whatever the throttle allowed -
        final_message = f"ran {self.TOTAL}/{self.TOTAL}"
        final_idx = _first_matching_index(
            posts, lambda p, b: _is_heartbeat_message(p, b, final_message))
        self.assertIsNotNone(
            final_idx,
            f"AC4/§S1: the run must end with the board holding the FINAL "
            f"count {final_message!r} -- this run's last two completions "
            f"(#11/#12) land inside the >=10-completion throttle window and "
            f"would never trigger a post of their own, so only an "
            f"UNCONDITIONAL final post can land it. bun's _Narrator has no "
            f"finish()/final post at all today. "
            f"posted messages={all_messages!r}")

        # -- §S2: 'ingesting…' follows the final count, precedes the ingest --
        ingesting_idx = _first_matching_index(
            posts, lambda p, b: _is_heartbeat_message(p, b, "ingesting…"))
        parsed_idx = _first_matching_index(posts, lambda p, b: p == "/api/v2/runs/parsed")
        self.assertIsNotNone(
            ingesting_idx,
            f"§S2: the message must follow the run to its end -- "
            f"'ingesting…' must be posted while the result is being "
            f"recorded; posted messages={all_messages!r}")
        assert final_idx is not None and ingesting_idx is not None and parsed_idx is not None
        self.assertLess(
            final_idx, ingesting_idx,
            "the final count must land BEFORE 'ingesting…' replaces it on "
            "the board -- never the reverse")
        self.assertLess(
            ingesting_idx, parsed_idx,
            "'ingesting…' must be posted BEFORE the ingest POST itself "
            "(§S2), not after -- the exact ordering bug the CR names for "
            "mvn's finish(), which this test guards bun against too")


class BunRunnerOutputReachesStderrAndLogWhileTheSuiteIsStillRunningTest(unittest.TestCase):
    """AC2 — bun's `test` verb, with a fake bun that blocks mid-suite."""

    MARKER = "BUN_LIVE_STREAM_MARKER_8821"

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="bun-run-live-stream-")
        self.board = _RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        self.fake_bun = _write_fake_bun(self.tmpdir)
        _write_test_source(self.tmpdir, 2)
        self.release_file = os.path.join(self.tmpdir, "release")
        self.log_path = os.path.join(self.tmpdir, "run.log")
        self.stderr_path = os.path.join(self.tmpdir, "stderr.txt")

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_a_line_printed_before_a_blocking_test_is_visible_before_that_test_ends(self):
        env = _scrubbed_env()
        env.update({
            "FAKE_BUN_TOTAL": "2",
            "FAKE_BUN_BLOCK_AFTER_INDEX": "1",
            "FAKE_BUN_RELEASE_FILE": self.release_file,
            "FAKE_BUN_MARKER_LINE": self.MARKER,
        })
        cmd = [sys.executable, str(BUN_SCRIPT), "test",
               "--bun", self.fake_bun, "--project-dir", self.tmpdir,
               "--package-dir", self.tmpdir, "--reports", "reports",
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
            f"AC2: a line the fake runner printed BEFORE its second "
            f"(blocking) test finished must already be visible on stderr "
            f"AND in --log WHILE that test is still running -- not only "
            f"after the whole run exits. §S0 requires the runner's output "
            f"to stream live; clients/bun-crucible.py's `_run_logged` "
            f"collects every line and writes stderr/--log only once AFTER "
            f"proc.wait() returns. stderr so far={stderr_so_far!r} "
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
