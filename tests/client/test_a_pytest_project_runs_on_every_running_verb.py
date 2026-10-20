"""A project that declares pytest runs pytest on every running verb.

With `[python] runner = "pytest"` in the project's own `crucible.toml`, the
python client's `test`, `regression` (with and without `--coverage`), a tier
verb declared by `--start-dir`, and `pre-merge-gate` each run the project's
tests under pytest and file what pytest reported through the same parse the
unittest path uses:

* the counts of the fixture's three tests: 1 passed, 1 failed, 1 pending;
* `files` counted per test FILE -- pytest stamps `file=` on each test case
  only with `-o junit_family=xunit1`, so a file holding a module-level test
  and a test class is one file, never two;
* the run's tree grouped by each test case's `classname` (the module for a
  module-level test, the module and class for a test in a class), never one
  node named after pytest's single `<testsuite name="pytest">`;
* `pre-merge-gate` and `regression --coverage` file coverage measured by
  coverage.py over the pytest run.

Every run drives the REAL `clients/python-crucible.py` as an OS subprocess on
a scratch copy of `tests/fixtures/pytest-project`, filing to a recording board
named by the scratch project's own `crucible.toml`. Each verb runs ONCE per
class (`setUpClass`); the tests read what that one run filed.

Invocation:
    python3 -m unittest tests.client.test_a_pytest_project_runs_on_every_running_verb -v
"""

import unittest

from tests.client.pytest_project_harness import (
    AGENT,
    FIXTURE_GROUPS,
    ScratchProject,
    counts,
    diag,
    envelope,
    leaves,
    require_pytest_and_coverage,
    tree_groups,
)

ONE_PASSED_ONE_FAILED_ONE_PENDING = {"total": 3, "passed": 1, "failed": 1, "pending": 1}

# A file holding both a module-level test and a test class: one FILE whose
# tests carry two `classname`s.
_MIXED_FILE = '''"""One module-level test and one test in a class, both passing."""


def test_at_module_level():
    assert 2 * 2 == 4


class TestInAClass:

    def test_in_a_class(self):
        assert 3 * 3 == 9
'''


class _OneRunOfThePytestFixture(unittest.TestCase):
    """Drive one verb once on a pytest-declared scratch copy of the fixture."""

    ARGV: tuple[str, ...] = ()
    EXTRA_FILES: tuple[tuple[str, str], ...] = ()

    @classmethod
    def setUpClass(cls):
        require_pytest_and_coverage()
        cls.project = ScratchProject(f"pytest-every-verb-{cls.__name__}-")
        cls.project.declare("pytest")
        for rel, text in cls.EXTRA_FILES:
            cls.project.write(rel, text)
        cls.result = cls.project.drive(list(cls.ARGV))
        cls.ingests = cls.project.parsed_ingests()
        cls.axi = envelope(cls.result.stdout)

    @classmethod
    def tearDownClass(cls):
        cls.project.close()

    def the_one_ingest(self):
        self.assertEqual(len(self.ingests), 1,
                         f"exactly one parsed ingest must be filed; {diag(self.result)}")
        return self.ingests[0]

    def the_envelope_run(self):
        if self.axi is None:
            self.fail(f"stdout must be one AXI envelope; {diag(self.result)}")
        run = self.axi.get("run")
        self.assertIsInstance(run, dict, f"the envelope carries run{{}}; {diag(self.result)}")
        return run


class _FilesTheFixturesCounts(_OneRunOfThePytestFixture):
    """The checks every verb's run of the plain fixture must meet."""

    TIER = None

    def test_it_files_one_passed_one_failed_one_pending(self):
        body = self.the_one_ingest()
        self.assertEqual(counts(body), ONE_PASSED_ONE_FAILED_ONE_PENDING, diag(self.result))
        self.assertEqual(leaves(body), [("test_it_fails", "fail"),
                                        ("test_it_is_skipped", "pending"),
                                        ("test_it_passes", "pass")], diag(self.result))
        self.assertEqual(self.result.returncode, 1,
                         f"a run with a failing test exits 1; {diag(self.result)}")
        self.assertEqual(self.project.compile_ingests(), [],
                         f"a run that ran its tests files no compile record; "
                         f"{diag(self.result)}")

    def test_the_envelope_counts_three_tests_in_two_files(self):
        run = self.the_envelope_run()
        self.assertEqual({k: run.get(k) for k in ("passed", "failed", "pending", "total", "files")},
                         {"passed": 1, "failed": 1, "pending": 1, "total": 3, "files": 2},
                         diag(self.result))

    def test_the_tree_groups_the_tests_by_classname(self):
        body = self.the_one_ingest()
        groups = tree_groups(body)
        self.assertNotIn("pytest", groups,
                         f"the tree must not file every test under pytest's one suite "
                         f"node; tree={body.get('tree')!r}")
        self.assertEqual(groups, FIXTURE_GROUPS, f"tree={body.get('tree')!r}")
        node = next(n for n in body["tree"] if n.get("name") == "check_outcomes")
        self.assertEqual(node.get("status"), "fail",
                         f"the module holding the failing test is a failing node; "
                         f"tree={body.get('tree')!r}")

    def test_the_run_is_filed_under_the_tier_its_verb_names(self):
        body = self.the_one_ingest()
        self.assertEqual(body.get("tier"), self.TIER, diag(self.result))


class _FilesTheFixturesCountsAndCoverage(_FilesTheFixturesCounts):
    """A verb whose run is measured by coverage.py."""

    def test_coverage_measured_by_coverage_py_over_the_pytest_run_is_filed(self):
        body = self.the_one_ingest()
        coverage = body.get("coverage")
        self.assertIsInstance(coverage, dict,
                              f"the run must file coverage; {diag(self.result)}")
        lines = coverage.get("lines") or {}
        total, covered = lines.get("total"), lines.get("covered")
        if not isinstance(total, int) or not isinstance(covered, int):
            self.fail(f"coverage lines must carry integer total/covered; "
                      f"coverage={coverage!r}")
        # Measured over the fixture's own files: its two module-level tests'
        # five statements ran; the skipped test's body never did.
        self.assertGreaterEqual(covered, 5, f"coverage={coverage!r}")
        self.assertLess(covered, total,
                        f"the skipped test's body never runs, so not every line is "
                        f"covered; coverage={coverage!r}")


class TestVerbRunsPytestOnADeclaredProjectTest(_FilesTheFixturesCounts):
    ARGV = ("test", "--agent", AGENT)
    TIER = None


class RegressionRunsPytestOnADeclaredProjectTest(_FilesTheFixturesCounts):
    ARGV = ("regression", "--agent", AGENT)
    TIER = "regression"


class RegressionWithCoverageRunsPytestUnderCoveragePyTest(
        _FilesTheFixturesCountsAndCoverage):
    ARGV = ("regression", "--agent", AGENT, "--coverage")
    TIER = "regression"


class ATierVerbDeclaredByStartDirRunsPytestTest(_FilesTheFixturesCounts):
    """The tier verb's declaration is its invocation: `--start-dir .` names the
    project root, and no `--pattern` is stated, so the fixture's own
    `python_files` decides what is collected there."""
    ARGV = ("integration", "--agent", AGENT, "--start-dir", ".")
    TIER = "integration"


class PreMergeGateRunsPytestUnderCoveragePyTest(_FilesTheFixturesCountsAndCoverage):
    """The gate's own fail-fast check step compiles `app` and `tests`; the
    scratch project carries an `app` package for it to compile (an empty one,
    which pytest's `check_*.py` never collects), so the gate reaches its
    regression step as it does on a real project."""
    ARGV = ("pre-merge-gate", "--agent", AGENT)
    TIER = "regression"
    EXTRA_FILES = (("app/__init__.py", ""),)


class FilesAreCountedPerFileNotPerClassnameTest(_OneRunOfThePytestFixture):
    """A scratch file holding a module-level test AND a test class adds two
    `classname`s but only ONE file: the count is 3 files, never 4."""

    ARGV = ("test", "--agent", AGENT)
    EXTRA_FILES = (("check_mixed.py", _MIXED_FILE),)

    def test_a_file_with_a_module_level_test_and_a_class_counts_once(self):
        body = self.the_one_ingest()
        self.assertEqual(counts(body), {"total": 5, "passed": 3, "failed": 1, "pending": 1},
                         diag(self.result))
        run = self.the_envelope_run()
        self.assertEqual(run.get("files"), 3,
                         f"three test files (check_outcomes, check_skipped, "
                         f"check_mixed); {diag(self.result)}")

    def test_one_file_yields_a_module_node_and_a_module_and_class_node(self):
        body = self.the_one_ingest()
        self.assertEqual(tree_groups(body), {
            **FIXTURE_GROUPS,
            "check_mixed": [("test_at_module_level", "pass")],
            "check_mixed.TestInAClass": [("test_in_a_class", "pass")],
        }, f"tree={body.get('tree')!r}")


# The shared bases drive no verb of their own: out of the module's namespace,
# so unittest's loader collects only the concrete classes above.
del _OneRunOfThePytestFixture, _FilesTheFixturesCounts, _FilesTheFixturesCountsAndCoverage


if __name__ == "__main__":
    unittest.main()
