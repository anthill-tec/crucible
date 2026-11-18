"""Report-isolation behaviour for `clients/rust-crucible.py`, pinned against
the spec's own language
(docs/changes/CR-CRU-155-each-test-run-keeps-its-reports-to-itself.md §S1/§S3):
nextest's JUnit path and llvm-cov's output are FIXED BY THE TOOL (nextest's
profile config; llvm-cov's `target/`), so unlike mvn/arduino there is no flag
the client can hand the tool -- instead the client must MOVE what the tool
wrote into the agent's own `test-reports/<agent>/` directory right after the
run, BEFORE reading/ingesting it, narrowing the window rather than closing it.

A rust run's record is the nextest stream it writes: the run is closed from
that stream (`codec: "nextest"`, no `data`), so the JUnit report a profile
still configures is filed by no verb that streamed it. It is still moved out
of `target/nextest/<profile>/` into the agent's own directory, as before, so
no later `auto-ingest` files a run already streamed. The lcov a coverage run
writes is moved there too, and its text travels inline as the close's
coverage report.

Toolchain: the real `cargo`/`nextest`/`llvm-cov` toolchain is never spawned.
A fake `cargo` first on PATH answers a streamed run's calls
(`tests/client/fake_nextest.py`: the version, the list, `llvm-cov show-env`,
`llvm-cov report` writing LCOV_FIXTURE, and the `libtest-json-plus` stream of
one passing test) and plays a real, unconfigurable nextest: every `nextest
run` ALWAYS writes its JUnit fixture at the tool's own FIXED path
(`target/nextest/<-P profile>/junit.xml` under its cwd), regardless of any
flags in the command -- exactly the "fixed by the tool" property the spec
describes -- so every assertion below proves the CLIENT's own post-run move,
never a flag the tool happens to honour.

Module-loading + HTTP-mocking convention copied from
`test_rust_crucible_axi.py`: load `clients/rust-crucible.py` by file path via
`importlib`, and record the module's `_post` HTTP seam (and the transport
under it) with a board that opens the run and holds its stream, so the live
Crucible server on :3849 is NEVER touched; `_get` answers the board's health
as a board that decodes the reports (`get_answering_health`).

Invocation:
    python3 -m pytest tests/client/test_rust_crucible_agent_report_isolation.py -q
Fallback:
    python3 tests/client/test_rust_crucible_agent_report_isolation.py
"""

import contextlib
import glob
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.fake_nextest import held_results, private_fake_prelude
from tests.client.live_run_harness import StreamingPost, get_answering_health
from tests.client.client_fleet_envelope_census_helpers import install_project_limits
from tests.client import client_script

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = client_script("rust-crucible.py")

GOOD_JUNIT_XML = (
    '<?xml version="1.0"?>'
    '<testsuites><testsuite name="fixture" tests="1" failures="0">'
    '<testcase name="test_passes" time="0.001"/>'
    '</testsuite></testsuites>'
)

LCOV_FIXTURE = "TN:\nSF:src/main.rs\nFNF:1\nFNH:1\nLF:2\nLH:2\nend_of_record\n"

# The fake `cargo`: a streamed run's calls are answered by
# `tests/client/fake_nextest.py` (one passing `test_passes`); every `nextest
# run` first writes GOOD_JUNIT_XML at nextest's fixed path for its profile.
_FAKE_CARGO = ("#!" + sys.executable + "\n" + private_fake_prelude(
    "[fake_nextest.case('test_passes', crate='fixture-crate', binary='fixture_crate')]",
    streamed=False) + r'''
import os
if _nx_args[:2] == ["nextest", "run"]:
    _profile = fake_nextest.option(_nx_args, "-P") or fake_nextest.option(
        _nx_args, "--profile") or "default"
    _fixed = os.path.join(os.getcwd(), "target", "nextest", _profile, "junit.xml")
    os.makedirs(os.path.dirname(_fixed), exist_ok=True)
    with open(_fixed, "w") as _handle:
        _handle.write(''' + repr(GOOD_JUNIT_XML) + r''')
    _nx_code = fake_nextest.streamed_run(_nx_args, _nx_cases)
    _nx_sys.exit(0 if _nx_code is None else _nx_code)
_nx_sys.exit(0)
''')


def _junit_suite(name, tests, failures, testcase_prefix):
    cases = []
    for i in range(tests):
        fail_child = ('<failure message="planted">planted failure</failure>'
                      if i < failures else "")
        cases.append(f'<testcase name="{testcase_prefix}_{i}" time="0.001">{fail_child}</testcase>')
    return (
        '<?xml version="1.0"?>'
        f'<testsuites><testsuite name="{name}" tests="{tests}" failures="{failures}">'
        + "".join(cases) + "</testsuite></testsuites>"
    )


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module():
    return _load_module(SCRIPT_PATH, "rust_crucible_under_test_report_isolation")


def _run_main(module, argv, scratch):
    """Invoke `module.main()` with `sys.argv` patched and its streams real
    files under `scratch` (a runner child may be handed them). Returns (code,
    stdout, stderr). Only `SystemExit` is caught; any other exception
    propagates so unittest reports it as an ERROR (still a valid RED
    signal)."""
    full_argv = ["rust-crucible.py"] + argv
    out_path = os.path.join(scratch, "drive-stdout.txt")
    err_path = os.path.join(scratch, "drive-stderr.txt")
    with open(out_path, "w") as stdout, open(err_path, "w") as stderr, \
            mock.patch.object(sys, "argv", full_argv), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            module.main()
            code = 0
        except SystemExit as e:
            code = 0 if e.code is None else (e.code if isinstance(e.code, int) else 1)
    return code, Path(out_path).read_text(), Path(err_path).read_text()


def _post_call_for_path(post_mock, path):
    for call in post_mock.call_args_list:
        args, kwargs = call
        call_path = args[0] if args else kwargs.get("path")
        if call_path == path:
            return call
    return None


class _BaseRustIsolationTest(unittest.TestCase):
    PROJECT_KEY = "test-key-rust-report-isolation"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE",
                "NEXTEST_EXPERIMENTAL_LIBTEST_JSON", "CARGO_TARGET_DIR",
                "FAKE_CARGO_CALLS", "FAKE_LCOV", "FAKE_LCOV_FILE")

    def setUp(self):
        self.module = _load_client_module()
        self.tmpdir = tempfile.mkdtemp(prefix="rust-crucible-report-isolation-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        install_project_limits(self.tmpdir)
        self.bin_dir = tempfile.mkdtemp(prefix="rust-crucible-report-isolation-bin-")
        cargo = Path(self.bin_dir, "cargo")
        cargo.write_text(_FAKE_CARGO)
        cargo.chmod(0o755)
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS + ("PATH",)}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)
        os.environ["PATH"] = self.bin_dir + os.pathsep + os.environ.get("PATH", "")
        os.environ["FAKE_LCOV"] = LCOV_FIXTURE
        self.scratch = tempfile.mkdtemp(prefix="rust-crucible-report-isolation-out-")

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        import shutil
        for directory in (self.tmpdir, self.bin_dir, self.scratch):
            shutil.rmtree(directory, ignore_errors=True)

    def _mocked_transport(self):
        """`_post` (kept as the returned mock) and the transport under it,
        answered by a board that opens the run and holds its stream
        (`self.stream`), and `_get` answering the board's health."""
        self.stream = StreamingPost()
        health = get_answering_health()

        def request(method, path, payload=None, timeout=None):
            if method == "POST":
                return self.stream(path, payload)
            return health(path)

        return (
            mock.patch.object(self.module, "_post", side_effect=self.stream, create=True),
            mock.patch.object(self.module, "_request", side_effect=request, create=True),
            mock.patch.object(self.module, "_get", side_effect=health, create=True),
        )

    def run_verb(self, argv, *extra_patches):
        post_patch, request_patch, get_patch = self._mocked_transport()
        with post_patch as post_mock, request_patch, get_patch, \
                contextlib.ExitStack() as stack:
            for patch in extra_patches:
                stack.enter_context(patch)
            code, out, err = _run_main(self.module, argv, self.scratch)
        return code, out, err, post_mock

    def assert_closed_from_its_stream(self, post_mock, out, err):
        """The run's one `/api/v2/runs` closes it from the nextest stream the
        board holds, carrying no report, and returns its body."""
        self.assertIsNone(_post_call_for_path(post_mock, "/api/v2/runs/parsed"),
                          "the run is never posted to the parsed route")
        closes = [call[0][1] for call in post_mock.call_args_list
                  if call[0] and call[0][0] == "/api/v2/runs"]
        self.assertEqual(
            [(body.get("codec"), "data" in body) for body in closes], [("nextest", False)],
            f"the run is closed once from its nextest stream, carrying no JUnit "
            f"report; stdout={out!r} stderr={err[-1500:]!r}")
        self.assertEqual(held_results(self.stream.held.decode("utf-8")),
                         {"ok": 1, "failed": 0, "ignored": 0},
                         "the board holds this run's stream: one passing test")
        return closes[0] if closes else {}


class AgentDirectoryJunitMoveAndReadTest(_BaseRustIsolationTest):
    """AC1/AC7 -- nextest's JUnit path is fixed by the tool
    (`target/nextest/<profile>/junit.xml`); the client must MOVE it into the
    agent's own directory right after the run (narrowing, not closing, the
    window the tool writes it in) -- a stale report already sitting in the
    agent's own directory from a prior run must be cleared before the fresh
    moved one lands. The run itself is closed from its stream."""

    def test_test_run_moves_nextests_fixed_junit_into_the_agents_directory_and_wipes_stale_content_first(self):
        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-x")
        os.makedirs(own_dir, exist_ok=True)
        stale_path = os.path.join(own_dir, "junit.xml")
        with open(stale_path, "w") as f:
            f.write(_junit_suite("stale.suite", 9, 9, "stale"))

        fixed_junit = os.path.join(self.tmpdir, "target", "nextest", "ci", "junit.xml")

        code, out, err, post_mock = self.run_verb([
            "test", "--project-dir", self.tmpdir, "--crate", "fixture-crate",
            "--agent", "agent-x",
        ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        moved = glob.glob(os.path.join(own_dir, "**", "junit.xml"), recursive=True)
        self.assertEqual(
            len(moved), 1,
            f"nextest's junit.xml must be MOVED into the agent's own "
            f"directory {own_dir} right after the run; found {moved!r}",
        )
        self.assertFalse(
            os.path.exists(fixed_junit),
            f"the junit.xml must be MOVED out of nextest's fixed "
            f"{fixed_junit}, not merely copied, narrowing the window "
            f"between the tool writing it and anything reading it",
        )
        moved_content = Path(moved[0]).read_text() if moved else ""
        self.assertNotIn(
            "stale_0", moved_content,
            "the STALE junit already sitting in the agent's own directory "
            "from a prior run must be WIPED before this run's fresh moved "
            "junit lands there; the agent's directory still carries stale content",
        )
        self.assertEqual(
            moved_content, GOOD_JUNIT_XML,
            f"the agent's directory must hold THIS run's fresh junit; "
            f"got content={moved_content!r}",
        )
        self.assert_closed_from_its_stream(post_mock, out, err)


class AgentDirectoryCoverageMoveAndReadTest(_BaseRustIsolationTest):
    """AC1/AC7 -- llvm-cov's coverage output is likewise fixed by the tool
    (`target/lcov.info`); the client must move it (alongside the junit its
    own run produces) into the agent's own directory before reading it."""

    def test_regression_ingest_moves_llvm_cov_output_into_the_agents_directory_before_reading_coverage(self):
        fixed_lcov = os.path.join(self.tmpdir, "target", "lcov.info")

        code, out, err, post_mock = self.run_verb([
            "regression-ingest", "--project-dir", self.tmpdir,
            "--crates", "fixture-crate", "--agent", "agent-cov",
        ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-cov")
        moved_lcov = glob.glob(os.path.join(own_dir, "**", "lcov.info"), recursive=True)
        self.assertEqual(
            len(moved_lcov), 1,
            f"llvm-cov's lcov.info must be MOVED into the agent's own "
            f"directory {own_dir}; found {moved_lcov!r}",
        )
        self.assertFalse(
            os.path.exists(fixed_lcov),
            "lcov.info must be MOVED out of the tool's fixed "
            "target/lcov.info, not merely copied",
        )

        body = self.assert_closed_from_its_stream(post_mock, out, err)
        self.assertEqual(
            body.get("coverage"), {"codec": "lcov", "data": [LCOV_FIXTURE]},
            "the close must carry the MOVED lcov.info's text as its "
            "coverage report, not an absent/fixed-path read",
        )


class AgentDirectorySurvivesTest(_BaseRustIsolationTest):
    """AC3 -- the agent's directory is still there after its run, holding
    the moved junit."""

    def test_agent_directory_still_exists_after_the_run_holding_its_moved_results(self):
        code, out, err, _post_mock = self.run_verb([
            "test", "--project-dir", self.tmpdir, "--crate", "fixture-crate",
            "--agent", "agent-w",
        ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-w")
        self.assertTrue(os.path.isdir(own_dir), f"{own_dir} must still exist after the run")
        found = glob.glob(os.path.join(own_dir, "**", "junit.xml"), recursive=True)
        self.assertEqual(
            len(found), 1,
            f"expected exactly one surviving junit.xml under {own_dir}; found {found!r}",
        )
        self.assertEqual(
            Path(found[0]).read_text(), GOOD_JUNIT_XML,
            "the surviving directory must hold THIS run's real results",
        )


class WorkspaceRegressionAndSmokeTestMoveOutputsIntoAgentDirectoryTest(_BaseRustIsolationTest):
    """AC7/§S3 -- `workspace-regression` (the orchestrator's full-workspace
    coverage gate) and `smoke-test` (its faster no-coverage pass) drive
    nextest/llvm-cov over the WHOLE workspace, exactly like the crate-scoped
    `test`/`regression-ingest` verbs already covered above -- their own
    fixed tool paths (`target/nextest/<profile>/junit.xml`,
    `target/lcov.info`) must be moved into the agent's own directory, narrowing
    (not closing) the same window."""

    def test_workspace_regression_moves_nextests_junit_and_llvm_covs_lcov_into_the_agents_directory(self):
        fixed_junit = os.path.join(self.tmpdir, "target", "nextest", "ci", "junit.xml")
        fixed_lcov = os.path.join(self.tmpdir, "target", "lcov.info")

        code, out, err, post_mock = self.run_verb(
            ["workspace-regression", "--project-dir", self.tmpdir,
             "--agent", "agent-wr", "--keep-target"],
            mock.patch.object(self.module, "_disk_guard", return_value=True))
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-wr")
        moved_junit = glob.glob(os.path.join(own_dir, "**", "junit.xml"), recursive=True)
        moved_lcov = glob.glob(os.path.join(own_dir, "**", "lcov.info"), recursive=True)
        self.assertEqual(
            len(moved_junit), 1,
            f"workspace-regression's junit.xml must be MOVED into the "
            f"agent's own directory {own_dir}; found {moved_junit!r}",
        )
        self.assertEqual(
            len(moved_lcov), 1,
            f"workspace-regression's lcov.info must be MOVED into the "
            f"agent's own directory {own_dir}; found {moved_lcov!r}",
        )
        self.assertFalse(os.path.exists(fixed_junit),
                         "junit.xml must be MOVED out of nextest's fixed path, not copied")
        self.assertFalse(os.path.exists(fixed_lcov),
                         "lcov.info must be MOVED out of llvm-cov's fixed path, not copied")
        self.assertEqual(Path(moved_junit[0]).read_text() if moved_junit else "",
                         GOOD_JUNIT_XML, "the agent's directory holds THIS run's junit")

        payload = self.assert_closed_from_its_stream(post_mock, out, err)
        self.assertEqual(payload.get("tier"), "regression")
        self.assertEqual(
            payload.get("coverage"), {"codec": "lcov", "data": [LCOV_FIXTURE]},
            "the close must carry the MOVED lcov.info's text as its "
            "coverage report, not an absent/fixed-path read",
        )

    def test_smoke_test_moves_nextests_fixed_junit_into_the_agents_directory_before_ingesting(self):
        fixed_junit = os.path.join(self.tmpdir, "target", "nextest", "ci", "junit.xml")

        code, out, err, post_mock = self.run_verb([
            "smoke-test", "--agent", "agent-st", "--project-dir", self.tmpdir,
        ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-st")
        moved = glob.glob(os.path.join(own_dir, "**", "junit.xml"), recursive=True)
        self.assertEqual(
            len(moved), 1,
            f"smoke-test's junit.xml must be MOVED into the agent's own "
            f"directory {own_dir}; found {moved!r}",
        )
        self.assertFalse(os.path.exists(fixed_junit),
                         "junit.xml must be MOVED out of nextest's fixed path, not copied")
        self.assertEqual(Path(moved[0]).read_text() if moved else "", GOOD_JUNIT_XML,
                         "the agent's directory holds THIS run's junit")
        self.assert_closed_from_its_stream(post_mock, out, err)


class ReportsHelpTextTest(_BaseRustIsolationTest):
    """AC9 -- the `--reports` help text states the per-agent default, and
    (uniquely for rust) also states the narrowed-not-closed window: nextest's
    junit and llvm-cov's lcov are written to fixed tool paths and moved right
    after the run, so the window between the tool writing and the client
    moving is narrowed, never fully closed."""

    def test_test_verb_reports_help_states_the_per_agent_default(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
             mock.patch.object(sys, "argv", ["rust-crucible.py", "test", "--help"]), \
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

    def test_test_verb_reports_help_states_the_narrowed_not_closed_window(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
             mock.patch.object(sys, "argv", ["rust-crucible.py", "test", "--help"]), \
             self.assertRaises(SystemExit):
            self.module.main()
        help_text = out.getvalue()
        normalized = " ".join(help_text.split())
        self.assertIn(
            "narrowed, not closed", normalized,
            f"rust's --reports help must state that the window between the "
            f"tool writing its fixed-path output and the client moving it is "
            f"narrowed, not closed (unlike mvn/arduino, which hand the tool "
            f"the agent's directory directly); got help_text={help_text!r}",
        )


if __name__ == "__main__":
    unittest.main()
