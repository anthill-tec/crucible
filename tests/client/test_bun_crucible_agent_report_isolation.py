"""Report-isolation behaviour for `clients/bun-crucible.py`, pinned against the
spec's own language: a run made with `--agent <id>` and no `--reports` writes,
reads and ingests its results under `test-reports/<id>/` in the package; only
that directory is ever cleared before the run; the directory survives the
run; a run without `--agent` keeps today's shared location; an explicit
`--reports <dir>` is honoured verbatim; coverage (`--coverage-dir`) and a
declared target's raw report (e.g. `playwright.json`) follow the run into the
same directory; and the `--reports` help text states the per-agent default.

RED PHASE: `_reports_dir` (`clients/bun-crucible.py`) ignores the agent id
entirely today -- `rd = arg_value or DEFAULT_REPORTS` -- so every agent's run
writes into the SAME `test-reports/junit.xml` regardless of who ran it, and
`coverage_dir` is hard-fixed at `<package_dir>/coverage` regardless of
`--reports` or agent. Every test below drives the REAL client through its CLI
against a tiny fake `bun` executable (never real bun/playwright) and asserts
on the FILESYSTEM PATHS the client actually used and the payload it actually
POSTed -- never on an assumed internal helper signature, so a correct fix can
land its own shape and still satisfy every assertion here. The board's HTTP
seam (`_post`/`_get`) is mocked throughout; no live server and no real bun
binary is ever touched.

Module-loading + fake-bun convention copied verbatim from the sibling
harnesses (`test_bun_crucible_auto_attach.py`, `test_client_fleet_envelope_census.py`):
a tiny fake `bun` executable that answers `bun test`'s own flag contract, plus
(for the declared-target case) `bun run <script>` executed faithfully against
the fixture's own `package.json` script table.

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_agent_report_isolation.py -q
Fallback:
    python3 tests/client/test_bun_crucible_agent_report_isolation.py
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"

_ENV_KEYS = (
    "WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE",
    "BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_BUN",
    "FAKE_BUN_JUNIT_CONTENT", "FAKE_BUN_EXIT_CODE", "FAKE_BUN_LCOV_CONTENT",
    "FAKE_E2E_RAW_CONTENT", "FAKE_E2E_EXIT_CODE", "PLAYWRIGHT_JSON_OUTPUT_NAME",
)

PASSING_JUNIT_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<testsuites><testsuite name="fixture.test.ts" tests="1" failures="0">'
    '<testcase name="passes" classname="fixture.test.ts" time="0.001"></testcase>'
    '</testsuite></testsuites>'
)


def _junit_suite(name, failures, testcase_name):
    fail_child = '<failure message="planted">planted failure</failure>' if failures else ""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<testsuites><testsuite name="{name}" tests="1" failures="{failures}">'
        f'<testcase name="{testcase_name}" classname="{name}" time="0.001">'
        f'{fail_child}</testcase></testsuite></testsuites>'
    )


# A fake `bun` that answers BOTH invocations this file needs: `bun test ...`
# (the flag contract -- `--reporter-outfile=`, `--coverage-dir=`) and
# `bun run <script>` (faithfully executing the fixture's OWN package.json
# script body, so a run dispatched THROUGH a declared script is not invisible
# to the fixture).
_FAKE_BUN_TEMPLATE = """#!{python}
import json
import os
import shlex
import subprocess
import sys

argv = sys.argv[1:]

if argv[:1] == ["run"] and len(argv) > 1:
    script = argv[1]
    try:
        with open(os.path.join(os.getcwd(), "package.json")) as handle:
            scripts = (json.load(handle) or {{}}).get("scripts") or {{}}
    except OSError:
        scripts = {{}}
    body = scripts.get(script)
    if body is None:
        sys.stderr.write("error: Script not found %s\\n" % script)
        sys.exit(1)
    command = " ".join([body] + [shlex.quote(a) for a in argv[2:]])
    sys.exit(subprocess.run(command, shell=True, cwd=os.getcwd()).returncode)

if argv[:1] == ["test"]:
    outfile = None
    coverage_dir = None
    for tok in argv:
        if tok.startswith("--reporter-outfile="):
            outfile = tok.split("=", 1)[1]
        elif tok.startswith("--coverage-dir="):
            coverage_dir = tok.split("=", 1)[1]
    content = os.environ.get("FAKE_BUN_JUNIT_CONTENT", "")
    if outfile and content:
        directory = os.path.dirname(outfile)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(outfile, "w") as handle:
            handle.write(content)
    lcov_content = os.environ.get("FAKE_BUN_LCOV_CONTENT")
    if coverage_dir and lcov_content:
        os.makedirs(coverage_dir, exist_ok=True)
        with open(os.path.join(coverage_dir, "lcov.info"), "w") as handle:
            handle.write(lcov_content)
    sys.exit(int(os.environ.get("FAKE_BUN_EXIT_CODE", "0")))

sys.exit(1)
"""

# A fake e2e runner (stands in for playwright): ignores every CLI flag it does
# not need (a declared target under the flag-default mechanism still gets
# `bun test`'s own `--reporter=junit --reporter-outfile=...` appended) and
# writes its RAW report to the path named by the declared env var.
_FAKE_E2E_TEMPLATE = """#!{python}
import os
import sys

outfile = os.environ.get("PLAYWRIGHT_JSON_OUTPUT_NAME")
content = os.environ.get("FAKE_E2E_RAW_CONTENT", "")
if outfile and content:
    directory = os.path.dirname(outfile)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(outfile, "w") as handle:
        handle.write(content)
sys.exit(int(os.environ.get("FAKE_E2E_EXIT_CODE", "0")))
"""


def _load_bun_crucible_module():
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_report_isolation", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    full_argv = ["bun-crucible.py"] + argv
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", full_argv), \
         contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
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


def _files_under(root):
    if not os.path.isdir(root):
        return []
    found = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            found.append(os.path.relpath(os.path.join(dirpath, name), root))
    return sorted(found)


class _BaseIsolationTest(unittest.TestCase):
    PROJECT_KEY = "test-key-bun-report-isolation"

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-report-isolation-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in _ENV_KEYS}
        for k in _ENV_KEYS:
            os.environ.pop(k, None)
        self.fake_bun = os.path.join(self.tmpdir, "fake_bun.py")
        with open(self.fake_bun, "w") as f:
            f.write(_FAKE_BUN_TEMPLATE.format(python=sys.executable))
        os.chmod(self.fake_bun, 0o700)
        self.fake_e2e = os.path.join(self.tmpdir, "fake_playwright.py")
        with open(self.fake_e2e, "w") as f:
            f.write(_FAKE_E2E_TEMPLATE.format(python=sys.executable))
        os.chmod(self.fake_e2e, 0o700)
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASSING_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_package_json(self, scripts=None, crucible=None):
        manifest = {"name": "bun-report-isolation-fixture"}
        if scripts:
            manifest["scripts"] = scripts
        if crucible:
            manifest["crucible"] = crucible
        with open(os.path.join(self.tmpdir, "package.json"), "w") as f:
            json.dump(manifest, f)

    def _run_test_verb(self, agent=None, reports=None, extra=()):
        argv = ["test", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir]
        if agent:
            argv += ["--agent", agent]
        if reports:
            argv += ["--reports", reports]
        argv += list(extra)
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value={"ok": False},
                                create=True):
            code, out, err = _run_main(self.module, argv)
        return code, out, err, post_mock

    def _run_regression_verb(self, agent=None, reports=None, extra=()):
        argv = ["regression", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir]
        if agent:
            argv += ["--agent", agent]
        if reports:
            argv += ["--reports", reports]
        argv += list(extra)
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value={"ok": False},
                                create=True):
            code, out, err = _run_main(self.module, argv)
        return code, out, err, post_mock


class AgentDefaultDirectoryTest(_BaseIsolationTest):
    """AC1/§S1 -- `--agent A`, no `--reports`, ingests from `test-reports/A/`."""

    def test_agent_run_without_reports_flag_writes_and_ingests_from_its_own_directory(self):
        code, _out, err, post_mock = self._run_test_verb(agent="agent-alpha")
        self.assertEqual(code, 0, f"stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-alpha")
        self.assertIn(
            "junit.xml", _files_under(own_dir),
            f"expected junit.xml under {own_dir}; found {_files_under(own_dir)!r}",
        )
        top_files = [name for name in
                     _files_under(os.path.join(self.tmpdir, "test-reports"))
                     if os.sep not in name]
        self.assertEqual(
            top_files, [],
            f"no file may be written directly into the shared test-reports/ "
            f"top level when an agent id is given; found {top_files!r}",
        )

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the real bun-test run must be ingested")
        assert ingest_call is not None
        summary = ingest_call[0][1]["summary"]
        self.assertEqual(summary["passed"], 1)
        self.assertEqual(summary["failed"], 0)


class AgentDirectoryIsolationTest(_BaseIsolationTest):
    """AC1/AC2 -- two agents' directories are never shared, read or cleared."""

    def test_another_agents_preexisting_directory_is_neither_read_nor_cleared(self):
        other_dir = os.path.join(self.tmpdir, "test-reports", "agent-bravo")
        os.makedirs(other_dir, exist_ok=True)
        sentinel_path = os.path.join(other_dir, "junit.xml")
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
            "byte-for-byte -- neither read into alpha's ingest nor cleared "
            "by alpha's wipe",
        )

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        assert ingest_call is not None
        summary = ingest_call[0][1]["summary"]
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
        stale_path = os.path.join(own_dir, "junit.xml")
        with open(stale_path, "w") as f:
            f.write(_junit_suite("alpha.stale", 42, "STALE_FROM_A_PRIOR_RUN"))

        code, _out, err, post_mock = self._run_test_verb(agent="agent-alpha")
        self.assertEqual(code, 0, f"stderr={err!r}")

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        assert ingest_call is not None
        summary = ingest_call[0][1]["summary"]
        self.assertEqual(
            (summary["passed"], summary["failed"], summary["total"]), (1, 0, 1),
            f"the stale planted failures (42) must be GONE from the ingested "
            f"summary; got summary={summary!r}",
        )
        with open(stale_path) as f:
            remaining = f.read()
        self.assertNotIn("STALE_FROM_A_PRIOR_RUN", remaining)


class AgentDirectorySurvivesTest(_BaseIsolationTest):
    """AC3 -- the agent's directory is still there after its run."""

    def test_agent_directory_still_exists_after_the_run_holding_its_results(self):
        code, _out, err, _post_mock = self._run_test_verb(agent="agent-alpha")
        self.assertEqual(code, 0, f"stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-alpha")
        junit_path = os.path.join(own_dir, "junit.xml")
        self.assertTrue(os.path.exists(junit_path), f"{junit_path} must still exist")
        summary, _tree, _files = self.module._parse_junit_file(junit_path)
        self.assertEqual((summary["passed"], summary["failed"]), (1, 0))


class UnchangedLocationsTest(_BaseIsolationTest):
    """AC4/§S2 -- no `--agent` keeps today's shared location; an explicit
    `--reports` is honoured verbatim; `auto-ingest` of a caller-produced
    directory reads exactly that directory."""

    def test_run_without_an_agent_id_writes_directly_into_the_shared_reports_root(self):
        code, _out, err, _post_mock = self._run_test_verb(agent=None)
        self.assertEqual(code, 0, f"stderr={err!r}")

        junit_path = os.path.join(self.tmpdir, "test-reports", "junit.xml")
        self.assertTrue(
            os.path.exists(junit_path),
            f"an agentless run must keep writing directly into "
            f"{os.path.dirname(junit_path)} (today's behaviour)",
        )

    def test_explicit_reports_flag_is_honoured_verbatim_even_with_an_agent_id(self):
        code, _out, err, post_mock = self._run_test_verb(
            agent="agent-alpha", reports="custom-reports-dir")
        self.assertEqual(code, 0, f"stderr={err!r}")

        junit_path = os.path.join(self.tmpdir, "custom-reports-dir", "junit.xml")
        self.assertTrue(os.path.exists(junit_path), f"expected {junit_path}")
        nested = os.path.join(self.tmpdir, "custom-reports-dir", "agent-alpha")
        self.assertFalse(
            os.path.isdir(nested),
            f"an explicit --reports must not be nested by agent id; "
            f"{nested} must not exist",
        )
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call)

    def test_auto_ingest_with_an_explicit_reports_dir_reads_exactly_that_directory(self):
        caller_dir = os.path.join(self.tmpdir, "caller-produced-reports")
        os.makedirs(caller_dir, exist_ok=True)
        with open(os.path.join(caller_dir, "junit.xml"), "w") as f:
            f.write(_junit_suite("caller.suite", 1, "CALLER_PRODUCED_TESTCASE"))

        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value={"ok": False},
                                create=True):
            code, _out, err = _run_main(self.module, [
                "auto-ingest", "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir,
                "--reports", "caller-produced-reports", "--agent", "agent-alpha",
            ])
        self.assertEqual(code, 0, f"stderr={err!r}")

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "auto-ingest must ingest the given directory")
        assert ingest_call is not None
        summary = ingest_call[0][1]["summary"]
        self.assertEqual(
            (summary["total"], summary["failed"]), (1, 1),
            f"auto-ingest with an explicit --reports must read EXACTLY the "
            f"given directory's content, agent id or not; got "
            f"summary={summary!r}",
        )
        self.assertFalse(
            os.path.isdir(os.path.join(caller_dir, "agent-alpha")),
            "auto-ingest given an explicit --reports must not nest it by agent id",
        )


class RegressionCoverageFollowsTheAgentTest(_BaseIsolationTest):
    """AC5 -- coverage follows the run: `regression --coverage`'s
    `--coverage-dir` lands under the agent's own directory, never the fixed
    `<package>/coverage`, and the ingested figures come from THAT lcov."""

    LCOV = "SF:src/agent.ts\nDA:1,1\nDA:2,1\nDA:3,0\nLF:3\nLH:2\nFNF:1\nFNH:1\nend_of_record\n"
    DECOY_LCOV = ("SF:src/decoy.ts\nDA:1,0\nDA:2,0\nLF:2\nLH:0\nFNF:5\nFNH:0\n"
                  "end_of_record\n")

    def test_regression_coverage_dir_lands_under_the_agents_own_directory(self):
        # A decoy at the OLD fixed location (<package_dir>/coverage/lcov.info):
        # if the client still reads there instead of the agent's own
        # directory, the ingested figures below would match this decoy, not
        # the real run.
        decoy_dir = os.path.join(self.tmpdir, "coverage")
        os.makedirs(decoy_dir, exist_ok=True)
        with open(os.path.join(decoy_dir, "lcov.info"), "w") as f:
            f.write(self.DECOY_LCOV)

        os.environ["FAKE_BUN_LCOV_CONTENT"] = self.LCOV
        code, _out, err, post_mock = self._run_regression_verb(
            agent="agent-alpha", extra=["--coverage"])
        self.assertEqual(code, 0, f"stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-alpha")
        under_own_dir = [n for n in _files_under(own_dir) if n.endswith("lcov.info")]
        self.assertTrue(
            under_own_dir,
            f"the run's own lcov.info must live somewhere under {own_dir}; "
            f"found {_files_under(own_dir)!r}",
        )

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        assert ingest_call is not None
        coverage = ingest_call[0][1].get("coverage")
        self.assertIsNotNone(coverage, "a --coverage run must ingest a coverage object")
        self.assertEqual(
            coverage["lines"]["total"], 3,
            f"the ingested coverage must come from the RUN's own lcov "
            f"(lines total=3), not the decoy at the old fixed "
            f"<package>/coverage location (lines total=2); got "
            f"coverage={coverage!r}",
        )
        self.assertEqual(coverage["lines"]["covered"], 2)
        with open(os.path.join(decoy_dir, "lcov.info")) as f:
            self.assertEqual(
                f.read(), self.DECOY_LCOV,
                "the decoy at the old fixed location must be left untouched",
            )


class DeclaredRawReportFollowsTheAgentTest(_BaseIsolationTest):
    """AC6 -- a declared target's raw report (e.g. `playwright.json`) is
    written to, sent from, and survives in the agent's own directory."""

    RAW_MARKER = "FAKE_E2E_RAW_REPORT_MARKER_9137"

    def test_declared_e2e_raw_report_is_written_to_and_sent_from_the_agents_directory(self):
        self._write_package_json(
            scripts={"test:e2e": self.fake_e2e},
            crucible={"rawReport": {"test:e2e": {
                "codec": "playwright", "file": "playwright.json",
                "path": "env:PLAYWRIGHT_JSON_OUTPUT_NAME",
            }}},
        )
        os.environ["FAKE_E2E_RAW_CONTENT"] = json.dumps({"marker": self.RAW_MARKER})
        os.environ["FAKE_E2E_EXIT_CODE"] = "0"

        with mock.patch.object(self.module, "_post", return_value={"ok": True,
                                "run": {"passed": 1, "failed": 0, "pending": 0,
                                        "total": 1}}, create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value={"ok": False},
                                create=True):
            code, _out, err = _run_main(self.module, [
                "e2e", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir, "--agent", "agent-alpha",
            ])
        self.assertEqual(code, 0, f"stderr={err!r}")

        expected_path = os.path.join(
            self.tmpdir, "test-reports", "agent-alpha", "playwright.json")
        self.assertTrue(
            os.path.exists(expected_path),
            f"the declared raw report must be written under the agent's own "
            f"directory at {expected_path}",
        )
        with open(expected_path) as f:
            written = json.load(f)
        self.assertEqual(written.get("marker"), self.RAW_MARKER)

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call, "the raw report must be sent to /api/v2/runs")
        assert ingest_call is not None
        payload = ingest_call[0][1]
        self.assertEqual(
            payload.get("dataPath"), expected_path,
            f"the client must send dataPath under the agent's own directory, "
            f"not the shared/top-level location; got "
            f"dataPath={payload.get('dataPath')!r}",
        )
        # AC3 -- still there after the run.
        self.assertTrue(os.path.exists(expected_path))


class ReportsHelpTextTest(_BaseIsolationTest):
    """AC9 -- the `--reports` help text states the per-agent default."""

    def test_test_verb_reports_help_states_the_per_agent_default(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
             mock.patch.object(sys, "argv", ["bun-crucible.py", "test", "--help"]), \
             self.assertRaises(SystemExit):
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
