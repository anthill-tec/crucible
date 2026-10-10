"""Report-isolation behaviour for `clients/arduino-crucible.py`, pinned
against the spec's own language
(docs/changes/CR-CRU-155-each-test-run-keeps-its-reports-to-itself.md §S1/§S3):
arduino passes the agent's own `test-reports/<agent>/` locations to `make`
via `REPORTS_DIR=`/`COVERAGE_DIR=`, a documented contract for the project's
Makefile; a Makefile that ignores them still works because the client MOVES
what it wrote into the agent's directory right after the run and SAYS SO in a
warning; the agent's directory survives the run, holding its results.

RED PHASE: `_run_native_tests_body` (clients/arduino-crucible.py) today calls
`subprocess.run(["make", target], cwd=native_dir, capture_output=True,
text=True)` with NO `env=` override at all (confirmed by reading the source),
and always globs `<native_dir>/reports/TEST-*.xml` and
`<native_dir>/coverage/lcov.info` -- ONE fixed, shared, per-project location,
regardless of `--agent`. Every test below fails: the client never sets
REPORTS_DIR/COVERAGE_DIR for the child process (an ambient value simply
passes through untouched), `test-reports/<agent>/` is never created or read,
and no move-and-warn behaviour exists for a Makefile that ignores the
contract.

Toolchain: the native HOST test harness is kept REAL, mirroring the
established precedent in `test_arduino_crucible_axi.py`
(`_write_native_make_junit_fixture`) -- a genuine `make junit` target backed
by a tiny Python helper script, no g++/hardware compile involved. Two
variants are used here: an "honouring" Makefile that writes its report/
coverage wherever REPORTS_DIR/COVERAGE_DIR point (and always records the env
values it saw, for the command-construction assertions), and an "ignoring"
legacy Makefile that always writes to its own fixed `reports/`/`coverage/`
regardless of what the client passes -- the §S3 fallback case the client must
still make work by moving the output itself.

Module-loading + HTTP-mocking convention copied verbatim from
`test_arduino_crucible_axi.py`: load `clients/arduino-crucible.py` by file
path via `importlib`, mock the module's `_post`/`_get` HTTP transport seam so
the live Crucible server on :3849 is NEVER touched.

Invocation:
    python3 -m pytest tests/client/test_arduino_crucible_agent_report_isolation.py -q
Fallback:
    python3 tests/client/test_arduino_crucible_agent_report_isolation.py
"""

import contextlib
import glob
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

from tests.client.test_client_fleet_envelope_census import install_project_limits

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "arduino-crucible.py"
TOON_PATH = REPO_ROOT / "clients" / "toon.py"

GOOD_NATIVE_JUNIT_XML = (
    '<?xml version="1.0"?>'
    '<testsuite name="native.Fixture" tests="1" failures="0">'
    '<testcase classname="native.Fixture" name="test_passes" time="0.001"/>'
    '</testsuite>'
)

LCOV_FIXTURE = "TN:\nSF:src/main.c\nFNF:1\nFNH:1\nLF:2\nLH:2\nend_of_record\n"


def _native_junit_suite(name, tests, failures, testcase_prefix):
    cases = []
    for i in range(tests):
        fail_child = ('<failure message="planted">planted failure</failure>'
                      if i < failures else "")
        cases.append(
            f'<testcase classname="{name}" name="{testcase_prefix}_{i}" '
            f'time="0.001">{fail_child}</testcase>'
        )
    return (
        '<?xml version="1.0"?>'
        f'<testsuite name="{name}" tests="{tests}" failures="{failures}">'
        + "".join(cases) + "</testsuite>"
    )


def _write_native_make_fixture(project_dir, sub="tests/native", honor_env=True,
                               write_coverage=False):
    """A REAL `make junit` target -- no g++/hardware compile, just a tiny
    helper script -- modelling the §S3 REPORTS_DIR/COVERAGE_DIR contract.

    `honor_env=True` writes the JUnit fixture (and lcov, if `write_coverage`)
    wherever REPORTS_DIR/COVERAGE_DIR point when the client sets them,
    mirroring a Makefile that HONOURS the documented contract.
    `honor_env=False` always writes to the project's own fixed `reports/`/
    `coverage/`, mirroring a legacy Makefile that IGNORES the contract -- the
    §S3 fallback the client must still make work by moving the output itself.

    Always records the REPORTS_DIR/COVERAGE_DIR values it was invoked with
    into `env_capture.json` in the native dir, for the command-construction
    assertions (regardless of whether the Makefile then honours them)."""
    native_dir = os.path.join(project_dir, *sub.split("/"))
    os.makedirs(native_dir, exist_ok=True)
    script = f'''import json
import os

reports_dir = os.environ.get("REPORTS_DIR")
coverage_dir = os.environ.get("COVERAGE_DIR")
with open("env_capture.json", "w") as fh:
    json.dump({{"REPORTS_DIR": reports_dir, "COVERAGE_DIR": coverage_dir}}, fh)

honor = {honor_env!r}
target_reports = reports_dir if (honor and reports_dir) else "reports"
os.makedirs(target_reports, exist_ok=True)
with open(os.path.join(target_reports, "TEST-Fixture.xml"), "w") as fh:
    fh.write({GOOD_NATIVE_JUNIT_XML!r})

if {write_coverage!r}:
    target_coverage = coverage_dir if (honor and coverage_dir) else "coverage"
    os.makedirs(target_coverage, exist_ok=True)
    with open(os.path.join(target_coverage, "lcov.info"), "w") as fh:
        fh.write({LCOV_FIXTURE!r})
'''
    with open(os.path.join(native_dir, "run_tests.py"), "w") as f:
        f.write(script)
    with open(os.path.join(native_dir, "Makefile"), "w") as f:
        f.write(f"junit:\n\t{sys.executable} run_tests.py\n")
    return native_dir


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module():
    return _load_module(SCRIPT_PATH, "arduino_crucible_under_test_report_isolation")


def _load_toon_module():
    return _load_module(TOON_PATH, "toon_under_test_for_arduino_report_isolation")


def _run_main(module, argv):
    """Invoke `module.main()` with `sys.argv` patched. Returns (code, stdout,
    stderr). Only `SystemExit` is caught; any other exception propagates so
    unittest reports it as an ERROR (still a valid RED signal)."""
    full_argv = ["arduino-crucible.py"] + argv
    stdout, stderr = io.StringIO(), io.StringIO()
    # os.environ is restored on exit: arduino's main() exports $AGENT_ID from --agent for its
    # children, which would otherwise leak into every later test in this process.
    with mock.patch.object(sys, "argv", full_argv), mock.patch.dict(os.environ), \
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


class _BaseArduinoIsolationTest(unittest.TestCase):
    PROJECT_KEY = "test-key-arduino-report-isolation"
    PROJECT_NAME = "fixture-firmware"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE",
               "REPORTS_DIR", "COVERAGE_DIR")

    def setUp(self):
        self.module = _load_client_module()
        self.toon = _load_toon_module()
        self.tmpdir = tempfile.mkdtemp(prefix="arduino-crucible-report-isolation-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
            f.write(f"CRUCIBLE_PROJECT_NAME={self.PROJECT_NAME}\n")
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
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _decode_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn("axi", decoded,
                      f"stdout must decode to a TOON envelope with a top-level "
                      f"'axi' key; got stdout={stdout_text!r}")
        return decoded["axi"]

    def _mocked_transport(self, post_return=None):
        return (
            mock.patch.object(self.module, "_post",
                              return_value=post_return or {"ok": True}, create=True),
            mock.patch.object(self.module, "_get",
                              return_value={"ok": False}, create=True),
        )


class AgentReportsAndCoverageDirCommandTest(_BaseArduinoIsolationTest):
    """AC7/§S3 -- arduino passes REPORTS_DIR (every run) and COVERAGE_DIR (a
    coverage run) to `make`, pointing at the agent's OWN directory --
    overriding whatever the AMBIENT environment already carried, never just
    inheriting it (the client must actively set it, not merely let it pass
    through `subprocess.run`'s default env inheritance)."""

    def test_test_run_with_agent_passes_reports_dir_pointing_at_the_agents_own_directory(self):
        native_dir = _write_native_make_fixture(self.tmpdir, honor_env=True)
        post_patch, get_patch = self._mocked_transport()
        with mock.patch.dict(os.environ, {"REPORTS_DIR": "AMBIENT-SHOULD-BE-OVERRIDDEN"}), \
             post_patch, get_patch:
            code, out, err = _run_main(self.module, [
                "test", "--project-dir", self.tmpdir, "--agent", "agent-x",
            ])

        capture_path = os.path.join(native_dir, "env_capture.json")
        self.assertTrue(
            os.path.exists(capture_path),
            f"make junit never ran; stdout={out!r} stderr={err!r}")
        with open(capture_path) as f:
            captured = json.load(f)
        expected_dir = os.path.join(self.tmpdir, "test-reports", "agent-x")
        actual = captured.get("REPORTS_DIR")
        self.assertIsNotNone(
            actual,
            "the client must set REPORTS_DIR for `make` -- it was not "
            "present in the child process's environment at all",
        )
        self.assertTrue(
            os.path.normpath(actual).startswith(os.path.normpath(expected_dir)),
            f"REPORTS_DIR must point under the agent's own directory "
            f"{expected_dir}; got {actual!r} (an ambient sentinel leaking "
            f"through unmodified would mean the client never overrides it)",
        )

    def test_regression_coverage_run_with_agent_passes_coverage_dir_pointing_at_the_agents_own_directory(self):
        native_dir = _write_native_make_fixture(self.tmpdir, honor_env=True,
                                                write_coverage=True)
        post_patch, get_patch = self._mocked_transport()
        with mock.patch.dict(os.environ, {"COVERAGE_DIR": "AMBIENT-COV-SHOULD-BE-OVERRIDDEN"}), \
             post_patch, get_patch:
            code, out, err = _run_main(self.module, [
                "regression", "--project-dir", self.tmpdir, "--agent", "agent-y",
                "--coverage",
            ])

        capture_path = os.path.join(native_dir, "env_capture.json")
        self.assertTrue(
            os.path.exists(capture_path),
            f"make junit never ran; stdout={out!r} stderr={err!r}")
        with open(capture_path) as f:
            captured = json.load(f)
        expected_dir = os.path.join(self.tmpdir, "test-reports", "agent-y")
        actual = captured.get("COVERAGE_DIR")
        self.assertIsNotNone(
            actual,
            "the client must set COVERAGE_DIR for `make` on a --coverage run")
        self.assertTrue(
            os.path.normpath(actual).startswith(os.path.normpath(expected_dir)),
            f"COVERAGE_DIR must point under the agent's own directory "
            f"{expected_dir}; got {actual!r}",
        )


class AgentDirectoryReadAndMoveTest(_BaseArduinoIsolationTest):
    """AC1/AC7 -- once REPORTS_DIR is honoured the client must read from
    there, isolated from a stale report sitting in the project's fixed
    default `reports/`; and when a legacy Makefile IGNORES the contract, the
    client must MOVE the output into the agent's directory and say so in a
    warning."""

    def test_test_run_ingests_from_the_agents_own_directory_when_the_makefile_honours_the_contract(self):
        native_dir = _write_native_make_fixture(self.tmpdir, honor_env=True)
        default_reports = os.path.join(native_dir, "reports")
        os.makedirs(default_reports, exist_ok=True)
        with open(os.path.join(default_reports, "TEST-Decoy.xml"), "w") as f:
            f.write(_native_junit_suite("native.Decoy", 4, 4, "decoy"))

        post_patch, get_patch = self._mocked_transport()
        with post_patch as post_mock, get_patch:
            code, out, err = _run_main(self.module, [
                "test", "--project-dir", self.tmpdir, "--agent", "agent-z",
            ])

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(
            ingest_call,
            f"the real make-junit run must be ingested; stdout={out!r} stderr={err!r}")
        assert ingest_call is not None
        summary = ingest_call[0][1]["summary"]
        self.assertEqual(
            (summary["passed"], summary["failed"], summary["total"]), (1, 0, 1),
            f"the ingested summary must reflect ONLY the fresh report the "
            f"Makefile wrote under REPORTS_DIR (1 passed) -- the 4 stale "
            f"decoy failures sitting in the project's fixed default "
            f"reports/ must not be read; got summary={summary!r}",
        )
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

    def test_test_run_moves_output_into_the_agents_directory_and_warns_when_the_makefile_ignores_the_contract(self):
        native_dir = _write_native_make_fixture(self.tmpdir, honor_env=False)
        post_patch, get_patch = self._mocked_transport()
        with post_patch, get_patch:
            code, out, err = _run_main(self.module, [
                "test", "--project-dir", self.tmpdir, "--agent", "agent-legacy",
            ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-legacy")
        moved = glob.glob(os.path.join(own_dir, "**", "TEST-*.xml"), recursive=True)
        self.assertEqual(
            len(moved), 1,
            f"a Makefile that writes to its own fixed reports/ (ignoring "
            f"REPORTS_DIR) must still end up with its output MOVED into "
            f"{own_dir}; found {moved!r}",
        )
        self.assertFalse(
            os.path.exists(os.path.join(native_dir, "reports", "TEST-Fixture.xml")),
            "the report must be MOVED out of the project's fixed reports/, "
            "not merely copied, once the client relocates a Makefile's "
            "ignored output",
        )

        axi = self._decode_axi(out)
        warnings = axi.get("warnings") or []
        self.assertTrue(
            any("reports_dir" in str(w.get("detail", "")).lower() for w in warnings),
            f"a Makefile that ignored REPORTS_DIR must be called out in a "
            f"warning naming it; got warnings={warnings!r}",
        )


class AgentDirectorySurvivesTest(_BaseArduinoIsolationTest):
    """AC3 -- the agent's directory is still there after its run, holding
    that run's results."""

    def test_agent_directory_still_exists_after_the_run_holding_its_results(self):
        _write_native_make_fixture(self.tmpdir, honor_env=True)
        post_patch, get_patch = self._mocked_transport()
        with post_patch, get_patch:
            code, out, err = _run_main(self.module, [
                "test", "--project-dir", self.tmpdir, "--agent", "agent-w",
            ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-w")
        self.assertTrue(
            os.path.isdir(own_dir),
            f"{own_dir} must still exist after the run")
        found = glob.glob(os.path.join(own_dir, "**", "TEST-*.xml"), recursive=True)
        self.assertEqual(
            len(found), 1,
            f"expected exactly one surviving report under {own_dir}; found {found!r}",
        )


if __name__ == "__main__":
    unittest.main()


class AgentDirectoryCoverageIgnoredByMakefileMoveAndReadTest(_BaseArduinoIsolationTest):
    """AC7 -- when a Makefile ignores BOTH REPORTS_DIR and COVERAGE_DIR (writes
    its own fixed reports/ and coverage/), the client must move BOTH the
    JUnit AND the lcov into the agent's own directory, warn about the
    ignored COVERAGE_DIR specifically, and ingest coverage parsed from the
    MOVED lcov.info -- never the one left (or since-moved-away) at the
    project's fixed <native_dir>/coverage/lcov.info."""

    def test_regression_coverage_run_moves_lcov_into_the_agents_directory_and_warns_about_coverage_dir(self):
        native_dir = _write_native_make_fixture(self.tmpdir, honor_env=False,
                                                write_coverage=True)
        post_patch, get_patch = self._mocked_transport()
        with post_patch as post_mock, get_patch:
            code, out, err = _run_main(self.module, [
                "regression", "--project-dir", self.tmpdir,
                "--agent", "agent-cov-legacy", "--coverage",
            ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        own_dir = os.path.join(self.tmpdir, "test-reports", "agent-cov-legacy")
        own_lcov = os.path.join(own_dir, "coverage", "lcov.info")
        self.assertTrue(
            os.path.exists(own_lcov),
            f"the Makefile's ignored lcov.info must be MOVED into {own_lcov}; "
            f"stdout={out!r} stderr={err!r}",
        )
        self.assertFalse(
            os.path.exists(os.path.join(native_dir, "coverage", "lcov.info")),
            "lcov.info must be MOVED out of the project's fixed coverage/, "
            "not merely copied, once the client relocates a Makefile's "
            "ignored coverage output",
        )

        axi = self._decode_axi(out)
        warnings = axi.get("warnings") or []
        self.assertTrue(
            any("coverage_dir" in str(w.get("detail", "")).lower() for w in warnings),
            f"a Makefile that ignored COVERAGE_DIR must be called out in a "
            f"warning naming it; got warnings={warnings!r}",
        )

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, f"stdout={out!r} stderr={err!r}")
        assert ingest_call is not None
        coverage = ingest_call[0][1].get("coverage")
        self.assertIsNotNone(
            coverage,
            "the ingested payload must carry coverage parsed from the MOVED "
            "lcov.info, not an absent/fixed-path read",
        )
        assert coverage is not None
        self.assertEqual(
            (coverage["lines"]["total"], coverage["lines"]["covered"]), (2, 2),
            f"the ingested line coverage must reflect the MOVED lcov's real "
            f"fixture values (LF:2/LH:2); got coverage={coverage!r}",
        )
        self.assertEqual(
            (coverage["functions"]["total"], coverage["functions"]["covered"]), (1, 1),
            f"the ingested function coverage must reflect the MOVED lcov's "
            f"real fixture values (FNF:1/FNH:1); got coverage={coverage!r}",
        )


class ReportsHelpTextTest(_BaseArduinoIsolationTest):
    """AC9 -- the `--reports` help text states the per-agent default."""

    def test_test_verb_reports_help_states_the_per_agent_default(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
             mock.patch.object(sys, "argv", ["arduino-crucible.py", "test", "--help"]), \
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
