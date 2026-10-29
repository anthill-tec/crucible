"""A `pre-merge-gate` whose suite ran but could not be filed names that suite
unreported, states no figures for it, and is not green — end to end, against
a REAL ephemeral board.

With no board there are no figures: a run whose ingest cannot reach the board,
or whose health read before the ingest cannot, is not filed, and a gate that
counts that run cannot say what it covered. It names the suite
`gate-suite-unreported`, never `gate-suite-failed` (nothing was filed to have
failed), states no counts for it, and exits non-zero.

Both gate shapes, for both clients:

  - **bun, a declared suite** — `package.json` declares `test:unit` (an
    own-stack target the whole-suite run covers), so the gate composes;
  - **bun, no declared suite** — the gate's one whole-suite regression IS the
    gate, and emits that run's own envelope;
  - **python, no declared suite** — python's surface enumerates no
    declaration (`suites=None`), so this is the only shape python's own gate
    has;
  - **python, a declared suite** — the one way a python suite is a DECLARED
    suite: a bun project's `test:python` script invoking the python client,
    which bun's gate dispatches to it.

The board is a scratch `bun run src/server.ts` (never :3850/:3849/39877),
booted once for the module, each test filing under a project of its own. The
client reaches it through a transparent forwarding proxy that every request
passes through untouched, so the run is opened, registered and (where it is)
filed on the real board. The ONE thing the proxy adds is the board going
away at a chosen moment, which a spawned server cannot be timed to do between
two requests of one client:

  - **unreachable at the health read** — the fake runner, while the suite is
    running, has the proxy stop listening; the ingest's health read and
    everything after it find nothing at the address (connection refused);
  - **unreachable at the ingest** — the fake runner arms the proxy; the next
    health read is forwarded and answered, and the proxy stops listening
    before answering it, so the `POST /api/v2/runs` that follows finds
    nothing at the address.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_gate_names_an_unfiled_suite_unreported_end_to_end
"""

import http.server
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from tests.client.live_run_harness import load_toon, scrubbed_env
from tests.client.test_client_fleet_envelope_census import declare_and_require_board

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
BUN_CLIENT = CLIENTS_DIR / "bun-crucible.py"
PYTHON_CLIENT = CLIENTS_DIR / "python-crucible.py"
TIMEOUT = 180
TOON = load_toon()

HEALTH_PATHS = ("/api/health", "/api/v2/health")
CUT_NOW = "/__proxy__/cut-now"
CUT_AFTER_HEALTH = "/__proxy__/cut-after-health"
COUNT_KEYS = ("passed", "failed", "pending", "total", "files")

_SCRUBBED = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
             "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
             "PY_CRUCIBLE_PYTHON", "PY_CRUCIBLE_PROJECT_DIR",
             "PYTHON_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_URL", "PYTEST_ADDOPTS",
             "COVERAGE_RCFILE", "COVERAGE_PROCESS_START")

# A passing run in each runner's report shape: a gate that filed it would be
# green, so a gate that is not green is so for the unfiled run alone.
GREEN_BUN_JUNIT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuites name="bun test" tests="1" failures="0">\n'
    '  <testsuite name="tests/green.test.ts" file="tests/green.test.ts" '
    'tests="1" failures="0">\n'
    '    <testcase name="passes" classname="green" time="0.001" '
    'file="tests/green.test.ts" />\n'
    '  </testsuite>\n'
    '</testsuites>\n')
GREEN_PYTHON_JUNIT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuite name="test_green.GreenTest" tests="1" errors="0" failures="0" '
    'skipped="0" time="0.001"><testcase classname="test_green.GreenTest" '
    'name="test_passes" time="0.001" file="tests/test_green.py"/></testsuite>\n')
GREEN_LCOV = ("TN:\nSF:src/green.ts\nFNF:1\nFNH:1\nDA:1,1\nDA:2,1\n"
              "LF:2\nLH:2\nend_of_record\n")

# The fake runners' shared tail: the cut this runner was told to make, as a
# GET of the proxy's control path, made while the suite is still running.
_CUT = r'''
cut = os.environ.get(CUT_VAR)
if cut:
    urllib.request.urlopen(cut, timeout=60).read()
'''

# `bun test`'s stand-in: GREEN_BUN_JUNIT to `--reporter-outfile=`, GREEN_LCOV
# to `<--coverage-dir>/lcov.info` under `--coverage`, the cut FAKE_BUN_CUT
# names, exit 0.
_FAKE_BUN = r'''
import os
import sys
import urllib.request

CUT_VAR = "FAKE_BUN_CUT"
JUNIT, LCOV = ''' + repr((GREEN_BUN_JUNIT, GREEN_LCOV)) + r'''

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

argv = sys.argv[1:]
junit = coverage_dir = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
    if arg.startswith("--coverage-dir="):
        coverage_dir = arg.split("=", 1)[1]
sys.stdout.write("tests/green.test.ts:\n(pass) green > passes [0.01ms]\n")
sys.stdout.flush()
if junit:
    write(junit, JUNIT)
if "--coverage" in argv and coverage_dir:
    write(os.path.join(coverage_dir, "lcov.info"), LCOV)
''' + _CUT + r'''
sys.exit(0)
'''

# The python interpreter's stand-in: `-c <probe>` answers `true`; `-m coverage
# lcov ... -o <file>` writes GREEN_LCOV there; a suite run (the subtest runner
# under `coverage run`) writes GREEN_PYTHON_JUNIT into the `-o` reports dir,
# makes the cut FAKE_PYTHON_CUT names, and exits 0.
_FAKE_PYTHON = r'''
import os
import sys
import urllib.request

CUT_VAR = "FAKE_PYTHON_CUT"
JUNIT, LCOV = ''' + repr((GREEN_PYTHON_JUNIT, GREEN_LCOV)) + r'''

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

argv = sys.argv[1:]
if argv[:1] == ["-c"]:
    sys.stdout.write("true\n")
    sys.exit(0)
if argv[:3] == ["-m", "coverage", "lcov"]:
    write(argv[argv.index("-o") + 1], LCOV)
    sys.exit(0)
out_dir = argv[len(argv) - 1 - argv[::-1].index("-o") + 1]
write(os.path.join(out_dir, "TEST-test_green.GreenTest.xml"), JUNIT)
sys.stderr.write("test_passes (test_green.GreenTest.test_passes) ... ok\n")
sys.stdout.write("fake python ran\n")
sys.stdout.flush()
''' + _CUT + r'''
sys.exit(0)
'''


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _require_http(url):
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        raise ValueError(f"refusing a non-http(s) URL: {url!r}")
    return url


def _http(base, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(  # noqa: S310 - scheme checked
        _require_http(base + path), data=data,
        method="POST" if data is not None else "GET",
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())


def _await_board(base, proc, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"scratch board exited early with {proc.returncode}")
        try:
            with urllib.request.urlopen(  # noqa: S310 - scheme checked
                    _require_http(base + "/api/v2/health"), timeout=2):
                return
        except (urllib.error.URLError, OSError):
            time.sleep(0.2)
    raise RuntimeError(f"scratch board never became reachable at {base}")


class _ProxyServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False


class BoardProxy:
    """Forwards every request to the real board, byte for byte, until it is
    told to stop listening: at once (`CUT_NOW`), or just before it answers
    the next health read (`CUT_AFTER_HEALTH`). Once it has stopped, its
    address refuses every connection, as a board that has gone away does."""

    def __init__(self, upstream):
        self.upstream = upstream
        self.requests = []
        self._armed = False
        self._lock = threading.Lock()
        self._stopped = threading.Event()
        proxy = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _relay(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else None
                path = self.path
                with proxy._lock:
                    proxy.requests.append((self.command, path))
                if path == CUT_NOW:
                    proxy.stop_listening()
                    return self._answer(200, b'{"ok":true}')
                if path == CUT_AFTER_HEALTH:
                    with proxy._lock:
                        proxy._armed = True
                    return self._answer(200, b'{"ok":true}')
                status, payload = proxy.forward(self.command, path, body)
                if self.command == "GET" and path.split("?")[0] in HEALTH_PATHS:
                    with proxy._lock:
                        armed, proxy._armed = proxy._armed, False
                    if armed:
                        proxy.stop_listening()
                return self._answer(status, payload)

            def _answer(self, status, payload):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _relay

            def log_message(self, format, *args):
                pass

        self._server = _ProxyServer(("127.0.0.1", 0), _Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        daemon=True)
        self._thread.start()

    def forward(self, method, path, body):
        request = urllib.request.Request(  # noqa: S310 - scheme checked
            _require_http(self.upstream + path), data=body, method=method,
            headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def stop_listening(self):
        """Close the listener: called from a handler thread, so the serving
        loop (on its own thread) is stopped first and the socket closed after
        it, before the handler answers the connection it already holds."""
        if self._stopped.is_set():
            return
        self._stopped.set()
        self._server.shutdown()
        self._server.server_close()

    def close(self):
        self.stop_listening()
        self._thread.join(timeout=5)


_BOARD = {}


def setUpModule():
    bun = shutil.which("bun")
    if bun is None:
        raise unittest.SkipTest(
            "the board these gates file to is a real `src/server.ts`: without "
            "`bun` there is no board to boot")
    store = tempfile.mkdtemp(prefix="gate-unreported-board-")
    port = _free_port()
    assert port not in (3850, 3849, 39877), f"reserved port handed back: {port}"
    Path(store, "crucible.toml").write_text(
        f'[server]\nhost = "127.0.0.1"\nport = {port}\n', encoding="utf-8")
    proc = subprocess.Popen(
        [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
        env={**os.environ, "CRUCIBLE_DB": os.path.join(store, "crucible.db")},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _BOARD.update(proc=proc, store=store, base=f"http://127.0.0.1:{port}")
    try:
        _await_board(_BOARD["base"], proc)
    except BaseException:
        tearDownModule()
        raise


def tearDownModule():
    proc = _BOARD.pop("proc", None)
    if proc is not None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    store = _BOARD.pop("store", None)
    if store:
        shutil.rmtree(store, ignore_errors=True)


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _codes(envelope):
    return [w.get("code") for w in (envelope or {}).get("warnings") or []
            if isinstance(w, dict)]


def _warnings_coded(envelope, code):
    return [w for w in (envelope or {}).get("warnings") or []
            if isinstance(w, dict) and w.get("code") == code]


def _figures(block):
    """The integer counts a `run:` block or a `suites[]` row states."""
    block = block if isinstance(block, dict) else {}
    return {k: block[k] for k in COUNT_KEYS
            if isinstance(block.get(k), int) and not isinstance(block.get(k), bool)}


def _write_executable(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body, encoding="utf-8")
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)
    return path


class _GateAgainstABoardThatGoesAway(unittest.TestCase):
    """A scratch project of its own on the module's board, reached through a
    `BoardProxy`; both fake runners; and the gate's envelope. Defines no test
    of its own."""

    def setUp(self):
        self.base = _BOARD["base"]
        self.scratch = tempfile.mkdtemp(prefix="gate-unreported-")
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        project = _http(self.base, "/api/v2/projects",
                        {"name": f"gate-unreported-{os.path.basename(self.scratch)}"})
        self.assertTrue(project.get("ok"), f"project creation failed: {project!r}")
        self.key = project["project"]["key"]
        self.proxy = BoardProxy(self.base)
        self.addCleanup(self.proxy.close)
        self.project = os.path.join(self.scratch, "project")
        os.makedirs(os.path.join(self.project, "tests"))
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={self.key}\n")
        declare_and_require_board(self.project, self.proxy.url, "a gate's client")
        self.fake_bun = _write_executable(os.path.join(self.scratch, "fake_bun.py"),
                                          _FAKE_BUN)
        self.fake_python = _write_executable(
            os.path.join(self.scratch, "fake_python.py"), _FAKE_PYTHON)

    def manifest(self, scripts=None):
        manifest = {"name": "gate-unreported", "private": True}
        if scripts:
            manifest["scripts"] = scripts
        Path(self.project, "package.json").write_text(json.dumps(manifest, indent=2))

    def cut(self, when):
        return self.proxy.url + {"health": CUT_NOW, "ingest": CUT_AFTER_HEALTH}[when]

    def env(self, **fake):
        env = scrubbed_env(None, **fake)
        for key in _SCRUBBED + ("FAKE_BUN_CUT", "FAKE_PYTHON_CUT"):
            if key not in fake:
                env.pop(key, None)
        return env

    def bun_gate(self, agent, **fake):
        return self._drive(BUN_CLIENT, [
            "pre-merge-gate", "--agent", agent, "--skip-check",
            "--bun", self.fake_bun, "--project-dir", self.project,
            "--package-dir", self.project, "--reports", "reports"], **fake)

    def python_gate(self, agent, **fake):
        return self._drive(PYTHON_CLIENT, [
            "pre-merge-gate", "--agent", agent, "--skip-check",
            "--python", self.fake_python, "--project-dir", self.project,
            "--reports", "reports"], **fake)

    def _drive(self, client, argv, **fake):
        return subprocess.run([sys.executable, str(client), *argv],
                              cwd=self.project, env=self.env(**fake),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    @staticmethod
    def diagnostics(result):
        return (f"exit={result.returncode} stdout={result.stdout!r} "
                f"stderr={result.stderr[-3000:]!r}")

    def assert_the_cut_landed(self, when, result):
        """Fixture sanity: the proxy was told to go away, and (for the ingest
        cut) a health read reached the real board after it was armed."""
        paths = [p for _m, p in self.proxy.requests]
        control = {"health": CUT_NOW, "ingest": CUT_AFTER_HEALTH}[when]
        self.assertIn(control, paths, f"the fake runner made its cut; "
                                      f"requests={paths!r} {self.diagnostics(result)}")
        after = paths[paths.index(control) + 1:]
        if when == "ingest":
            self.assertTrue(any(p in HEALTH_PATHS for p in after),
                            f"the health read before the ingest was answered; "
                            f"requests={paths!r} {self.diagnostics(result)}")
        self.assertNotIn("/api/v2/runs", after,
                         f"no ingest reached the board after the cut; "
                         f"requests={paths!r} {self.diagnostics(result)}")

    def assert_unreported_and_not_green(self, result, *, names=None):
        envelope = _envelope(result.stdout)
        where = f"envelope={envelope!r} {self.diagnostics(result)}"
        self.assertIsNotNone(envelope, f"stdout is one TOON envelope; {where}")
        envelope = envelope or {}
        self.assertEqual(envelope.get("verb"), "pre-merge-gate", where)
        self.assertIs(envelope.get("ok"), False, f"the gate is not green; {where}")
        self.assertNotEqual(result.returncode, 0, f"the gate exits non-zero; {where}")
        unreported = _warnings_coded(envelope, "gate-suite-unreported")
        self.assertEqual(len(unreported), 1,
                         f"the gate names the one suite it could not file "
                         f"`gate-suite-unreported`, once; {where}")
        if names is not None and unreported:
            self.assertIn(names, unreported[0].get("detail") or "",
                          f"the warning names the unfiled suite; {where}")
        self.assertNotIn("gate-suite-failed", _codes(envelope),
                         f"a run that was never filed did not fail; {where}")
        return envelope


class BunGateWithADeclaredSuiteEndToEndTest(_GateAgainstABoardThatGoesAway):
    """`test:unit` declared: the gate composes, and its whole-suite run,
    which covers `test:unit`, is the suite it could not file."""

    def drive(self, when, agent):
        self.manifest({"test:unit": "bun test"})
        result = self.bun_gate(agent, FAKE_BUN_CUT=self.cut(when))
        self.assert_the_cut_landed(when, result)
        envelope = self.assert_unreported_and_not_green(result, names="test:unit")
        rows = [r for r in envelope.get("suites") or []
                if isinstance(r, dict) and r.get("suite") == "test:unit"]
        self.assertEqual(len(rows), 1, f"envelope={envelope!r}")
        self.assertEqual(_figures(rows[0] if rows else {}), {},
                         f"the gate states no figures for the unfiled suite; "
                         f"envelope={envelope!r}")

    def test_bun_gate_with_a_declared_suite_whose_ingest_finds_no_board_names_it_unreported(self):
        self.drive("ingest", "bun-gate-declared-ingest-gone")

    def test_bun_gate_with_a_declared_suite_whose_health_read_finds_no_board_names_it_unreported(self):
        self.drive("health", "bun-gate-declared-health-gone")


class BunGateWithNoDeclaredSuiteEndToEndTest(_GateAgainstABoardThatGoesAway):
    """No `test:*` script: the gate's one whole-suite regression is the gate,
    and its envelope is that run's own."""

    def drive(self, when, agent):
        self.manifest()
        result = self.bun_gate(agent, FAKE_BUN_CUT=self.cut(when))
        self.assert_the_cut_landed(when, result)
        envelope = self.assert_unreported_and_not_green(result, names="bun")
        self.assertEqual(_figures(envelope.get("run")), {},
                         f"the gate states no figures for the unfiled suite; "
                         f"envelope={envelope!r}")

    def test_bun_gate_with_no_declared_suite_whose_ingest_finds_no_board_names_it_unreported(self):
        self.drive("ingest", "bun-gate-whole-ingest-gone")

    def test_bun_gate_with_no_declared_suite_whose_health_read_finds_no_board_names_it_unreported(self):
        self.drive("health", "bun-gate-whole-health-gone")


class PythonGateWithNoDeclaredSuiteEndToEndTest(_GateAgainstABoardThatGoesAway):
    """Python's own gate: its surface declares no suites, so its one
    whole-suite regression is the gate."""

    def drive(self, when, agent):
        result = self.python_gate(agent, FAKE_PYTHON_CUT=self.cut(when))
        self.assert_the_cut_landed(when, result)
        envelope = self.assert_unreported_and_not_green(result, names="python")
        self.assertEqual(_figures(envelope.get("run")), {},
                         f"the gate states no figures for the unfiled suite; "
                         f"envelope={envelope!r}")

    def test_python_gate_whose_ingest_finds_no_board_names_its_suite_unreported(self):
        self.drive("ingest", "python-gate-whole-ingest-gone")

    def test_python_gate_whose_health_read_finds_no_board_names_its_suite_unreported(self):
        self.drive("health", "python-gate-whole-health-gone")


class DeclaredPythonSuiteDispatchedByTheBunGateEndToEndTest(
        _GateAgainstABoardThatGoesAway):
    """A `test:python` script invoking the python client is a declared python
    suite; bun's gate dispatches it. Bun's own whole suite is filed (the cut
    is the python runner's alone), so the python suite is the one unfiled."""

    def drive(self, when, agent):
        command = (f"{sys.executable} {PYTHON_CLIENT} regression "
                   f"--python {self.fake_python} --project-dir {self.project} "
                   f"--reports reports-python")
        self.manifest({"test:python": command})
        result = self.bun_gate(agent, FAKE_PYTHON_CUT=self.cut(when))
        self.assert_the_cut_landed(when, result)
        envelope = self.assert_unreported_and_not_green(result, names="test:python")
        rows = [r for r in envelope.get("suites") or []
                if isinstance(r, dict) and r.get("suite") == "test:python"]
        self.assertEqual(len(rows), 1, f"envelope={envelope!r}")
        self.assertEqual(rows[0].get("stack") if rows else None, "python",
                         f"envelope={envelope!r}")
        self.assertEqual(_figures(rows[0] if rows else {}), {},
                         f"the gate states no figures for the unfiled suite; "
                         f"envelope={envelope!r}")

    def test_bun_gate_dispatching_a_python_suite_whose_ingest_finds_no_board_names_it_unreported(self):
        self.drive("ingest", "bun-gate-python-ingest-gone")

    def test_bun_gate_dispatching_a_python_suite_whose_health_read_finds_no_board_names_it_unreported(self):
        self.drive("health", "bun-gate-python-health-gone")


if __name__ == "__main__":
    unittest.main()
