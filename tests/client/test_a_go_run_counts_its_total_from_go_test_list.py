"""A go run states its run-start total from `go test -list`, and `--run`
passes Go's own `-run`.

Before the run, the go client runs `go test -list <re> -json` over the run's
own packages and counts the names it prints: the listed `Test*`, `Fuzz*` and
`Example*` names, never a `Benchmark*` name or a package summary line
(`ok …`, `? … [no test files]`, `FAIL … [build failed]`). `<re>` is `.` with
no `--run`, and the top-level element of `--run` (before its first unbracketed
`/`) with one. The count rides the run start as its `total`.

  - the pure readers: `_count_listed(text)` counts a list's names (None when
    nothing in it can be read) and `_list_pattern(run)` answers `<re>`;
  - the whole module's run states the module's listed total;
  - `--run` passes Go's own `-run <regex>` to the run, lists the top-level
    element, and a regex naming a subtest runs only that subtest;
  - a regex matching nothing is a passing run of 0 tests, with a warning
    naming the regex;
  - a list that exits non-zero still counts the names it printed;
  - a list that cannot be read starts the run with no total and a warning,
    and the run goes on.

Driven with the real `go` through a recording shim (`go_client_harness`),
against a `RecordingBoard`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_go_run_counts_its_total_from_go_test_list
"""

import json
import unittest

from tests.client.go_client_harness import (
    CASES_PKG,
    FIXTURES,
    MODULE_LISTED,
    PLAIN_PKG,
    STREAM_CODEC,
    GoProject,
    diagnostics,
    envelope,
    flag_value,
    go_toolchain_gap,
    terminal_events,
    warning_texts,
)
from tests.client.live_run_harness import load_client

CAPTURED = FIXTURES / "captured"


def _output(text, package="example.com/p"):
    return json.dumps({"Action": "output", "Package": package, "Output": text})


class TheListIsCountedTest(unittest.TestCase):
    """`_count_listed`: the names of a `go test -list <re> -json` output."""

    @classmethod
    def setUpClass(cls):
        cls.client = load_client("go-crucible.py")

    def test_tests_fuzz_tests_and_examples_are_counted_and_benchmarks_and_summaries_are_not(self):
        text = "\n".join([
            '{"Action":"start","Package":"example.com/p"}',
            _output("TestA\n"), _output("TestB\n"), _output("BenchmarkX\n"),
            _output("FuzzF\n"), _output("ExampleHello\n"),
            _output("ok  \texample.com/p\t0.002s\n"),
            _output("?   \texample.com/q\t[no test files]\n", "example.com/q"),
            '{"Action":"pass","Package":"example.com/p","Elapsed":0.002}',
        ]) + "\n"
        self.assertEqual(self.client._count_listed(text), 4)

    def test_the_captured_list_of_the_fixture_module_counts_its_eleven_names(self):
        text = (CAPTURED / "module-list.jsonl").read_text(encoding="utf-8")
        self.assertEqual(self.client._count_listed(text), MODULE_LISTED)

    def test_a_list_with_a_package_that_did_not_build_counts_the_names_it_printed(self):
        text = (CAPTURED / "broken-list.jsonl").read_text(encoding="utf-8")
        self.assertEqual(self.client._count_listed(text), 2,
                         "TestG1 and TestG2; the build failure's lines are no names")

    def test_a_list_naming_no_test_counts_zero(self):
        text = "\n".join([
            '{"Action":"start","Package":"example.com/p"}',
            _output("ok  \texample.com/p\t0.002s\n"),
            '{"Action":"pass","Package":"example.com/p","Elapsed":0.002}',
        ]) + "\n"
        self.assertEqual(self.client._count_listed(text), 0)

    def test_a_list_that_cannot_be_read_counts_nothing(self):
        self.assertIsNone(self.client._count_listed("the list could not be read\n"))


class TheListPatternIsTheTopLevelElementTest(unittest.TestCase):
    """`_list_pattern`: the regex a run's list takes."""

    @classmethod
    def setUpClass(cls):
        cls.client = load_client("go-crucible.py")

    def test_no_run_regex_lists_every_test(self):
        self.assertEqual(self.client._list_pattern(None), ".")

    def test_a_top_level_regex_is_listed_as_given(self):
        self.assertEqual(self.client._list_pattern("TestSubs"), "TestSubs")
        self.assertEqual(self.client._list_pattern("^Test(A|B)$"), "^Test(A|B)$")

    def test_a_subtest_regex_lists_its_element_before_the_first_slash(self):
        self.assertEqual(self.client._list_pattern("TestSubs/ok"), "TestSubs")
        self.assertEqual(self.client._list_pattern("TestSubs/nest/deep"), "TestSubs")

    def test_a_slash_inside_brackets_does_not_split_the_regex(self):
        self.assertEqual(self.client._list_pattern("Test[/]X/sub"), "Test[/]X")
        self.assertEqual(self.client._list_pattern("Test[a/b]"), "Test[a/b]")


class _RealGo(unittest.TestCase):
    maxDiff = 4000

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")

    def start_body(self, p, result):
        starts = p.starts()
        self.assertEqual(len(starts), 1, f"one run is opened; {diagnostics(result)}")
        return starts[0] if starts else {}


class TheRunStartCarriesTheListedTotalTest(_RealGo):

    def test_a_whole_module_run_states_the_listed_test_fuzz_and_example_names(self):
        p = GoProject(self)
        p.board.script_run(passed=10, failed=5, pending=2)
        result = p.drive()
        where = diagnostics(result)
        self.assertEqual(self.start_body(p, result).get("total"), MODULE_LISTED,
                         f"11 names: benchmarks and the example with no Output are "
                         f"not counted; {where}")
        lists = p.list_calls()
        self.assertEqual(len(lists), 1, f"the module is listed once; {where}")
        self.assertEqual(flag_value(lists[0]["argv"], "-list"), ".", where)
        self.assertIn("-json", lists[0]["argv"], where)
        self.assertIn("./...", lists[0]["argv"], "the list covers the run's packages")
        index = p.calls().index(lists[0])
        self.assertLess(index, p.calls().index(p.run_calls()[0]),
                        "the list runs before the tests")

    def test_the_run_streams_go_test_json_to_the_open_run_under_go_test(self):
        p = GoProject(self)
        result = p.drive()
        where = diagnostics(result)
        self.assertEqual(self.start_body(p, result).get("framework"), STREAM_CODEC, where)
        batches = p.board.stream_posts()
        self.assertGreaterEqual(len(batches), 1, f"the run streams; {where}")
        self.assertEqual({b.get("codec") for _p, b in batches}, {STREAM_CODEC}, where)
        runs = p.run_calls()
        self.assertEqual(len(runs), 1, where)
        self.assertIn("-json", runs[0]["argv"], where)
        self.assertEqual({pkg for pkg, _t, _a in terminal_events(p.held())},
                         {CASES_PKG, PLAIN_PKG},
                         f"the board holds go's own stream of both packages; {where}")
        closes = p.closes()
        self.assertEqual([(c.get("codec"), c.get("runId"), "data" in c) for c in closes],
                         [(STREAM_CODEC, "run-live-1", False)],
                         f"the run is closed once from its stream; {where}")

    def test_a_list_that_exits_non_zero_still_counts_the_names_it_printed(self):
        p = GoProject(self, fixture="broken")
        p.board.script_run(passed=2, failed=1)
        result = p.drive()
        self.assertEqual(self.start_body(p, result).get("total"), 2,
                         f"TestG1 and TestG2 of the package that built; {diagnostics(result)}")
        self.assertEqual(len(p.run_calls()), 1, "the run goes on")

    def test_a_list_that_cannot_be_read_starts_the_run_with_no_total_and_a_warning(self):
        p = GoProject(self)
        p.board.script_run(passed=10, failed=5, pending=2)
        result = p.drive(GO_SHIM_UNREADABLE_LIST="1")
        where = diagnostics(result)
        start = self.start_body(p, result)
        self.assertIsNone(start.get("total"), f"no total is stated; start={start!r} {where}")
        self.assertEqual(len(p.run_calls()), 1, f"the run goes on; {where}")
        self.assertGreaterEqual(len(p.board.stream_posts()), 1, f"and streams; {where}")
        self.assertEqual(len(p.closes()), 1, f"and is closed; {where}")
        axi = envelope(result.stdout) or {}
        self.assertTrue([w for w in warning_texts(axi) if "list" in w],
                        f"a warning names the list; warnings={warning_texts(axi)!r} {where}")


class ARunRegexSelectsGosOwnRunTest(_RealGo):

    def test_run_passes_gos_own_run_flag_and_lists_its_top_level_element(self):
        p = GoProject(self)
        p.board.script_run(passed=1)
        result = p.drive("--run", "TestSubs/ok")
        where = diagnostics(result)
        runs = p.run_calls()
        self.assertEqual(len(runs), 1, where)
        self.assertEqual(flag_value(runs[0]["argv"], "-run"), "TestSubs/ok", where)
        lists = p.list_calls()
        self.assertEqual(len(lists), 1, where)
        self.assertEqual(flag_value(lists[0]["argv"], "-list"), "TestSubs", where)
        self.assertEqual(self.start_body(p, result).get("total"), 1,
                         f"the list names TestSubs alone; {where}")
        self.assertEqual(
            [(test, action) for _pkg, test, action in terminal_events(p.held())],
            [("TestSubs/ok", "pass"), ("TestSubs", "pass")],
            f"only the named subtest and its parent ran; {where}")

    def test_a_top_level_regex_runs_only_the_tests_it_matches(self):
        p = GoProject(self)
        p.board.script_run(passed=2)
        result = p.drive("--run", "TestB")
        where = diagnostics(result)
        self.assertEqual(self.start_body(p, result).get("total"), 2, where)
        self.assertEqual(sorted(test for _pkg, test, _a in terminal_events(p.held())),
                         ["TestB1", "TestB2"], where)
        self.assertEqual(result.returncode, 0, where)

    def test_a_regex_matching_nothing_is_a_passing_run_of_zero_tests_with_a_warning(self):
        p = GoProject(self)
        p.board.script_run(passed=0)
        result = p.drive("--run", "TestNoSuchThing")
        where = diagnostics(result)
        self.assertEqual(result.returncode, 0, f"the run passes; {where}")
        axi = envelope(result.stdout) or {}
        self.assertIs(axi.get("ok"), True, where)
        self.assertEqual(self.start_body(p, result).get("total"), 0, where)
        self.assertEqual(terminal_events(p.held()), [], f"no test ran; {where}")
        self.assertEqual(len(p.closes()), 1, f"the run is closed, not aborted; {where}")
        self.assertEqual(p.board.aborts(), [], f"nothing is aborted; {where}")
        self.assertTrue([w for w in warning_texts(axi) if "TestNoSuchThing" in w],
                        f"a warning names the regex; warnings={warning_texts(axi)!r}")


if __name__ == "__main__":
    unittest.main()
