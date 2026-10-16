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
    LCOV_UNAVAILABLE,
    REAL_VENV_PYTHON,
    VERBS,
    base_files,
    drive,
    ingested_coverage,
    line_counts,
    make_project,
    plant_earlier_parallel_data,
)

PARALLEL_CONFIG = "[tool.coverage.run]\nparallel = true\n"
EXPLICIT_REPORTS = ("--reports", "test-reports/explicit")
GIVEN_SOURCE = ("--cov-source", "mypkg")


class _StaleDataCase(unittest.TestCase):

    def setUp(self):
        self.assertTrue(
            REAL_VENV_PYTHON.exists(),
            f"these tests need the repo's interpreter with coverage.py and "
            f"unittest-xml-reporting installed, at {REAL_VENV_PYTHON}")

    def _assert_only_this_runs_coverage(self, label, result):
        stored = ingested_coverage(result.board)
        self.assertEqual(
            line_counts(stored), (CORE_TOTAL, CORE_COVERED),
            f"{label}: only this run's coverage may be reported -- "
            f"{CORE_TOTAL} statements, {CORE_COVERED} executed; an earlier "
            f"run's data was merged in if either count is higher. Got "
            f"coverage={stored!r} ({result.describe()})")
        self.assertNotIn(
            LCOV_UNAVAILABLE, result.err,
            f"{label}: the coverage report must succeed; got "
            f"stderr={result.err!r}")

    def _run_after_an_earlier_run(self, config, data_file_rel, extra_argv):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                files = base_files()
                if config:
                    files["pyproject.toml"] = config
                project_dir, board = make_project(self, files)
                plant_earlier_parallel_data(
                    self, project_dir, os.path.join(project_dir, data_file_rel))
                result = drive(project_dir, board, verb,
                               extra_argv=GIVEN_SOURCE + tuple(extra_argv))
                self._assert_only_this_runs_coverage(label, result)


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


if __name__ == "__main__":
    unittest.main()
