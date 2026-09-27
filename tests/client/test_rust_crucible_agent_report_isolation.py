"""Report-isolation behaviour for `clients/rust-crucible.py`, pinned against
the spec's own language
(docs/changes/CR-CRU-155-each-test-run-keeps-its-reports-to-itself.md §S1/§S3):
nextest's JUnit path and llvm-cov's output are FIXED BY THE TOOL (nextest's
profile config; llvm-cov's `target/`), so unlike mvn/arduino there is no flag
the client can hand the tool -- instead the client must MOVE what the tool
wrote into the agent's own `test-reports/<agent>/` directory right after the
run, BEFORE reading/ingesting it, narrowing the window rather than closing it.

RED PHASE: `_resolve_junit_path` (unit/integration/`test` tier) always
resolves one of the FIXED `target/nextest/{ci,default,<profile>}/junit.xml`
candidates (confirmed by reading the source); `_regression_ingest_run`
hardcodes `junit_path = f"{project_dir}/target/nextest/ci/junit.xml"` and
`coverage = _parse_lcov(f"{project_dir}/target/lcov.info")` -- there is no
`--agent`-aware directory anywhere in this client, no move step, and no
`test-reports/` concept at all. Every test below fails: the moved file never
appears under `test-reports/<agent>/`, the fixed tool-written path is never
even touched (nothing moves it away), and the ingest reads/posts the
ORIGINAL fixed-path content untouched by any per-agent isolation.

Toolchain: the real `cargo`/`nextest`/`llvm-cov` toolchain is never spawned
(mirrors the established convention in `test_rust_crucible_axi.py`) --
`subprocess.run` (rust-crucible.py's own module-level import, called by every
tier body via `_run_logged`) is mocked with a `side_effect` fake that plays a
real, unconfigurable nextest/llvm-cov: it ALWAYS writes its JUnit (and, for a
coverage run, lcov) fixture at the tool's own FIXED path, regardless of any
flags in the command -- exactly the "fixed by the tool" property the spec
describes -- so every assertion below proves the CLIENT's own post-run move,
never a flag the tool happens to honour.

Module-loading + HTTP-mocking convention copied verbatim from
`test_rust_crucible_axi.py`: load `clients/rust-crucible.py` by file path via
`importlib`, mock the module's `_post`/`_get` HTTP transport seam so the live
Crucible server on :3849 is NEVER touched.

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
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.test_client_fleet_envelope_census import install_project_limits

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "rust-crucible.py"

GOOD_JUNIT_XML = (
    '<?xml version="1.0"?>'
    '<testsuites><testsuite name="fixture" tests="1" failures="0">'
    '<testcase name="test_passes" time="0.001"/>'
    '</testsuite></testsuites>'
)

LCOV_FIXTURE = "TN:\nSF:src/main.rs\nFNF:1\nFNH:1\nLF:2\nLH:2\nend_of_record\n"


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


def _run_main(module, argv):
    """Invoke `module.main()` with `sys.argv` patched. Returns (code, stdout,
    stderr). Only `SystemExit` is caught; any other exception propagates so
    unittest reports it as an ERROR (still a valid RED signal)."""
    full_argv = ["rust-crucible.py"] + argv
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


class _BaseRustIsolationTest(unittest.TestCase):
    PROJECT_KEY = "test-key-rust-report-isolation"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_client_module()
        self.tmpdir = tempfile.mkdtemp(prefix="rust-crucible-report-isolation-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        install_project_limits(self.tmpdir)
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _mocked_transport(self, post_return=None):
        return (
            mock.patch.object(self.module, "_post",
                              return_value=post_return or {"ok": True}, create=True),
            mock.patch.object(self.module, "_get",
                              return_value={"ok": False}, create=True),
        )


class AgentDirectoryJunitMoveAndReadTest(_BaseRustIsolationTest):
    """AC1/AC7 -- nextest's JUnit path is fixed by the tool
    (`target/nextest/<profile>/junit.xml`); the client must MOVE it into the
    agent's own directory right after the run, BEFORE reading/ingesting it
    (narrowing, not closing, the window the tool writes it in), and read
    ONLY from there -- a stale report already sitting in the agent's own
    directory from a prior run must be cleared before the fresh moved one
    lands."""

    def test_test_run_moves_nextests_fixed_junit_into_the_agents_directory_and_wipes_stale_content_first(self):
        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-x")
        os.makedirs(own_dir, exist_ok=True)
        stale_path = os.path.join(own_dir, "junit.xml")
        with open(stale_path, "w") as f:
            f.write(_junit_suite("stale.suite", 9, 9, "stale"))

        fixed_junit = os.path.join(self.tmpdir, "target", "nextest", "ci", "junit.xml")

        def fake_subprocess_run(cmd, *args, **kwargs):
            if "nextest" in cmd:
                os.makedirs(os.path.dirname(fixed_junit), exist_ok=True)
                with open(fixed_junit, "w") as f:
                    f.write(GOOD_JUNIT_XML)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        post_patch, get_patch = self._mocked_transport()
        with mock.patch.object(self.module.subprocess, "run",
                                side_effect=fake_subprocess_run), \
             post_patch as post_mock, get_patch:
            code, out, err = _run_main(self.module, [
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
            f"between the tool writing it and the client reading it",
        )

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call, "the moved junit.xml must be ingested")
        assert ingest_call is not None
        posted_path = ingest_call[0][1].get("dataPath")
        self.assertIsNotNone(posted_path)
        with open(posted_path) as f:
            posted_content = f.read()
        self.assertNotIn(
            "stale_0", posted_content,
            f"the STALE junit already sitting in the agent's own directory "
            f"from a prior run must be WIPED before this run's fresh moved "
            f"junit lands there; {posted_path} still carries stale content",
        )
        self.assertIn(
            "test_passes", posted_content,
            f"the ingested file must be THIS run's fresh junit; "
            f"got content={posted_content!r}",
        )


class AgentDirectoryCoverageMoveAndReadTest(_BaseRustIsolationTest):
    """AC1/AC7 -- llvm-cov's coverage output is likewise fixed by the tool
    (`target/lcov.info`); the client must move it (alongside the junit its
    own run produces) into the agent's own directory before parsing it."""

    def test_regression_ingest_moves_llvm_cov_output_into_the_agents_directory_before_reading_coverage(self):
        fixed_junit = os.path.join(self.tmpdir, "target", "nextest", "ci", "junit.xml")
        fixed_lcov = os.path.join(self.tmpdir, "target", "lcov.info")

        def fake_subprocess_run(cmd, *args, **kwargs):
            if len(cmd) >= 2 and cmd[0] == "cargo" and cmd[1] == "llvm-cov":
                os.makedirs(os.path.dirname(fixed_junit), exist_ok=True)
                with open(fixed_junit, "w") as f:
                    f.write(GOOD_JUNIT_XML)
                with open(fixed_lcov, "w") as f:
                    f.write(LCOV_FIXTURE)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        post_patch, get_patch = self._mocked_transport()
        with mock.patch.object(self.module.subprocess, "run",
                                side_effect=fake_subprocess_run), \
             post_patch as post_mock, get_patch:
            code, out, err = _run_main(self.module, [
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

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the coverage-bearing run must be ingested")
        assert ingest_call is not None
        coverage = ingest_call[0][1].get("coverage")
        self.assertIsNotNone(
            coverage,
            "the ingested payload must carry the coverage parsed from the "
            "MOVED lcov.info, not an absent/fixed-path read",
        )
        self.assertEqual(coverage["lines"]["total"], 2)
        self.assertEqual(coverage["lines"]["covered"], 2)


class AgentDirectorySurvivesTest(_BaseRustIsolationTest):
    """AC3 -- the agent's directory is still there after its run, holding
    the moved junit."""

    def test_agent_directory_still_exists_after_the_run_holding_its_moved_results(self):
        fixed_junit = os.path.join(self.tmpdir, "target", "nextest", "ci", "junit.xml")

        def fake_subprocess_run(cmd, *args, **kwargs):
            if "nextest" in cmd:
                os.makedirs(os.path.dirname(fixed_junit), exist_ok=True)
                with open(fixed_junit, "w") as f:
                    f.write(GOOD_JUNIT_XML)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        post_patch, get_patch = self._mocked_transport()
        with mock.patch.object(self.module.subprocess, "run",
                                side_effect=fake_subprocess_run), \
             post_patch, get_patch:
            code, out, err = _run_main(self.module, [
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
        summary, _tree, _files = self.module._parse_junit(found[0])
        self.assertEqual(
            (summary["passed"], summary["failed"]), (1, 0),
            "the surviving directory must hold THIS run's real results",
        )


if __name__ == "__main__":
    unittest.main()
