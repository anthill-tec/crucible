"""Report-isolation behaviour for `clients/python-crucible.py`, pinned against
the spec's own language: a run made with `--agent <id>` and no `--reports`
writes, reads and ingests its results under `test-reports/<id>/` in the
project; only that directory is ever cleared before the run; the directory
survives the run; a run without `--agent` keeps today's shared location; an
explicit `--reports <dir>` is honoured verbatim; coverage follows the run into
the same directory; and the `--reports` help text states the per-agent
default.

RED PHASE: `_reports_dir` (`clients/python-crucible.py`) ignores the agent id
entirely today -- `rd = arg_value or DEFAULT_REPORTS` -- so every agent's run
writes into the SAME `test-reports/` no matter who ran it, and `_wipe` clears
whatever is there regardless of who put it there. Every test below drives the
real toolchain (the client's real unittest runner, which writes the run's
Crucible event stream into the reports dir (CR-CRU-224), and real
`coverage.py`) through the CLI and
asserts on the FILESYSTEM PATHS the client actually used and on the payload
the client actually POSTed, never on an assumed internal helper signature --
so a correct fix can land its own shape and still satisfy every assertion
here. The board's HTTP seam (`_post`/`_get`) is mocked throughout; no live
server is ever touched.

Module-loading + mocking convention copied verbatim from the sibling harness
(`test_python_crucible_axi.py`): load `clients/python-crucible.py` by file
path via `importlib`, mock the module's `_post`/`_get` seam.

Invocation:
    python3 -m pytest tests/client/test_python_crucible_agent_report_isolation.py -q
Fallback:
    python3 tests/client/test_python_crucible_agent_report_isolation.py
"""

import importlib.util
import io
import json
import os
import contextlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.live_run_harness import StreamingPost, get_answering_health, junit_sent
from tests.client.test_client_fleet_envelope_census import install_project_limits

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "python-crucible.py"

FIXTURE_PASS_MODULE = """import unittest


class FixtureTest(unittest.TestCase):
    def test_passes(self):
        self.assertTrue(True)
"""

# The stream file a streamed unittest run writes into its reports dir.
STREAM_FILE = "crucible-events.ndjson"


# A hand-written JUnit fixture in the bare `<testsuite>` shape a JUnit writer
# writes -- used to plant "already there before this
# run" files a real run never wrote, so a test can prove whether the client
# read/cleared them without needing a second real subprocess run per case.
def _junit_suite(name, failures, testcase_name):
    fail_child = (
        f'<failure message="planted">planted failure</failure>' if failures else ""
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<testsuite name="{name}" tests="1" failures="{failures}" errors="0">'
        f'<testcase classname="{name}" name="{testcase_name}" time="0.001">'
        f'{fail_child}</testcase></testsuite>'
    )


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module():
    return _load_module(SCRIPT_PATH, "python_crucible_under_test_report_isolation")


def _run_main(module, argv):
    """Invoke `module.main()` with `sys.argv` patched. Returns (code, stdout,
    stderr). Only `SystemExit` is caught; any other exception propagates so
    unittest reports it as an ERROR (still a valid RED signal)."""
    full_argv = ["python-crucible.py"] + argv
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", full_argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                code = 0 if e.code is None else (e.code if isinstance(e.code, int) else 1)
    return code, stdout.getvalue(), stderr.getvalue()


def _post_call_for_path(post_mock, path):
    for call in post_mock.call_args_list:
        args, kwargs = call
        call_path = args[0] if args else kwargs.get("path")
        if call_path == path:
            return call
    return None


def _sent_summary(call):
    """`{total, passed, failed, pending}` over the JUnit report texts one
    `/api/v2/runs` POST carried (`auto-ingest`), read as the board's `junit`
    codec reads them -- the client parses none of them."""
    read = junit_sent(call[0][1]) if call is not None else None
    assert read is not None, f"not a junit ingest: {call!r}"
    return read["summary"]


def _stream_summary(call, post):
    """`{total, passed, failed, pending}` over the stream `post` holds, once
    the `/api/v2/runs` close `call` is checked to be a stream close."""
    assert call is not None and call[0][1].get("codec") == "crucible-events", (
        f"not a stream close: {call!r}")
    return post.summary()


def _stream_file_summary(path):
    """`{total, passed, failed}` over the `test-end` lines of a stream file."""
    statuses = [json.loads(line).get("status")
                for line in Path(path).read_text(encoding="utf-8").splitlines()
                if '"test-end"' in line]
    return {"total": len(statuses), "passed": statuses.count("pass"),
            "failed": statuses.count("fail")}


def _files_under(root):
    """Every file path under `root`, relative to it, sorted -- an empty list
    when `root` does not exist."""
    if not os.path.isdir(root):
        return []
    found = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            found.append(os.path.relpath(os.path.join(dirpath, name), root))
    return sorted(found)


class _BaseIsolationTest(unittest.TestCase):
    PROJECT_KEY = "test-key-python-report-isolation"

    def setUp(self):
        self.module = _load_client_module()
        self.tmpdir = tempfile.mkdtemp(prefix="python-crucible-report-isolation-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        install_project_limits(self.tmpdir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_fixture_pkg(self, pkg_name="agentreportfixturepkg"):
        pkg_dir = os.path.join(self.tmpdir, pkg_name)
        os.makedirs(pkg_dir, exist_ok=True)
        with open(os.path.join(pkg_dir, "__init__.py"), "w") as f:
            f.write("")
        with open(os.path.join(pkg_dir, "test_fixture.py"), "w") as f:
            f.write(FIXTURE_PASS_MODULE)
        return pkg_name

    def _run_test_verb(self, agent=None, reports=None, extra=()):
        pkg = self._write_fixture_pkg()
        argv = ["test", "--project-dir", self.tmpdir, "--python", sys.executable,
                "--tests", f"{pkg}.test_fixture"]
        if agent:
            argv += ["--agent", agent]
        if reports:
            argv += ["--reports", reports]
        argv += list(extra)
        post = StreamingPost()
        os.environ.pop("CRUCIBLE_STREAM", None)
        with mock.patch.object(self.module, "_post", side_effect=post,
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", side_effect=get_answering_health(),
                                create=True):
            code, out, err = _run_main(self.module, argv)
        self.post = post
        return code, out, err, post_mock


class AgentDefaultDirectoryTest(_BaseIsolationTest):
    """AC1/§S1 -- `--agent A`, no `--reports`, ingests from `test-reports/A/`."""

    def test_agent_run_without_reports_flag_writes_and_ingests_from_its_own_directory(self):
        code, _out, err, post_mock = self._run_test_verb(agent="agent-alpha")
        self.assertEqual(code, 0, f"stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-alpha")
        self.assertIn(
            STREAM_FILE, _files_under(own_dir),
            f"expected the run's stream under {own_dir}; found {_files_under(own_dir)!r}",
        )
        shared_root_files = [
            name for name in _files_under(os.path.join(self.tmpdir, "test-reports"))
            if os.sep not in name
        ]
        self.assertEqual(
            shared_root_files, [],
            f"no file may be written directly into the shared test-reports/ "
            f"top level when an agent id is given; found {shared_root_files!r}",
        )

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call, "the real unittest run must be closed")
        assert ingest_call is not None
        summary = _stream_summary(ingest_call, self.post)
        self.assertEqual(summary["passed"], 1)
        self.assertEqual(summary["failed"], 0)


class AgentDirectoryIsolationTest(_BaseIsolationTest):
    """AC1/AC2 -- two agents' directories are never shared, read or cleared."""

    def test_another_agents_preexisting_directory_is_neither_read_nor_cleared(self):
        other_dir = os.path.join(self.tmpdir, "test-reports", "agent-bravo")
        os.makedirs(other_dir, exist_ok=True)
        sentinel_path = os.path.join(other_dir, "TEST-sentinel.xml")
        sentinel_content = _junit_suite("bravo.sentinel", 13, "AGENT_BRAVO_SENTINEL")
        with open(sentinel_path, "w") as f:
            f.write(sentinel_content)

        code, _out, err, post_mock = self._run_test_verb(agent="agent-alpha")
        self.assertEqual(code, 0, f"stderr={err!r}")

        with open(sentinel_path) as f:
            after = f.read()
        self.assertEqual(
            after, sentinel_content,
            "agent-bravo's own directory must survive agent-alpha's run "
            "byte-for-byte -- it must be neither read into alpha's ingest "
            "nor cleared by alpha's wipe",
        )

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        assert ingest_call is not None
        summary = _stream_summary(ingest_call, self.post)
        self.assertEqual(
            summary["failed"], 0,
            f"agent-alpha's ingested summary must reflect ONLY its own real "
            f"run (0 failures), not agent-bravo's 13 planted failures; "
            f"got summary={summary!r}",
        )
        self.assertEqual(summary["total"], 1)

    def test_a_stale_file_in_the_same_agents_own_directory_is_still_wiped_before_the_run(self):
        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-alpha")
        os.makedirs(own_dir, exist_ok=True)
        stale_path = os.path.join(own_dir, "TEST-stale.xml")
        with open(stale_path, "w") as f:
            f.write(_junit_suite("alpha.stale", 42, "STALE_FROM_A_PRIOR_RUN"))
        stale_stream = os.path.join(own_dir, STREAM_FILE)
        with open(stale_stream, "w") as f:
            f.write(json.dumps({"event": "test-end", "name": "STALE_FROM_A_PRIOR_RUN",
                                "status": "fail"}) + "\n")

        code, _out, err, post_mock = self._run_test_verb(agent="agent-alpha")
        self.assertEqual(code, 0, f"stderr={err!r}")

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        assert ingest_call is not None
        summary = _stream_summary(ingest_call, self.post)
        self.assertEqual(
            (summary["passed"], summary["failed"], summary["total"]), (1, 0, 1),
            f"the stale planted failures (42) must be GONE from the ingested "
            f"summary -- narrowing the wipe to the agent's own directory "
            f"must not mean the wipe stops happening; got summary={summary!r}",
        )
        self.assertFalse(
            os.path.exists(stale_path),
            "the stale planted testcase must not survive inside the "
            "agent's own directory -- only ANOTHER agent's directory is "
            "protected from the wipe",
        )


class AgentDirectorySurvivesTest(_BaseIsolationTest):
    """AC3 -- the agent's directory is still there after its run, holding
    that run's results."""

    def test_agent_directory_still_exists_after_the_run_holding_its_results(self):
        code, _out, err, _post_mock = self._run_test_verb(agent="agent-alpha")
        self.assertEqual(code, 0, f"stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-alpha")
        self.assertTrue(os.path.isdir(own_dir), f"{own_dir} must still exist")
        stream_path = os.path.join(own_dir, STREAM_FILE)
        self.assertTrue(os.path.isfile(stream_path),
                        f"the run's stream must survive in {own_dir}; found "
                        f"{_files_under(own_dir)!r}")
        summary = _stream_file_summary(stream_path)
        self.assertEqual(
            (summary["passed"], summary["failed"]), (1, 0),
            "the surviving directory must hold THIS run's real stream",
        )


class UnchangedLocationsTest(_BaseIsolationTest):
    """AC4/§S2 -- an explicit
    `--reports` is honoured verbatim, agent id or not; `auto-ingest` of a
    caller-produced directory reads exactly that directory. (An agentless
    unittest run writes no stream at all: the client sets none.)"""

    def test_explicit_reports_flag_is_honoured_verbatim_even_with_an_agent_id(self):
        code, _out, err, post_mock = self._run_test_verb(
            agent="agent-alpha", reports="custom-reports-dir")
        self.assertEqual(code, 0, f"stderr={err!r}")

        custom = os.path.join(self.tmpdir, "custom-reports-dir")
        custom_files = [name for name in _files_under(custom) if os.sep not in name]
        self.assertIn(
            STREAM_FILE, custom_files,
            f"an explicit --reports must be used AS GIVEN; found "
            f"{_files_under(custom)!r} under {custom}",
        )
        nested_under_agent = os.path.join(custom, "agent-alpha")
        self.assertFalse(
            os.path.isdir(nested_under_agent),
            f"an explicit --reports must not be nested by agent id; "
            f"{nested_under_agent} must not exist",
        )
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call)

    def test_auto_ingest_with_an_explicit_reports_dir_reads_exactly_that_directory(self):
        caller_dir = os.path.join(self.tmpdir, "caller-produced-reports")
        os.makedirs(caller_dir, exist_ok=True)
        with open(os.path.join(caller_dir, "TEST-caller.xml"), "w") as f:
            f.write(_junit_suite("caller.suite", 1, "CALLER_PRODUCED_TESTCASE"))

        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", side_effect=get_answering_health(),
                                create=True):
            code, _out, err = _run_main(self.module, [
                "auto-ingest", "--project-dir", self.tmpdir,
                "--reports", "caller-produced-reports", "--agent", "agent-alpha",
            ])
        self.assertEqual(code, 0, f"stderr={err!r}")

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call, "auto-ingest must ingest the given directory")
        assert ingest_call is not None
        summary = _sent_summary(ingest_call)
        self.assertEqual(
            (summary["total"], summary["failed"]), (1, 1),
            f"auto-ingest with an explicit --reports must read EXACTLY the "
            f"given directory's content, agent id or not; got "
            f"summary={summary!r}",
        )
        self.assertFalse(
            os.path.isdir(os.path.join(caller_dir, "agent-alpha")),
            "auto-ingest given an explicit --reports must not nest it by "
            "agent id",
        )


class RegressionCoverageFollowsTheAgentTest(_BaseIsolationTest):
    """AC5 -- coverage follows the run: `regression --coverage` writes and
    ingests coverage.py's data (and the derived lcov) from the agent's own
    directory, never the project root."""

    def _write_coverage_fixture(self):
        pkg_dir = os.path.join(self.tmpdir, "covfixturepkg")
        os.makedirs(pkg_dir, exist_ok=True)
        with open(os.path.join(pkg_dir, "__init__.py"), "w") as f:
            f.write("")
        with open(os.path.join(pkg_dir, "lib.py"), "w") as f:
            f.write("def add(a, b):\n    return a + b\n")
        tests_dir = os.path.join(self.tmpdir, "tests")
        os.makedirs(tests_dir, exist_ok=True)
        with open(os.path.join(tests_dir, "__init__.py"), "w") as f:
            f.write("")
        with open(os.path.join(tests_dir, "test_fixture.py"), "w") as f:
            f.write(
                "import unittest\n"
                "from covfixturepkg.lib import add\n\n\n"
                "class FixtureTest(unittest.TestCase):\n"
                "    def test_add(self):\n"
                "        self.assertEqual(add(2, 3), 5)\n"
            )

    def test_regression_coverage_writes_and_ingests_coverage_from_the_agents_own_directory(self):
        self._write_coverage_fixture()
        os.environ.pop("CRUCIBLE_STREAM", None)
        with mock.patch.object(self.module, "_post", side_effect=StreamingPost(),
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", side_effect=get_answering_health(),
                                create=True):
            code, _out, err = _run_main(self.module, [
                "regression", "--project-dir", self.tmpdir, "--python", sys.executable,
                "--agent", "agent-alpha", "--coverage", "--cov-source", "covfixturepkg",
            ])
        self.assertEqual(code, 0, f"stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-alpha")
        under_own_dir = _files_under(own_dir)
        data_file_under_own_dir = any(
            os.path.basename(name) == ".coverage" for name in under_own_dir
        )
        lcov_under_own_dir = any(
            os.path.basename(name) == "coverage.lcov" for name in under_own_dir
        )
        self.assertTrue(
            data_file_under_own_dir,
            f"coverage.py's data file (.coverage) must live under {own_dir}; "
            f"found {under_own_dir!r}",
        )
        self.assertTrue(
            lcov_under_own_dir,
            f"the derived coverage.lcov must live under {own_dir}; found "
            f"{under_own_dir!r}",
        )
        self.assertFalse(
            os.path.exists(os.path.join(self.tmpdir, ".coverage")),
            "coverage.py's data file must NOT be left at the project root",
        )
        self.assertFalse(
            os.path.exists(os.path.join(self.tmpdir, "coverage.lcov")),
            "the derived coverage.lcov must NOT be left at the project root",
        )

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call)
        assert ingest_call is not None
        payload = ingest_call[0][1]
        coverage = payload.get("coverage")
        self.assertEqual((coverage or {}).get("codec"), "lcov",
                         f"a --coverage run must send its lcov report; "
                         f"coverage={coverage!r}")
        lcov = "".join((coverage or {}).get("data") or [])
        self.assertIn("SF:", lcov, f"coverage={coverage!r}")
        self.assertIn("covfixturepkg", lcov,
                      f"the lcov report sent must reflect the REAL run over "
                      f"covfixturepkg, not an empty/absent measurement; got "
                      f"coverage={coverage!r}")


class ReportsHelpTextTest(_BaseIsolationTest):
    """AC9 -- the `--reports` help text states the per-agent default."""

    def test_test_verb_reports_help_states_the_per_agent_default(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
             mock.patch.object(sys, "argv", ["python-crucible.py", "test", "--help"]):
            with self.assertRaises(SystemExit):
                self.module.main()
        help_text = out.getvalue()
        reports_lines = [line for line in help_text.splitlines() if "--reports" in line]
        self.assertTrue(reports_lines, f"no --reports line found in help text {help_text!r}")
        self.assertTrue(
            any("agent" in line.lower() for line in reports_lines),
            f"the --reports help text must state the per-agent default "
            f"(test-reports/<agent>); got {reports_lines!r}",
        )


if __name__ == "__main__":
    unittest.main()
