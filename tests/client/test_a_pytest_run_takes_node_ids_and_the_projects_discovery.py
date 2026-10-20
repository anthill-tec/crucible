"""Under pytest, `--tests` takes node ids and the project's own configuration
decides discovery unless the caller states `--start-dir`/`--pattern`.

* `test --tests <nodeid>` runs exactly that test, and with `--tests` given no
  start dir is passed, as on the unittest path -- a stated `--start-dir`
  adds nothing to the run;
* with no `--start-dir` and no `--pattern`, the project's own pytest
  configuration decides what runs (the fixture's `pytest.ini` collects
  `check_*.py`) -- never the unittest defaults `tests` and `test_*.py`;
* a stated `--start-dir` is the path pytest is given, and a stated `--pattern`
  is pytest's `python_files`;
* without pytest chosen, `--start-dir` still defaults to `tests` and
  `--pattern` to `test_*.py`, on `test`, `regression` and `pre-merge-gate`.

Every run drives the REAL `clients/python-crucible.py` as an OS subprocess on
a scratch project filing to a recording board named by the project's own
`crucible.toml`; what ran is read from the one parsed ingest the board
received.

Invocation:
    python3 -m unittest tests.client.test_a_pytest_run_takes_node_ids_and_the_projects_discovery -v
"""

import unittest

from tests.client.pytest_project_harness import (
    AGENT,
    ScratchProject,
    counts,
    diag,
    leaves,
    require_pytest_and_coverage,
)


def _module(*tests):
    """A test module: each `(name, passes)` a module-level pytest test."""
    body = ['"""Written by the test that runs it."""\n']
    for name, passes in tests:
        body.append(f"\ndef {name}():\n    assert {'True' if passes else 'False'}, "
                    f"{name!r}\n")
    return "\n".join(body)


# A unittest module, collectable by unittest discovery.
def _unittest_module(cls, name, passes):
    return ("import unittest\n\n\n"
            f"class {cls}(unittest.TestCase):\n\n"
            f"    def {name}(self):\n"
            f"        self.assertTrue({passes}, {name!r})\n")


class _PytestCase(unittest.TestCase):

    def setUp(self):
        require_pytest_and_coverage()
        self.project = ScratchProject("pytest-node-ids-discovery-")
        self.project.declare("pytest")

    def tearDown(self):
        self.project.close()

    def run_test_verb(self, *argv):
        result = self.project.drive(["test", "--agent", AGENT, *argv])
        ingests = self.project.parsed_ingests()
        self.assertEqual(len(ingests), 1,
                         f"exactly one parsed ingest must be filed; {diag(result)}")
        return result, ingests[0]


class ANodeIdRunsExactlyThatTestTest(_PytestCase):

    def test_a_module_level_node_id_runs_exactly_that_test(self):
        result, body = self.run_test_verb("--tests", "check_outcomes.py::test_it_passes")
        self.assertEqual(counts(body), {"total": 1, "passed": 1, "failed": 0, "pending": 0},
                         diag(result))
        self.assertEqual(leaves(body), [("test_it_passes", "pass")], diag(result))
        self.assertEqual(result.returncode, 0, diag(result))

    def test_a_class_node_id_runs_exactly_that_test(self):
        result, body = self.run_test_verb(
            "--tests", "check_skipped.py::TestSkipped::test_it_is_skipped")
        self.assertEqual(counts(body), {"total": 1, "passed": 0, "failed": 0, "pending": 1},
                         diag(result))
        self.assertEqual(leaves(body), [("test_it_is_skipped", "pending")], diag(result))

    def test_with_tests_given_a_stated_start_dir_is_not_passed(self):
        """`sub/` holds a failing test pytest would collect if the start dir
        reached it beside the node id."""
        self.project.write("sub/check_sub.py", _module(("test_in_sub", False)))
        result, body = self.run_test_verb("--tests", "check_outcomes.py::test_it_passes",
                                          "--start-dir", "sub")
        self.assertEqual(leaves(body), [("test_it_passes", "pass")], diag(result))
        self.assertEqual(counts(body), {"total": 1, "passed": 1, "failed": 0, "pending": 0},
                         diag(result))


class TheProjectsPytestConfigurationDecidesDiscoveryTest(_PytestCase):

    def test_with_no_start_dir_or_pattern_the_projects_pytest_ini_decides(self):
        """Decoys the unittest defaults would select (`tests/`, `test_*.py`)
        fail if collected; the fixture's `python_files = check_*.py` collects
        exactly its three tests."""
        self.project.write("tests/test_decoy.py", _module(("test_decoy_in_tests", False)))
        self.project.write("tests/check_in_tests.py", _module(("test_check_in_tests", True)))
        self.project.write("test_root_decoy.py", _module(("test_root_decoy", False)))
        result, body = self.run_test_verb()
        self.assertEqual(leaves(body), [("test_check_in_tests", "pass"),
                                        ("test_it_fails", "fail"),
                                        ("test_it_is_skipped", "pending"),
                                        ("test_it_passes", "pass")], diag(result))
        self.assertEqual(counts(body), {"total": 4, "passed": 2, "failed": 1, "pending": 1},
                         diag(result))

    def test_a_stated_start_dir_is_the_path_pytest_is_given(self):
        self.project.write("sub/check_sub.py", _module(("test_in_sub", True)))
        result, body = self.run_test_verb("--start-dir", "sub")
        self.assertEqual(leaves(body), [("test_in_sub", "pass")],
                         f"only the stated start dir's tests run; {diag(result)}")
        self.assertEqual(counts(body), {"total": 1, "passed": 1, "failed": 0, "pending": 0},
                         diag(result))
        self.assertEqual(result.returncode, 0, diag(result))

    def test_a_stated_pattern_is_pytests_python_files(self):
        self.project.write("probe_one.py", _module(("test_probe_a", True),
                                                   ("test_probe_b", True)))
        result, body = self.run_test_verb("--pattern", "probe_*.py")
        self.assertEqual(leaves(body), [("test_probe_a", "pass"), ("test_probe_b", "pass")],
                         f"only files matching the stated pattern run; {diag(result)}")
        self.assertEqual(counts(body), {"total": 2, "passed": 2, "failed": 0, "pending": 0},
                         diag(result))
        self.assertEqual(result.returncode, 0, diag(result))

    def test_a_stated_start_dir_and_pattern_together_select_their_intersection(self):
        self.project.write("sub/check_sub.py", _module(("test_check_in_sub", False)))
        self.project.write("sub/probe_sub.py", _module(("test_probe_in_sub", True)))
        self.project.write("probe_root.py", _module(("test_probe_at_root", False)))
        result, body = self.run_test_verb("--start-dir", "sub", "--pattern", "probe_*.py")
        self.assertEqual(leaves(body), [("test_probe_in_sub", "pass")], diag(result))
        self.assertEqual(counts(body), {"total": 1, "passed": 1, "failed": 0, "pending": 0},
                         diag(result))


class WithoutPytestTheUnittestDefaultsStandTest(unittest.TestCase):
    """A scratch unittest project whose only test the defaults select is
    the `CountedTest` module setUp writes under the scratch `tests/` dir;
    every other file holds a failing test a different start dir or
    pattern would collect."""

    def setUp(self):
        self.project = ScratchProject("unittest-discovery-defaults-", from_fixture=False)
        self.project.write("tests/test_counted.py",
                           _unittest_module("CountedTest", "test_counted", True))
        self.project.write("tests/check_not_counted.py",
                           _unittest_module("CheckTest", "test_check_not_counted", False))
        self.project.write("test_at_root.py",
                           _unittest_module("RootTest", "test_at_root", False))
        self.project.write("other/test_other.py",
                           _unittest_module("OtherTest", "test_other", False))

    def tearDown(self):
        self.project.close()

    def assert_only_the_default_selection_ran(self, verb, *argv):
        result = self.project.drive([verb, "--agent", AGENT, *argv])
        ingests = self.project.parsed_ingests()
        self.assertEqual(len(ingests), 1,
                         f"{verb}: exactly one parsed ingest; {diag(result)}")
        self.assertEqual(leaves(ingests[0]), [("test_counted", "pass")],
                         f"{verb}: start dir `tests`, pattern `test_*.py`; {diag(result)}")
        self.assertEqual(counts(ingests[0]),
                         {"total": 1, "passed": 1, "failed": 0, "pending": 0},
                         f"{verb}: {diag(result)}")
        self.assertEqual(result.returncode, 0, f"{verb}: {diag(result)}")

    def test_an_undeclared_project_test_run_discovers_tests_and_test_star_py(self):
        self.project.declare()
        self.assert_only_the_default_selection_ran("test")

    def test_an_undeclared_project_regression_discovers_tests_and_test_star_py(self):
        self.project.declare()
        self.assert_only_the_default_selection_ran("regression")

    def test_an_undeclared_project_pre_merge_gate_discovers_tests_and_test_star_py(self):
        self.project.declare()
        self.assert_only_the_default_selection_ran("pre-merge-gate")

    def test_runner_unittest_over_a_pytest_declaration_discovers_tests_and_test_star_py(self):
        self.project.declare("pytest")
        self.assert_only_the_default_selection_ran("test", "--runner", "unittest")


del _PytestCase


if __name__ == "__main__":
    unittest.main()
