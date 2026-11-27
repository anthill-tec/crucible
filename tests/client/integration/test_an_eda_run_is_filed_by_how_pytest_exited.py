"""An eda run is filed by how its pytest exited, on a tier verb and on
`regression` alike, and its verdict says whether it was filed with counts.

Every run drives the REAL `clients/eda-crucible.py` as an OS subprocess on a
scratch copy of `tests/fixtures/eda-project`, in a recording interpreter that
hands each call to this suite's own interpreter (which has pytest), filing to
a REAL throwaway board (`tests/client/real_board.py`) behind a recording
proxy, which also lets one case refuse a filing. Each copy is made to give
pytest one way out, and that copy is driven once by a tier verb and once by
`regression`:

- a module that cannot be imported (exit 2): the JUnit is filed, the error
  one failed test, verdict `fail`;
- a node id that names no test and a `conftest.py` that cannot load (exit
  4), and a collection hook that raises (exit 3): ONE compile record carrying
  pytest's own error line closes the opened run, no test is filed, verdict
  `fail`;
- an entry with nothing to collect (exit 5): the opened run is aborted as
  having run nothing (`no-test-reports`), verdict `fail`;
- a SIGTERM to the client mid-run: the run is aborted, stdout is one
  envelope, and no later entry runs;
- a run whose filing the board refuses is a `fail`, though every test it ran
  was skipped.

A missing `bun` FAILS every test here, naming it.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_an_eda_run_is_filed_by_how_pytest_exited
"""

import json
import os
import shutil
import signal
import time
import unittest
from pathlib import Path

from tests.client.eda_project_harness import (
    TIMEOUT,
    EdaProject,
    RecordingInterpreter,
    diagnostics,
    envelope,
    is_pytest_argv,
    scratch,
)
from tests.client.pytest_project_harness import sent_cases
from tests.client.real_board import RealBoard

_MODULE = {}

RUN_START = "/api/v2/runs/start"
RUN_INGEST = "/api/v2/runs"
RUN_COMPILE = "/api/v2/runs/compile"
NO_TEST_REPORTS = "no-test-reports"

BROKEN_IMPORT_MODULE = "a_module_no_interpreter_has_7ab3"
_BROKEN_IMPORT_CHECK = f'''"""A gate module that cannot be imported."""

import {BROKEN_IMPORT_MODULE}


def test_never_collected():
    assert {BROKEN_IMPORT_MODULE}
'''

MISSING_GATE = "test_there_is_no_such_gate_e2c8"
MISSING_NODE_ENTRY = (f'[targets."module"]\nframework = "eda-pytest"\n'
                      f'paths = ["tests/unit/check_board.py::{MISSING_GATE}"]\n')

BROKEN_CONFTEST_MODULE = "a_conftest_dependency_nobody_has_5c19"
_BROKEN_CONFTEST = f'''"""A conftest that cannot be loaded."""

import {BROKEN_CONFTEST_MODULE}
'''

INTERNAL_ERROR_MARKER = "planted internal error 9d41"
_RAISING_HOOK = f'''

def pytest_collection_modifyitems(items):
    raise RuntimeError({INTERNAL_ERROR_MARKER!r})
'''

EMPTY_ENTRY = '[targets."bdd"]\nframework = "eda-pytest"\npaths = ["tests/empty"]\n'

# A gate that says it has started (a file beside the copy's root) and then
# holds the run open until released, so a signal lands mid-run.
_HOLDING_CHECK = '''"""A gate that holds the run open until released."""

import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_it_holds_the_run_open():
    (ROOT / "held-started").write_text("started")
    deadline = time.monotonic() + 60
    while not (ROOT / "held-release").exists() and time.monotonic() < deadline:
        time.sleep(0.05)
'''
HOLDING_ENTRIES = (
    '[targets."integration/a"]\nframework = "eda-pytest"\npaths = ["tests/hold"]\n\n'
    '[targets."integration/b"]\nframework = "eda-pytest"\npaths = ["tests/integ"]\n')

REFUSED_FILING = {"ok": False, "error": "the test board refuses this filing"}


def setUpModule():
    bun = shutil.which("bun")
    if bun is None:
        _MODULE["gap"] = "bun is not on PATH: these runs file to a real board"
        return
    _MODULE["board"] = RealBoard(bun, "eda-exit-paths", proxy=True)


def tearDownModule():
    board = _MODULE.pop("board", None)
    if board is not None:
        board.close()


class Exit:
    """One client run: its exit, its stdout and stderr, what it sent the
    board, and which pytest calls the interpreter took."""

    def __init__(self, returncode, stdout, stderr, records, calls, reached=True):
        self.reached = reached
        self.returncode = returncode
        self.stdout = stdout or ""
        self.stderr = stderr or ""
        self.axi = envelope(self.stdout)
        self.records = records
        self.pytest_calls = [c for c in calls if is_pytest_argv(c["argv"])]

    def posted(self, path):
        return [r for r in self.records
                if r.get("method") == "POST" and r.get("path") == path]

    def aborts(self):
        return [r.get("path") for r in self.records
                if r.get("method") == "POST" and str(r.get("path")).startswith("/api/v2/runs/")
                and str(r.get("path")).endswith("/abort")]

    def opened(self):
        return [(r.get("answer") or {}).get("runId") for r in self.posted(RUN_START)]

    def envelope_lines(self):
        return [line for line in self.stdout.splitlines() if line.startswith("axi:")]

    def warnings_coded(self, code):
        return [w for w in (self.axi or {}).get("warnings") or []
                if isinstance(w, dict) and w.get("code") == code]

    def diag(self):
        return (f"exit={self.returncode} stdout={self.stdout[-2000:]!r} "
                f"stderr={self.stderr[-3000:]!r}")


class _OneCopyPerExit(unittest.TestCase):
    """One scratch copy and one recording interpreter per class, on the
    module's real board; the copy is driven once by `TIER_VERB` and once by
    `regression`."""

    maxDiff = 8000
    TIER_VERB = "unit"
    TIER_KEY = "unit"

    @classmethod
    def setUpClass(cls):
        cls.gap = _MODULE.get("gap")
        if cls.gap:
            return
        cls.board = _MODULE["board"]
        cls.project = EdaProject(cls, board=cls.board, project_key=cls.board.key)
        cls.python = RecordingInterpreter(
            Path(scratch(cls, "eda-exit-python-"), "bin", "python"))
        cls.prepare()
        cls.exits = {"tier": cls.drive(cls.TIER_VERB, f"eda-exit-{cls.__name__}-tier"),
                     "regression": cls.drive("regression",
                                             f"eda-exit-{cls.__name__}-regression")}

    @classmethod
    def prepare(cls):
        """Shape this class's copy so pytest exits its way."""

    @classmethod
    def register(cls, agent):
        registered = cls.project.drive("register", "--role", "report", agent=agent)
        if registered.returncode != 0:
            raise RuntimeError(f"register {agent}: {diagnostics(registered)}")

    @classmethod
    def drive(cls, verb, agent):
        cls.register(agent)
        mark = cls.board.proxy.count()
        before = len(cls.python.calls())
        result = cls.project.drive(verb, agent=agent, python=cls.python.path)
        return Exit(result.returncode, result.stdout, result.stderr,
                    cls.board.proxy.since(mark), cls.python.calls()[before:])

    def setUp(self):
        if self.gap:
            self.fail(f"missing toolchain: {self.gap}")

    def each_exit(self):
        """`(verb, exit)` for the tier verb's run and regression's."""
        return [(self.TIER_VERB, self.exits["tier"]), ("regression", self.exits["regression"])]

    def the_envelope(self, run):
        if run.axi is None:
            self.fail(f"stdout must be one AXI envelope; {run.diag()}")
        return run.axi

    def assert_verdict_fail(self):
        for verb, run in self.each_exit():
            with self.subTest(verb=verb):
                axi = self.the_envelope(run)
                self.assertEqual(axi.get("verdict"), "fail", run.diag())
                self.assertNotEqual(run.returncode, 0, run.diag())
        tier = self.exits["tier"]
        self.assertEqual(tier.returncode, 1, f"a tier verb exits 1 on fail; {tier.diag()}")
        self.assertEqual(
            [(e.get("key"), e.get("verdict")) for e in self.the_envelope(tier).get("entries") or []],
            [(self.TIER_KEY, "fail")], tier.diag())


class ACollectionErrorIsFiledAsAFailedTestTest(_OneCopyPerExit):
    """A gate module that cannot be imported, beside `tests/unit`'s gates:
    pytest exits 2."""

    @classmethod
    def prepare(cls):
        cls.project.write("tests/unit/check_broken_import.py", _BROKEN_IMPORT_CHECK)

    def test_the_junit_is_filed_with_the_error_as_a_failed_test(self):
        for verb, run in self.each_exit():
            with self.subTest(verb=verb):
                self.assertEqual(len(run.pytest_calls), 1, run.diag())
                ingests = run.posted(RUN_INGEST)
                self.assertEqual(len(ingests), 1, f"one filing; {run.diag()}")
                cases = sent_cases(ingests[0].get("body"))
                broken = [c for c in cases if "check_broken_import" in str(c[0])]
                self.assertEqual([status for _g, _n, status, _f in broken], ["fail"],
                                 f"the collection error is one failed test; {cases!r}")
                self.assertEqual(run.posted(RUN_COMPILE), [],
                                 f"no compile record; {run.diag()}")

    def test_the_verdict_is_fail(self):
        self.assert_verdict_fail()


class _ARunnerFailure(_OneCopyPerExit):
    """pytest failed as a runner (exit 3 or 4): one compile record carrying
    pytest's own error line closes the opened run, and no test is filed."""

    CARRIED = ""

    def test_one_compile_record_carries_pytests_error_line_and_no_test_is_filed(self):
        for verb, run in self.each_exit():
            with self.subTest(verb=verb):
                self.assertEqual(len(run.pytest_calls), 1, run.diag())
                opened = run.opened()
                self.assertEqual(len(opened), 1, f"one run is opened; {run.diag()}")
                records = run.posted(RUN_COMPILE)
                self.assertEqual(len(records), 1, f"one compile record; {run.diag()}")
                body = records[0].get("body") or {}
                self.assertIn(self.CARRIED, str(body.get("errors") or ""),
                              f"the record carries pytest's error line; record={body!r}")
                self.assertEqual(body.get("runId"), opened[0],
                                 f"the record closes the opened run; record={body!r}")
                self.assertEqual(run.posted(RUN_INGEST), [],
                                 f"a runner failure files no test; {run.diag()}")

    def test_the_verdict_is_fail(self):
        self.assert_verdict_fail()


class AMissingNodeIdIsARunnerFailureTest(_ARunnerFailure):
    """A `module` entry naming a gate its file does not hold: pytest exits 4
    with `ERROR: not found:`; regression passes the same node id."""

    TIER_VERB = "module"
    TIER_KEY = "module"
    # pytest's error line: `ERROR: not found: <path>::<gate>`.
    CARRIED = MISSING_GATE

    @classmethod
    def prepare(cls):
        cls.project.declare(MISSING_NODE_ENTRY)


class ABrokenConftestIsARunnerFailureTest(_ARunnerFailure):
    """A `tests/unit/conftest.py` that cannot be imported: pytest exits 4."""

    # pytest's error line: `ImportError while loading conftest '<path>'.`
    CARRIED = "while loading conftest"

    @classmethod
    def prepare(cls):
        cls.project.write("tests/unit/conftest.py", _BROKEN_CONFTEST)


class AnInternalErrorIsARunnerFailureTest(_ARunnerFailure):
    """A collection hook that raises: pytest prints `INTERNALERROR>` and
    exits 3."""

    # pytest's error lines each start `INTERNALERROR>`.
    CARRIED = "INTERNALERROR"

    @classmethod
    def prepare(cls):
        with open(cls.project.path("conftest.py"), "a", encoding="utf-8") as handle:
            handle.write(_RAISING_HOOK)


class AnEmptyEntryRanNothingTest(_OneCopyPerExit):
    """A copy whose only entry is `bdd` over a directory with no gate:
    pytest collects nothing and exits 5."""

    TIER_VERB = "bdd"
    TIER_KEY = "bdd"

    @classmethod
    def prepare(cls):
        cls.project.declare_only_the_board()
        cls.project.write("tests/empty/README.txt", "No gate lives here yet.\n")
        cls.project.declare(EMPTY_ENTRY)

    def test_the_opened_run_is_aborted_as_having_run_nothing(self):
        for verb, run in self.each_exit():
            with self.subTest(verb=verb):
                self.assertEqual(len(run.pytest_calls), 1, run.diag())
                opened = run.opened()
                self.assertEqual(len(opened), 1, f"one run is opened; {run.diag()}")
                self.assertEqual(run.aborts(), [f"/api/v2/runs/{opened[0]}/abort"],
                                 f"the opened run is aborted, once; {run.diag()}")
                self.the_envelope(run)
                self.assertEqual(len(run.warnings_coded(NO_TEST_REPORTS)), 1, run.diag())
                self.assertEqual(run.posted(RUN_INGEST), [], run.diag())
                self.assertEqual(run.posted(RUN_COMPILE), [], run.diag())

    def test_the_verdict_is_fail(self):
        self.assert_verdict_fail()


def _wait_for(path, proc, timeout):
    """Whether `path` appears within `timeout` while `proc` still runs."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if os.path.exists(path):
            return True
        if proc.poll() is not None:
            return False
        time.sleep(0.05)
    return False


class ASigtermLeavesTheRunAbortedTest(unittest.TestCase):
    """`integration` over `integration/a` (a gate that holds the run open)
    and `integration/b`, and `regression` over both: a SIGTERM to the client
    while the holding gate runs."""

    maxDiff = 8000

    @classmethod
    def setUpClass(cls):
        cls.gap = _MODULE.get("gap")
        if cls.gap:
            return
        cls.board = _MODULE["board"]
        cls.project = EdaProject(cls, board=cls.board, project_key=cls.board.key)
        cls.python = RecordingInterpreter(
            Path(scratch(cls, "eda-sigterm-python-"), "bin", "python"))
        cls.project.declare_only_the_board()
        cls.project.write("tests/hold/check_hold.py", _HOLDING_CHECK)
        cls.project.declare(HOLDING_ENTRIES)
        cls.exits = {"integration": cls.signalled("integration", "eda-sigterm-tier"),
                     "regression": cls.signalled("regression", "eda-sigterm-regression")}

    @classmethod
    def signalled(cls, verb, agent):
        registered = cls.project.drive("register", "--role", "report", agent=agent)
        if registered.returncode != 0:
            raise RuntimeError(f"register {agent}: {diagnostics(registered)}")
        started = cls.project.path("held-started")
        release = cls.project.path("held-release")
        for path in (started, release):
            if os.path.exists(path):
                os.remove(path)
        mark = cls.board.proxy.count()
        before = len(cls.python.calls())
        proc = cls.project.spawn(verb, python=cls.python.path, agent=agent)
        try:
            reached = _wait_for(started, proc, 60)
            if reached:
                proc.send_signal(signal.SIGTERM)
            stdout, stderr = proc.communicate(timeout=TIMEOUT)
        finally:
            Path(release).write_text("go", encoding="utf-8")
            if proc.poll() is None:
                proc.kill()
                proc.communicate()
        return Exit(proc.returncode, stdout, stderr, cls.board.proxy.since(mark),
                    cls.python.calls()[before:], reached=reached)

    def setUp(self):
        if self.gap:
            self.fail(f"missing toolchain: {self.gap}")

    def each_exit(self):
        return list(self.exits.items())

    def test_the_client_exits_on_the_signal_with_one_envelope(self):
        for verb, run in self.each_exit():
            with self.subTest(verb=verb):
                self.assertTrue(run.reached, f"the holding gate started; {run.diag()}")
                self.assertEqual(run.returncode, 128 + signal.SIGTERM, run.diag())
                self.assertEqual(len(run.envelope_lines()), 1, f"one envelope; {run.diag()}")
                axi = run.axi or {}
                self.assertIs(axi.get("ok"), False, run.diag())
                self.assertEqual(axi.get("signal"), "SIGTERM", run.diag())

    def test_the_opened_run_is_aborted_and_no_later_entry_runs(self):
        for verb, run in self.each_exit():
            with self.subTest(verb=verb):
                self.assertTrue(run.reached, f"the holding gate started; {run.diag()}")
                opened = run.opened()
                self.assertEqual(len(opened), 1, f"one run is opened, no later one; {run.diag()}")
                self.assertEqual(run.aborts(), [f"/api/v2/runs/{opened[0]}/abort"], run.diag())
                self.assertEqual(len(run.pytest_calls), 1,
                                 f"no pytest runs after the signal; {run.diag()}")
                self.assertEqual(run.posted(RUN_INGEST), [], run.diag())
                self.assertEqual(run.posted(RUN_COMPILE), [], run.diag())

    def test_the_aborted_runs_verdict_is_fail(self):
        for verb, run in self.each_exit():
            with self.subTest(verb=verb):
                self.assertEqual((run.axi or {}).get("verdict"), "fail", run.diag())


class ARefusedFilingIsAFailTest(unittest.TestCase):
    """`e2e` (every test skipped, a `skip` when filed) on a board that
    refuses the filing."""

    maxDiff = 8000
    AGENT = "eda-refused-filing"

    @classmethod
    def setUpClass(cls):
        cls.gap = _MODULE.get("gap")
        if cls.gap:
            return
        cls.board = _MODULE["board"]
        cls.project = EdaProject(cls, board=cls.board, project_key=cls.board.key)
        cls.python = RecordingInterpreter(
            Path(scratch(cls, "eda-refused-python-"), "bin", "python"))
        registered = cls.project.drive("register", "--role", "report", agent=cls.AGENT)
        if registered.returncode != 0:
            raise RuntimeError(f"register {cls.AGENT}: {diagnostics(registered)}")
        proxy = cls.board.proxy
        refusal = json.dumps(REFUSED_FILING).encode()
        proxy.intercept = (lambda method, path, _body: (409, refusal)
                           if method == "POST" and path == RUN_INGEST else None)
        try:
            mark = proxy.count()
            result = cls.project.drive("e2e", agent=cls.AGENT, python=cls.python.path)
        finally:
            proxy.intercept = None
        cls.refused = Exit(result.returncode, result.stdout, result.stderr,
                       proxy.since(mark), cls.python.calls())

    def setUp(self):
        if self.gap:
            self.fail(f"missing toolchain: {self.gap}")

    def test_the_filing_was_tried_and_refused(self):
        self.assertEqual(len(self.refused.posted(RUN_INGEST)), 1, self.refused.diag())
        self.assertEqual(len(self.refused.pytest_calls), 1, self.refused.diag())

    def test_an_unfiled_run_is_a_fail(self):
        axi = self.refused.axi
        if axi is None:
            self.fail(f"stdout must be one AXI envelope; {self.refused.diag()}")
        self.assertEqual(axi.get("verdict"), "fail", self.refused.diag())
        self.assertEqual([(e.get("key"), e.get("verdict")) for e in axi.get("entries") or []],
                         [("e2e", "fail")], self.refused.diag())
        self.assertEqual(self.refused.returncode, 1, self.refused.diag())


# The shared bases drive no run of their own: out of the module's namespace,
# so unittest's loader collects only the concrete classes above.
del _OneCopyPerExit, _ARunnerFailure

if __name__ == "__main__":
    unittest.main()
