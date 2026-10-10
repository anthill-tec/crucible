"""Shared fixtures for the real-subprocess live-run tests: a stand-in HTTP
board that records every request in wire order, a project installer that
points a client at it, fake runners for each stack, and two drivers — one
that proves the runner's output streams live (a marker printed before a
blocked test must reach stderr while the test is still blocked), one that
interrupts a run mid-suite with a signal.

Never the live :3849/:3850 Crucible server and never a real toolchain: every
runner here is a small python program speaking the real tool's output shape.
"""

import http.server
import importlib.util
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS = REPO_ROOT / "clients"
SHIPPED_TOML = CLIENTS / "crucible.toml"

ENV_KEYS_TO_SCRUB = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                     "WORKFLOW_CYCLE", "PY_CRUCIBLE_PYTHON", "REPORTS_DIR",
                     "COVERAGE_DIR", "CLAUDECODE", "AGENT", "REPL_ID", "AI_AGENT")

START = "/api/v2/runs/start"
INGEST_PATHS = ("/api/v2/runs", "/api/v2/runs/parsed", "/api/v2/runs/compile")


def load_toon():
    spec = importlib.util.spec_from_file_location("toon_for_live_run_tests",
                                                  CLIENTS / "toon.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_client(name):
    """Import one `clients/<name>-crucible.py` (or `_crucible_axi.py`) by path."""
    path = CLIENTS / name
    spec = importlib.util.spec_from_file_location(
        "live_run_" + name.replace("-", "_").replace(".", "_"), path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecordingBoard:
    """A real `ThreadingHTTPServer` on loopback that records every request in
    wire order with its receipt time, opens a run on `/api/v2/runs/start` and
    answers everything else `ok`."""

    def __init__(self):
        self.events = []  # [(received_at, method, path, body)]
        self._lock = threading.Lock()
        self._run_seq = 0
        # CR-CRU-170 \u00a7S2 \u2014 scripted refusals, so a RED test can drive the real
        # abort-posting path both ways: the board answering the client's own
        # `POST .../abort` non-ok (board refuses the close), and the board
        # answering a runId-carrying ingest non-ok (the exit \u00a7S2's table calls
        # "the board refused the ingest that carried the runId"). Both default
        # to off \u2014 every pre-existing drive that never calls `refuse_next_abort`/
        # `refuse_ingest_for` sees the unchanged all-`ok` board.
        self._refuse_abort_remaining = 0
        self._refuse_abort_status = 409
        self._refuse_ingest_run_id = None
        self._refuse_ingest_remaining = 0
        self._refuse_ingest_status = 409
        # CR-CRU-171 \u00a7S2 \u2014 a scripted refusal of `/api/v2/runs/start` itself,
        # so a RED test can drive the client's existing `ReleaseRunRefused`
        # hard-stop (a release run that the board declines to open \u2014 an
        # undeclared release, or a release beside a cycle) against ANY
        # client/verb via a real subprocess, without needing a bespoke
        # in-process fake per stack. Default off, like the two above: every
        # pre-existing drive that never calls `refuse_next_start` sees the
        # unchanged always-opens board.
        self._refuse_start_remaining = 0
        self._refuse_start_error = "run refused"
        # CR-CRU-180 \u00a7S1 \u2014 a scripted HELD answer, so a RED test can land a
        # signal while the client is still waiting on one POST's answer (the
        # window a slow runner widens: the board has RECORDED the call, the
        # client has not yet READ its reply). Default off, like the scripted
        # refusals above.
        self._hold_path = None
        self._hold_released = threading.Event()
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

            def _reply_status(self, status, payload):
                """A non-200 JSON reply \u2014 `urllib`'s client side raises `HTTPError`
                for it, which `_crucible_axi.http_request` turns into the real
                `{ok: False, error}` shape a genuine refusal (400/409) produces.
                Used only by the scripted-refusal branches below."""
                encoded = json.dumps(payload).encode()
                self.send_response(status)
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
                    held = board._hold_path == self.path
                    if held:
                        board._hold_path = None
                if held:
                    board._hold_released.wait(timeout=30)
                if self.path == START:
                    refuse, error = False, None
                    with board._lock:
                        if board._refuse_start_remaining > 0:
                            board._refuse_start_remaining -= 1
                            refuse, error = True, board._refuse_start_error
                    if refuse:
                        self._reply({"ok": False, "error": error})
                        return
                    with board._lock:
                        board._run_seq += 1
                        run_id = f"run-live-{board._run_seq}"
                    self._reply({"ok": True, "changed": True, "runId": run_id,
                                 "startedAt": int(time.time() * 1000)})
                elif self.path.startswith("/api/v2/runs/") and self.path.endswith("/abort"):
                    refuse, status = False, 409
                    with board._lock:
                        if board._refuse_abort_remaining > 0:
                            board._refuse_abort_remaining -= 1
                            refuse, status = True, board._refuse_abort_status
                    if refuse:
                        self._reply_status(status, {"ok": False, "error": "abort refused"})
                    else:
                        run_id = (body or {}).get("runId") if isinstance(body, dict) else None
                        reason = (body or {}).get("reason") if isinstance(body, dict) else None
                        self._reply({"ok": True, "changed": True, "runId": run_id,
                                     "status": "aborted", "reason": reason})
                elif self.path in INGEST_PATHS:
                    run_id = (body or {}).get("runId") if isinstance(body, dict) else None
                    refuse, status = False, 409
                    with board._lock:
                        if (board._refuse_ingest_run_id is not None
                                and run_id == board._refuse_ingest_run_id
                                and board._refuse_ingest_remaining > 0):
                            board._refuse_ingest_remaining -= 1
                            refuse, status = True, board._refuse_ingest_status
                    if refuse:
                        self._reply_status(status, {"ok": False, "error": "ingest refused"})
                    elif self.path == "/api/v2/runs":
                        self._reply({"ok": True, "changed": True,
                                 "run": {"total": 0, "passed": 0, "failed": 0}})
                    else:
                        self._reply({"ok": True, "changed": True})
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
        self._hold_released.set()
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)

    def posts(self):
        """`[(path, body), ...]` for every POST, in wire order."""
        with self._lock:
            return [(p, b) for _, m, p, b in self.events if m == "POST"]

    def aborts(self):
        """CR-CRU-170 \u00a7S2 \u2014 `[(path, body), ...]` for every `POST
        /api/v2/runs/<runId>/abort`, in wire order (a strict subset of
        `posts()`, filtered the same way the live-run tests already filter
        `paths` for `"abort" in p`)."""
        with self._lock:
            return [(p, b) for _, m, p, b in self.events
                   if m == "POST" and p.startswith("/api/v2/runs/") and p.endswith("/abort")]

    def refuse_next_abort(self, times=1, status=409):
        """CR-CRU-170 \u00a7S2 \u2014 script the next `times` `POST .../abort` calls to
        answer non-ok (`{ok: False}`, HTTP `status`) instead of settling the
        run \u2014 the board REFUSING the client's own close, so a RED test can
        drive the `run-left-open` fallback the spec requires when the abort
        itself fails. The call is still recorded in `posts()`/`aborts()`
        exactly as a successful one would be."""
        with self._lock:
            self._refuse_abort_remaining = times
            self._refuse_abort_status = status

    def refuse_next_start(self, times=1, error="run refused"):
        """CR-CRU-171 \u00a7S2 \u2014 script the next `times` `POST /api/v2/runs/start`
        calls to answer `{ok: False, error}` (HTTP 200, the same shape the
        real server's `resolveReleaseAttach` 400 produces once `_post` decodes
        it) instead of opening a run \u2014 the board REFUSING to open the run at
        all, so a RED test can drive the client's existing `ReleaseRunRefused`
        hard-stop (CR-CRU-164 \u00a7S1: an undeclared release, or a release beside
        a cycle) for ANY client/verb via a real subprocess. The call is still
        recorded in `posts()` exactly as a successful one would be, and no
        `runId` is ever handed out for a refused call."""
        with self._lock:
            self._refuse_start_remaining = times
            self._refuse_start_error = error

    def refuse_ingest_for(self, run_id, times=1, status=409):
        """CR-CRU-170 \u00a7S2 \u2014 script the next `times` ingest POSTs (any of
        `INGEST_PATHS`) that carry `runId == run_id` to answer non-ok \u2014 "the
        board refused the ingest that carried the runId", the third exit in
        \u00a7S2's table. An ingest for a DIFFERENT runId, or one carrying none, is
        answered exactly as the unscripted board answers it."""
        with self._lock:
            self._refuse_ingest_run_id = run_id
            self._refuse_ingest_remaining = times
            self._refuse_ingest_status = status

    def hold_next_reply(self, path):
        """CR-CRU-180 \u00a7S1 \u2014 record the next `POST path` as usual but withhold
        its answer until `release_held()` (or `close()`), so the client stays
        blocked on that call for exactly as long as the test needs. Only the
        NEXT such call is held; every other request is answered at once."""
        with self._lock:
            self._hold_released.clear()
            self._hold_path = path

    def release_held(self):
        """CR-CRU-180 \u00a7S1 \u2014 answer the call `hold_next_reply` withheld."""
        self._hold_released.set()

    def received_at(self, post_index):
        with self._lock:
            return [t for t, m, _p, _b in self.events if m == "POST"][post_index]

    def messages(self):
        """Every heartbeat message, in wire order."""
        return [b.get("message") for p, b in self.posts()
                if p.endswith("/agents/heartbeat") and isinstance(b, dict)
                and isinstance(b.get("message"), str)]

    def run_ids_opened(self):
        return [f"run-live-{i}" for i in range(1, self._run_seq + 1)]


def first_index(posts, predicate):
    for i, (path, body) in enumerate(posts):
        if predicate(path, body):
            return i
    return None


def heartbeat_index(posts, message):
    return first_index(posts, lambda p, b: p.endswith("/agents/heartbeat")
                       and isinstance(b, dict) and b.get("message") == message)


def install_project(project_dir, board_url, project_key, project_name=None):
    with open(os.path.join(project_dir, ".env"), "w") as f:
        f.write(f"CRUCIBLE_PROJECT_KEY={project_key}\n")
        if project_name:
            f.write(f"CRUCIBLE_PROJECT_NAME={project_name}\n")
    toml_text = SHIPPED_TOML.read_text()
    assert 'url = "http://localhost:3849"' in toml_text, (
        "fixture assumption broken: clients/crucible.toml no longer ships "
        "the default [client] url this fixture patches")
    with open(os.path.join(project_dir, "crucible.toml"), "w") as f:
        f.write(toml_text.replace('url = "http://localhost:3849"',
                                  f'url = "{board_url}"'))


def scrubbed_env(path_prefix=None, **extra):
    env = os.environ.copy()
    for k in ENV_KEYS_TO_SCRUB:
        env.pop(k, None)
    if path_prefix:
        env["PATH"] = path_prefix + os.pathsep + env.get("PATH", "")
    env.update({k: str(v) for k, v in extra.items()})
    return env


def _write_executable(path, text):
    with open(path, "w") as f:
        f.write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IRUSR)
    return path


# ── the shared fake-runner prologue: stamp, total, block-after, marker ──────

_PROLOGUE = """import os
import sys
import time

def _env_int(name, default):
    return int(os.environ.get(name, default))

stamp = os.environ.get("FAKE_SPAWN_STAMP")
if stamp:
    with open(stamp, "w") as f:
        f.write(repr(time.time()))
total = _env_int("FAKE_TOTAL", "1")
block_after = _env_int("FAKE_BLOCK_AFTER_INDEX", "0")
release_file = os.environ.get("FAKE_RELEASE_FILE")
marker = os.environ.get("FAKE_MARKER_LINE")
no_report = os.environ.get("FAKE_NO_REPORT") == "1"

def maybe_block(i, stream=sys.stdout):
    if i != block_after:
        return
    if marker:
        stream.write(marker + "\\n")
        stream.flush()
    deadline = time.time() + 15
    while release_file and not os.path.exists(release_file) and time.time() < deadline:
        time.sleep(0.02)
"""

FAKE_BUN = "#!{python}\n" + _PROLOGUE + """
outfile = None
for a in sys.argv[1:]:
    if a.startswith("--reporter-outfile="):
        outfile = a.split("=", 1)[1]
sys.stdout.write("narration.test.ts:\\n")
sys.stdout.flush()
cases = []
for i in range(1, total + 1):
    maybe_block(i)
    sys.stdout.write("(pass) narration.test.ts > case_%d [0.01ms]\\n" % i)
    sys.stdout.flush()
    cases.append('<testcase name="case_%d" file="narration.test.ts" time="0.001"></testcase>' % i)
if outfile and not no_report:
    d = os.path.dirname(outfile)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(outfile, "w") as f:
        f.write('<?xml version="1.0"?><testsuites><testsuite name="narration.test.ts" '
                'tests="%d" failures="0">%s</testsuite></testsuites>' % (total, "".join(cases)))
sys.exit(0)
"""

FAKE_MVNW = "#!{python}\n" + _PROLOGUE + """
args = sys.argv[1:]
if "test-compile" in args:
    sys.stdout.write("[ERROR] Foo.java:[1,1] cannot find symbol\\n")
    sys.exit(1)
dirs = [a.split("=", 1)[1] for a in args
        if a.startswith("-Dsurefire.reportsDirectory=")]
dirs = dirs or [os.path.join("target", "surefire-reports")]
classes = ["com.acme.LiveCase%dTest" % i for i in range(1, total + 1)]
if not no_report:
    for d in dirs:
        os.makedirs(d, exist_ok=True)
        for name in classes:
            with open(os.path.join(d, "TEST-%s.xml" % name), "w") as f:
                f.write('<?xml version="1.0"?><testsuite name="%s" tests="1" '
                        'failures="0"><testcase name="t" classname="%s" '
                        'time="0.001"/></testsuite>' % (name, name))
for i, name in enumerate(classes, 1):
    maybe_block(i)
    sys.stdout.write("[INFO] Running %s\\n" % name)
    sys.stdout.flush()
sys.stdout.write("[INFO] BUILD SUCCESS\\n")
sys.exit(0)
"""

FAKE_PYTHON = "#!{python}\n" + _PROLOGUE + """
argv = sys.argv[1:]
verbose = "-v" in argv
outdir = None
for i, a in enumerate(argv):
    if a == "-o" and i + 1 < len(argv):
        outdir = argv[i + 1]
if os.environ.get("FAKE_ZERO_DISCOVERY") == "1":
    sys.stderr.write("\\n----------------------------------------------------------------------\\n"
                     "Ran 0 tests in 0.000s\\n\\nNO TESTS RAN\\n")
    sys.exit(5)
cases = []
for i in range(1, total + 1):
    maybe_block(i)
    if verbose:
        sys.stderr.write("test_case_%d (fake_module.FakeCase.test_case_%d) ... ok\\n" % (i, i))
        sys.stderr.flush()
    cases.append('<testcase classname="fake_module.FakeCase" name="test_case_%d" '
                 'time="0.001"></testcase>' % i)
if outdir and not no_report:
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "TEST-fake_module.FakeCase.xml"), "w") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\\n<testsuite '
                'name="fake_module.FakeCase" tests="%d" errors="0" failures="0" '
                'skipped="0">%s</testsuite>\\n' % (total, "".join(cases)))
sys.exit(0)
"""

FAKE_CARGO = "#!{python}\n" + _PROLOGUE + """
args = sys.argv[1:]
if not args or args[0] in ("clean", "check", "cache"):
    sys.exit(0)
profile = "ci"
lcov = None
for i, a in enumerate(args):
    if a == "-P" and i + 1 < len(args):
        profile = args[i + 1]
    if a == "--output-path" and i + 1 < len(args):
        lcov = args[i + 1]
verdict = os.environ.get("FAKE_CARGO_VERDICT", "PASS")
sys.stdout.write("    Starting %d tests across 1 binary (run ID: deadbeef, nextest "
                 "profile: %s)\\n" % (total, profile))
sys.stdout.flush()
cases = []
for i in range(1, total + 1):
    maybe_block(i)
    sys.stdout.write("        %s [   0.001s] fake-crate tests::case_%d\\n" % (verdict, i))
    sys.stdout.flush()
    cases.append('<testcase name="tests::case_%d" classname="fake-crate" '
                 'time="0.001"></testcase>' % i)
sys.stdout.write("------------\\n     Summary [   0.010s] %d tests run: %d passed, "
                 "0 skipped\\n" % (total, total))
sys.stdout.flush()
if not no_report:
    junit_dir = os.path.join(os.getcwd(), "target", "nextest", profile)
    os.makedirs(junit_dir, exist_ok=True)
    with open(os.path.join(junit_dir, "junit.xml"), "w") as f:
        f.write('<?xml version="1.0"?><testsuites><testsuite name="fake-crate" '
                'tests="%d" failures="0">%s</testsuite></testsuites>' % (total, "".join(cases)))
    if lcov:
        os.makedirs(os.path.dirname(os.path.join(os.getcwd(), lcov)) or ".", exist_ok=True)
        with open(os.path.join(os.getcwd(), lcov), "w") as f:
            f.write("SF:src/lib.rs\\nLF:1\\nLH:1\\nend_of_record\\n")
sys.exit(0)
"""

FAKE_NATIVE_RUNNER = _PROLOGUE + """
reports_dir = os.environ.get("REPORTS_DIR") or "reports"
cases = []
for i in range(1, total + 1):
    maybe_block(i)
    sys.stdout.write("test/test_main.c:%d:test_case_%d:PASS\\n" % (10 + i, i))
    sys.stdout.flush()
    cases.append('<testcase name="test_case_%d" classname="native" time="0.001"/>' % i)
sys.stdout.write("-----------------------\\n%d Tests 0 Failures 0 Ignored\\nOK\\n" % total)
sys.stdout.flush()
if not no_report:
    os.makedirs(reports_dir, exist_ok=True)
    with open(os.path.join(reports_dir, "TEST-native.xml"), "w") as f:
        f.write('<?xml version="1.0"?><testsuite name="native" tests="%d" failures="0">'
                '%s</testsuite>' % (total, "".join(cases)))
sys.exit(0)
"""


def write_fake_bun(project_dir, n_declared):
    """The fake `bun`, plus `n_declared` real `test(...)` declarations so bun's
    prescan resolves a known total."""
    lines = "\n".join(f'test("case{i}", () => {{}});' for i in range(1, n_declared + 1))
    with open(os.path.join(project_dir, "narration.test.ts"), "w") as f:
        f.write(lines + "\n")
    return _write_executable(os.path.join(project_dir, "fake_bun.py"),
                             FAKE_BUN.format(python=sys.executable))


def write_fake_mvnw(maven_dir):
    return _write_executable(os.path.join(maven_dir, "mvnw"),
                             FAKE_MVNW.format(python=sys.executable))


def write_fake_python(project_dir):
    return _write_executable(os.path.join(project_dir, "fake_python.py"),
                             FAKE_PYTHON.format(python=sys.executable))


def write_fake_cargo(bin_dir):
    return _write_executable(os.path.join(bin_dir, "cargo"),
                             FAKE_CARGO.format(python=sys.executable))


def write_fake_native(project_dir, sub="tests/native"):
    native_dir = os.path.join(project_dir, *sub.split("/"))
    os.makedirs(native_dir, exist_ok=True)
    with open(os.path.join(native_dir, "run_native.py"), "w") as f:
        f.write(FAKE_NATIVE_RUNNER)
    with open(os.path.join(native_dir, "Makefile"), "w") as f:
        f.write(f"junit:\n\t{sys.executable} run_native.py\n")
    return native_dir


# ── drivers ─────────────────────────────────────────────────────────────────

def _read(path):
    try:
        with open(path, errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def _wait_for(path, needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in _read(path):
            return True
        time.sleep(0.02)
    return False


_RELEASE_SEQ = [0]


def _fresh_release_path(scratch):
    """A release-file path no earlier drive in this process has used (the
    file is created only to release the runner, never ahead of time)."""
    _RELEASE_SEQ[0] += 1
    return os.path.join(scratch, f"release-{os.getpid()}-{_RELEASE_SEQ[0]}")


class Drive:
    """The outcome of one client invocation."""

    def __init__(self, returncode, stdout, stderr, live_on_stderr, live_in_log):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.live_on_stderr = live_on_stderr
        self.live_in_log = live_in_log


def drive_live(cmd, cwd, env, scratch, marker, log_path=None, timeout=60):
    """Run `cmd` with its fake runner told to print `marker` and then block
    until released. While the runner is blocked, look for the marker on the
    client's stderr (and in `log_path`); then release it and wait."""
    release = _fresh_release_path(scratch)
    env = dict(env, FAKE_RELEASE_FILE=release, FAKE_MARKER_LINE=marker)
    env.setdefault("FAKE_BLOCK_AFTER_INDEX", "1")
    stderr_path = os.path.join(scratch, "client-stderr.txt")
    with open(stderr_path, "w") as err:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                stderr=err, text=True)
        try:
            live_on_stderr = _wait_for(stderr_path, marker, 10)
            live_in_log = (_wait_for(log_path, marker, 2)
                           if log_path and live_on_stderr else None)
            released_early = os.path.exists(release)
        finally:
            with open(release, "w") as f:
                f.write("go")
        stdout, _ = proc.communicate(timeout=timeout)
    return Drive(proc.returncode, stdout, _read(stderr_path),
                 live_on_stderr and not released_early,
                 live_in_log)


def drive_and_signal(cmd, cwd, env, scratch, signum, timeout=30):
    """Run `cmd`, wait until its blocked runner's marker has reached the
    client's stderr (the client is reading the run, its run already open),
    then deliver `signum` to the CLIENT process."""
    marker = "LIVE_RUN_SIGNAL_MARKER"
    # A fresh release file per drive: an earlier drive's release must never
    # unblock this one's runner before the signal lands.
    release = _fresh_release_path(scratch)
    env = dict(env, FAKE_RELEASE_FILE=release, FAKE_MARKER_LINE=marker,
               FAKE_BLOCK_AFTER_INDEX="1")
    stderr_path = os.path.join(scratch, "client-stderr.txt")
    with open(stderr_path, "w") as err:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                stderr=err, text=True)
        try:
            reached = _wait_for(stderr_path, marker, 15)
            if reached:
                proc.send_signal(signum)
            stdout, _ = proc.communicate(timeout=timeout)
        finally:
            with open(release, "w") as f:
                f.write("go")
            if proc.poll() is None:
                proc.kill()
                proc.wait()
    return reached, proc.returncode, stdout, _read(stderr_path)


def drive_and_close_stderr(cmd, cwd, env, scratch, timeout=30):
    """CR-CRU-175 \u00a7S3 \u2014 run `cmd`, wait until its blocked runner's marker has
    reached the client's REAL stderr PIPE (the client's own "run started"
    line and the runner's first lines already reached it \u2014 the run is
    genuinely open and in flight), then close THIS PROCESS'S READ END of that
    pipe WITHOUT reading any further \u2014 exactly what the reader of
    `cmd | head -N` leaves behind once it has its N lines \u2014 and only then
    release the runner, so every further echo the client's `run_streamed`
    attempts lands on an already-dead pipe.

    Returns `(reached, returncode, stdout, pre_close_lines)`: `stdout` is
    read from the UNTOUCHED stdout pipe (never closed here \u2014 this driver is
    the stderr half of \u00a7S3's pair), and `pre_close_lines` is everything read
    on stderr before it was closed (so a failed `reached` can explain
    itself)."""
    marker = "LIVE_RUN_PIPE_CLOSE_MARKER"
    # A fresh release file per drive: an earlier drive's release must never
    # unblock this one's runner before the pipe is closed.
    release = _fresh_release_path(scratch)
    env = dict(env, FAKE_RELEASE_FILE=release, FAKE_MARKER_LINE=marker,
               FAKE_BLOCK_AFTER_INDEX="1")
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)
    assert proc.stderr is not None  # stderr=PIPE always yields a stream
    lines = []
    reached = False
    try:
        for line in proc.stderr:
            lines.append(line)
            if marker in line:
                reached = True
                break
    finally:
        proc.stderr.close()
        # `communicate()` below must not try to read the pipe we just closed.
        proc.stderr = None
        with open(release, "w") as f:
            f.write("go")
    try:
        stdout, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, _ = proc.communicate()
    return reached, proc.returncode, stdout, lines


def new_scratch(prefix):
    return tempfile.mkdtemp(prefix=prefix)


SIGNALS = (signal.SIGINT, signal.SIGTERM)
