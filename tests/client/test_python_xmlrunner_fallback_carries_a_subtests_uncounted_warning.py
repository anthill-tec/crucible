"""When the project's interpreter's `xmlrunner` package IMPORTS but offers no
`xmlrunner.result._XMLTestResult` (or the runner/program classes built on it)
for `clients/subtest_runner.py` to extend, the runner falls back to running
xmlrunner's own entry point directly (`runpy.run_module("xmlrunner",
run_name="__main__", alter_sys=True)`, already the behaviour measured off
`subtest_runner.main`/`_extendable`). What is NOT built yet:

* the runner never states the fallback anywhere on its output before that
  entry point runs, naming the xmlrunner version it found (or that none is
  declared) -- it just silently delegates;
* the python client never carries a structured `{"code":
  "subtests-uncounted", "detail": ...}` warning on the envelope of a run that
  hit this fallback, through ANY of the four shapes a run can take (filed,
  ran-nothing, no-report/compile, interrupted), through either `test` or
  `regression`.

This file drives the REAL `python-crucible.py` `test` and `regression` verbs
against a real interpreter (the repo's own `.venv`, so `importlib.util.
find_spec("xmlrunner")` succeeds) whose `sys.path` is given a FAKE
`xmlrunner` package -- a bare `__init__.py` declaring a `__version__` the
real package never carries, plus an `__main__.py` standing in for
xmlrunner's own entry point, with no `result.py`/`runner.py` submodules at
all, so `subtest_runner._extendable()` finds nothing to extend and falls
back exactly as it does for a real xmlrunner release this old -- against a
live in-process HTTP board double, the same `RecordingBoard` the sibling
live-run tests already use, and decodes the real TOON-AXI envelope
`python-crucible.py` prints on stdout (`clients/toon.py`, loaded the way the
sibling fixture-drive tests already load it) to inspect `warnings[]`.

Fixture names, the fake package's declared version string and its
`__main__.py`'s env-var contract are chosen for this file alone and carry no
significance beyond it."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.live_run_harness import (
    RecordingBoard,
    install_project,
    load_client,
    load_toon,
    scrubbed_env,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS = REPO_ROOT / "clients"
SCRIPT_PATH = CLIENTS / "python-crucible.py"
REAL_VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"

AGENT = "xmlrunner-fallback-fixture-agent"
PROJECT_KEY = "xmlrunner-fallback-fixture-key"

# Deliberately NOT the real unittest-xml-reporting version string, so a
# detail naming it can only have come from THIS fake package.
FAKE_VERSION = "9.9.9-fake-xmlrunner-no-extend"

WARNING_CODE = "subtests-uncounted"

# A fake `xmlrunner` package holding only `__init__.py` + `__main__.py` -- no
# `result.py`/`runner.py` at all, so `importlib.import_module("xmlrunner.
# result")` raises ImportError and `subtest_runner._extendable()` returns
# None, exactly the "offers no result class to extend" condition. Its
# `__main__.py` stands in for xmlrunner's own entry point: it reads `-o
# <dir>` off its argv (the one flag `_runner_args`/`runpy.run_module` leaves
# intact) and, driven entirely by env vars, can print a liveness marker and
# block (for the interrupted-run drive), write no report at all with a
# traceback on stderr (the no-report/compile shape), write a report holding
# zero results (the ran-nothing shape), or write a small all-passing report
# (the filed shape) -- xmlrunner's own counts, uncounted by anything this
# cycle's runner does differently.
FAKE_XMLRUNNER_MAIN_BODY = '''\
import os
import sys
import time

argv = sys.argv[1:]
outdir = None
for i, a in enumerate(argv):
    if a == "-o" and i + 1 < len(argv):
        outdir = argv[i + 1]

marker = os.environ.get("FAKE_XMLRUNNER_MARKER")
if marker:
    sys.stderr.write(marker + "\\n")
    sys.stderr.flush()

release_file = os.environ.get("FAKE_XMLRUNNER_RELEASE_FILE")
if release_file:
    deadline = time.time() + 20
    while not os.path.exists(release_file) and time.time() < deadline:
        time.sleep(0.02)

mode = os.environ.get("FAKE_XMLRUNNER_MODE", "filed")
exit_code = int(os.environ.get("FAKE_XMLRUNNER_EXIT_CODE", "0"))

if mode == "no-report":
    sys.stderr.write("Traceback (most recent call last):\\n")
    sys.stderr.write("ImportError: boom\\n")
    sys.exit(exit_code or 1)

if outdir:
    os.makedirs(outdir, exist_ok=True)
    report_path = os.path.join(outdir, "TEST-fake_fallback.FallbackCase.xml")
    if mode == "ran-nothing":
        with open(report_path, "w") as f:
            f.write(
                "<?xml version=\\"1.0\\"?><testsuite "
                "name=\\"fake_fallback.FallbackCase\\" tests=\\"0\\" "
                "errors=\\"0\\" failures=\\"0\\" skipped=\\"0\\"></testsuite>")
        sys.exit(exit_code or 1)
    with open(report_path, "w") as f:
        f.write(
            "<?xml version=\\"1.0\\"?><testsuite "
            "name=\\"fake_fallback.FallbackCase\\" tests=\\"2\\" errors=\\"0\\" "
            "failures=\\"0\\" skipped=\\"0\\">"
            "<testcase classname=\\"fake_fallback.FallbackCase\\" "
            "name=\\"test_one\\" time=\\"0.001\\"></testcase>"
            "<testcase classname=\\"fake_fallback.FallbackCase\\" "
            "name=\\"test_two\\" time=\\"0.001\\"></testcase></testsuite>")
sys.exit(exit_code)
'''


def _write_fake_xmlrunner_package(root_dir):
    pkg_dir = os.path.join(root_dir, "xmlrunner")
    os.makedirs(pkg_dir, exist_ok=True)
    with open(os.path.join(pkg_dir, "__init__.py"), "w", encoding="utf-8") as f:
        f.write(f'__version__ = "{FAKE_VERSION}"\n')
    with open(os.path.join(pkg_dir, "__main__.py"), "w", encoding="utf-8") as f:
        f.write(FAKE_XMLRUNNER_MAIN_BODY)
    return root_dir


# A plain fixture with no `subTest` at all -- used only for the "a real,
# extendable xmlrunner never carries this warning" negative check, which
# must drive the REAL installed unittest-xml-reporting, not the fake above.
NO_SUBTEST_FIXTURE_SOURCE = '''\
import unittest

class PlainOnlyCase(unittest.TestCase):
    def test_one(self):
        self.assertEqual(1 + 1, 2)
'''


def _run_main(module, argv):
    """`module.main()` with `sys.argv` patched -- real argparse dispatch, the
    same helper the sibling fixture-drive test files already use."""
    import contextlib
    import io
    from unittest import mock as _mock

    full_argv = ["python-crucible.py"] + list(argv)
    stdout, stderr = io.StringIO(), io.StringIO()
    with _mock.patch.object(sys, "argv", full_argv), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            module.main()
            code = 0
        except SystemExit as exc:
            if exc.code is None:
                code = 0
            elif isinstance(exc.code, int):
                code = exc.code
            else:
                code = 1
    return code, stdout.getvalue(), stderr.getvalue()


def _decode_axi(toon_mod, stdout_text):
    decoded = toon_mod.decode(stdout_text)
    assert "axi" in decoded, f"no TOON-AXI envelope on stdout; got {stdout_text!r}"
    return decoded["axi"]


def _subtests_uncounted_warning(axi):
    for w in axi.get("warnings", []):
        if isinstance(w, dict) and w.get("code") == WARNING_CODE:
            return w
    return None


def _last_parsed_or_compile_payload(board):
    for path, body in reversed(board.posts()):
        if path in ("/api/v2/runs/parsed", "/api/v2/runs/compile"):
            return path, body
    return None, None


class _FallbackCase(unittest.TestCase):
    """Shared fixture-drive: a fresh throwaway project, a fresh in-process
    HTTP board double, the real `python-crucible.py` loaded by file path and
    driven in-process (`module.main()`), against a REAL interpreter
    (`REAL_VENV_PYTHON`) whose `sys.path` is steered onto the fake
    `xmlrunner` package above via `PYTHONPATH` -- the same technique the
    shipped fleet's own TypeScript fixtures already use to fake `xmlrunner`
    for other clients, applied here through the real python client's own
    `--python`/env plumbing."""

    def setUp(self):
        self.assertTrue(
            REAL_VENV_PYTHON.exists(),
            f"this file needs a real interpreter with unittest-xml-reporting "
            f"4.0.0 installed; expected one at {REAL_VENV_PYTHON}")

    def _run_scenario(self, verb_argv, *, mode, exit_code=None, extra_env=None):
        project_dir = tempfile.mkdtemp(prefix="xmlrunner-fallback-")
        self.addCleanup(shutil.rmtree, project_dir, ignore_errors=True)
        board = RecordingBoard()
        self.addCleanup(board.close)
        install_project(project_dir, board.url, PROJECT_KEY)
        pkg_dir = os.path.join(project_dir, "pkg")
        os.makedirs(pkg_dir, exist_ok=True)
        Path(os.path.join(pkg_dir, "__init__.py")).write_text("", encoding="utf-8")
        fake_root = tempfile.mkdtemp(prefix="fake-xmlrunner-root-")
        self.addCleanup(shutil.rmtree, fake_root, ignore_errors=True)
        _write_fake_xmlrunner_package(fake_root)

        env_overrides = {"PYTHONPATH": fake_root, "FAKE_XMLRUNNER_MODE": mode}
        if exit_code is not None:
            env_overrides["FAKE_XMLRUNNER_EXIT_CODE"] = str(exit_code)
        if extra_env:
            env_overrides.update(extra_env)
        saved_env = {}
        for key, value in env_overrides.items():
            saved_env[key] = os.environ.get(key)
            os.environ[key] = value
        try:
            module = load_client("python-crucible.py")
            toon_mod = load_toon()
            argv = list(verb_argv) + [
                "--start-dir", "pkg", "--pattern", "fixture_unused.py",
                "--project-dir", project_dir, "--agent", AGENT,
                "--python", str(REAL_VENV_PYTHON)]
            code, out, err = _run_main(module, argv)
        finally:
            for key, old in saved_env.items():
                if old is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = old
        axi = _decode_axi(toon_mod, out)
        return code, out, err, board, axi

    def _run_real_xmlrunner_scenario(self, verb_argv):
        """The negative-check drive: no PYTHONPATH override at all, so the
        real interpreter's own installed unittest-xml-reporting 4.0.0 is
        reached -- extendable, no fallback, no warning."""
        project_dir = tempfile.mkdtemp(prefix="xmlrunner-real-")
        self.addCleanup(shutil.rmtree, project_dir, ignore_errors=True)
        board = RecordingBoard()
        self.addCleanup(board.close)
        install_project(project_dir, board.url, PROJECT_KEY)
        pkg_dir = os.path.join(project_dir, "pkg")
        os.makedirs(pkg_dir, exist_ok=True)
        Path(os.path.join(pkg_dir, "__init__.py")).write_text("", encoding="utf-8")
        Path(os.path.join(pkg_dir, "fixture_plain.py")).write_text(
            NO_SUBTEST_FIXTURE_SOURCE, encoding="utf-8")
        module = load_client("python-crucible.py")
        toon_mod = load_toon()
        argv = list(verb_argv) + [
            "--start-dir", "pkg", "--pattern", "fixture_plain.py",
            "--project-dir", project_dir, "--agent", AGENT,
            "--python", str(REAL_VENV_PYTHON)]
        code, out, err = _run_main(module, argv)
        axi = _decode_axi(toon_mod, out)
        return code, out, err, board, axi


VERB_VARIANTS = (
    ("test", ["test"]),
    ("regression", ["regression"]),
)


class AFiledRunCarriesTheWarningTest(_FallbackCase):
    """"a filed run" -- the fallback still files xmlrunner's own counts, with
    the fallback warning on the envelope, through `test` and `regression`."""

    def test_filed_run_carries_the_subtests_uncounted_warning_naming_the_version(self):
        for verb_label, verb_argv in VERB_VARIANTS:
            with self.subTest(verb=verb_label):
                code, out, err, board, axi = self._run_scenario(
                    verb_argv, mode="filed")
                warning = _subtests_uncounted_warning(axi)
                self.assertIsNotNone(
                    warning,
                    f"{verb_label}: a run that fell back to xmlrunner's own "
                    f"entry point (no result class to extend) must carry a "
                    f"{WARNING_CODE!r} warning on its envelope; got "
                    f"warnings={axi.get('warnings')!r} stdout={out!r} "
                    f"stderr={err!r}")
                assert warning is not None  # narrowed by the assert above
                self.assertIn(
                    FAKE_VERSION, str(warning.get("detail", "")),
                    f"{verb_label}: the warning's detail must name the "
                    f"xmlrunner version this fallback found; got "
                    f"detail={warning.get('detail')!r}")
                # The run is still FILED with xmlrunner's own counts, and the
                # exit stays the runner's own (a clean 2-passed report exits
                # 0, same as any other filed green run).
                self.assertEqual(
                    code, 0,
                    f"{verb_label}: a filed all-passing run's exit must stay "
                    f"unchanged by the warning; got code={code} stdout={out!r}")
                run_summary = axi.get("run") or {}
                self.assertEqual(
                    run_summary.get("total"), 2,
                    f"{verb_label}: the run must be filed with xmlrunner's "
                    f"OWN counts (2 cases, none recounted); got "
                    f"run={run_summary!r}")
                self.assertEqual(run_summary.get("failed"), 0, run_summary)
                path, payload = _last_parsed_or_compile_payload(board)
                self.assertEqual(
                    path, "/api/v2/runs/parsed",
                    f"{verb_label}: a filed run must reach the board's "
                    f"parsed-ingest path; posts={board.posts()!r}")
                self.assertEqual(
                    (payload or {}).get("summary", {}).get("total"), 2,
                    f"{verb_label}: the board must store the SAME total "
                    f"xmlrunner's own report carried; payload={payload!r}")


class ARanNothingRunCarriesTheWarningTest(_FallbackCase):
    """"a run that ran nothing" -- a report that exists but holds zero
    results, with a non-zero exit, still carries the fallback warning."""

    def test_ran_nothing_run_carries_the_subtests_uncounted_warning(self):
        for verb_label, verb_argv in VERB_VARIANTS:
            with self.subTest(verb=verb_label):
                code, out, err, board, axi = self._run_scenario(
                    verb_argv, mode="ran-nothing", exit_code=1)
                self.assertIs(
                    axi.get("ok"), False,
                    f"{verb_label}: a run that ran nothing must still be "
                    f"ok:false; got axi={axi!r}")
                self.assertNotEqual(
                    code, 0,
                    f"{verb_label}: a ran-nothing run's non-zero exit must "
                    f"stay unchanged; got code={code}")
                warning = _subtests_uncounted_warning(axi)
                self.assertIsNotNone(
                    warning,
                    f"{verb_label}: a ran-nothing run that hit the fallback "
                    f"must still carry the {WARNING_CODE!r} warning; got "
                    f"warnings={axi.get('warnings')!r} stdout={out!r} "
                    f"stderr={err!r}")
                assert warning is not None  # narrowed by the assert above
                self.assertIn(FAKE_VERSION, str(warning.get("detail", "")))


class ANoReportCompileFailureCarriesTheWarningTest(_FallbackCase):
    """"a run that wrote no report and is filed as a compile failure" --
    xmlrunner's own entry point dying before writing anything still carries
    the fallback warning."""

    def test_no_report_compile_failure_carries_the_subtests_uncounted_warning(self):
        for verb_label, verb_argv in VERB_VARIANTS:
            with self.subTest(verb=verb_label):
                code, out, err, board, axi = self._run_scenario(
                    verb_argv, mode="no-report", exit_code=1)
                self.assertIs(
                    axi.get("ok"), False,
                    f"{verb_label}: a no-report run must be ok:false; got "
                    f"axi={axi!r}")
                self.assertNotEqual(code, 0, f"{verb_label}: code={code}")
                warning = _subtests_uncounted_warning(axi)
                self.assertIsNotNone(
                    warning,
                    f"{verb_label}: a run filed as a compile failure after "
                    f"the fallback wrote no report must still carry the "
                    f"{WARNING_CODE!r} warning; got "
                    f"warnings={axi.get('warnings')!r} stdout={out!r} "
                    f"stderr={err!r}")
                assert warning is not None  # narrowed by the assert above
                self.assertIn(FAKE_VERSION, str(warning.get("detail", "")))
                path, _payload = _last_parsed_or_compile_payload(board)
                self.assertEqual(
                    path, "/api/v2/runs/compile",
                    f"{verb_label}: a no-report run must still be filed as "
                    f"a COMPILE failure; posts={board.posts()!r}")


class AnInterruptedRunCarriesTheWarningTest(unittest.TestCase):
    """"an interrupted run" -- the fallback marker reaches the client's live
    output (narrated as it streams) before the fake entry point blocks mid-
    run; a real SIGTERM lands while it is blocked, and the ONE ok:false exit
    envelope must still carry the fallback warning, through `test` and
    `regression`."""

    def setUp(self):
        self.assertTrue(
            REAL_VENV_PYTHON.exists(),
            f"this file needs a real interpreter with unittest-xml-reporting "
            f"4.0.0 installed; expected one at {REAL_VENV_PYTHON}")
        self.project_dir = tempfile.mkdtemp(prefix="xmlrunner-fallback-interrupt-")
        self.addCleanup(shutil.rmtree, self.project_dir, ignore_errors=True)
        self.fake_root = tempfile.mkdtemp(prefix="fake-xmlrunner-root-interrupt-")
        self.addCleanup(shutil.rmtree, self.fake_root, ignore_errors=True)
        _write_fake_xmlrunner_package(self.fake_root)
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        install_project(self.project_dir, self.board.url, PROJECT_KEY)
        pkg_dir = os.path.join(self.project_dir, "pkg")
        os.makedirs(pkg_dir, exist_ok=True)
        Path(os.path.join(pkg_dir, "__init__.py")).write_text("", encoding="utf-8")

    def _drive_and_signal(self, cmd, env, marker, signum, timeout=30):
        """Spawn `cmd` as a REAL process, read its real stderr until `marker`
        is seen (the fake entry point's own liveness line, echoed live by
        the client's `run_streamed`), signal the CLIENT process, then
        collect its final stdout (the one AXI envelope an interrupted run
        still prints)."""
        proc = subprocess.Popen(cmd, cwd=self.project_dir, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        reached = False
        stderr_chunks = []
        try:
            assert proc.stderr is not None
            for line in proc.stderr:
                stderr_chunks.append(line)
                if marker in line:
                    reached = True
                    break
            if reached:
                proc.send_signal(signum)
            try:
                stdout, rest_stderr = proc.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, rest_stderr = proc.communicate(timeout=10)
            stderr_chunks.append(rest_stderr or "")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        return reached, proc.returncode, stdout, "".join(stderr_chunks)

    def _assert_interrupted_run_carries_the_warning(self, verb):
        import signal as signal_mod

        marker = "XMLRUNNER_FALLBACK_LIVE_MARKER"
        cmd = [sys.executable, str(SCRIPT_PATH), verb,
               "--start-dir", "pkg", "--pattern", "fixture_unused.py",
               "--project-dir", self.project_dir, "--agent", AGENT,
               "--python", str(REAL_VENV_PYTHON)]
        env = scrubbed_env(PYTHONPATH=self.fake_root,
                           FAKE_XMLRUNNER_MARKER=marker,
                           FAKE_XMLRUNNER_MODE="filed")
        reached, code, stdout, stderr = self._drive_and_signal(
            cmd, env, marker, signal_mod.SIGTERM)
        self.assertTrue(
            reached,
            f"{verb}: fixture failure -- the fake entry point's liveness "
            f"marker never reached the client's stderr; stderr="
            f"{stderr[-2000:]!r}")
        toon_mod = load_toon()
        axi = _decode_axi(toon_mod, stdout)
        self.assertIs(
            axi.get("ok"), False,
            f"{verb}: an interrupted run's envelope must be ok:false; got "
            f"axi={axi!r} stderr={stderr[-2000:]!r}")
        warning = _subtests_uncounted_warning(axi)
        self.assertIsNotNone(
            warning,
            f"{verb}: an interrupted run that had already hit the xmlrunner "
            f"fallback before the signal landed must still carry the "
            f"{WARNING_CODE!r} warning on its ONE exit envelope; got "
            f"warnings={axi.get('warnings')!r} stdout={stdout!r} "
            f"stderr={stderr[-2000:]!r}")
        assert warning is not None  # narrowed by the assert above
        self.assertIn(FAKE_VERSION, str(warning.get("detail", "")))

    def test_interrupted_test_run_carries_the_subtests_uncounted_warning(self):
        self._assert_interrupted_run_carries_the_warning("test")

    def test_interrupted_regression_run_carries_the_subtests_uncounted_warning(self):
        self._assert_interrupted_run_carries_the_warning("regression")


class ARealExtendableXmlrunnerNeverCarriesTheWarningTest(_FallbackCase):
    """Negative check -- the repo's own real, extendable unittest-xml-
    reporting 4.0.0 never carries this warning: the fallback is reached ONLY
    when there is nothing to extend."""

    def test_real_xmlrunner_four_zero_zero_never_carries_the_warning(self):
        for verb_label, verb_argv in VERB_VARIANTS:
            with self.subTest(verb=verb_label):
                code, out, err, board, axi = self._run_real_xmlrunner_scenario(
                    verb_argv)
                self.assertEqual(
                    code, 0,
                    f"{verb_label}: the plain no-subtest fixture must still "
                    f"pass cleanly; got code={code} stdout={out!r} "
                    f"stderr={err!r}")
                warning = _subtests_uncounted_warning(axi)
                self.assertIsNone(
                    warning,
                    f"{verb_label}: a run through the real, EXTENDABLE "
                    f"unittest-xml-reporting 4.0.0 must never carry the "
                    f"{WARNING_CODE!r} warning; got "
                    f"warnings={axi.get('warnings')!r}")


if __name__ == "__main__":
    unittest.main()
