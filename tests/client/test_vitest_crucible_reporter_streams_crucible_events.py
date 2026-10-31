"""The shipped Vitest reporter streams the board's `crucible-events` shape.

`clients/reporters/vitest-crucible.ts` is handed to a REAL Vitest run of a
scratch copy of `tests/fixtures/vitest-project`, through `CRUCIBLE_REPORTERS`,
and writes the file `CRUCIBLE_STREAM` names. Its stream must hold:

* one `run-start`, first, stating NO `total` -- Vitest's `onTestRunStart`
  receives only the files, before anything is collected;
* one `test-end` per test case, as it finishes, with `id`, `name`, `file`,
  `status` and `duration_ms`, and `failure` (message, type, trace) on a failing
  one; its `suite` is the describe chain joined by ` > `, or the test's file for
  a top-level test;
* passed -> `pass`, failed -> `fail`, skipped and todo -> `pending`, a test
  skipped statically included;
* for a module that fails to load, one failing `test-end` named `?` with that
  module's file and the error's message;
* one `run-end`, last, whose totals match the `test-end`s it follows.

Every line is one complete JSON object the board's `crucible-events` rules read
as a known event, and the whole stream decodes through the board's own codec
(`parseCrucibleEvents`) with nothing incomplete. A line is written as its test
finishes: a test that runs after another polls the stream for the earlier
test's line while the run is still going.

The interface these tests drive -- `CRUCIBLE_REPORTERS` naming the reporter's
directory, the fixture's config adding the reporter only when it is set, the
reporter reading `CRUCIBLE_STREAM` itself -- is stated in
`tests/client/vitest_reporter_scratch.py`.

The client side (the targets table, the relay, the streamed-run close) is not
exercised here: Vitest is run by the fixture's own script, with no client.

Invocation:
    python3 -m unittest tests.client.test_vitest_crucible_reporter_streams_crucible_events -v
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path
from typing import ClassVar

from tests.client.live_run_harness import REPO_ROOT, scrubbed_env
from tests.client.vitest_reporter_scratch import (
    FIXTURE_ALPHA,
    FIXTURE_BETA,
    FIXTURE_FAILING_CASE,
    FIXTURE_MIXED_FILE,
    FIXTURE_PASSING_CASE,
    FIXTURE_RUNTIME_CASE,
    REPORTERS_DIR,
    STREAM_FILE_NAME,
    TIMEOUT,
    codec_rejection,
    diagnostics,
    require_vitest_toolchain,
    run_fixture_vitest,
    scratch_fixture,
    stream_events,
)

SUITES_FILE = "suites-and-pending.vitest.ts"
BROKEN_FILE = "fails-to-load.vitest.ts"
MISSING_MODULE = "no-such-module-anywhere"
NEVER_COLLECTED = "a case in a module that never loads"

OUTER = "outer group"
INNER = "inner group"
NESTED_CASE = "a nested passing case"
OUTER_CASE = "a case in the outer group"
STATIC_SKIP = "a statically skipped case"
TODO_CASE = "a todo case"
RUNTIME_SKIP = "a case skipped at runtime"
SKIPPED_GROUP = "a skipped group"
SKIPPED_GROUP_CASE = "a case in a skipped group"
LOAD_FAILURE_NAME = "?"

_SUITES_SOURCE = f'''import {{ describe, expect, test }} from "vitest";

describe("{OUTER}", () => {{
  describe("{INNER}", () => {{
    test("{NESTED_CASE}", () => {{
      expect(1 + 1).toBe(2);
    }});
  }});
  test("{OUTER_CASE}", () => {{
    expect(2 + 2).toBe(4);
  }});
}});

test.skip("{STATIC_SKIP}", () => {{
  expect(1).toBe(2);
}});

test.todo("{TODO_CASE}");

test("{RUNTIME_SKIP}", (context) => {{
  context.skip();
  expect(1).toBe(2);
}});

describe.skip("{SKIPPED_GROUP}", () => {{
  test("{SKIPPED_GROUP_CASE}", () => {{
    expect(1).toBe(2);
  }});
}});
'''

_BROKEN_SOURCE = f'''import {{ expect, test }} from "vitest";
import {{ nothing }} from "./{MISSING_MODULE}.ts";

test("{NEVER_COLLECTED}", () => {{
  expect(nothing).toBe(undefined);
}});
'''

# name -> (status, the test's file, its describe chain or None for top level)
EXPECTED_TESTS = {
    FIXTURE_PASSING_CASE: ("pass", FIXTURE_MIXED_FILE, None),
    FIXTURE_FAILING_CASE: ("fail", FIXTURE_MIXED_FILE, None),
    FIXTURE_RUNTIME_CASE: ("pass", "runtime.vitest.ts", None),
    FIXTURE_ALPHA: ("pass", "name-filter.vitest.ts", None),
    FIXTURE_BETA: ("pass", "name-filter.vitest.ts", None),
    NESTED_CASE: ("pass", SUITES_FILE, f"{OUTER} > {INNER}"),
    OUTER_CASE: ("pass", SUITES_FILE, OUTER),
    STATIC_SKIP: ("pending", SUITES_FILE, None),
    TODO_CASE: ("pending", SUITES_FILE, None),
    RUNTIME_SKIP: ("pending", SUITES_FILE, None),
    SKIPPED_GROUP_CASE: ("pending", SUITES_FILE, SKIPPED_GROUP),
    LOAD_FAILURE_NAME: ("fail", BROKEN_FILE, None),
}
EXPECTED_TOTALS = {"total": 12, "passed": 6, "failed": 2, "pending": 4}

# The board's own decoding of the stream, through the real codec.
_DECODE_SCRIPT = (
    'import { parseCrucibleEvents } from '
    + json.dumps(str(REPO_ROOT / "src" / "codecs" / "crucible-events.ts")) + ";\n"
    'const text = await Bun.file(process.env["STREAM_TO_DECODE"] ?? "").text();\n'
    "const run = parseCrucibleEvents(text);\n"
    "console.log(JSON.stringify({ summary: run.summary, incomplete: run.incomplete ?? null,\n"
    "  suites: run.tree.map((suite) => suite.name) }));\n"
)


def _test_ends(events):
    return [event for event in events if event.get("event") == "test-end"]


def _by_name(events):
    named = {}
    for event in _test_ends(events):
        named.setdefault(event.get("name"), []).append(event)
    return named


class VitestReporterStreamsEveryTestTest(unittest.TestCase):
    """One real Vitest run of the fixture plus a describe chain, skips, a todo
    and a module that fails to load, its stream read back."""

    bun: ClassVar[str]
    scratch: ClassVar[str]
    stream: ClassVar[str]
    result: ClassVar[subprocess.CompletedProcess | None]

    @classmethod
    def setUpClass(cls):
        cls.scratch, project = scratch_fixture(
            "vitest-reporter-stream-",
            {SUITES_FILE: _SUITES_SOURCE, BROKEN_FILE: _BROKEN_SOURCE})
        stream_dir = os.path.join(cls.scratch, "reports")
        os.makedirs(stream_dir)
        cls.stream = os.path.join(stream_dir, STREAM_FILE_NAME)
        cls.bun = shutil.which("bun") or ""
        # Without bun nothing runs; `setUp` then fails every test naming why.
        cls.result = (run_fixture_vitest(cls.bun, project, REPORTERS_DIR, cls.stream)
                      if cls.bun else None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.scratch, ignore_errors=True)

    def setUp(self):
        require_vitest_toolchain(self)

    def events(self):
        return stream_events(self, self.stream, self.result)

    def test_every_line_is_a_complete_json_event_the_board_codec_reads(self):
        events = self.events()
        self.assertGreater(len(events), 0, diagnostics(self.result))
        rejected = [(event, codec_rejection(event)) for event in events
                    if codec_rejection(event) is not None]
        self.assertEqual(rejected, [],
                         "every line must be an event the board's `crucible-events` "
                         "rules read as known, never undecodable or unknown")

    def test_the_stream_opens_with_one_run_start_stating_no_total(self):
        events = self.events()
        starts = [event for event in events if event.get("event") == "run-start"]
        self.assertEqual(len(starts), 1, f"exactly one run-start; events={events!r}")
        self.assertEqual(events[0].get("event"), "run-start",
                         f"the run-start is the first line; first={events[0]!r}")
        self.assertNotIn("total", starts[0],
                         f"a Vitest run states no total up front; run-start={starts[0]!r}")

    def test_one_test_end_per_test_case_with_its_status(self):
        named = _by_name(self.events())
        statuses = {name: [event.get("status") for event in group]
                    for name, group in named.items()}
        expected = {name: [status] for name, (status, _, _) in EXPECTED_TESTS.items()}
        self.assertEqual(
            statuses, expected,
            "one test-end per test case: passed -> pass, failed -> fail, skipped "
            "(statically, at runtime, or in a skipped describe) and todo -> pending, "
            "and one `?` failure for the module that fails to load")
        self.assertNotIn(NEVER_COLLECTED, named,
                         "a module that fails to load streams no test of its own")

    def test_every_test_end_carries_id_name_file_status_and_duration(self):
        test_ends = _test_ends(self.events())
        self.assertEqual(len(test_ends), EXPECTED_TOTALS["total"], f"{test_ends!r}")
        ids = []
        for event in test_ends:
            name = event.get("name")
            if name == LOAD_FAILURE_NAME:
                continue
            _, expected_file, _ = EXPECTED_TESTS[name]
            self.assertIsInstance(event.get("id"), str, f"id: {event!r}")
            self.assertNotEqual(event.get("id"), "", f"id: {event!r}")
            ids.append(event.get("id"))
            self.assertIsInstance(event.get("file"), str, f"file: {event!r}")
            self.assertEqual(Path(event["file"]).name, expected_file,
                             f"the test's own file: {event!r}")
            if event.get("status") in ("pass", "fail"):
                duration = event.get("duration_ms")
                self.assertIsInstance(duration, (int, float), f"duration_ms: {event!r}")
                self.assertGreaterEqual(duration, 0, f"duration_ms: {event!r}")
        self.assertEqual(len(ids), len(set(ids)), f"every test's id is its own: {ids!r}")

    def test_suite_is_the_describe_chain_or_the_file_for_a_top_level_test(self):
        named = _by_name(self.events())
        wrong = {}
        for name, (_, _, chain) in EXPECTED_TESTS.items():
            if name == LOAD_FAILURE_NAME or name not in named:
                continue
            event = named[name][0]
            expected_suite = chain if chain is not None else event.get("file")
            if event.get("suite") != expected_suite:
                wrong[name] = (event.get("suite"), expected_suite)
        self.assertEqual(set(named) & set(EXPECTED_TESTS), set(EXPECTED_TESTS),
                         f"every expected test streams; streamed={sorted(named)!r}")
        self.assertEqual(
            wrong, {},
            "suite (got, expected): the describe chain joined by ' > ', or the "
            "test's file when it sits in no describe")

    def test_a_failing_test_carries_its_failure_message_type_and_trace(self):
        named = _by_name(self.events())
        self.assertIn(FIXTURE_FAILING_CASE, named, f"streamed={sorted(named)!r}")
        failing = named[FIXTURE_FAILING_CASE][0]
        failure = failing.get("failure")
        self.assertIsInstance(failure, dict, f"failing test-end: {failing!r}")
        self.assertIn("expected 2 to be 3", failure.get("message", ""), f"{failure!r}")
        self.assertEqual(failure.get("type"), "AssertionError",
                         f"the error's name, as Vitest's JUnit report types it; {failure!r}")
        self.assertIsInstance(failure.get("trace"), str, f"{failure!r}")
        self.assertIn(FIXTURE_MIXED_FILE, failure["trace"],
                      f"the trace locates the failure in its file; {failure!r}")
        unfailed = [event for event in _test_ends(self.events())
                    if event.get("status") != "fail" and "failure" in event]
        self.assertEqual(unfailed, [], "only a failing test carries a failure")

    def test_a_module_that_fails_to_load_is_one_failing_question_mark_test(self):
        named = _by_name(self.events())
        failures = named.get(LOAD_FAILURE_NAME, [])
        self.assertEqual(len(failures), 1,
                         f"exactly one `?` test-end, for the one module that fails "
                         f"to load; streamed={sorted(named)!r}")
        event = failures[0]
        self.assertEqual(event.get("status"), "fail", f"{event!r}")
        self.assertIsInstance(event.get("file"), str, f"{event!r}")
        self.assertEqual(Path(event["file"]).name, BROKEN_FILE,
                         f"the `?` test names the module that failed; {event!r}")
        failure = event.get("failure")
        self.assertIsInstance(failure, dict, f"{event!r}")
        self.assertIn(MISSING_MODULE, failure.get("message", ""),
                      f"the load error's own message; {event!r}")

    def test_the_stream_closes_with_one_run_end_whose_totals_match_its_tests(self):
        events = self.events()
        ends = [event for event in events if event.get("event") == "run-end"]
        self.assertEqual(len(ends), 1, f"exactly one run-end; events={events!r}")
        self.assertEqual(events[-1].get("event"), "run-end",
                         f"the run-end is the last line; last={events[-1]!r}")
        stated = {key: ends[0].get(key) for key in EXPECTED_TOTALS}
        self.assertEqual(stated, EXPECTED_TOTALS, f"run-end={ends[0]!r}")
        statuses = [event.get("status") for event in _test_ends(events)]
        counted = {"total": len(statuses), "passed": statuses.count("pass"),
                   "failed": statuses.count("fail"), "pending": statuses.count("pending")}
        self.assertEqual(stated, counted, "the run-end states what the test-ends count")

    def test_the_board_codec_decodes_the_stream_with_nothing_incomplete(self):
        self.events()
        decoded = subprocess.run(
            [self.bun, "-e", _DECODE_SCRIPT], cwd=REPO_ROOT,
            env=scrubbed_env(None, STREAM_TO_DECODE=self.stream),
            capture_output=True, text=True, timeout=TIMEOUT, check=False)
        self.assertEqual(decoded.returncode, 0, f"stderr={decoded.stderr[-2000:]!r}")
        run = json.loads(decoded.stdout.strip().splitlines()[-1])
        self.assertIsNone(run["incomplete"],
                          f"the board would mark this stream incomplete: {run!r}")
        summary = {key: run["summary"].get(key) for key in EXPECTED_TOTALS}
        self.assertEqual(summary, EXPECTED_TOTALS, f"{run!r}")
        self.assertIn(f"{OUTER} > {INNER}", run["suites"], f"{run!r}")
        self.assertIn(OUTER, run["suites"], f"{run!r}")


STREAMING_FILE = "streams-as-it-runs.vitest.ts"
FIRST_CASE = "the first case finishes"
SECOND_CASE = "the second case sees the first case already streamed"

_STREAMING_SOURCE = f'''import {{ existsSync, readFileSync }} from "node:fs";
import {{ expect, test }} from "vitest";

test("{FIRST_CASE}", () => {{
  expect(1 + 1).toBe(2);
}});

// Polls the stream while the run is still going: a reporter that writes only
// at exit never shows the first case's line here.
test("{SECOND_CASE}", async () => {{
  const path = process.env["CRUCIBLE_STREAM"] ?? "";
  const deadline = Date.now() + 10000;
  let seen = false;
  while (!seen && Date.now() < deadline) {{
    if (path !== "" && existsSync(path)) {{
      seen = readFileSync(path, "utf8").split("\\n").some((line) =>
        line.endsWith("}}") && line.includes({json.dumps(json.dumps(FIRST_CASE))}));
    }}
    if (!seen) await new Promise((resolve) => setTimeout(resolve, 50));
  }}
  expect(seen).toBe(true);
}}, 20000);
'''


class VitestReporterWritesEachLineAsItsTestFinishesTest(unittest.TestCase):
    """A line is on disk while the run is still going, not only at exit."""

    def setUp(self):
        self.bun = require_vitest_toolchain(self)
        self.scratch, self.project = scratch_fixture(
            "vitest-reporter-live-", {STREAMING_FILE: _STREAMING_SOURCE})
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        os.makedirs(os.path.join(self.scratch, "reports"))
        self.stream = os.path.join(self.scratch, "reports", STREAM_FILE_NAME)

    def test_a_later_test_reads_an_earlier_tests_line_during_the_run(self):
        result = run_fixture_vitest(self.bun, self.project, REPORTERS_DIR, self.stream,
                                    STREAMING_FILE)
        named = _by_name(stream_events(self, self.stream, result))
        self.assertEqual(sorted(named), sorted([FIRST_CASE, SECOND_CASE]),
                         f"the filtered run streams its two tests; {diagnostics(result)}")
        second = named[SECOND_CASE][0]
        self.assertEqual(
            second.get("status"), "pass",
            f"the first test's complete line must be in the stream while the second "
            f"test is still running; second={second!r}")
        self.assertEqual(result.returncode, 0, diagnostics(result))


if __name__ == "__main__":
    unittest.main()
