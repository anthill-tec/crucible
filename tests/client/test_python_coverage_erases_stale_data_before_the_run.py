"""The python client's coverage run reports only ITS OWN coverage: whatever
data an earlier run left beside the data file this run writes -- suffixed
parallel files included -- is gone before the run starts, so coverage.py's
report-time combine never folds it in.

Every test drives the real `python-crucible.py` `main` in-process against
the `RecordingBoard` double, with the repo's own interpreter and its real
coverage.py, over a scratch project built by `python_coverage_project`, and
checks both verbs that run a coverage run (`regression --coverage` and
`pre-merge-gate`) as subtests of the same scenario.

The earlier run is real coverage.py data: two separate processes, each
measuring the project root, one running `mypkg.core.triple` and one running
`otherpkg.extra.unused`, each leaving a suffixed parallel data file. The
second run is given `--cov-source mypkg` and its tests only ever call
`double`, so its own coverage is exactly `mypkg`'s four statements with three
executed; any stale data merged in shows up as more statements, more
executed, or both.
"""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.python_coverage_project import (  # noqa: E402
    AGENT,
    CORE_COVERED,
    CORE_TOTAL,
    EXTRA_COVERED,
    EXTRA_TOTAL,
    LCOV_UNAVAILABLE,
    REAL_VENV_PYTHON,
    TESTS_COVERED,
    TESTS_TOTAL,
    VERBS,
    base_files,
    drive,
    ingested_coverage,
    line_counts,
    make_project,
    plant_earlier_parallel_data,
)

PARALLEL_CONFIG = "[tool.coverage.run]\nparallel = true\n"
DECLARED_CONFIG = '[tool.coverage.run]\nsource = ["mypkg"]\n'
PARALLEL_DECLARED_CONFIG = DECLARED_CONFIG + "parallel = true\n"
ENV_DATA_FILE = os.path.join("envdata", ".covenv")
CONFIG_DATA_FILE = os.path.join("cfgdata", ".covcfg")
CONFIG_DATA_FILE_LINE = f'data_file = "{CONFIG_DATA_FILE}"\n'
EXPLICIT_REPORTS = ("--reports", "test-reports/explicit")
GIVEN_SOURCE = ("--cov-source", "mypkg")


class _StaleDataCase(unittest.TestCase):

    def setUp(self):
        self.assertTrue(
            REAL_VENV_PYTHON.exists(),
            f"these tests need the repo's interpreter with coverage.py and "
            f"unittest-xml-reporting installed, at {REAL_VENV_PYTHON}")

    def _assert_only_this_runs_coverage(self, label, result,
                                        expected=(CORE_TOTAL, CORE_COVERED)):
        stored = ingested_coverage(result.board)
        self.assertEqual(
            line_counts(stored), expected,
            f"{label}: only this run's coverage may be reported -- "
            f"{expected[0]} statements, {expected[1]} executed; an earlier "
            f"run's data was merged in if either count is higher. Got "
            f"coverage={stored!r} ({result.describe()})")
        self.assertNotIn(
            LCOV_UNAVAILABLE, result.err,
            f"{label}: the coverage report must succeed; got "
            f"stderr={result.err!r}")

    def _run_after_an_earlier_run(self, config, data_file_rel, extra_argv,
                                  source_argv=GIVEN_SOURCE,
                                  expected=(CORE_TOTAL, CORE_COVERED)):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                files = base_files()
                if config:
                    files["pyproject.toml"] = config
                project_dir, board = make_project(self, files)
                plant_earlier_parallel_data(
                    self, project_dir, os.path.join(project_dir, data_file_rel))
                result = drive(project_dir, board, verb,
                               extra_argv=tuple(source_argv) + tuple(extra_argv))
                self._assert_only_this_runs_coverage(label, result, expected)


class StaleDataIsNotMergedTest(_StaleDataCase):
    """Two coverage runs in a row, the first leaving suffixed parallel files,
    report only the second run's coverage."""

    def test_an_earlier_runs_parallel_files_at_the_project_root_are_not_merged(self):
        self._run_after_an_earlier_run(PARALLEL_CONFIG, ".coverage", EXPLICIT_REPORTS)

    def test_an_earlier_runs_parallel_files_in_the_agents_own_directory_are_not_merged(self):
        self._run_after_an_earlier_run(
            PARALLEL_CONFIG, os.path.join("test-reports", AGENT, ".coverage"), ())

    def test_an_earlier_runs_parallel_files_are_not_merged_when_this_runs_config_is_not_parallel(self):
        self._run_after_an_earlier_run(None, ".coverage", EXPLICIT_REPORTS)


class OneDataFileIsUnchangedTest(_StaleDataCase):
    """A run that writes a single, unsuffixed data file reports the same
    coverage it does today. A pin: it holds today."""

    def test_a_single_unsuffixed_data_file_reports_this_runs_coverage(self):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                project_dir, board = make_project(self, base_files())
                result = drive(project_dir, board, verb, extra_argv=GIVEN_SOURCE)
                self._assert_only_this_runs_coverage(label, result)
                own_dir = os.path.join(project_dir, "test-reports", AGENT)
                self.assertEqual(
                    sorted(n for n in os.listdir(own_dir) if n.startswith(".coverage")),
                    [".coverage"],
                    f"{label}: the run writes one unsuffixed data file; got "
                    f"{sorted(os.listdir(own_dir))!r}")


class StaleDataIsErasedWithoutAGivenSourceTest(_StaleDataCase):
    """With no `--cov-source`, the erase still runs: an earlier run's
    parallel files are gone whether the project's configuration declares the
    source or declares none. A pin: it holds today."""

    def test_a_declared_source_run_does_not_merge_an_earlier_runs_files_at_the_project_root(self):
        self._run_after_an_earlier_run(
            PARALLEL_DECLARED_CONFIG, ".coverage", EXPLICIT_REPORTS, source_argv=())

    def test_a_declared_source_run_does_not_merge_an_earlier_runs_files_in_the_agents_own_directory(self):
        self._run_after_an_earlier_run(
            PARALLEL_DECLARED_CONFIG, os.path.join("test-reports", AGENT, ".coverage"),
            (), source_argv=())

    def test_an_undeclared_source_run_does_not_merge_an_earlier_runs_files(self):
        self._run_after_an_earlier_run(
            None, ".coverage", EXPLICIT_REPORTS, source_argv=(),
            expected=(CORE_TOTAL + EXTRA_TOTAL + TESTS_TOTAL,
                      CORE_COVERED + EXTRA_COVERED + TESTS_COVERED))


class TheDataFileIsCoveragePysTest(_StaleDataCase):
    """Without the run's own `--data-file`, the erase follows the data file
    coverage.py resolves itself -- `COVERAGE_FILE`, else `[run] data_file`,
    each relative to the project root -- with and without `--cov-source`.
    The earlier run's files are planted beside that file, so a run that
    erased anywhere else merges them. A pin: it holds today."""

    def _assert_erased_beside(self, config, env, data_file_rel, unused_rel=None):
        for label, verb in VERBS:
            for given, source_argv in (("with --cov-source", GIVEN_SOURCE),
                                       ("without --cov-source", ())):
                with self.subTest(verb=label, source=given):
                    where = f"{label} / {given}"
                    files = base_files()
                    files["pyproject.toml"] = config
                    project_dir, board = make_project(self, files)
                    data_file = os.path.join(project_dir, data_file_rel)
                    plant_earlier_parallel_data(self, project_dir, data_file)
                    result = drive(project_dir, board, verb, env=env,
                                   extra_argv=tuple(source_argv) + EXPLICIT_REPORTS)
                    self._assert_only_this_runs_coverage(where, result)
                    self.assertTrue(
                        os.path.isfile(data_file),
                        f"{where}: fixture -- the run writes its data to "
                        f"{data_file_rel!r}, beside the planted files; "
                        f"{result.describe()}")
                    if unused_rel:
                        self.assertFalse(
                            os.path.exists(os.path.join(project_dir, unused_rel)),
                            f"{where}: fixture -- the run never writes "
                            f"{unused_rel!r}; {result.describe()}")

    def test_coverage_file_names_the_data_file_the_erase_clears(self):
        self._assert_erased_beside(
            DECLARED_CONFIG, {"COVERAGE_FILE": ENV_DATA_FILE}, ENV_DATA_FILE)

    def test_run_data_file_names_the_data_file_the_erase_clears(self):
        self._assert_erased_beside(
            DECLARED_CONFIG + CONFIG_DATA_FILE_LINE, None, CONFIG_DATA_FILE)

    def test_coverage_file_wins_over_run_data_file_for_the_erase(self):
        self._assert_erased_beside(
            DECLARED_CONFIG + CONFIG_DATA_FILE_LINE,
            {"COVERAGE_FILE": ENV_DATA_FILE}, ENV_DATA_FILE,
            unused_rel=CONFIG_DATA_FILE)


if __name__ == "__main__":
    unittest.main()
