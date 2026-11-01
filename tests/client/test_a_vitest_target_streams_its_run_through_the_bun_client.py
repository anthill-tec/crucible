"""A Vitest target streams its run through the bun client, and is filed from it.

A scratch copy of `tests/fixtures/vitest-project` (its `node_modules` linked
offline, `tests/client/vitest_reporter_scratch.py`), with a describe chain, a
skipped and a todo test added, and its `crucible.reportPath` REPLACED by a
`crucible.targets` entry declaring `test:vitest` a `vitest` target streamed in
`crucible-events` through `env:CRUCIBLE_STREAM`. The fixture's own
`crucible.testScript` keeps naming `test:vitest`. It is run on the real `bun`
and Vitest through the REAL `clients/bun-crucible.py` (`test`) as an OS
subprocess, against `TargetsBoard` (tests/client/bun_targets_harness.py), whose
health lists `crucible-events` under `codecs.stream`.

What is pinned:
- the run streams its tests to `/api/v2/runs/<id>/stream` and is closed by its
  stream: ONE `/api/v2/runs` carrying the `runId`, codec `crucible-events` and
  no `data`, with framework `vitest` on the close and the start;
- the narration counts from the stream: `ran 10/10` (Vitest's `run-start` states
  no total), then `ingesting…`, both ahead of the close;
- the stored result (the held stream, its summary decoded by the board's own
  `crucible-events` codec) equals the same tests' JUnit report -- the same
  scratch copy run once more through the client with the fixture's own
  `crucible.reportPath` -- on summary counts and statuses, and on each test's
  failure message, matched by file and the describe chain plus name;
- a top-level test's suite is its file;
- a module that fails to load is one failing `?` test with its file;
- a `--name` run counts what ran from the stream: a pattern that matches
  files the run by its stream, one that matches nothing aborts it;
- nothing held (a runner that exits non-zero having written nothing, a stale
  stream file from an earlier run left in the reports dir): the run is closed
  by the compile ingest, `no-test-reports`;
- only a `run-start` held: the run is closed by its stream, with the
  `no-test-reports` warning and `ok: false`;
- no open run (a board with no `/api/v2/runs/start` route, or
  `--no-lifecycle`): the suite runs, nothing is filed, and the envelope is
  `ok: false` with an `error` naming the cause -- the board, or the opt-out.

The two runners with no test of their own (nothing held, only a `run-start`)
are the scratch copy's `test:vitest` script replaced by a shell line.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import ClassVar

from tests.client.bun_targets_harness import (
    AGENT,
    BUN_CLIENT,
    CLOSE,
    COMPILE,
    HEARTBEAT,
    INGESTING,
    NO_TEST_REPORTS,
    PARSED,
    PROJECT_KEY,
    RUN_ID,
    RUN_STREAM,
    STREAM_FILE,
    VITEST_STREAM_ENTRY,
    Drive,
    TargetsBoard,
    client_env,
)
from tests.client.live_run_harness import (
    REPO_ROOT,
    START,
    STREAM_CODEC,
    install_project,
)
from tests.client.vitest_reporter_scratch import (
    FIXTURE_ALPHA,
    FIXTURE_BETA,
    FIXTURE_FAILING_CASE,
    FIXTURE_MIXED_FILE,
    FIXTURE_PASSING_CASE,
    FIXTURE_RUNTIME_CASE,
    TIMEOUT,
    VITEST_SCRIPT,
    require_vitest_toolchain,
    scratch_fixture,
)

RUNTIME_FILE = "runtime.vitest.ts"
NAME_FILTER_FILE = "name-filter.vitest.ts"
CHAINS_FILE = "chains-and-pending.vitest.ts"
BROKEN_FILE = "fails-to-load.vitest.ts"
MISSING_MODULE = "no-such-module-anywhere"

OUTER = "outer group"
INNER = "inner group"
NESTED_PASSING = "a nested passing case"
NESTED_FAILING = "a nested failing case"
OUTER_CASE = "a case in the outer group"
SKIPPED_CASE = "a skipped case"
TODO_CASE = "a todo case"
LOAD_FAILURE_NAME = "?"

MATCHING_PATTERN = "^alpha match"
NO_MATCH_PATTERN = "zeta-matches-no-test"

_CHAINS_SOURCE = f'''import {{ describe, expect, test }} from "vitest";

describe("{OUTER}", () => {{
  describe("{INNER}", () => {{
    test("{NESTED_PASSING}", () => {{
      expect(1 + 1).toBe(2);
    }});
    test("{NESTED_FAILING}", () => {{
      expect("nested").toBe("expected");
    }});
  }});
  test("{OUTER_CASE}", () => {{
    expect(2 + 2).toBe(4);
  }});
}});

test.skip("{SKIPPED_CASE}", () => {{
  expect(1).toBe(2);
}});

test.todo("{TODO_CASE}");
'''

_BROKEN_SOURCE = f'''import {{ expect, test }} from "vitest";
import {{ nothing }} from "./{MISSING_MODULE}.ts";

test("a case in a module that never loads", () => {{
  expect(nothing).toBe(undefined);
}});
'''

# (file, describe chain plus name) -> status, for the whole scratch suite.
EXPECTED_STATUSES = {
    (FIXTURE_MIXED_FILE, FIXTURE_PASSING_CASE): "pass",
    (FIXTURE_MIXED_FILE, FIXTURE_FAILING_CASE): "fail",
    (RUNTIME_FILE, FIXTURE_RUNTIME_CASE): "pass",
    (NAME_FILTER_FILE, FIXTURE_ALPHA): "pass",
    (NAME_FILTER_FILE, FIXTURE_BETA): "pass",
    (CHAINS_FILE, f"{OUTER} > {INNER} > {NESTED_PASSING}"): "pass",
    (CHAINS_FILE, f"{OUTER} > {INNER} > {NESTED_FAILING}"): "fail",
    (CHAINS_FILE, f"{OUTER} > {OUTER_CASE}"): "pass",
    (CHAINS_FILE, SKIPPED_CASE): "pending",
    (CHAINS_FILE, TODO_CASE): "pending",
}
EXPECTED_SUMMARY = {"total": 10, "passed": 6, "failed": 2, "pending": 2}

# The board's own decoding of a held stream, through the real codec.
_DECODE_SCRIPT = (
    'import { parseCrucibleEvents } from '
    + json.dumps(str(REPO_ROOT / "src" / "codecs" / "crucible-events.ts")) + ";\n"
    'const text = await Bun.file(process.env["STREAM_TO_DECODE"] ?? "").text();\n'
    "const run = parseCrucibleEvents(text);\n"
    "console.log(JSON.stringify({ summary: run.summary, incomplete: run.incomplete ?? null }));\n"
)


# ── the scratch project ─────────────────────────────────────────────────────


def _manifest(project):
    return json.loads(Path(project, "package.json").read_text(encoding="utf-8"))


def _write_manifest(project, manifest):
    Path(project, "package.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def declare_stream_target(project, script_body=None):
    """The scratch copy's `crucible.reportPath` replaced by a `vitest` stream
    entry in `crucible.targets`; `script_body` replaces `test:vitest`'s."""
    manifest = _manifest(project)
    crucible = manifest["crucible"]
    crucible.pop("reportPath", None)
    crucible["targets"] = {VITEST_SCRIPT: VITEST_STREAM_ENTRY}
    if script_body is not None:
        manifest["scripts"][VITEST_SCRIPT] = script_body
    _write_manifest(project, manifest)


def restore_report_path(project, fixture_manifest):
    """The fixture's own manifest back: its JUnit through `reportPath`."""
    _write_manifest(project, fixture_manifest)


def drive_client(bun, project, board, *flags):
    """`bun-crucible.py test` in the scratch copy, filing to `board`."""
    install_project(project, board.url, PROJECT_KEY)
    cmd = [sys.executable, str(BUN_CLIENT), "test", "--agent", AGENT,
           "--project-dir", project, "--package-dir", project, "--bun", bun,
           "--reports", "reports", *flags]
    result = subprocess.run(cmd, cwd=project, env=client_env(NO_COLOR="1", FORCE_COLOR="0"),
                            capture_output=True, text=True, timeout=TIMEOUT, check=False)
    return Drive(result.returncode, result.stdout, result.stderr)


# ── reading what was filed ──────────────────────────────────────────────────


def posts_to(board, path):
    return [body for p, body in board.posts() if p == path]


def held_test_ends(board, run_id=RUN_ID):
    ends = []
    for line in board.held_stream(run_id).splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("event") == "test-end":
            ends.append(event)
    return ends


def stream_key(event):
    """A held `test-end` keyed by its file and its describe chain plus name
    (a top-level test's suite is its file, so it has no chain)."""
    file, suite, name = event.get("file"), event.get("suite"), event.get("name")
    return (file, name if suite == file else f"{suite} > {name}")


def junit_cases(body):
    """`{(classname, name): (status, failure message)}` over the JUnit report
    an ingest body carried inline. Vitest's JUnit names each case's file as
    its `classname` and its describe chain plus name as its `name`."""
    cases = {}
    for text in body.get("data") or []:
        root = ET.fromstring(text)  # noqa: S314 - a report a test's own run wrote
        for case in root.iter("testcase"):
            failure = case.find("failure")
            if failure is None:
                failure = case.find("error")
            if failure is not None:
                status = "fail"
            elif case.find("skipped") is not None:
                status = "pending"
            else:
                status = "pass"
            message = failure.get("message") if failure is not None else None
            cases[(case.get("classname"), case.get("name"))] = (status, message)
    return cases


def summary_of(statuses):
    values = list(statuses)
    return {"total": len(values), "passed": values.count("pass"),
            "failed": values.count("fail"), "pending": values.count("pending")}


class _VitestTargetCase(unittest.TestCase):
    """One scratch copy per class, run on the real Vitest in `setUpClass`."""

    bun: ClassVar[str]
    scratch: ClassVar[str]
    project: ClassVar[str]
    boards: ClassVar[list]

    EXTRA_FILES: ClassVar[dict] = {}

    @classmethod
    def setUpClass(cls):
        cls.scratch, cls.project = scratch_fixture("vitest-target-stream-", cls.EXTRA_FILES)
        cls.bun = shutil.which("bun") or ""
        cls.boards = []
        if cls.bun:
            cls.run_scenario()

    @classmethod
    def tearDownClass(cls):
        for board in cls.boards:
            board.close()
        shutil.rmtree(cls.scratch, ignore_errors=True)

    @classmethod
    def run_scenario(cls):
        """Each class's drives; without bun nothing runs and `setUp` fails."""

    @classmethod
    def new_board(cls, **options):
        board = TargetsBoard(**options)
        cls.boards.append(board)
        return board

    def setUp(self):
        require_vitest_toolchain(self)

    def assert_closed_by_its_stream(self, board, drive):
        closes = posts_to(board, CLOSE)
        self.assertEqual(len(closes), 1, f"posts={board.posts()!r}; {drive.diag()}")
        close = closes[0] or {}
        self.assertEqual(
            (close.get("runId"), close.get("codec"), close.get("framework")),
            (RUN_ID, STREAM_CODEC, "vitest"),
            f"the run is closed by its stream, framework vitest; close={close!r}")
        self.assertNotIn("data", close, f"a stream close sends no report; close={close!r}")
        self.assertEqual(posts_to(board, COMPILE) + posts_to(board, PARSED), [],
                         f"nor filed any other way; {drive.diag()}")
        return close


# ── the whole suite, streamed, against its JUnit report ─────────────────────


class AVitestRunIsStreamedAndFiledFromItsStreamTest(_VitestTargetCase):
    """The whole scratch suite streamed, then run once more with its JUnit."""

    EXTRA_FILES: ClassVar[dict] = {CHAINS_FILE: _CHAINS_SOURCE}
    stream_drive: ClassVar[Drive]
    junit_drive: ClassVar[Drive]
    stream_board: ClassVar[TargetsBoard]
    junit_board: ClassVar[TargetsBoard]

    @classmethod
    def run_scenario(cls):
        fixture_manifest = _manifest(cls.project)
        declare_stream_target(cls.project)
        cls.stream_board = cls.new_board()
        cls.stream_board.script_run(passed=6, failed=2, pending=2)
        cls.stream_drive = drive_client(cls.bun, cls.project, cls.stream_board)
        restore_report_path(cls.project, fixture_manifest)
        cls.junit_board = cls.new_board()
        cls.junit_drive = drive_client(cls.bun, cls.project, cls.junit_board)

    def junit_report(self):
        closes = posts_to(self.junit_board, CLOSE)
        self.assertEqual(len(closes), 1,
                         f"the JUnit run is filed once; {self.junit_drive.diag()}")
        body = closes[0] or {}
        self.assertEqual(body.get("codec"), "junit", f"body keys={sorted(body)!r}")
        return junit_cases(body)

    def test_the_run_streams_its_tests_to_the_open_runs_stream_route(self):
        board, drive = self.stream_board, self.stream_drive
        batches = board.stream_posts()
        self.assertTrue(batches, f"the run relays its stream; {drive.diag()}")
        self.assertEqual({p for p, _b in batches}, {RUN_STREAM})
        self.assertEqual({(b or {}).get("codec") for _p, b in batches}, {STREAM_CODEC})
        self.assertEqual(len(held_test_ends(board)), EXPECTED_SUMMARY["total"],
                         f"the board holds every test; held={board.held_stream(RUN_ID)!r}")
        self.assertTrue(os.path.isfile(os.path.join(self.project, "reports", STREAM_FILE)),
                        f"the runner wrote <reports dir>/{STREAM_FILE}")

    def test_the_run_is_closed_by_its_stream_with_framework_vitest(self):
        board, drive = self.stream_board, self.stream_drive
        self.assertEqual(drive.returncode, 1, f"a failing test exits 1; {drive.diag()}")
        starts = posts_to(board, START)
        self.assertEqual(len(starts), 1, drive.diag())
        self.assertEqual((starts[0] or {}).get("framework"), "vitest",
                         f"the run start carries framework vitest; start={starts[0]!r}")
        self.assert_closed_by_its_stream(board, drive)

    def test_the_narration_counts_the_streams_tests_ahead_of_the_close(self):
        board = self.stream_board
        posts = board.posts()
        messages = [(i, str(b["message"])) for i, (p, b) in enumerate(posts)
                    if p == HEARTBEAT and isinstance(b, dict)
                    and isinstance(b.get("message"), str)]
        counts = [(i, m) for i, m in messages if m.startswith("ran ")]
        self.assertEqual([m for _i, m in counts], ["ran 10/10"],
                         f"one final count, from the stream's test-ends; messages={messages!r}")
        ingesting = [i for i, m in messages if m == INGESTING]
        close_at = [i for i, (p, _b) in enumerate(posts) if p == CLOSE]
        self.assertTrue(ingesting and close_at, f"messages={messages!r}")
        self.assertLess(counts[0][0], ingesting[0])
        self.assertLess(ingesting[0], close_at[0], "both are said ahead of the close")

    def test_the_stored_summary_and_statuses_equal_the_junit_reports(self):
        board = self.stream_board
        held = Path(tempfile.mkdtemp(prefix="vitest-target-held-")) / STREAM_FILE
        self.addCleanup(shutil.rmtree, held.parent, ignore_errors=True)
        held.write_text(board.held_stream(RUN_ID), encoding="utf-8")
        decoded = subprocess.run([self.bun, "-e", _DECODE_SCRIPT], cwd=REPO_ROOT,
                                 env=client_env(STREAM_TO_DECODE=str(held)),
                                 capture_output=True, text=True, timeout=TIMEOUT, check=False)
        self.assertEqual(decoded.returncode, 0, f"stderr={decoded.stderr[-2000:]!r}")
        run = json.loads(decoded.stdout.strip().splitlines()[-1])
        self.assertIsNone(run["incomplete"], f"the stored stream is complete: {run!r}")
        stored = {key: run["summary"].get(key) for key in EXPECTED_SUMMARY}
        junit = self.junit_report()
        self.assertEqual(stored, summary_of(status for status, _m in junit.values()),
                         "the stored summary equals the JUnit report's")
        self.assertEqual(stored, EXPECTED_SUMMARY)
        streamed = {stream_key(e): e.get("status") for e in held_test_ends(board)}
        self.assertEqual(streamed, {key: status for key, (status, _m) in junit.items()},
                         "each test's status, by file and describe chain plus name, "
                         "equals the JUnit report's")
        self.assertEqual(streamed, EXPECTED_STATUSES)

    def test_each_failure_message_equals_the_junit_reports(self):
        junit = self.junit_report()
        expected = {key: message for key, (status, message) in junit.items()
                    if status == "fail"}
        self.assertEqual(len(expected), 2, f"junit={junit!r}")
        streamed = {stream_key(e): (e.get("failure") or {}).get("message")
                    for e in held_test_ends(self.stream_board) if e.get("status") == "fail"}
        self.assertEqual(streamed, expected,
                         "each failure message, matched by file and describe chain "
                         "plus name, equals the JUnit report's")
        for message in streamed.values():
            self.assertTrue(message, "a failure carries its message")

    def test_a_top_level_test_sits_under_its_file_as_its_suite(self):
        ends = {e.get("name"): e for e in held_test_ends(self.stream_board)}
        self.assertIn(FIXTURE_PASSING_CASE, ends, self.stream_drive.diag())
        top = ends[FIXTURE_PASSING_CASE]
        self.assertEqual((top.get("suite"), top.get("file")),
                         (FIXTURE_MIXED_FILE, FIXTURE_MIXED_FILE), f"test-end={top!r}")
        nested = ends.get(NESTED_PASSING) or {}
        self.assertEqual(nested.get("suite"), f"{OUTER} > {INNER}", f"test-end={nested!r}")


# ── a module that fails to load ─────────────────────────────────────────────


class AModuleThatFailsToLoadIsOneFailingTestTest(_VitestTargetCase):

    EXTRA_FILES: ClassVar[dict] = {BROKEN_FILE: _BROKEN_SOURCE}
    drive: ClassVar[Drive]
    board: ClassVar[TargetsBoard]

    @classmethod
    def run_scenario(cls):
        declare_stream_target(cls.project)
        cls.board = cls.new_board()
        cls.drive = drive_client(cls.bun, cls.project, cls.board, "--tests", BROKEN_FILE)

    def test_a_module_that_fails_to_load_is_one_failing_question_mark_test_with_its_file(self):
        self.assert_closed_by_its_stream(self.board, self.drive)
        ends = held_test_ends(self.board)
        self.assertEqual(len(ends), 1, f"held={self.board.held_stream(RUN_ID)!r}")
        only = ends[0]
        self.assertEqual((only.get("name"), only.get("status"), only.get("file")),
                         (LOAD_FAILURE_NAME, "fail", BROKEN_FILE), f"test-end={only!r}")
        self.assertIn(MISSING_MODULE, (only.get("failure") or {}).get("message", ""),
                      f"the load error's message is the failure's; test-end={only!r}")
        self.assertNotEqual(self.drive.returncode, 0, self.drive.diag())


# ── a --name run counts what ran from the stream ────────────────────────────


class ANameFilteredRunCountsWhatRanFromTheStreamTest(_VitestTargetCase):

    matched: ClassVar[Drive]
    unmatched: ClassVar[Drive]
    matched_board: ClassVar[TargetsBoard]
    unmatched_board: ClassVar[TargetsBoard]

    @classmethod
    def run_scenario(cls):
        declare_stream_target(cls.project)
        cls.matched_board = cls.new_board()
        cls.matched_board.script_run(passed=1, pending=1)
        cls.matched = drive_client(cls.bun, cls.project, cls.matched_board,
                                   "--tests", NAME_FILTER_FILE, "--name", MATCHING_PATTERN)
        cls.unmatched_board = cls.new_board()
        cls.unmatched = drive_client(cls.bun, cls.project, cls.unmatched_board,
                                     "--tests", NAME_FILTER_FILE, "--name", NO_MATCH_PATTERN)

    def test_a_pattern_that_matches_is_filed_by_its_stream(self):
        board, drive = self.matched_board, self.matched
        self.assert_closed_by_its_stream(board, drive)
        self.assertEqual(board.aborts(), [], f"the run is not aborted; {drive.diag()}")
        ran = [e for e in held_test_ends(board) if e.get("status") in ("pass", "fail")]
        self.assertEqual([(e.get("name"), e.get("status")) for e in ran],
                         [(FIXTURE_ALPHA, "pass")], "only the matching test ran")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual((drive.envelope or {}).get("name"), MATCHING_PATTERN,
                         f"envelope={drive.envelope!r}")

    def test_a_pattern_that_matches_nothing_aborts_the_run_and_files_nothing(self):
        board, drive = self.unmatched_board, self.unmatched
        self.assertEqual(drive.returncode, 1, drive.diag())
        envelope = drive.envelope or {}
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        codes = [w.get("code") for w in envelope.get("warnings") or [] if isinstance(w, dict)]
        self.assertIn("name-filter-ran-nothing", codes, f"envelope={envelope!r}")
        self.assertIn(NO_MATCH_PATTERN, json.dumps(envelope.get("warnings")))
        self.assertEqual(posts_to(board, CLOSE) + posts_to(board, COMPILE), [],
                         f"nothing is filed; posts={board.posts()!r}")
        aborts = board.aborts()
        self.assertEqual(len(aborts), 1, f"the opened run is aborted once; {drive.diag()}")
        self.assertIn(RUN_ID, aborts[0][0])


# ── a runner that holds no test ─────────────────────────────────────────────


class AVitestRunThatHoldsNoTestTest(_VitestTargetCase):
    """`test:vitest` replaced by a shell line: one writes nothing, one writes
    only a `run-start` before it fails."""

    nothing: ClassVar[Drive]
    run_start_only: ClassVar[Drive]
    nothing_board: ClassVar[TargetsBoard]
    run_start_board: ClassVar[TargetsBoard]
    STALE_MARKER = "a-stale-test-from-an-earlier-run"

    @classmethod
    def run_scenario(cls):
        declare_stream_target(cls.project, script_body="exit 3")
        reports = Path(cls.project, "reports")
        reports.mkdir(exist_ok=True)
        (reports / STREAM_FILE).write_text(
            json.dumps({"event": "test-end", "name": cls.STALE_MARKER, "status": "pass"})
            + "\n", encoding="utf-8")
        cls.nothing_board = cls.new_board()
        cls.nothing = drive_client(cls.bun, cls.project, cls.nothing_board)
        declare_stream_target(
            cls.project,
            script_body='echo \'{"event":"run-start"}\' > "$CRUCIBLE_STREAM"; exit 4')
        cls.run_start_board = cls.new_board()
        cls.run_start_only = drive_client(cls.bun, cls.project, cls.run_start_board)

    def test_a_runner_that_writes_nothing_is_closed_by_the_compile_ingest(self):
        board, drive = self.nothing_board, self.nothing
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        compiles = posts_to(board, COMPILE)
        self.assertEqual(len(compiles), 1, f"posts={board.posts()!r}; {drive.diag()}")
        self.assertEqual(((compiles[0] or {}).get("runId"), (compiles[0] or {}).get("framework")),
                         (RUN_ID, "vitest"), f"compile={compiles[0]!r}")
        self.assertEqual(posts_to(board, CLOSE), [], "no stream close")
        self.assertNotIn(self.STALE_MARKER, board.held_stream(RUN_ID),
                         "the wipe removed the earlier run's stream file")
        envelope = drive.envelope or {}
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        codes = [w.get("code") for w in envelope.get("warnings") or [] if isinstance(w, dict)]
        self.assertIn(NO_TEST_REPORTS, codes, f"envelope={envelope!r}")

    def test_a_runner_that_wrote_only_a_run_start_is_closed_by_its_stream_with_the_warning(self):
        board, drive = self.run_start_board, self.run_start_only
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        self.assertIn('"run-start"', board.held_stream(RUN_ID), drive.diag())
        self.assert_closed_by_its_stream(board, drive)
        envelope = drive.envelope or {}
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        codes = [w.get("code") for w in envelope.get("warnings") or [] if isinstance(w, dict)]
        self.assertIn(NO_TEST_REPORTS, codes, f"envelope={envelope!r}")


# ── no open run ─────────────────────────────────────────────────────────────


class AVitestRunWithNoOpenRunFilesNothingTest(_VitestTargetCase):

    no_route: ClassVar[Drive]
    no_lifecycle: ClassVar[Drive]
    no_route_board: ClassVar[TargetsBoard]
    no_lifecycle_board: ClassVar[TargetsBoard]

    @classmethod
    def run_scenario(cls):
        declare_stream_target(cls.project)
        cls.no_route_board = cls.new_board(start_route=False)
        cls.no_route = drive_client(cls.bun, cls.project, cls.no_route_board,
                                    "--tests", FIXTURE_MIXED_FILE)
        cls.no_lifecycle_board = cls.new_board()
        cls.no_lifecycle = drive_client(cls.bun, cls.project, cls.no_lifecycle_board,
                                        "--tests", FIXTURE_MIXED_FILE, "--no-lifecycle")

    def assert_ran_and_filed_nothing(self, board, drive):
        self.assertIn(FIXTURE_FAILING_CASE, drive.stderr,
                      f"the suite runs: its output reaches stderr; {drive.diag()}")
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(posts_to(board, CLOSE) + posts_to(board, COMPILE)
                         + posts_to(board, PARSED), [],
                         f"nothing is filed; posts={board.posts()!r}")
        self.assertEqual(board.stream_posts(), [], "nothing is streamed")
        envelope = drive.envelope or {}
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        error = envelope.get("error")
        self.assertIsInstance(error, str, f"the envelope names its cause; envelope={envelope!r}")
        return str(error)

    def test_a_board_with_no_run_start_route_runs_the_suite_and_files_nothing(self):
        error = self.assert_ran_and_filed_nothing(self.no_route_board, self.no_route)
        self.assertIn(self.no_route_board.url, error,
                      "the cause named is the board that opened no run")

    def test_no_lifecycle_runs_the_suite_and_files_nothing(self):
        board, drive = self.no_lifecycle_board, self.no_lifecycle
        error = self.assert_ran_and_filed_nothing(board, drive)
        self.assertIn("no-lifecycle", error, "the cause named is the opt-out")
        self.assertEqual(posts_to(board, START), [], "no run is opened")
        self.assertEqual(board.health_reads(), [], "no health is read under --no-lifecycle")


if __name__ == "__main__":
    unittest.main()
