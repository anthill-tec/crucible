"""The shared stream reading counts a `go test -json` stream's top-level results.

`_counted_event(event, codec)` (`clients/_crucible_run.py`) is the one
reading of a stream line every streamed run's in-run ticks are counted from.
Under the `go-test` codec (the shared module's own `GO_TEST_STREAM_CODEC`) it
reads a line's `Action` and `Test`:

  - `pass` or `fail` with a top-level `Test` (one holding no `/`) is
    `("result", True)`;
  - `skip` with a top-level `Test` is `("result", False)`;
  - everything else is `(None, None)`: a subtest's result, a package-level
    action (no `Test`), and every `run`, `output`, `pause`, `cont`, `start`,
    `bench`, `build-output` and `build-fail` line, and an action go has not
    written yet.

Counting top-level tests only keeps the tick's N at the granularity of
`go test -list`, which gives the tick's M.

The readings are checked against a stream captured once with go1.27.3 from
the `tests/fixtures/go-client/stream-shapes` module (a passing, a failing
and a skipped test, a parent with nested subtests, a parent whose subtest
fails, an Example with output, and parallel tests that `pause` and `cont`):
`tests/fixtures/go-client/captured/stream-shapes.jsonl`.

The `crucible-events` and `nextest` readings are pinned as they are, so the
`go-test` branch changes neither.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.unit.test_the_shared_stream_reading_counts_top_level_go_results
"""

import json
import unittest

from tests.client.go_client_harness import FIXTURES
from tests.client.live_run_harness import load_client

RUN = load_client("_crucible_run.py")
AXI = load_client("_crucible_axi.py")

GO_TEST = "go-test"
CAPTURED_STREAM = FIXTURES / "captured" / "stream-shapes.jsonl"
PACKAGE = "example.com/shapes"

RESULT_RAN = ("result", True)
RESULT_SKIPPED = ("result", False)
NOTHING = (None, None)

#: The captured stream's top-level results, in stream order: `(Test,
#: Action, reading)`. TestPass is parallel, so it finishes after the others
#: that run in sequence.
TOP_LEVEL_RESULTS = [
    ("TestFail", "fail", RESULT_RAN),
    ("TestSkip", "skip", RESULT_SKIPPED),
    ("TestParent", "pass", RESULT_RAN),
    ("TestParentFailsChild", "fail", RESULT_RAN),
    ("TestPass", "pass", RESULT_RAN),
    ("Example", "pass", RESULT_RAN),
]


def captured_events():
    return [json.loads(line) for line in
            CAPTURED_STREAM.read_text(encoding="utf-8").splitlines() if line.strip()]


def _line(action, test=None, **extra):
    event = {"Time": "2026-11-10T21:21:35.789602426+05:30", "Action": action,
             "Package": PACKAGE}
    if test is not None:
        event["Test"] = test
    event.update(extra)
    return event


class TheSharedModuleNamesTheGoTestStreamCodecTest(unittest.TestCase):

    def test_the_go_test_stream_codec_is_go_test_beside_nextest(self):
        self.assertEqual(getattr(RUN, "GO_TEST_STREAM_CODEC", None), GO_TEST,
                         "clients/_crucible_run.py names the `go-test` stream codec "
                         "GO_TEST_STREAM_CODEC")
        self.assertEqual(RUN.NEXTEST_STREAM_CODEC, "nextest",
                         "the nextest codec beside it is unchanged")
        self.assertEqual(getattr(AXI, "GO_TEST_STREAM_CODEC", None), GO_TEST,
                         "the constant is re-exported to every client's `_axi()`")


class ACapturedGoStreamCountsItsTopLevelResultsTest(unittest.TestCase):
    """The captured stream, read line by line under `go-test`."""

    maxDiff = 8000

    @classmethod
    def setUpClass(cls):
        cls.events = captured_events()
        cls.readings = [RUN._counted_event(event, GO_TEST) for event in cls.events]

    def test_the_captured_stream_holds_every_shape_the_reading_must_tell_apart(self):
        actions = [(e.get("Action"), e.get("Test")) for e in self.events]
        subtest_results = [t for a, t in actions
                           if a in ("pass", "fail", "skip") and t and "/" in t]
        self.assertEqual(sorted(subtest_results),
                         ["TestParent/a", "TestParent/b", "TestParent/b/deep",
                          "TestParentFailsChild/bad"],
                         "four subtest results, one of them a failure")
        self.assertIn(("fail", None), actions, "a package-level fail")
        self.assertIn(("start", None), actions, "a package-level start")
        self.assertIn(("pause", "TestPass"), actions, "a top-level pause")
        self.assertIn(("cont", "TestPass"), actions, "a top-level cont")
        self.assertIn(("pause", "TestParent/a"), actions, "a subtest pause")
        self.assertIn(("run", "TestPass"), actions, "a top-level run")
        self.assertIn(("output", "Example"), actions, "a top-level output")

    def test_each_top_level_result_counts_once_and_a_skip_did_not_run(self):
        counted = [(e.get("Test"), e.get("Action"), reading)
                   for e, reading in zip(self.events, self.readings, strict=True)
                   if reading != NOTHING]
        self.assertEqual(counted, TOP_LEVEL_RESULTS,
                         "6 results, one per top-level test: 5 that ran, the skip that "
                         "did not; no subtest, package-level or progress line counts")

    def test_the_counted_results_are_six_of_which_five_ran(self):
        results = [ran for kind, ran in self.readings if kind == "result"]
        self.assertEqual((len(results), results.count(True), results.count(False)),
                         (6, 5, 1), "(results, ran, did not run)")
        self.assertEqual([r for r in self.readings if r[0] not in (None, "result")], [],
                         "a go-test line is never a start, an end or a `started`")

    def test_every_line_but_a_top_level_result_reads_as_nothing(self):
        top_level = {(test, action) for test, action, _r in TOP_LEVEL_RESULTS}
        read = [((e.get("Test"), e.get("Action")), reading)
                for e, reading in zip(self.events, self.readings, strict=True)]
        self.assertEqual(
            [key for key, reading in read if key not in top_level and reading != NOTHING],
            [], "a subtest's result, a package-level action, and every run, output, "
                "pause and cont line count nothing")
        self.assertEqual(
            [key for key, reading in read if key in top_level and reading == NOTHING],
            [], f"and every top-level result counts; readings={read!r}")


class EachGoActionReadsByItsActionAndItsTestTest(unittest.TestCase):
    """Lines the captured module cannot write (build output, benchmarks, an
    action go has not written yet), read beside a top-level result each, so
    a reading that counted nothing at all is caught."""

    def assert_readings(self, expected):
        got = [(event, RUN._counted_event(event, GO_TEST)) for event, _want in expected]
        self.assertEqual(got, expected)

    def test_build_output_build_fail_start_and_bench_count_nothing(self):
        self.assert_readings([
            (_line("start"), NOTHING),
            ({"ImportPath": PACKAGE + " [example.com/shapes.test]",
              "Action": "build-output", "Output": "# example.com/shapes\n"}, NOTHING),
            ({"ImportPath": PACKAGE + " [example.com/shapes.test]",
              "Action": "build-fail"}, NOTHING),
            (_line("bench", "BenchmarkHello", Output="BenchmarkHello 1 ns/op\n"), NOTHING),
            (_line("fail", FailedBuild=PACKAGE + " [example.com/shapes.test]"), NOTHING),
            (_line("pass", "TestAfterTheBuild", Elapsed=0), RESULT_RAN),
        ])

    def test_a_top_level_progress_line_counts_nothing_and_its_result_counts(self):
        self.assert_readings([
            (_line("run", "TestOne"), NOTHING),
            (_line("pause", "TestOne"), NOTHING),
            (_line("cont", "TestOne"), NOTHING),
            (_line("output", "TestOne", Output="--- PASS: TestOne (0.00s)\n"), NOTHING),
            (_line("pass", "TestOne", Elapsed=0), RESULT_RAN),
        ])

    def test_a_subtest_result_counts_nothing_at_any_depth(self):
        self.assert_readings([
            (_line("pass", "TestOne/a"), NOTHING),
            (_line("fail", "TestOne/a/deep"), NOTHING),
            (_line("skip", "TestOne/b"), NOTHING),
            (_line("fail", "TestOne"), RESULT_RAN),
        ])

    def test_a_top_level_skip_is_a_result_that_did_not_run(self):
        self.assert_readings([
            (_line("skip", "TestLater"), RESULT_SKIPPED),
            (_line("skip", "ExampleLater"), RESULT_SKIPPED),
            (_line("pass", "FuzzSeed"), RESULT_RAN),
        ])

    def test_an_action_go_has_not_written_yet_counts_nothing(self):
        self.assert_readings([
            (_line("interrupt", "TestOne"), NOTHING),
            (_line("attempt", "TestOne"), NOTHING),
            (_line("pass", "TestTwo"), RESULT_RAN),
        ])

    def test_a_line_of_another_codec_counts_nothing_under_go_test(self):
        self.assert_readings([
            ({"event": "test-end", "status": "pass"}, NOTHING),
            ({"type": "test", "event": "ok", "name": "a::b"}, NOTHING),
            ("not an object", NOTHING),
            (_line("pass", "TestThree"), RESULT_RAN),
        ])


class TheOtherCodecsReadAsBeforeTest(unittest.TestCase):
    """Pins: the `crucible-events` and `nextest` readings, line by line, as
    they are before the `go-test` branch; and a `go test -json` line counts
    nothing under either."""

    def assert_readings(self, codec, expected):
        got = [(event, RUN._counted_event(event, codec)) for event, _want in expected]
        self.assertEqual(got, expected, f"codec {codec!r}")

    def test_the_crucible_events_reading_is_unchanged(self):
        self.assert_readings(RUN.STREAM_RECORD_CODEC, [
            ({"event": "test-end", "status": "pass"}, ("result", True)),
            ({"event": "test-end", "status": "fail"}, ("result", True)),
            ({"event": "test-end", "status": "skip"}, ("result", False)),
            ({"event": "run-end", "total": 3}, ("end", 3)),
            ({"event": "run-end"}, ("end", None)),
            ({"event": "run-end", "total": True}, ("end", None)),
            ({"event": "run-start", "total": 4}, ("start", 4)),
            ({"event": "run-start"}, NOTHING),
            ({"event": "test-start", "id": "a"}, NOTHING),
            (["not", "an", "object"], NOTHING),
            (_line("pass", "TestOne"), NOTHING),
        ])

    def test_the_nextest_reading_is_unchanged(self):
        self.assert_readings(RUN.NEXTEST_STREAM_CODEC, [
            ({"type": "test", "event": "ok", "name": "a::b"}, ("result", True)),
            ({"type": "test", "event": "failed", "name": "a::c"}, ("result", True)),
            ({"type": "test", "event": "ignored", "name": "a::d"}, ("result", False)),
            ({"type": "test", "event": "started", "name": "a::e"}, ("started", "a::e")),
            ({"type": "suite", "event": "ok"}, NOTHING),
            ({"type": "test", "event": "timeout", "name": "a::f"}, NOTHING),
            ({"event": "test-end", "status": "pass"}, NOTHING),
            (_line("pass", "TestOne"), NOTHING),
        ])

    def test_the_default_codec_is_still_crucible_events(self):
        self.assertEqual(RUN._counted_event({"event": "test-end", "status": "pass"}, None),
                         ("result", True))
        self.assertEqual(RUN._counted_event(_line("pass", "TestOne"), None), NOTHING)


if __name__ == "__main__":
    unittest.main()
