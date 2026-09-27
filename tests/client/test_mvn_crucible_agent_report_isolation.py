"""Report-isolation behaviour for `clients/mvn-crucible.py`, pinned against
the spec's own language: an agent's run reports into its OWN directory
(docs/changes/CR-CRU-155-each-test-run-keeps-its-reports-to-itself.md §S1/§S3):
mvn passes `test-reports/<agent>/` to surefire AND failsafe
(`-Dsurefire.reportsDirectory`, `-Dfailsafe.reportsDirectory`) and reads from
there afterwards; the directory survives the run.

RED PHASE: `mvn-crucible.py` today builds NO `-Dsurefire.reportsDirectory`/
`-Dfailsafe.reportsDirectory` flag anywhere (confirmed by reading the source:
`_common_mvn_flags` only ever emits `-B`/`-pl`/`-U`/`-Dnative`/`-P`/`-D<k>=<v>`
from `--system-prop`), has no `--reports` flag at all, and `_report_dirs`
always resolves the ONE fixed `<maven_dir>/target/{surefire,failsafe}-reports`
(or `<maven_dir>/<module>/target/...`) regardless of `--agent`. Every test
below therefore fails: either the expected `-D*.reportsDirectory=<agent dir>`
flag is simply absent from the built command, or the agent's own
`test-reports/<agent>/` directory never gets created/read at all because
nothing in the client resolves it. Both are valid RED (missing behaviour, not
a crash).

Toolchain: the REAL `mvn`/`mvnw` invocation is never spawned. `_run_logged`
(mvn-crucible.py's own subprocess wrapper, called by every tier body) is
mocked with a `side_effect` fake that plays the part of a real,
property-respecting Surefire/Failsafe: it inspects the built `cmd` for
`-Dsurefire.reportsDirectory=`/`-Dfailsafe.reportsDirectory=` and writes its
JUnit fixture there when present, falling back to Maven's own real default
(`target/{surefire,failsafe}-reports`) when absent -- exactly what real
Surefire/Failsafe do. This lets every assertion below run against the ACTUAL
command list the client built and the ACTUAL filesystem paths it reads from,
without ever touching a real Maven Wrapper/JVM (mirrors the `_run_logged`
mock already established in `tests/client/test_cr040_coverage_tooling.py` for
the python client's own subprocess seam).

Module-loading + HTTP-mocking convention copied verbatim from
`test_mvn_crucible_axi.py`: load `clients/mvn-crucible.py` by file path via
`importlib`, mock the module's `_post`/`_get` HTTP transport seam so the live
Crucible server on :3849 is NEVER touched.

Invocation:
    python3 -m pytest tests/client/test_mvn_crucible_agent_report_isolation.py -q
Fallback:
    python3 tests/client/test_mvn_crucible_agent_report_isolation.py
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
SCRIPT_PATH = REPO_ROOT / "clients" / "mvn-crucible.py"


def _junit_suite(name, tests, failures, testcase_prefix):
    """A hand-written Surefire/Failsafe-shaped `<testsuite>` with `tests`
    testcases, the first `failures` of them carrying a `<failure>` child --
    lets a fixture assert a SPECIFIC pass/fail split rather than a single
    trivially-passing case."""
    cases = []
    for i in range(tests):
        fail_child = ('<failure message="planted">planted failure</failure>'
                      if i < failures else "")
        cases.append(
            f'<testcase classname="{name}" name="{testcase_prefix}_{i}" '
            f'time="0.001">{fail_child}</testcase>'
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<testsuite name="{name}" tests="{tests}" failures="{failures}" errors="0">'
        + "".join(cases) + "</testsuite>"
    )


def _flag_value(cmd, prefix):
    for arg in cmd:
        if arg.startswith(prefix):
            return arg[len(prefix):]
    return None


def _make_fake_mvn_run(surefire_content=None, failsafe_content=None):
    """A `_run_logged` `side_effect`: plays a real, property-respecting
    Surefire/Failsafe -- writes each report to the `-D*.reportsDirectory=`
    the command names, defaulting to Maven's OWN real default
    (`<cwd>/target/{surefire,failsafe}-reports`) exactly as the real tool does
    when the property is absent. Returns a `subprocess.CompletedProcess` the
    way `_run_logged` itself would."""
    def _fake(cmd, cwd, env, log_path, narrator=None):
        if surefire_content is not None:
            surefire_dir = (_flag_value(cmd, "-Dsurefire.reportsDirectory=")
                            or os.path.join(cwd, "target", "surefire-reports"))
            os.makedirs(surefire_dir, exist_ok=True)
            with open(os.path.join(surefire_dir, "TEST-Fixture.xml"), "w") as f:
                f.write(surefire_content)
        if failsafe_content is not None:
            failsafe_dir = (_flag_value(cmd, "-Dfailsafe.reportsDirectory=")
                            or os.path.join(cwd, "target", "failsafe-reports"))
            os.makedirs(failsafe_dir, exist_ok=True)
            with open(os.path.join(failsafe_dir, "TEST-FixtureIT.xml"), "w") as f:
                f.write(failsafe_content)
        return subprocess.CompletedProcess(cmd, 0, stdout="")
    return _fake


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module():
    return _load_module(SCRIPT_PATH, "mvn_crucible_under_test_report_isolation")


def _run_main(module, argv):
    """Invoke `module.main()` with `sys.argv` patched. Returns (code, stdout,
    stderr). Only `SystemExit` is caught; any other exception propagates so
    unittest reports it as an ERROR (still a valid RED signal)."""
    full_argv = ["mvn-crucible.py"] + argv
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


class _BaseMvnIsolationTest(unittest.TestCase):
    PROJECT_KEY = "test-key-mvn-report-isolation"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_client_module()
        self.tmpdir = tempfile.mkdtemp(prefix="mvn-crucible-report-isolation-")
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


class AgentSurefireFailsafeReportsDirectoryCommandTest(_BaseMvnIsolationTest):
    """AC7/§S3 -- mvn passes the agent's OWN `test-reports/<agent>/` to
    surefire (unit/module tiers) and to BOTH surefire and failsafe
    (integration/e2e tiers) via `-Dsurefire.reportsDirectory`/
    `-Dfailsafe.reportsDirectory`, asserted on the ACTUAL command list the
    client built for `_run_logged`."""

    def test_unit_run_with_agent_passes_surefire_reports_directory_at_the_agents_own_directory(self):
        fake_run = _make_fake_mvn_run(
            surefire_content=_junit_suite("com.acme.FixtureTest", 1, 0, "test_passes"))
        post_patch, get_patch = self._mocked_transport()
        with mock.patch.object(self.module, "_run_logged",
                                side_effect=fake_run) as run_logged_mock, \
             post_patch, get_patch:
            code, out, err = _run_main(self.module, [
                "unit", "--project-dir", self.tmpdir, "--agent", "agent-x",
                "--test", "FixtureTest",
            ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertEqual(run_logged_mock.call_count, 1)

        cmd = run_logged_mock.call_args_list[0][0][0]
        expected_dir = os.path.join(self.tmpdir, "test-reports", "agent-x")
        surefire_flags = [a for a in cmd if a.startswith("-Dsurefire.reportsDirectory=")]
        self.assertEqual(
            len(surefire_flags), 1,
            f"expected exactly ONE -Dsurefire.reportsDirectory flag pointing "
            f"at the agent's own directory in the mvn command; got cmd={cmd!r}",
        )
        self.assertEqual(
            os.path.normpath(surefire_flags[0].split("=", 1)[1]),
            os.path.normpath(expected_dir),
            f"-Dsurefire.reportsDirectory must point at {expected_dir}; "
            f"got {surefire_flags[0]!r}",
        )

    def test_integration_run_with_agent_passes_both_surefire_and_failsafe_reports_directory_flags(self):
        fake_run = _make_fake_mvn_run(
            surefire_content=_junit_suite("com.acme.FixtureTest", 1, 0, "test_passes"),
            failsafe_content=_junit_suite("com.acme.FixtureIT", 1, 0, "test_passes_it"),
        )
        post_patch, get_patch = self._mocked_transport()
        with mock.patch.object(self.module, "_run_logged",
                                side_effect=fake_run) as run_logged_mock, \
             post_patch, get_patch:
            code, out, err = _run_main(self.module, [
                "integration", "--project-dir", self.tmpdir, "--agent", "agent-y",
            ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        cmd = run_logged_mock.call_args_list[0][0][0]
        expected_dir = os.path.join(self.tmpdir, "test-reports", "agent-y")
        for prop in ("surefire.reportsDirectory", "failsafe.reportsDirectory"):
            flags = [a for a in cmd if a.startswith(f"-D{prop}=")]
            self.assertEqual(
                len(flags), 1,
                f"expected exactly one -D{prop} flag in the mvn command; "
                f"got cmd={cmd!r}",
            )
            self.assertEqual(
                os.path.normpath(flags[0].split("=", 1)[1]),
                os.path.normpath(expected_dir),
                f"-D{prop} must point at {expected_dir}; got {flags[0]!r}",
            )


class AgentDirectoryReadIsolationTest(_BaseMvnIsolationTest):
    """AC1/AC7 -- once mvn is TOLD to write into the agent's own directory,
    the client must READ from there too: a stale report already sitting in
    the shared `target/{surefire,failsafe}-reports/` (today's ONE fixed
    location, shared by every run/agent) must not leak into this run's
    ingested summary."""

    def test_integration_run_ingests_only_its_own_fresh_reports_not_stale_ones_in_shared_target(self):
        stale_surefire_dir = os.path.join(self.tmpdir, "target", "surefire-reports")
        stale_failsafe_dir = os.path.join(self.tmpdir, "target", "failsafe-reports")
        os.makedirs(stale_surefire_dir, exist_ok=True)
        os.makedirs(stale_failsafe_dir, exist_ok=True)
        with open(os.path.join(stale_surefire_dir, "TEST-Stale.xml"), "w") as f:
            f.write(_junit_suite("com.acme.StaleTest", 5, 5, "stale_su"))
        with open(os.path.join(stale_failsafe_dir, "TEST-StaleIT.xml"), "w") as f:
            f.write(_junit_suite("com.acme.StaleIT", 3, 3, "stale_fs"))

        fake_run = _make_fake_mvn_run(
            surefire_content=_junit_suite("com.acme.FixtureTest", 1, 0, "test_passes"),
            failsafe_content=_junit_suite("com.acme.FixtureIT", 1, 0, "test_passes_it"),
        )
        post_patch, get_patch = self._mocked_transport()
        with mock.patch.object(self.module, "_run_logged", side_effect=fake_run), \
             post_patch as post_mock, get_patch:
            code, out, err = _run_main(self.module, [
                "integration", "--project-dir", self.tmpdir, "--agent", "agent-z",
            ])

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(
            ingest_call,
            f"an integration run (>1 report dir) must ingest via "
            f"/api/v2/runs/parsed; stdout={out!r} stderr={err!r}",
        )
        assert ingest_call is not None
        summary = ingest_call[0][1]["summary"]
        self.assertEqual(
            (summary["passed"], summary["failed"], summary["total"]), (2, 0, 2),
            f"the ingested summary must reflect ONLY this run's own fresh "
            f"reports (2 passed, 0 failed) written under the agent's own "
            f"directory -- the 8 stale planted failures sitting in the "
            f"shared target/{{surefire,failsafe}}-reports/ must not be read "
            f"at all once the agent's own directory is used; "
            f"got summary={summary!r}",
        )
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        # The stale planted files belong to the SHARED location, not this
        # agent's own directory -- they must survive byte-for-byte.
        with open(os.path.join(stale_surefire_dir, "TEST-Stale.xml")) as f:
            self.assertIn("stale_su_0", f.read())
        with open(os.path.join(stale_failsafe_dir, "TEST-StaleIT.xml")) as f:
            self.assertIn("stale_fs_0", f.read())


class AgentDirectorySurvivesTest(_BaseMvnIsolationTest):
    """AC3 -- the agent's directory is still there after its run, holding
    that run's results."""

    def test_agent_directory_still_exists_after_unit_run_holding_its_results(self):
        fake_run = _make_fake_mvn_run(
            surefire_content=_junit_suite("com.acme.FixtureTest", 1, 0, "test_passes"))
        post_patch, get_patch = self._mocked_transport()
        with mock.patch.object(self.module, "_run_logged", side_effect=fake_run), \
             post_patch, get_patch:
            code, out, err = _run_main(self.module, [
                "unit", "--project-dir", self.tmpdir, "--agent", "agent-w",
                "--test", "FixtureTest",
            ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-w")
        self.assertTrue(
            os.path.isdir(own_dir),
            f"the agent's own reports directory must still exist after the "
            f"run, holding this run's surefire results; {own_dir} does not exist",
        )
        found = glob.glob(os.path.join(own_dir, "**", "TEST-*.xml"), recursive=True)
        self.assertEqual(
            len(found), 1,
            f"expected exactly one surviving TEST-*.xml under {own_dir}; found {found!r}",
        )
        summary, _tree, _files = self.module._parse_junit([os.path.dirname(found[0])])
        self.assertEqual(
            (summary["passed"], summary["failed"]), (1, 0),
            "the surviving directory must hold THIS run's real results",
        )


if __name__ == "__main__":
    unittest.main()
