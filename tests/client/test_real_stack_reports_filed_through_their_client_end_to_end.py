"""A real stack report, filed through its own client, is stored as the board
decodes it — end to end, against a REAL ephemeral board.

CR-CRU-152 froze one real run per stack under `tests/fixtures/reports/<stack>/`
with its client's parse beside it (`expected.json`).
`tests/real-stack-reports-decode-on-the-board.test.ts` proves the board's
decode of those reports by POSTing them itself. This suite proves the same
figures through the CLIENT VERB: `bun-crucible.py test` and
`python-crucible.py test` (unittest and pytest) run a faithful fake runner
that writes the fixture's own report bytes where the client tells it to (and,
for bun, prints the fixture's captured console as its output), exits non-zero
as the fixture's run did, and the client sends what it found to the board
(`ingest_reports`, clients/_crucible_axi.py). The stored run is then read back
over the board's own `GET /api/v2/events/<id>`.

  - the stored `total`, `passed`, `failed` and `pending`, and every case's
    status in order, equal the fixture's `expected.json`;
  - the stored codec is `junit` (the board decoded the report; nothing was
    filed pre-parsed);
  - the envelope's `run:` counts equal the stored ones (the client's figures
    are the board's).

The fixtures are failing runs, whose coverage the board discards, so the
coverage object is proven on a PASSING report filed beside each fixture's own
lcov through the coverage-measuring verb (`regression --coverage`): the stored
coverage object equals the fixture's `expected.json` coverage.

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
GREEN_XMLRUNNER_JUNIT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuite name="test_green.GreenTest-20261027165127" tests="1" '
    'file="tests/test_green.py" errors="0" failures="0" skipped="0" '
    'time="0.001"><testcase classname="test_green.GreenTest" '
    'name="test_passes" time="0.001" file="tests/test_green.py" '
    'line="5"/></testsuite>\n')
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
# there; a suite run -- the subtest runner (`... -o <dir> -v`) or `-m pytest
# ... --junitxml=<file>`, bare or under `-m coverage run` -- copies every
# FAKE_REPORTS file into the reports dir (xmlrunner: one file per class, by
# its own name) or the first to the `--junitxml` path (pytest), prints
# FAKE_OUTPUT, and exits FAKE_EXIT.
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
    out_dir = argv[len(argv) - 1 - argv[::-1].index("-o") + 1]
    for src in reports:
        place(src, os.path.join(out_dir, os.path.basename(src)))
sys.stdout.write(os.environ.get("FAKE_OUTPUT", "fake python ran") + "\n")
sys.stdout.flush()
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

    def assert_fixture_stored(self, fixture_dir, agent, result):
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

    def test_the_xmlrunner_fixture_filed_by_python_test_stores_its_expected_counts_and_statuses(self):
        agent = "real-xmlrunner-through-client"
        result = self.drive(PYTHON_CLIENT, self.argv("test", agent),
                            FAKE_REPORTS=self.fixture_reports("python/xmlrunner"),
                            FAKE_EXIT="1")
        self.assert_fixture_stored("python/xmlrunner", agent, result)

    def test_the_pytest_fixture_filed_by_python_test_under_pytest_stores_its_expected_counts_and_statuses(self):
        agent = "real-pytest-through-client"
        result = self.drive(PYTHON_CLIENT,
                            self.argv("test", agent, "--runner", "pytest"),
                            FAKE_REPORTS=self.fixture_reports("python/pytest"),
                            FAKE_EXIT="1")
        self.assert_fixture_stored("python/pytest", agent, result)

    def test_the_xmlrunner_fixtures_lcov_filed_by_regression_coverage_stores_its_expected_coverage(self):
        agent = "real-xmlrunner-coverage-through-client"
        result = self.drive(
            PYTHON_CLIENT, self.argv("regression", agent, "--coverage"),
            FAKE_REPORTS=self.green_report("TEST-test_green.GreenTest-20261027165127.xml",
                                           GREEN_XMLRUNNER_JUNIT),
            FAKE_LCOV=str(FIXTURES / "python" / "xmlrunner" / "lcov.info"),
            FAKE_EXIT="0")
        self.assert_coverage_stored("python/xmlrunner", agent, result)

    def test_the_pytest_fixtures_lcov_filed_by_regression_coverage_under_pytest_stores_its_expected_coverage(self):
        agent = "real-pytest-coverage-through-client"
        result = self.drive(
            PYTHON_CLIENT,
            self.argv("regression", agent, "--coverage", "--runner", "pytest"),
            FAKE_REPORTS=self.green_report("TEST-pytest.xml", GREEN_PYTEST_JUNIT),
            FAKE_LCOV=str(FIXTURES / "python" / "pytest" / "lcov.info"),
            FAKE_EXIT="0")
        self.assert_coverage_stored("python/pytest", agent, result)


if __name__ == "__main__":
    unittest.main()
