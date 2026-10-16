"""Python's test/regression verbs run `unittest` through xmlrunner's own
discovery entry point (built by the client's `_xmlrunner_cmd` helper and
parsed back by `_parse_junit_dir`). `unittest` reports every subtest to the
result through `addSubTest(test, subtest, outcome)`, with `outcome` `None` for
a pass. The installed unittest-xml-reporting result class's `addSubTest`
writes a `<testcase>` only when `outcome` is not `None` -- a passing subtest
is silently dropped, and the whole parent test's own success is written once
instead. A suite with subtests therefore reports a SMALLER total when every
subtest passes than when one of them fails, and the subtest's own name never
appears in the all-pass run at all.

Measured directly against the installed unittest-xml-reporting 4.0.0 (see
`xmlrunner.result._XMLTestResult.addSubTest`): a loop of three `subTest`
cases plus one plain test reports 2 cases when every subtest passes (the
plain test's success plus the parent's own, collapsed) and 4 when the loop
fails (the plain test plus one `<testcase>` per failing subtest, named
`<method> (<params>)`). This file drives the REAL `python-crucible.py`
`test` and `regression` verbs (regression both with and without coverage.py
on) against a real interpreter holding the real unittest-xml-reporting
4.0.0, through an in-process HTTP board double, and asserts what the board
actually stores: the total must be identical whether every subtest passes or
some of them fail, every subtest's case name must be identical between the
two runs, and `passed + failed + pending` must equal `total` on every run.

Fixture names and environment variables below are chosen for this file alone
and carry no significance beyond it."""

import contextlib
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.live_run_harness import RecordingBoard, install_project, load_client

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"

AGENT = "subtest-parity-fixture-agent"
PROJECT_KEY = "subtest-parity-fixture-key"

# A loop of three `subTest` cases plus one plain test -- the exact shape the
# user's own probe used. `SUBTEST_PARITY_FAIL_CASES` is a comma-separated set
# of loop indices that must fail; empty (or unset) means every subtest
# passes.
PARITY_FIXTURE_SOURCE = '''\
import os
import unittest

_FAIL_CASES = {
    int(x) for x in os.environ.get("SUBTEST_PARITY_FAIL_CASES", "").split(",")
    if x != ""
}


class SubtestParityCase(unittest.TestCase):
    def test_three_case_loop(self):
        for i in range(3):
            with self.subTest(case=i):
                self.assertNotIn(i, _FAIL_CASES, "case %d failed" % i)

    def test_plain_case(self):
        self.assertTrue(True)
'''

# The case names unittest/xmlrunner assign: the plain test keeps its own
# name, and each subtest is named "<method> (case=<i>)" -- measured directly
# off a failing run's own JUnit XML, which already names failing subtests
# this way today.
PARITY_ALL_NAMES = frozenset({
    "test_plain_case",
    "test_three_case_loop (case=0)",
    "test_three_case_loop (case=1)",
    "test_three_case_loop (case=2)",
})


def _run_main(module, argv):
    """`module.main()` with `sys.argv` patched -- real argparse dispatch.
    Only `SystemExit` is caught; any other exception propagates as a test
    ERROR, which is still a valid signal."""
    full_argv = ["python-crucible.py"] + list(argv)
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", full_argv), \
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


def _last_parsed_payload(board):
    parsed = [body for path, body in board.posts() if path == "/api/v2/runs/parsed"]
    assert parsed, f"no /api/v2/runs/parsed POST observed; posts={board.posts()!r}"
    return parsed[-1]


def _case_names(payload):
    names = []
    for suite in payload.get("tree", []):
        for child in suite.get("children", []):
            names.append(child["name"])
    return names


class _SubtestCountingCase(unittest.TestCase):
    """Shared fixture-drive: a fresh throwaway project, a fresh in-process
    HTTP board double (the same `RecordingBoard` the sibling live-run tests
    already use), and the real `python-crucible.py` loaded by file path and
    driven in-process against a REAL interpreter (the repo's own `.venv`,
    which carries the real unittest-xml-reporting 4.0.0) -- never a fake
    runner, never a mocked `_post`."""

    def setUp(self):
        self.assertTrue(
            REAL_VENV_PYTHON.exists(),
            f"this file needs a real interpreter with unittest-xml-reporting "
            f"4.0.0 installed; expected one at {REAL_VENV_PYTHON}")

    def _run_scenario(self, verb_argv, fixture_source, env=None,
                       module_filename="fixture_subtests.py"):
        project_dir = tempfile.mkdtemp(prefix="subtest-counting-")
        self.addCleanup(shutil.rmtree, project_dir, ignore_errors=True)
        board = RecordingBoard()
        self.addCleanup(board.close)
        install_project(project_dir, board.url, PROJECT_KEY)
        pkg_dir = os.path.join(project_dir, "pkg")
        os.makedirs(pkg_dir, exist_ok=True)
        Path(os.path.join(pkg_dir, "__init__.py")).write_text("", encoding="utf-8")
        Path(os.path.join(pkg_dir, module_filename)).write_text(
            fixture_source, encoding="utf-8")
        # Restored IMMEDIATELY after the drive below, not deferred via
        # `addCleanup` -- this helper is called several times per test
        # method (once per `subTest` scenario), and a deferred restore would
        # leak one scenario's env into the next one run inside the SAME test
        # method.
        saved_env = {}
        for key, value in (env or {}).items():
            saved_env[key] = os.environ.get(key)
            os.environ[key] = value
        try:
            module = load_client("python-crucible.py")
            argv = list(verb_argv) + ["--project-dir", project_dir, "--agent", AGENT,
                                       "--python", str(REAL_VENV_PYTHON)]
            code, out, err = _run_main(module, argv)
        finally:
            for key, old in saved_env.items():
                if old is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = old
        return code, out, err, board


class TotalsAndNamesMatchAcrossRunOutcomesTest(_SubtestCountingCase):
    """Totals match across outcomes / Names match / the sum holds -- `test`,
    `regression`, and `regression --coverage`."""

    VERB_VARIANTS = (
        ("test", ["test", "--start-dir", "pkg", "--pattern", "fixture_subtests.py"]),
        ("regression", ["regression", "--start-dir", "pkg",
                         "--pattern", "fixture_subtests.py"]),
        ("regression-coverage", ["regression", "--start-dir", "pkg",
                                  "--pattern", "fixture_subtests.py",
                                  "--coverage", "--cov-source", "pkg"]),
    )

    def _assert_sum_holds(self, verb_label, summary):
        self.assertEqual(
            summary["passed"] + summary["failed"] + summary.get("pending", 0),
            summary["total"],
            f"{verb_label}: passed+failed+pending must equal total; "
            f"got summary={summary!r}")

    def test_total_and_names_are_identical_whether_every_subtest_passes_or_the_whole_loop_fails(self):
        for verb_label, verb_argv in self.VERB_VARIANTS:
            with self.subTest(verb=verb_label, run="all subtests pass"):
                _code, _out, err, board = self._run_scenario(
                    verb_argv, PARITY_FIXTURE_SOURCE, env={})
                payload = _last_parsed_payload(board)
                summary = payload["summary"]
                self.assertEqual(
                    summary["total"], 4,
                    f"{verb_label}: 3 passing subtests + 1 plain test must "
                    f"report total=4 -- the parent's own success must NOT be "
                    f"counted on top of its passing subtests; got "
                    f"summary={summary!r} stderr={err!r}")
                self.assertEqual(summary["failed"], 0, f"{verb_label}: {summary!r}")
                self.assertEqual(summary["passed"], 4, f"{verb_label}: {summary!r}")
                self._assert_sum_holds(verb_label, summary)
                names = set(_case_names(payload))
                self.assertEqual(
                    names, set(PARITY_ALL_NAMES),
                    f"{verb_label}: every subtest must be named exactly as a "
                    f"failing subtest is named today (the parent's method "
                    f"name plus its subtest params); got names={names!r}")

            with self.subTest(verb=verb_label, run="the loop fails"):
                _code, _out, err, board = self._run_scenario(
                    verb_argv, PARITY_FIXTURE_SOURCE,
                    env={"SUBTEST_PARITY_FAIL_CASES": "0,1,2"})
                payload = _last_parsed_payload(board)
                summary = payload["summary"]
                self.assertEqual(
                    summary["total"], 4,
                    f"{verb_label}: the SAME 4 cases must be reported when "
                    f"the loop fails as when it passes; got "
                    f"summary={summary!r} stderr={err!r}")
                self.assertEqual(summary["failed"], 3, f"{verb_label}: {summary!r}")
                self.assertEqual(summary["passed"], 1, f"{verb_label}: {summary!r}")
                self._assert_sum_holds(verb_label, summary)
                names = set(_case_names(payload))
                self.assertEqual(
                    names, set(PARITY_ALL_NAMES),
                    f"{verb_label}: subtest case names must be IDENTICAL "
                    f"between the passing and failing run; got "
                    f"names={names!r}")

    def test_mixed_subtest_outcomes_are_filed_as_three_cases_with_the_all_pass_names(self):
        _code, _out, err, board = self._run_scenario(
            ["test", "--start-dir", "pkg", "--pattern", "fixture_subtests.py"],
            PARITY_FIXTURE_SOURCE, env={"SUBTEST_PARITY_FAIL_CASES": "1"})
        payload = _last_parsed_payload(board)
        summary = payload["summary"]
        self.assertEqual(
            summary["total"], 4,
            f"two passing subtests + one failing subtest + the plain test "
            f"must total 4; got summary={summary!r} stderr={err!r}")
        self.assertEqual(summary["failed"], 1, summary)
        self.assertEqual(summary["passed"], 3, summary)
        self._assert_sum_holds("test", summary)
        names = set(_case_names(payload))
        self.assertEqual(
            names, set(PARITY_ALL_NAMES),
            f"a mixed run must use the same three subtest names as the "
            f"all-pass run; got names={names!r}")


PARENT_FAIL_FIXTURE_SOURCE = '''\
import os
import unittest

_FAIL_IN_TEARDOWN = os.environ.get("PARENT_FAIL_IN_TEARDOWN") == "1"


class ParentOwnFailureCase(unittest.TestCase):
    def test_subtests_then_parent_fails(self):
        for i in range(3):
            with self.subTest(case=i):
                self.assertTrue(True)
        if not _FAIL_IN_TEARDOWN:
            self.fail("parent body failed after its own passing subtests")

    def tearDown(self):
        if _FAIL_IN_TEARDOWN:
            self.fail("parent tearDown failed after its own passing subtests")
'''


class ParentsOwnFailureIsItsOwnCaseTest(_SubtestCountingCase):
    """A parent whose subtests all pass, then fails in its own body or its
    own `tearDown`, is filed as its passing subtests plus one failing case
    named as the parent (no subtest suffix)."""

    def _assert_parent_failure_case(self, env):
        _code, _out, err, board = self._run_scenario(
            ["test", "--start-dir", "pkg", "--pattern", "fixture_parent_fail.py"],
            PARENT_FAIL_FIXTURE_SOURCE, env=env,
            module_filename="fixture_parent_fail.py")
        payload = _last_parsed_payload(board)
        summary = payload["summary"]
        self.assertEqual(
            summary["total"], 4,
            f"3 passing subtests + 1 parent-level failure must total 4; "
            f"got summary={summary!r} stderr={err!r}")
        self.assertEqual(summary["passed"], 3, summary)
        self.assertEqual(summary["failed"], 1, summary)
        names = _case_names(payload)
        self.assertIn(
            "test_subtests_then_parent_fails", names,
            f"the parent's own failure must be filed as its OWN case, named "
            f"as the parent with no subtest suffix; got names={names!r}")
        for i in range(3):
            self.assertIn(
                f"test_subtests_then_parent_fails (case={i})", names,
                f"the passing subtests must still be filed individually; "
                f"got names={names!r}")

    def test_a_body_failure_after_passing_subtests_is_a_case_of_its_own(self):
        self._assert_parent_failure_case(env={})

    def test_a_teardown_failure_after_passing_subtests_is_a_case_of_its_own(self):
        self._assert_parent_failure_case(env={"PARENT_FAIL_IN_TEARDOWN": "1"})


NESTED_AND_SKIPPED_FIXTURE_SOURCE = '''\
import os
import unittest

_INNER_FAIL = os.environ.get("NESTED_INNER_FAIL") == "1"


class NestedAndSkippedCase(unittest.TestCase):
    def test_outer_with_two_inner_subtests(self):
        with self.subTest(outer=0):
            with self.subTest(inner=0):
                self.assertTrue(True)
            with self.subTest(inner=1):
                self.assertFalse(_INNER_FAIL, "inner subtest 1 deliberately failed")

    def test_one_subtest_skips(self):
        with self.subTest(case=0):
            self.skipTest("skipped inside a subtest")
'''


class NestedAndSkippedSubtestsTest(_SubtestCountingCase):
    """Each `subTest` block -- nested or not -- is its own case; a skip
    raised inside a subtest is one pending case named as the subtest.

    Measured directly against the installed `unittest` (via a bare
    `TestCase.run()` with a result that records every `addSubTest` call):
    when every nested subtest passes, `addSubTest` fires once for EACH of
    the outer block and the two inner blocks (three calls, each carrying its
    own merged parameter set), plus the method's own success -- which a
    correct runner must suppress since subtests were used. When the second
    inner subtest fails, `unittest` itself never calls `addSubTest` for the
    OUTER block at all (its own success flag is already false by the time
    its block finishes) and never calls `addSuccess`/`addFailure` for the
    parent either -- so that run's correct total is the two inner cases plus
    the pending skip, not three."""

    def test_each_subtest_block_is_its_own_case_when_every_nested_subtest_passes(self):
        _code, _out, err, board = self._run_scenario(
            ["test", "--start-dir", "pkg", "--pattern", "fixture_nested_and_skipped.py"],
            NESTED_AND_SKIPPED_FIXTURE_SOURCE, env={},
            module_filename="fixture_nested_and_skipped.py")
        payload = _last_parsed_payload(board)
        summary = payload["summary"]
        self.assertEqual(
            summary["total"], 4,
            f"the outer block, its two passing inner blocks, and the pending "
            f"skip must total 4; got summary={summary!r} stderr={err!r}")
        self.assertEqual(summary["passed"], 3, summary)
        self.assertEqual(summary.get("pending", 0), 1, summary)
        self.assertEqual(summary["failed"], 0, summary)
        names = set(_case_names(payload))
        expected = {
            "test_outer_with_two_inner_subtests (outer=0)",
            "test_outer_with_two_inner_subtests (inner=0, outer=0)",
            "test_outer_with_two_inner_subtests (inner=1, outer=0)",
            "test_one_subtest_skips (case=0)",
        }
        self.assertEqual(
            names, expected,
            f"each subTest block (outer and both inner) must be named and "
            f"counted on its own, plus the skip; got names={names!r}")

    def test_a_failing_inner_subtest_is_its_own_case_and_the_skip_stays_pending(self):
        _code, _out, err, board = self._run_scenario(
            ["test", "--start-dir", "pkg", "--pattern", "fixture_nested_and_skipped.py"],
            NESTED_AND_SKIPPED_FIXTURE_SOURCE,
            env={"NESTED_INNER_FAIL": "1"},
            module_filename="fixture_nested_and_skipped.py")
        payload = _last_parsed_payload(board)
        summary = payload["summary"]
        self.assertEqual(
            summary["total"], 3,
            f"the passing inner block, the failing inner block, and the "
            f"pending skip must total 3; got summary={summary!r} "
            f"stderr={err!r}")
        self.assertEqual(summary["passed"], 1, summary)
        self.assertEqual(summary["failed"], 1, summary)
        self.assertEqual(summary.get("pending", 0), 1, summary)
        names = set(_case_names(payload))
        expected = {
            "test_outer_with_two_inner_subtests (inner=0, outer=0)",
            "test_outer_with_two_inner_subtests (inner=1, outer=0)",
            "test_one_subtest_skips (case=0)",
        }
        self.assertEqual(
            names, expected,
            f"a failing inner subtest must still be filed as its own named "
            f"case, and the skip must stay pending; got names={names!r}")


if __name__ == "__main__":
    unittest.main()
