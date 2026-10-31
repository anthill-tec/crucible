"""A real stack report, filed through its own client, is stored as the board
decodes it — end to end, against a REAL ephemeral board.

CR-CRU-152 froze one real run per stack under `tests/fixtures/reports/<stack>/`
with its client's parse beside it (`expected.json`).
`tests/real-stack-reports-decode-on-the-board.test.ts` proves the board's
decode of those reports by POSTing them itself. This suite proves the same
figures through the CLIENT VERB: `bun-crucible.py test`,
`python-crucible.py test` (unittest and pytest) and `mvn-crucible.py
regression` (a two-module reactor's surefire and failsafe reports, compared
by `(suite, case)`, since the client reads them from one pooled directory in
name order), `rust-crucible.py test` (nextest's one report, written where
nextest writes it, compared by `(suite, case)`) and `arduino-crucible.py unit`
(the native harness's three reports, written into the run's own reports
directory, compared by `(suite, case)`) run a faithful fake runner
that writes the fixture's own report bytes where the client tells it to (and,
for bun, prints the fixture's captured console as its output), exits non-zero
as the fixture's run did, and the client sends what it found to the board
(`ingest_reports`, clients/_crucible_run.py). The stored run is then read back
over the board's own `GET /api/v2/events/<id>`.

  - the stored `total`, `passed`, `failed` and `pending`, and every case's
    status in order, equal the fixture's `expected.json`;
  - the stored codec is `junit` (the board decoded the report; nothing was
    filed pre-parsed);
  - the envelope's `run:` counts equal the stored ones (the client's figures
    are the board's).

The fixtures are failing runs, whose coverage the board discards, so the
coverage object is proven on a PASSING report filed beside each fixture's own
lcov through the coverage-measuring verb (`regression --coverage`; rust's
`regression-ingest`; arduino's `regression --coverage`): the stored coverage object equals the fixture's
`expected.json` coverage.

The board is a scratch `bun run src/server.ts` on a free port with a throwaway
store (never :3850/:3849/39877), booted once for the module; each test files
under a project of its own.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_real_stack_reports_filed_through_their_client_end_to_end
"""

import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
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
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "reports"
TIMEOUT = 180
TOON = load_toon()

_SCRUBBED = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
             "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
             "PY_CRUCIBLE_PYTHON", "PY_CRUCIBLE_PROJECT_DIR",
             "PYTHON_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_URL", "PYTEST_ADDOPTS",
             "COVERAGE_RCFILE", "COVERAGE_PROCESS_START")

# A passing run, in each runner's own report shape: the run the board keeps a
# coverage report on.
GREEN_BUN_JUNIT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuites name="bun test" tests="1" failures="0">\n'
    '  <testsuite name="tests/green.test.ts" file="tests/green.test.ts" '
    'tests="1" failures="0">\n'
    '    <testcase name="passes" classname="green" time="0.001" '
    'file="tests/green.test.ts" />\n'
    '  </testsuite>\n'
    '</testsuites>\n')
GREEN_UNITTEST_STREAM = (
    '{"event": "run-start", "total": 1}\n'
    '{"event": "test-end", "id": "test_green.GreenTest.test_passes", '
    '"name": "test_passes", "suite": "test_green.GreenTest", '
    '"file": "tests/test_green.py", "status": "pass", "duration_ms": 1}\n'
    '{"event": "run-end", "total": 1, "passed": 1, "failed": 0, "pending": 0}\n')
GREEN_PYTEST_JUNIT = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<testsuites name="pytest tests"><testsuite name="pytest" errors="0" '
    'failures="0" skipped="0" tests="1" time="0.010"><testcase '
    'classname="ptests.test_green" name="test_passes" '
    'file="ptests/test_green.py" line="3" time="0.001" /></testsuite>'
    '</testsuites>\n')

# A `bun` stand-in, faithful to `bun test`'s report flags: it prints the
# console it is handed (FAKE_CONSOLE, the captured output of the real run) as
# its own output, copies FAKE_JUNIT to `--reporter-outfile=`, copies FAKE_LCOV
# to `<--coverage-dir>/lcov.info` when `--coverage` is given, and exits
# FAKE_EXIT.
_FAKE_BUN = r'''
import os
import shutil
import sys

def place(src, dst):
    directory = os.path.dirname(dst)
    if directory:
        os.makedirs(directory, exist_ok=True)
    shutil.copyfile(src, dst)

argv = sys.argv[1:]
junit = None
coverage_dir = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
    if arg.startswith("--coverage-dir="):
        coverage_dir = arg.split("=", 1)[1]
console = os.environ.get("FAKE_CONSOLE")
if console:
    with open(console, encoding="utf-8") as handle:
        sys.stdout.write(handle.read())
else:
    sys.stdout.write("bun test v1.4.2 (fake)\n")
sys.stdout.flush()
if junit:
    place(os.environ["FAKE_JUNIT"], junit)
if "--coverage" in argv and coverage_dir and os.environ.get("FAKE_LCOV"):
    place(os.environ["FAKE_LCOV"], os.path.join(coverage_dir, "lcov.info"))
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''

# A python interpreter stand-in, faithful to how the python client drives
# one: `-c <probe>` (the pytest import probe, coverage.py's config and erase
# probes) answers `true`; `-m coverage lcov ... -o <file>` copies FAKE_LCOV
# there; a suite run, bare or under `-m coverage run` -- `-m pytest ...
# --junitxml=<file>` copies the first FAKE_REPORTS file to the `--junitxml`
# path, and the client's unittest runner copies FAKE_STREAM to the stream file
# `CRUCIBLE_STREAM` names (CR-CRU-224) -- prints FAKE_OUTPUT, and exits
# FAKE_EXIT.
_FAKE_PYTHON = r'''
import os
import shutil
import sys

def place(src, dst):
    directory = os.path.dirname(dst)
    if directory:
        os.makedirs(directory, exist_ok=True)
    shutil.copyfile(src, dst)

argv = sys.argv[1:]
if argv[:1] == ["-c"]:
    sys.stdout.write("true\n")
    sys.exit(0)
if argv[:3] == ["-m", "coverage", "lcov"]:
    place(os.environ["FAKE_LCOV"], argv[argv.index("-o") + 1])
    sys.exit(0)
reports = [p for p in os.environ.get("FAKE_REPORTS", "").split(os.pathsep) if p]
pytest = any(argv[i:i + 2] == ["-m", "pytest"] for i in range(len(argv)))
if pytest:
    target = [a.split("=", 1)[1] for a in argv if a.startswith("--junitxml=")][0]
    place(reports[0], target)
else:
    stream = os.environ.pop("CRUCIBLE_STREAM", None)
    if stream and os.environ.get("FAKE_STREAM"):
        place(os.environ["FAKE_STREAM"], stream)
sys.stdout.write(os.environ.get("FAKE_OUTPUT", "fake python ran") + "\n")
sys.stdout.flush()
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''


MVN_CLIENT = CLIENTS_DIR / "mvn-crucible.py"
_MVN_SCRUBBED = ("MVN_CRUCIBLE_PROJECT_DIR", "MVN_CRUCIBLE_MAVEN_DIR",
                 "MVN_CRUCIBLE_COMPOSE_FILE", "CRUCIBLE_COVERAGE_PROFILE")

# A passing surefire report: the run the board keeps a coverage report on.
GREEN_SUREFIRE_JUNIT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuite name="com.acme.GreenTest" tests="1" failures="0" errors="0" '
    'skipped="0"><testcase name="passes" classname="com.acme.GreenTest" '
    'time="0.001"/></testsuite>\n')

# A `mvnw` stand-in, faithful to how the maven client drives the reactor: it
# copies every FAKE_SUREFIRE report into the directory the client named for
# surefire (`-Dsurefire.reportsDirectory=`) and every FAKE_FAILSAFE report
# into failsafe's, each by its own name; copies each FAKE_JACOCO path (relative
# to FAKE_JACOCO_ROOT) to the same relative path under the maven directory, as
# JaCoCo's `report` goal writes `<module>/target/site/jacoco/jacoco.csv`; and
# exits FAKE_EXIT.
_FAKE_MVNW = r'''
import os
import shutil
import sys

def place(src, dst):
    directory = os.path.dirname(dst)
    if directory:
        os.makedirs(directory, exist_ok=True)
    shutil.copyfile(src, dst)

args = sys.argv[1:]
if "test-compile" in args:
    sys.stdout.write("[INFO] BUILD SUCCESS\n")
    sys.exit(0)
sys.stdout.write("[INFO] Scanning for projects... (fake mvnw)\n")
for plugin in ("surefire", "failsafe"):
    flag = "-D%s.reportsDirectory=" % plugin
    target = [a[len(flag):] for a in args if a.startswith(flag)]
    reports = [p for p in os.environ.get("FAKE_" + plugin.upper(), "").split(os.pathsep) if p]
    for src in reports:
        place(src, os.path.join(target[0], os.path.basename(src)))
root = os.environ.get("FAKE_JACOCO_ROOT")
for rel in [p for p in os.environ.get("FAKE_JACOCO", "").split(os.pathsep) if p]:
    place(os.path.join(root, rel), rel)
sys.stdout.flush()
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''


RUST_CLIENT = CLIENTS_DIR / "rust-crucible.py"
_RUST_SCRUBBED = ("RUST_CRUCIBLE_PROJECT_DIR", "RUST_CRUCIBLE_COMPOSE_FILE",
                  "CARGO_TARGET_DIR")

# A passing nextest report: the run the board keeps a coverage report on.
GREEN_NEXTEST_JUNIT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuites name="nextest-run" tests="1" failures="0" errors="0">\n'
    '  <testsuite name="scratch_calc" tests="1" disabled="0" errors="0" '
    'failures="0">\n'
    '    <testcase name="tests::adds_two_numbers" classname="scratch_calc" '
    'time="0.003"></testcase>\n'
    '  </testsuite>\n'
    '</testsuites>\n')

# A `cargo` stand-in, faithful to where nextest and llvm-cov write: `clean`
# and `check` succeed silently; a run naming `nextest` (bare, or under
# `llvm-cov`) copies FAKE_JUNIT to `target/nextest/<-P profile>/junit.xml`
# under its cwd and, when given `--output-path`, FAKE_LCOV there; then it
# exits FAKE_EXIT.
_FAKE_CARGO = r'''
import os
import shutil
import sys

def place(src, dst):
    directory = os.path.dirname(dst)
    if directory:
        os.makedirs(directory, exist_ok=True)
    shutil.copyfile(src, dst)

args = sys.argv[1:]
if "nextest" not in args:
    sys.exit(0)
profile = "default"
lcov = None
for i, arg in enumerate(args):
    if arg == "-P" and i + 1 < len(args):
        profile = args[i + 1]
    if arg == "--output-path" and i + 1 < len(args):
        lcov = args[i + 1]
sys.stdout.write("    Starting tests (fake cargo nextest)\n")
sys.stdout.flush()
place(os.environ["FAKE_JUNIT"],
      os.path.join(os.getcwd(), "target", "nextest", profile, "junit.xml"))
if lcov and os.environ.get("FAKE_LCOV"):
    place(os.environ["FAKE_LCOV"], os.path.join(os.getcwd(), lcov))
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
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


_BOARD = {}


def setUpModule():
    bun = shutil.which("bun")
    if bun is None:
        raise unittest.SkipTest(
            "the board that decodes these reports is a real `src/server.ts`: "
            "without `bun` there is no board to boot")
    store = tempfile.mkdtemp(prefix="real-reports-through-client-board-")
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


def _expected(fixture_dir):
    return json.loads((FIXTURES / fixture_dir / "expected.json").read_text(encoding="utf-8"))


def _counts(block):
    block = block if isinstance(block, dict) else {}
    return {key: block.get(key) for key in ("total", "passed", "failed", "pending")}


def _leaves(tree):
    return [(case.get("name"), case.get("status"))
            for suite in tree or [] for case in suite.get("children") or []]


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _write_executable(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body, encoding="utf-8")
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)
    return path


class _FiledThroughTheClient(unittest.TestCase):
    """A scratch project of its own on the module's board, a fake runner, and
    the board's own read of what the client filed. Defines no test of its
    own."""

    client_label = "a client"

    def setUp(self):
        self.base = _BOARD["base"]
        self.scratch = tempfile.mkdtemp(prefix="real-reports-through-client-")
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        project = _http(self.base, "/api/v2/projects",
                        {"name": f"real-reports-{os.path.basename(self.scratch)}"})
        self.assertTrue(project.get("ok"), f"project creation failed: {project!r}")
        self.key = project["project"]["key"]
        self.project = os.path.join(self.scratch, "project")
        os.makedirs(os.path.join(self.project, "tests"))
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={self.key}\n")
        Path(self.project, "package.json").write_text(
            json.dumps({"name": "real-reports", "private": True}))
        declare_and_require_board(self.project, self.base, self.client_label)

    def env(self, **fake):
        env = scrubbed_env(None, **fake)
        for key in _SCRUBBED:
            env.pop(key, None)
        return env

    def drive(self, client, argv, **fake):
        result = subprocess.run(
            [sys.executable, str(client), *argv], cwd=self.project,
            env=self.env(**fake), capture_output=True, text=True,
            timeout=TIMEOUT, check=False)
        return result

    @staticmethod
    def diagnostics(result):
        return (f"exit={result.returncode} stdout={result.stdout!r} "
                f"stderr={result.stderr[-3000:]!r}")

    def stored_run(self, agent, result):
        """The one run event this agent filed, as the board's detail read
        answers it."""
        listed = _http(self.base, f"/api/v2/events?project={self.key}&limit=100")
        self.assertTrue(listed.get("ok"), f"events read failed: {listed!r}")
        runs = [e for e in listed.get("events") or []
                if e.get("agentId") == agent and e.get("kind") == "test"]
        self.assertEqual(
            len(runs), 1,
            f"the client files exactly one run for this drive; events="
            f"{listed.get('events')!r} {self.diagnostics(result)}")
        detail = _http(self.base, f"/api/v2/events/{runs[0]['id']}")
        self.assertTrue(detail.get("ok", True), f"detail read failed: {detail!r}")
        event = detail.get("event")
        self.assertIsInstance(event, dict, f"detail={detail!r}")
        return event

    def assert_fixture_stored(self, fixture_dir, agent, result, red_exit=True):
        expected = _expected(fixture_dir)["client"]
        event = self.stored_run(agent, result)
        where = f"event={json.dumps(event)[:3000]} {self.diagnostics(result)}"
        self.assertEqual(event.get("codec"), "junit",
                         f"the board decoded the report the client sent; {where}")
        self.assertEqual(_counts(event.get("summary")), _counts(expected["summary"]),
                         f"the stored counts are the fixture's; {where}")
        self.assertEqual(_leaves(event.get("tree")), _leaves(expected["tree"]),
                         f"every case is stored with the fixture's status, in "
                         f"order; {where}")
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(envelope, f"stdout is one TOON envelope; {where}")
        self.assertEqual(_counts((envelope or {}).get("run")),
                         _counts(event.get("summary")),
                         f"the envelope's run: counts are the stored ones; {where}")
        if red_exit:
            self.assertNotEqual(result.returncode, 0,
                                f"a run with failures is not green; {where}")
        return event

    def assert_coverage_stored(self, fixture_dir, agent, result):
        want = _expected(fixture_dir)["client"]["coverage"]
        self.assertGreater(want["lines"]["total"], 0, "fixture sanity")
        event = self.stored_run(agent, result)
        where = f"event={json.dumps(event)[:3000]} {self.diagnostics(result)}"
        self.assertEqual(event.get("coverage"), want,
                         f"the fixture's lcov, filed beside a passing report, "
                         f"is stored as the fixture's coverage object; {where}")
        self.assertEqual(_counts(event.get("summary")),
                         {"total": 1, "passed": 1, "failed": 0, "pending": 0},
                         f"the passing report is the one filed; {where}")
        self.assertEqual(result.returncode, 0, where)


class BunFixtureFiledThroughTheBunClientEndToEndTest(_FiledThroughTheClient):
    client_label = "bun-crucible.py"

    def setUp(self):
        super().setUp()
        self.fake_bun = _write_executable(os.path.join(self.scratch, "fake_bun.py"),
                                          _FAKE_BUN)

    def argv(self, verb, agent, *extra):
        return [verb, "--agent", agent, "--bun", self.fake_bun,
                "--project-dir", self.project, "--package-dir", self.project,
                "--reports", "reports", *extra]

    def test_the_bun_fixture_filed_by_bun_test_stores_its_expected_counts_and_statuses(self):
        agent = "real-bun-through-client"
        result = self.drive(BUN_CLIENT, self.argv("test", agent),
                            FAKE_JUNIT=str(FIXTURES / "bun" / "junit.xml"),
                            FAKE_CONSOLE=str(FIXTURES / "bun" / "console.txt"),
                            FAKE_EXIT="1")
        self.assert_fixture_stored("bun", agent, result)

    def test_the_bun_fixtures_lcov_filed_by_regression_coverage_stores_its_expected_coverage(self):
        agent = "real-bun-coverage-through-client"
        green = Path(self.scratch, "green-junit.xml")
        green.write_text(GREEN_BUN_JUNIT, encoding="utf-8")
        result = self.drive(BUN_CLIENT, self.argv("regression", agent, "--coverage"),
                            FAKE_JUNIT=str(green),
                            FAKE_LCOV=str(FIXTURES / "bun" / "lcov.info"),
                            FAKE_EXIT="0")
        self.assert_coverage_stored("bun", agent, result)


class PythonFixturesFiledThroughThePythonClientEndToEndTest(_FiledThroughTheClient):
    client_label = "python-crucible.py"

    def setUp(self):
        super().setUp()
        self.fake_python = _write_executable(
            os.path.join(self.scratch, "fake_python.py"), _FAKE_PYTHON)

    def argv(self, verb, agent, *extra):
        return [verb, "--agent", agent, "--python", self.fake_python,
                "--project-dir", self.project, "--reports", "reports", *extra]

    @staticmethod
    def fixture_reports(fixture_dir):
        return os.pathsep.join(str(FIXTURES / fixture_dir / name)
                               for name in _expected(fixture_dir)["reports"])

    def green_report(self, name, text):
        path = Path(self.scratch, "green", name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return str(path)

    def test_the_xmlrunner_fixture_filed_by_auto_ingest_stores_its_expected_counts_and_statuses(self):
        """The frozen `python/xmlrunner/` fixture stays the `junit` codec's
        and `auto-ingest`'s: a unittest run no longer writes JUnit
        (CR-CRU-224), so the fixture's reports are filed as a JUnit dir."""
        agent = "real-xmlrunner-through-auto-ingest"
        reports = Path(self.project, "reports")
        reports.mkdir(parents=True, exist_ok=True)
        for name in _expected("python/xmlrunner")["reports"]:
            shutil.copyfile(FIXTURES / "python" / "xmlrunner" / name, reports / name)
        registered = self.drive(PYTHON_CLIENT,
                                ["register", "--agent", agent, "--role", "report",
                                 "--project-dir", self.project])
        self.assertEqual(registered.returncode, 0, self.diagnostics(registered))
        result = self.drive(PYTHON_CLIENT,
                            ["auto-ingest", "--agent", agent, "--project-dir",
                             self.project, "--reports", "reports"])
        self.assert_fixture_stored("python/xmlrunner", agent, result, red_exit=False)

    def test_the_pytest_fixture_filed_by_python_test_under_pytest_stores_its_expected_counts_and_statuses(self):
        agent = "real-pytest-through-client"
        result = self.drive(PYTHON_CLIENT,
                            self.argv("test", agent, "--runner", "pytest"),
                            FAKE_REPORTS=self.fixture_reports("python/pytest"),
                            FAKE_EXIT="1")
        self.assert_fixture_stored("python/pytest", agent, result)

    def test_the_xmlrunner_fixtures_lcov_filed_by_a_streamed_regression_coverage_stores_its_expected_coverage(self):
        agent = "real-xmlrunner-coverage-through-client"
        stream = Path(self.scratch, "green", "crucible-events.ndjson")
        stream.parent.mkdir(parents=True, exist_ok=True)
        stream.write_text(GREEN_UNITTEST_STREAM, encoding="utf-8")
        result = self.drive(
            PYTHON_CLIENT, self.argv("regression", agent, "--coverage"),
            FAKE_STREAM=str(stream),
            FAKE_LCOV=str(FIXTURES / "python" / "xmlrunner" / "lcov.info"),
            FAKE_EXIT="0")
        self.assert_coverage_stored("python/xmlrunner", agent, result)
        self.assertEqual(self.stored_run(agent, result).get("codec"), "crucible-events",
                         "a unittest run's coverage travels with its stream close")

    def test_the_pytest_fixtures_lcov_filed_by_regression_coverage_under_pytest_stores_its_expected_coverage(self):
        agent = "real-pytest-coverage-through-client"
        result = self.drive(
            PYTHON_CLIENT,
            self.argv("regression", agent, "--coverage", "--runner", "pytest"),
            FAKE_REPORTS=self.green_report("TEST-pytest.xml", GREEN_PYTEST_JUNIT),
            FAKE_LCOV=str(FIXTURES / "python" / "pytest" / "lcov.info"),
            FAKE_EXIT="0")
        self.assert_coverage_stored("python/pytest", agent, result)


def _cases(tree):
    """Every case of a stored or frozen tree as `(suite, case, status)`,
    sorted: the comparison by `(suite, case)` a run whose reports are read in
    another order than the frozen parse read them still passes."""
    return sorted((suite.get("name"), case.get("name"), case.get("status"))
                  for suite in tree or [] for case in suite.get("children") or [])


class MavenFixtureFiledThroughTheMavenClientEndToEndTest(_FiledThroughTheClient):
    """The mvn fixture's five reports, written by a fake `mvnw` where the
    client tells surefire and failsafe to write them, filed by `regression`."""

    client_label = "mvn-crucible.py"

    def setUp(self):
        super().setUp()
        _write_executable(os.path.join(self.project, "mvnw"), _FAKE_MVNW)
        self.bin_dir = os.path.join(self.scratch, "bin")
        os.makedirs(self.bin_dir)
        _write_executable(os.path.join(self.bin_dir, "docker"),
                          "import sys\nsys.exit(0)\n")

    def env(self, **fake):
        env = super().env(**fake)
        for key in _MVN_SCRUBBED:
            env.pop(key, None)
        env["PATH"] = self.bin_dir + os.pathsep + env.get("PATH", "")
        return env

    def argv(self, verb, agent, *extra):
        return [verb, "--agent", agent, "--project-dir", self.project, *extra]

    @staticmethod
    def fixture_reports(plugin):
        return os.pathsep.join(
            str(FIXTURES / "mvn" / name) for name in _expected("mvn")["reports"]
            if f"/target/{plugin}-reports/" in name)

    def test_the_mvn_fixture_filed_by_regression_stores_its_expected_counts_and_statuses(self):
        agent = "real-mvn-through-client"
        expected = _expected("mvn")["client"]
        result = self.drive(MVN_CLIENT, self.argv("regression", agent),
                            FAKE_SUREFIRE=self.fixture_reports("surefire"),
                            FAKE_FAILSAFE=self.fixture_reports("failsafe"),
                            FAKE_EXIT="1")
        event = self.stored_run(agent, result)
        where = f"event={json.dumps(event)[:3000]} {self.diagnostics(result)}"
        self.assertEqual(event.get("codec"), "junit",
                         f"the board decoded the reports the client sent; {where}")
        self.assertEqual(_counts(event.get("summary")), _counts(expected["summary"]),
                         f"the stored counts are the fixture's; {where}")
        self.assertEqual(_cases(event.get("tree")), _cases(expected["tree"]),
                         f"every case is stored with the fixture's status, by "
                         f"(suite, case); {where}")
        envelope = _envelope(result.stdout) or {}
        self.assertEqual(_counts(envelope.get("run")), _counts(event.get("summary")),
                         f"the envelope's run: counts are the stored ones; {where}")
        self.assertEqual((envelope.get("run") or {}).get("files"), expected["files"],
                         f"the envelope's run.files is the answer's, the "
                         f"fixture's {expected['files']}; {where}")
        self.assertEqual(expected["files"], 5, "fixture sanity")
        self.assertNotEqual(result.returncode, 0,
                            f"a run with failures is not green; {where}")

    def test_the_mvn_fixtures_csvs_filed_by_regression_coverage_store_its_expected_coverage(self):
        agent = "real-mvn-coverage-through-client"
        green = Path(self.scratch, "green", "TEST-com.acme.GreenTest.xml")
        green.parent.mkdir(parents=True)
        green.write_text(GREEN_SUREFIRE_JUNIT, encoding="utf-8")
        csvs = _expected("mvn")["coverage"]["reports"]
        self.assertEqual(len(csvs), 2, "fixture sanity: the two modules' CSVs")
        result = self.drive(MVN_CLIENT, self.argv("regression", agent, "--coverage"),
                            FAKE_SUREFIRE=str(green),
                            FAKE_JACOCO_ROOT=str(FIXTURES / "mvn"),
                            FAKE_JACOCO=os.pathsep.join(csvs),
                            FAKE_EXIT="0")
        self.assert_coverage_stored("mvn", agent, result)
        event = self.stored_run(agent, result)
        self.assertEqual(event.get("codec"), "junit",
                         f"the board decoded the report and the CSVs the client "
                         f"sent; event={json.dumps(event)[:3000]} "
                         f"{self.diagnostics(result)}")


class RustFixtureFiledThroughTheRustClientEndToEndTest(_FiledThroughTheClient):
    """The rust fixture's nextest report, written by a fake `cargo` where
    nextest writes it, filed by `test --crate c`; its lcov, filed beside a
    passing report by `regression-ingest`."""

    client_label = "rust-crucible.py"

    def setUp(self):
        super().setUp()
        self.bin_dir = os.path.join(self.scratch, "bin")
        os.makedirs(self.bin_dir)
        _write_executable(os.path.join(self.bin_dir, "cargo"), _FAKE_CARGO)

    def env(self, **fake):
        env = super().env(**fake)
        for key in _RUST_SCRUBBED:
            env.pop(key, None)
        env["PATH"] = self.bin_dir + os.pathsep + env.get("PATH", "")
        return env

    def argv(self, verb, agent, *extra):
        return [verb, "--agent", agent, "--project-dir", self.project, *extra]

    def test_the_rust_fixture_filed_by_test_stores_its_expected_counts_and_statuses(self):
        agent = "real-rust-through-client"
        expected = _expected("rust")["client"]
        result = self.drive(RUST_CLIENT, self.argv("test", agent, "--crate", "c"),
                            FAKE_JUNIT=str(FIXTURES / "rust" / "junit.xml"),
                            FAKE_EXIT="100")
        event = self.stored_run(agent, result)
        where = f"event={json.dumps(event)[:3000]} {self.diagnostics(result)}"
        self.assertEqual(event.get("codec"), "junit",
                         f"the board decoded the report the client sent; {where}")
        self.assertEqual(_counts(event.get("summary")), _counts(expected["summary"]),
                         f"the stored counts are the fixture's; {where}")
        self.assertEqual(_counts(event.get("summary")),
                         {"total": 7, "passed": 5, "failed": 2, "pending": 0},
                         f"fixture sanity; {where}")
        self.assertEqual(_cases(event.get("tree")), _cases(expected["tree"]),
                         f"every case is stored with the fixture's status, by "
                         f"(suite, case); {where}")
        envelope = _envelope(result.stdout) or {}
        self.assertEqual(_counts(envelope.get("run")), _counts(event.get("summary")),
                         f"the envelope's run: counts are the stored ones; {where}")
        self.assertEqual((envelope.get("run") or {}).get("files"), expected["files"],
                         f"the envelope's run.files is the answer's, the "
                         f"fixture's {expected['files']}; {where}")
        self.assertEqual(expected["files"], 3, "fixture sanity")
        self.assertNotEqual(result.returncode, 0,
                            f"a run with failures is not green; {where}")

    def test_the_rust_fixtures_lcov_filed_by_regression_ingest_stores_its_expected_coverage(self):
        agent = "real-rust-coverage-through-client"
        green = Path(self.scratch, "green", "junit.xml")
        green.parent.mkdir(parents=True)
        green.write_text(GREEN_NEXTEST_JUNIT, encoding="utf-8")
        self.assertEqual(_expected("rust")["coverage"]["reports"], ["lcov.info"],
                         "fixture sanity: the one lcov report")
        result = self.drive(RUST_CLIENT,
                            self.argv("regression-ingest", agent, "--crates", "c"),
                            FAKE_JUNIT=str(green),
                            FAKE_LCOV=str(FIXTURES / "rust" / "lcov.info"),
                            FAKE_EXIT="0")
        self.assert_coverage_stored("rust", agent, result)
        event = self.stored_run(agent, result)
        self.assertEqual(event.get("codec"), "junit",
                         f"the board decoded the report and the lcov the client "
                         f"sent; event={json.dumps(event)[:3000]} "
                         f"{self.diagnostics(result)}")


ARDUINO_CLIENT = CLIENTS_DIR / "arduino-crucible.py"
_ARDUINO_SCRUBBED = ("ARDUINO_CRUCIBLE_PROJECT_DIR", "AGENT_ID", "TESTS",
                     "TEST_NAME")

# A passing native-harness report: the run the board keeps a coverage report
# on.
GREEN_NATIVE_JUNIT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuites>\n'
    '  <testsuite name="test_green" tests="1" failures="0" skipped="0" '
    'time="0.000010">\n'
    '    <testcase name="test_passes" classname="test_green" '
    'file="test/test_green.cpp" line="12" time="0.000010"/>\n'
    '  </testsuite>\n'
    '</testsuites>\n')

# A `make` stand-in, faithful to the native harness's make contract: whatever
# the target, it prints a Unity verdict line, copies each of FAKE_REPORTS (an
# os.pathsep-joined list) into REPORTS_DIR (else `reports/` under its cwd)
# under its own name and, when COVERAGE_DIR is set and FAKE_LCOV given,
# FAKE_LCOV to `<COVERAGE_DIR>/lcov.info`; then it exits FAKE_EXIT.
_FAKE_MAKE = r'''
import os
import shutil
import sys

reports = os.environ.get("REPORTS_DIR") or "reports"
os.makedirs(reports, exist_ok=True)
for src in os.environ["FAKE_REPORTS"].split(os.pathsep):
    shutil.copyfile(src, os.path.join(reports, os.path.basename(src)))
coverage = os.environ.get("COVERAGE_DIR")
if coverage and os.environ.get("FAKE_LCOV"):
    os.makedirs(coverage, exist_ok=True)
    shutil.copyfile(os.environ["FAKE_LCOV"], os.path.join(coverage, "lcov.info"))
sys.stdout.write("test/test_green.cpp:12:test_passes:PASS\n")
sys.stdout.flush()
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''


class ArduinoFixtureFiledThroughTheArduinoClientEndToEndTest(_FiledThroughTheClient):
    """The arduino fixture's three native-harness reports, copied by a fake
    `make` into the run's own reports directory, filed by `unit`; its lcov,
    filed beside a passing report by `regression --coverage`."""

    client_label = "arduino-crucible.py"

    def setUp(self):
        super().setUp()
        os.makedirs(os.path.join(self.project, "tests", "native"))
        self.bin_dir = os.path.join(self.scratch, "bin")
        os.makedirs(self.bin_dir)
        _write_executable(os.path.join(self.bin_dir, "make"), _FAKE_MAKE)

    def env(self, **fake):
        env = super().env(**fake)
        for key in _ARDUINO_SCRUBBED:
            env.pop(key, None)
        env["PATH"] = self.bin_dir + os.pathsep + env.get("PATH", "")
        return env

    def argv(self, verb, agent, *extra):
        return [verb, "--agent", agent, "--project-dir", self.project,
                "--reports", "reports", *extra]

    def test_the_arduino_fixture_filed_by_unit_stores_its_expected_counts_and_statuses(self):
        agent = "real-arduino-through-client"
        expected = _expected("arduino")
        reports = [str(FIXTURES / "arduino" / name) for name in expected["reports"]]
        self.assertEqual(len(reports), 3, "fixture sanity: the three reports")
        result = self.drive(ARDUINO_CLIENT, self.argv("unit", agent),
                            FAKE_REPORTS=os.pathsep.join(reports), FAKE_EXIT="0")
        event = self.stored_run(agent, result)
        where = f"event={json.dumps(event)[:3000]} {self.diagnostics(result)}"
        self.assertEqual(event.get("codec"), "junit",
                         f"the board decoded the reports the client sent; {where}")
        self.assertEqual(_counts(event.get("summary")),
                         {"total": 13, "passed": 8, "failed": 2, "pending": 3},
                         f"the stored counts are the fixture's; {where}")
        self.assertEqual(_counts(event.get("summary")),
                         _counts(expected["client"]["summary"]),
                         f"the stored counts are expected.json's; {where}")
        self.assertEqual(_cases(event.get("tree")), _cases(expected["client"]["tree"]),
                         f"every case is stored with the fixture's status, by "
                         f"(suite, case); {where}")
        envelope = _envelope(result.stdout) or {}
        self.assertEqual(_counts(envelope.get("run")), _counts(event.get("summary")),
                         f"the envelope's run: counts are the stored ones; {where}")
        self.assertEqual(expected["client"]["files"], 3,
                         "fixture sanity: the client summed 3 sources per report")
        self.assertEqual((envelope.get("run") or {}).get("files"), 2,
                         f"the envelope's run.files is the answer's 2 (the esp32 "
                         f"and uno reports share a source), not the per-report "
                         f"sum of 3; {where}")
        self.assertEqual(result.returncode, 1,
                         f"make exited 0, and the board's failure count makes "
                         f"the verb exit 1; {where}")

    def test_the_arduino_fixtures_lcov_filed_by_regression_coverage_stores_its_expected_coverage(self):
        agent = "real-arduino-coverage-through-client"
        green = Path(self.scratch, "green", "TEST-test_green.xml")
        green.parent.mkdir(parents=True)
        green.write_text(GREEN_NATIVE_JUNIT, encoding="utf-8")
        self.assertEqual(_expected("arduino")["coverage"]["reports"], ["lcov.info"],
                         "fixture sanity: the one lcov report")
        result = self.drive(ARDUINO_CLIENT,
                            self.argv("regression", agent, "--coverage"),
                            FAKE_REPORTS=str(green),
                            FAKE_LCOV=str(FIXTURES / "arduino" / "lcov.info"),
                            FAKE_EXIT="0")
        self.assert_coverage_stored("arduino", agent, result)
        event = self.stored_run(agent, result)
        self.assertEqual(event.get("codec"), "junit",
                         f"the board decoded the report and the lcov the client "
                         f"sent; event={json.dumps(event)[:3000]} "
                         f"{self.diagnostics(result)}")


if __name__ == "__main__":
    unittest.main()
