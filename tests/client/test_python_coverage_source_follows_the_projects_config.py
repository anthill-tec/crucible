"""The python client's coverage run measures what the PROJECT's own coverage
configuration declares, not a source the client picks for it.

Every test drives the real `python-crucible.py` `main` in-process against
the `RecordingBoard` double, with the repo's own interpreter and its real
coverage.py, over a scratch project built by `python_coverage_project`. It
asserts what the board stored (the ingested coverage object), what the
envelope warned, and the coverage run's own command as the client printed it
(`[crucible] running: ...` on stderr). Both verbs that run a coverage run,
`regression --coverage` and `pre-merge-gate`, are checked as subtests of the
same scenario.

The scratch project declares `mypkg` (four statements, three executed) and
also imports `otherpkg` (five statements, three executed), carries fifteen
fully executed statements of its own tests, and imports a vendored module
from a virtual environment under its root. A coverage total of exactly the
declared package's statements therefore proves both that the declared
source was measured and that nothing else was.
"""

import contextlib
import io
import json
import os
import signal
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.python_coverage_project import (  # noqa: E402
    BLOCKING_TEST_SOURCE,
    CORE_COVERED,
    CORE_TOTAL,
    DIES_TEST_SOURCE,
    EXTRA_COVERED,
    EXTRA_TOTAL,
    FAILING_TEST_SOURCE,
    LCOV_UNAVAILABLE,
    NO_REPORT_CODE,
    RAN_NOTHING_TEST_SOURCE,
    REAL_VENV_PYTHON,
    REPO_ROOT,
    TESTS_COVERED,
    TESTS_TOTAL,
    TOOL_COVERED,
    TOOL_TOTAL,
    UNDECLARED_CODE,
    VERBS,
    ZERO_DISCOVERY_CODE,
    base_files,
    coverage_run_lines,
    drive,
    drive_interrupted,
    ingested_coverage,
    line_counts,
    load_client,
    make_project,
    scrubbed_coverage_env,
    source_values,
    subprocess_files,
    warnings_with_code,
    write_starved_python,
)

PYPROJECT_SOURCE = '[tool.coverage.run]\nsource = ["mypkg"]\n'
COVERAGERC_SOURCE = "[run]\nsource = mypkg\n"
PYPROJECT_SOURCE_PKGS = '[tool.coverage.run]\nsource_pkgs = ["mypkg"]\n'
PYPROJECT_INCLUDE = '[tool.coverage.run]\ninclude = ["mypkg/*"]\n'
PYPROJECT_SUBPROCESS = ('[tool.coverage.run]\nsource = ["mypkg", "scripts"]\n'
                        'patch = ["subprocess"]\n')


class _CoverageRunCase(unittest.TestCase):

    def setUp(self):
        self.assertTrue(
            REAL_VENV_PYTHON.exists(),
            f"these tests need the repo's interpreter with coverage.py and "
            f"unittest-xml-reporting installed, at {REAL_VENV_PYTHON}")

    def _the_coverage_run_line(self, label, result):
        lines = coverage_run_lines(result.err)
        self.assertEqual(
            len(lines), 1,
            f"{label}: exactly one `[crucible] running:` line must name the "
            f"suite's own coverage run, and no other coverage command may "
            f"announce itself that way; got {lines!r} ({result.describe()})")
        self.assertIn(
            " coverage run ", f" {lines[0]} ",
            f"{label}: the announced command must be the coverage run; got "
            f"{lines[0]!r}")
        return lines[0]

    def _assert_measured(self, label, result, expected_total, expected_covered):
        stored = ingested_coverage(result.board)
        self.assertEqual(
            line_counts(stored), (expected_total, expected_covered),
            f"{label}: the board must store coverage of exactly "
            f"{expected_total} statements, {expected_covered} executed; got "
            f"coverage={stored!r} ({result.describe()})")
        self.assertNotIn(
            LCOV_UNAVAILABLE, result.err,
            f"{label}: the coverage report must succeed; got "
            f"stderr={result.err!r}")

    def _assert_no_undeclared_warning(self, label, result):
        self.assertIsNotNone(
            result.axi, f"{label}: stdout must carry an envelope; "
                        f"{result.describe()}")
        self.assertEqual(
            warnings_with_code(result.axi, UNDECLARED_CODE), [],
            f"{label}: a run whose source is decided must carry no "
            f"{UNDECLARED_CODE!r} warning; got "
            f"warnings={result.axi.get('warnings')!r}")

    def _assert_one_undeclared_warning(self, label, result):
        self.assertIsNotNone(
            result.axi, f"{label}: stdout must carry an envelope; "
                        f"{result.describe()}")
        matches = warnings_with_code(result.axi, UNDECLARED_CODE)
        self.assertEqual(
            len(matches), 1,
            f"{label}: exactly one {UNDECLARED_CODE!r} warning; got "
            f"warnings={result.axi.get('warnings')!r}")
        detail = matches[0].get("detail") or ""
        self.assertIn(
            "[tool.coverage.run] source", detail,
            f"{label}: the detail must name the config remedy; got {detail!r}")
        self.assertIn(
            "--cov-source", detail,
            f"{label}: the detail must name the flag remedy; got {detail!r}")


class DeclaredSourceIsMeasuredTest(_CoverageRunCase):
    """A project that declares what to measure has exactly that measured, and
    the coverage run passes no `--source` of its own."""

    def _assert_declared_source_measured(self, config_path, config_text):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                files = base_files()
                files[config_path] = config_text
                project_dir, board = make_project(self, files)
                result = drive(project_dir, board, verb)
                line = self._the_coverage_run_line(label, result)
                self.assertEqual(
                    source_values(line), [],
                    f"{label}: a declared source is left to coverage.py, so "
                    f"the run passes no --source; got {line!r}")
                self._assert_measured(label, result, CORE_TOTAL, CORE_COVERED)
                self._assert_no_undeclared_warning(label, result)

    def test_a_pyproject_source_is_measured_and_nothing_else(self):
        self._assert_declared_source_measured("pyproject.toml", PYPROJECT_SOURCE)

    def test_a_coveragerc_source_is_measured_and_nothing_else(self):
        self._assert_declared_source_measured(".coveragerc", COVERAGERC_SOURCE)

    def test_a_source_pkgs_declaration_is_measured_and_nothing_else(self):
        self._assert_declared_source_measured("pyproject.toml", PYPROJECT_SOURCE_PKGS)

    def test_an_include_declaration_is_measured_and_nothing_else(self):
        self._assert_declared_source_measured("pyproject.toml", PYPROJECT_INCLUDE)


class UndeclaredSourceMeasuresTheProjectTest(_CoverageRunCase):
    """With nothing declared and no `--cov-source`, the run measures the
    project root, given as an absolute path: the project's code and its
    tests, but neither the virtual environment inside the root nor the
    client's own runner outside it. Every envelope says so."""

    def test_the_project_root_is_measured_and_the_green_envelope_warns(self):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                project_dir, board = make_project(self, base_files())
                result = drive(project_dir, board, verb)
                line = self._the_coverage_run_line(label, result)
                sources = source_values(line)
                self.assertEqual(
                    len(sources), 1,
                    f"{label}: an undeclared source is passed as one "
                    f"--source; got {line!r}")
                self.assertTrue(
                    os.path.isabs(sources[0]),
                    f"{label}: the root is passed as an absolute path; got "
                    f"{sources[0]!r}")
                self.assertEqual(
                    os.path.realpath(sources[0]), os.path.realpath(project_dir),
                    f"{label}: the --source must be the project root; got "
                    f"{sources[0]!r}, root {project_dir!r}")
                self._assert_measured(
                    label, result,
                    CORE_TOTAL + EXTRA_TOTAL + TESTS_TOTAL,
                    CORE_COVERED + EXTRA_COVERED + TESTS_COVERED)
                self.assertEqual(
                    ((result.axi or {}).get("run") or {}).get("failed"), 0,
                    f"{label}: the run is green; {result.describe()}")
                self._assert_one_undeclared_warning(label, result)

    def test_a_red_run_envelope_carries_the_warning(self):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                project_dir, board = make_project(
                    self, base_files(),
                    extra_files={"tests/test_fails.py": FAILING_TEST_SOURCE})
                result = drive(project_dir, board, verb)
                self.assertEqual(
                    ((result.axi or {}).get("run") or {}).get("failed"), 1,
                    f"{label}: fixture -- the deliberately failing test makes "
                    f"the run red; {result.describe()}")
                self._assert_one_undeclared_warning(label, result)

    def test_a_zero_discovery_envelope_carries_the_warning(self):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                project_dir, board = make_project(
                    self, base_files(), extra_files={"no_tests_here/.keep": ""})
                result = drive(project_dir, board, verb, start_dir="no_tests_here")
                self.assertEqual(
                    len(warnings_with_code(result.axi, ZERO_DISCOVERY_CODE)), 1,
                    f"{label}: fixture -- an empty start dir is the "
                    f"zero-discovery failure; {result.describe()}")
                self._assert_one_undeclared_warning(label, result)

    def test_an_undeclared_source_under_a_relative_project_dir_is_passed_as_the_absolute_root(self):
        """Only the `--source` is pinned here. Both verbs run whole, the
        gate's py_compile step included: the client makes a relative project
        dir absolute when it resolves it, so every step, and the reports
        directory the run hands its runner, sees the same absolute root."""
        for label, verb in VERBS:
            with self.subTest(verb=label):
                project_dir, board = make_project(self, base_files())
                self.addCleanup(os.chdir, os.getcwd())
                os.chdir(os.path.dirname(project_dir))
                relative = os.path.basename(project_dir)
                result = drive(relative, board, verb)
                line = self._the_coverage_run_line(label, result)
                sources = source_values(line)
                self.assertEqual(
                    len(sources), 1,
                    f"{label}: an undeclared source is passed as one "
                    f"--source; got {line!r}")
                self.assertTrue(
                    os.path.isabs(sources[0]),
                    f"{label}: under the relative --project-dir {relative!r} "
                    f"the root is still passed as an absolute path; got "
                    f"{sources[0]!r}")
                self.assertEqual(
                    os.path.realpath(sources[0]), os.path.realpath(project_dir),
                    f"{label}: the --source must be the project root; got "
                    f"{sources[0]!r}, root {project_dir!r}")


class UndeclaredWarningRidesEveryFailureEnvelopeTest(_CoverageRunCase):
    """With nothing declared and no `--cov-source`, the run's failure
    envelopes carry the undeclared-source warning too: a run that wrote no
    report, a run whose report holds no results, and an interrupted run.
    A pin: it holds today."""

    def test_a_no_report_envelope_carries_the_warning(self):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                project_dir, board = make_project(
                    self, base_files(),
                    extra_files={"dies/__init__.py": "",
                                 "dies/test_dies.py": DIES_TEST_SOURCE})
                result = drive(project_dir, board, verb, start_dir="dies")
                self.assertEqual(
                    len(warnings_with_code(result.axi, NO_REPORT_CODE)), 1,
                    f"{label}: fixture -- a runner that dies before any "
                    f"report is the no-report failure; {result.describe()}")
                self.assertIs((result.axi or {}).get("ok"), False, result.describe())
                self._assert_one_undeclared_warning(label, result)

    def test_a_ran_nothing_envelope_carries_the_warning(self):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                project_dir, board = make_project(
                    self, base_files(),
                    extra_files={"empty_report/__init__.py": "",
                                 "empty_report/test_empty_report.py":
                                     RAN_NOTHING_TEST_SOURCE})
                result = drive(project_dir, board, verb, start_dir="empty_report")
                self.assertIn(
                    "holds no results", result.err,
                    f"{label}: fixture -- a report with zero results and a "
                    f"non-zero exit is the ran-nothing failure; "
                    f"{result.describe()}")
                self.assertIs((result.axi or {}).get("ok"), False, result.describe())
                self._assert_one_undeclared_warning(label, result)

    def test_an_interrupted_runs_envelope_carries_the_warning(self):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                project_dir, board = make_project(
                    self, base_files(),
                    extra_files={"blocks/__init__.py": "",
                                 "blocks/test_blocks.py": BLOCKING_TEST_SOURCE})
                result = drive_interrupted(self, project_dir, board, verb,
                                           start_dir="blocks")
                self.assertEqual(
                    result.code, 128 + signal.SIGTERM,
                    f"{label}: fixture -- the client was interrupted mid-run "
                    f"by SIGTERM; {result.describe()}")
                self.assertIs((result.axi or {}).get("ok"), False, result.describe())
                self._assert_one_undeclared_warning(label, result)


class UnreadableConfigurationDoesNotStopTheRunTest(_CoverageRunCase):
    """An interpreter without coverage.py cannot read the configuration: the
    run goes ahead as if a source were declared and fails for today's cause,
    never warning that the source was undeclared."""

    def test_a_starved_interpreter_reports_the_missing_module_and_passes_no_source(self):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                project_dir, board = make_project(self, base_files())
                starved = write_starved_python(self)
                result = drive(project_dir, board, verb, python=starved)
                line = self._the_coverage_run_line(label, result)
                self.assertEqual(
                    source_values(line), [],
                    f"{label}: an unreadable configuration is treated as a "
                    f"declared one, so the run passes no --source; got "
                    f"{line!r}")
                axi = result.axi or {}
                self.assertTrue(axi, f"{label}: {result.describe()}")
                no_report = warnings_with_code(axi, NO_REPORT_CODE)
                self.assertEqual(
                    len(no_report), 1,
                    f"{label}: the run fails for today's cause; got "
                    f"warnings={axi.get('warnings')!r}")
                self.assertIn(
                    "No module named coverage", no_report[0].get("detail") or "",
                    f"{label}: the cause names the missing coverage.py; got "
                    f"{no_report[0]!r}")
                self._assert_no_undeclared_warning(label, result)


class GivenSourceStillWinsTest(_CoverageRunCase):
    """A `--cov-source` is passed as `--source` and decides what is measured,
    even over a source the project's configuration declares. A pin: it holds
    today."""

    def test_a_given_cov_source_is_passed_as_source_over_the_configured_one(self):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                files = base_files()
                files["pyproject.toml"] = '[tool.coverage.run]\nsource = ["otherpkg"]\n'
                project_dir, board = make_project(self, files)
                result = drive(project_dir, board, verb,
                               extra_argv=("--cov-source", "mypkg"))
                line = self._the_coverage_run_line(label, result)
                self.assertEqual(
                    source_values(line), ["mypkg"],
                    f"{label}: the given source is passed as --source; got "
                    f"{line!r}")
                self._assert_measured(label, result, CORE_TOTAL, CORE_COVERED)
                self._assert_no_undeclared_warning(label, result)


class ThisRepositorysGateIsUnchangedTest(_CoverageRunCase):
    """This repository declares its own source, so its gate measures exactly
    `crucible_axi` and `clients` with no `--source` on the command line."""

    def test_this_repositorys_resolved_coverage_config_declares_exactly_its_two_packages(self):
        probe = ("import json, coverage\n"
                 "cfg = coverage.Coverage().config\n"
                 "print(json.dumps({'source': cfg.source, "
                 "'source_pkgs': cfg.source_pkgs, 'source_dirs': cfg.source_dirs, "
                 "'include': cfg.run_include}))\n")
        with scrubbed_coverage_env():
            env = os.environ.copy()
        result = subprocess.run([str(REAL_VENV_PYTHON), "-c", probe],
                                cwd=str(REPO_ROOT), env=env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        resolved = json.loads(result.stdout)
        self.assertEqual(
            sorted(resolved["source"] or []), ["clients", "crucible_axi"],
            f"this repository's coverage configuration must declare exactly "
            f"crucible_axi and clients as its source; resolved {resolved!r}")
        self.assertEqual(
            (resolved["source_pkgs"], resolved["source_dirs"], resolved["include"] or []),
            ([], [], []),
            f"nothing else may widen or narrow what is measured; resolved "
            f"{resolved!r}")

    def test_the_gate_run_with_this_repositorys_config_passes_no_source(self):
        files = base_files()
        files["pyproject.toml"] = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        project_dir, board = make_project(self, files)
        result = drive(project_dir, board, ("pre-merge-gate",))
        line = self._the_coverage_run_line("pre-merge-gate", result)
        self.assertEqual(
            source_values(line), [],
            f"this repository's own configuration declares its source, so its "
            f"gate's coverage run passes no --source; got {line!r}")
        self._assert_no_undeclared_warning("pre-merge-gate", result)


class SubprocessCoverageIsReportedTest(_CoverageRunCase):
    """A project measuring its subprocesses (`patch = ["subprocess"]`) has a
    script its tests run as a child process reported on the board, whether
    the run reports into the agent's own directory or an explicit one."""

    def test_a_script_run_as_a_subprocess_is_in_the_stored_coverage(self):
        placements = (("the agent's own reports directory", ()),
                      ("an explicit reports directory",
                       ("--reports", "test-reports/explicit")))
        for label, verb in VERBS:
            for placement, extra_argv in placements:
                with self.subTest(verb=label, reports=placement):
                    files = subprocess_files()
                    files["pyproject.toml"] = PYPROJECT_SUBPROCESS
                    project_dir, board = make_project(self, files)
                    result = drive(project_dir, board, verb, extra_argv=extra_argv)
                    self._assert_measured(
                        f"{label} / {placement}", result,
                        CORE_TOTAL + TOOL_TOTAL, CORE_COVERED + TOOL_COVERED)
                    self.assertEqual(
                        ((result.axi or {}).get("run") or {}).get("failed"), 0,
                        f"{label} / {placement}: {result.describe()}")


class CovSourceHelpIsTrueTest(unittest.TestCase):
    """Both verbs' `--cov-source` help says what happens when it is omitted
    and that subprocess coverage needs coverage.py 7.14 or later."""

    def _cov_source_help(self, verb):
        module = load_client("python-crucible.py")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
                mock.patch.dict(os.environ, {"COLUMNS": "200"}), \
                mock.patch.object(sys, "argv", ["python-crucible.py", verb, "--help"]), \
                self.assertRaises(SystemExit):
            module.main()
        block, inside = [], False
        for raw in out.getvalue().splitlines():
            stripped = raw.strip()
            if stripped.startswith("--cov-source"):
                inside = True
            elif inside and stripped.startswith("-"):
                break
            if inside:
                block.append(stripped)
        self.assertTrue(block, f"{verb}: no --cov-source help in {out.getvalue()!r}")
        return " ".join(block)

    def test_both_verbs_say_what_omitting_it_does_and_the_coverage_floor(self):
        for verb in ("regression", "pre-merge-gate"):
            with self.subTest(verb=verb):
                text = self._cov_source_help(verb)
                self.assertNotIn(
                    "crucible_axi", text,
                    f"{verb}: the help may no longer claim a fixed default "
                    f"source; got {text!r}")
                lowered = text.lower()
                self.assertTrue(
                    any(word in lowered for word in
                        ("config", "[tool.coverage", ".coveragerc")),
                    f"{verb}: omitted, the project's coverage configuration "
                    f"decides -- the help must say so; got {text!r}")
                self.assertTrue(
                    any(word in lowered for word in ("root", "project dir")),
                    f"{verb}: omitted with nothing declared, the project root "
                    f"is measured -- the help must say so; got {text!r}")
                self.assertIn(
                    "subprocess", lowered,
                    f"{verb}: the help must speak to subprocess coverage; got "
                    f"{text!r}")
                self.assertIn(
                    "7.14", text,
                    f"{verb}: subprocess coverage needs coverage.py 7.14 or "
                    f"later -- the help must say so; got {text!r}")


if __name__ == "__main__":
    unittest.main()
