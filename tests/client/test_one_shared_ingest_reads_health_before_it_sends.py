"""The one shared ingest: it reads the board's health, refuses before sending
what that board cannot take, and otherwise sends the run's reports inline.

`ingest_reports(post_fn, get_fn, *, stack, project_key, agent_id, codec,
report_paths, raw=None, coverage_codec=None, coverage_paths=(), tier=None,
context=None, run_id=None, release=None, runner_exit=None)` in
`clients/_crucible_axi.py`:

* reads health first, through `get_fn`; health that cannot be read (the board
  unreachable, or an answer that is not `ok`) sends nothing and the result
  names the health error;
* health with no `codecs`, or whose `codecs.test` lacks the run's codec, or
  (coverage given) whose `codecs.coverage` lacks the coverage codec, sends
  nothing, and the refusal names health's `version` and the 0.4.0 floor and
  carries no CR literal;
* a stamped body (`stack` and `release` included) over
  `limits.ingest_body_bytes` sends nothing and names the limit and its value;
  at exactly the limit it sends; health with `codecs` but no `limits` sends;
* otherwise ONE `POST /api/v2/runs` through `post_ingest`, carrying `codec`,
  `data` (each report's text, in path order), `coverage: {codec, data}` only
  when coverage was given, `raw`, and `tier`/`context`/`runId`/`release`/
  `runnerExit` when given, plus the `stack` stamp; its answer is returned;
* a 413 is reported naming `ingest_body_bytes`;
* a refusal before sending, with a run open, aborts the run through
  `abort_run` with the refusal as its reason, and the result's `warnings`
  carry `run-aborted` (`run-left-open` when the abort is refused).

`junit_non_skipped_count(paths)` counts the `<testcase>` elements carrying no
`<skipped>`; `junit_testcase_count` keeps its contract. `junit_case_sources(paths)`
reads each `<testcase>` as `(name, stem)` (the name `"?"` when it has none; the
stem from `classname`, else `file`, a backslash read as `/`, its basename without
extension, `None` when that is empty), and answers `None` with one warning for a
report it cannot read.

Driven in-process through recording `get`/`post` seams, and over real HTTP
against `RecordingBoard` (never the live board).

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_one_shared_ingest_reads_health_before_it_sends
"""

import contextlib
import copy
import inspect
import io
import json
import os
import re
import shutil
import tempfile
import unittest
from unittest import mock

from tests.client.live_run_harness import RecordingBoard, load_client

RUNS = "/api/v2/runs"
HEALTH_PATHS = ("/api/health", "/api/v2/health")
PROJECT_KEY = "shared-ingest-project-key"
AGENT = "shared-ingest-agent"
RUN_ID = "run-shared-ingest-1"
STACK = "python"
FLOOR = "0.4.0"
CR_LITERAL = re.compile(r"CR-[A-Z]{2,}-\d+")

JUNIT_A = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuites name="a">\n'
    '  <testsuite name="tests.test_a" tests="2">\n'
    '    <testcase classname="tests.test_a.A" name="test_one" time="0.001"/>\n'
    '    <testcase classname="tests.test_a.A" name="test_two" time="0.001">\n'
    '      <skipped message="not today"/>\n'
    '    </testcase>\n'
    '  </testsuite>\n'
    '</testsuites>\n')
JUNIT_B = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuite name="tests.test_b" tests="3">\n'
    '  <testcase classname="tests.test_b.B" name="test_three" time="0.001"/>\n'
    '  <testcase classname="tests.test_b.B" name="test_four" time="0.001">\n'
    '    <failure message="boom">Traceback</failure>\n'
    '  </testcase>\n'
    '  <testcase classname="tests.test_b.B" name="test_five" time="0.001"/>\n'
    '</testsuite>\n')
JUNIT_ALL_SKIPPED = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuites name="bun test">\n'
    '  <testsuite name="a.test.ts" tests="2">\n'
    '    <testcase name="first" classname="a.test.ts"><skipped/></testcase>\n'
    '    <testcase name="second" classname="a.test.ts">\n'
    '      <skipped message="filtered out">filtered</skipped>\n'
    '    </testcase>\n'
    '  </testsuite>\n'
    '</testsuites>\n')
LCOV = ("TN:\nSF:clients/x.py\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n")
RAW = "Ran 5 tests in 0.004s\n\nFAILED (failures=1, skipped=1)\n"
CONTEXT = {"wave": "8", "role": "RED", "cycleId": 787}

RUN_BLOCK = {"passed": 3, "failed": 1, "pending": 1, "total": 5, "files": 2}
INGEST_OK = {"ok": True, "changed": True, "event": "evt-shared-ingest-1",
             "run": RUN_BLOCK, "warnings": []}


def healthy(limit=128 * 1024 * 1024, version="0.4.0"):
    return {"ok": True, "status": "healthy", "version": version,
            "codecs": {"test": ["junit", "playwright"],
                       "coverage": ["jacoco", "lcov"]},
            "limits": {"ingest_body_bytes": limit}}


class _Board:
    """The client's `_get`/`_post` seams: every call recorded, in one wire
    order, with the answers a test chose."""

    def __init__(self, health=None, ingest_reply=None, abort_ok=True):
        self.health = healthy() if health is None else health
        self.ingest_reply = INGEST_OK if ingest_reply is None else ingest_reply
        self.abort_ok = abort_ok
        self.calls = []  # [(method, path, body)]

    def get(self, path, *_args, **_kwargs):
        self.calls.append(("GET", path, None))
        return copy.deepcopy(self.health)

    def post(self, path, payload=None, *_args, **_kwargs):
        self.calls.append(("POST", path, copy.deepcopy(payload)))
        if path.endswith("/abort"):
            return ({"ok": True, "changed": True, "status": "aborted"}
                    if self.abort_ok else {"ok": False, "error": "abort refused"})
        return copy.deepcopy(self.ingest_reply)

    def gets(self):
        return [path for method, path, _ in self.calls if method == "GET"]

    def posts(self, path=None):
        return [(p, b) for method, p, b in self.calls
                if method == "POST" and (path is None or p == path)]

    def aborts(self):
        return [(p, b) for p, b in self.posts() if p.endswith("/abort")]


class _SharedIngestCase(unittest.TestCase):
    """A fresh shared module per test (its module state cannot leak), and two
    report files plus one coverage file on disk."""

    def setUp(self):
        self.axi = load_client("_crucible_axi.py")
        self.scratch = tempfile.mkdtemp(prefix="shared-ingest-")
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.report_a = self._write("TEST-a.xml", JUNIT_A)
        self.report_b = self._write("TEST-b.xml", JUNIT_B)
        self.lcov = self._write("lcov.info", LCOV)

    def _write(self, name, text):
        path = os.path.join(self.scratch, name)
        with open(path, "w") as handle:
            handle.write(text)
        return path

    def ingest(self, board, **overrides):
        kwargs = {"stack": STACK, "project_key": PROJECT_KEY,
                  "agent_id": AGENT, "codec": "junit",
                  "report_paths": [self.report_a, self.report_b],
                  "raw": RAW}
        kwargs.update(overrides)
        with contextlib.redirect_stderr(io.StringIO()), \
                contextlib.redirect_stdout(io.StringIO()):
            return self.axi.ingest_reports(board.post, board.get, **kwargs)

    def assert_sent_nothing(self, board):
        self.assertEqual(
            board.posts(), [],
            f"a refusal before sending posts nothing; posted {board.posts()!r}")

    def assert_refused(self, resp):
        self.assertIsInstance(resp, dict)
        self.assertIs(resp.get("ok"), False,
                      f"a refusal answers ok: false; got {resp!r}")
        self.assertIsInstance(resp.get("error"), str)
        return resp["error"]

    def warning_codes(self, resp):
        return [w.get("code") for w in (resp.get("warnings") or [])
                if isinstance(w, dict)]


# ── health is read first ────────────────────────────────────────────────────

class TheSharedIngestReadsHealthFirstTest(_SharedIngestCase):

    def test_health_is_read_once_through_the_given_get_before_the_one_post(self):
        board = _Board()
        self.ingest(board)
        self.assertEqual(len(board.gets()), 1,
                         f"health is read exactly once; GETs: {board.gets()!r}")
        self.assertIn(board.gets()[0], HEALTH_PATHS)
        methods = [method for method, _p, _b in board.calls]
        self.assertEqual(methods, ["GET", "POST"],
                         f"health is read before the ingest is sent; calls: "
                         f"{[(m, p) for m, p, _ in board.calls]!r}")

    def test_an_unreachable_board_at_the_health_read_sends_nothing_and_names_the_error(self):
        unreachable = ("connection failed: [Errno 111] Connection refused "
                       "(is Crucible running at http://127.0.0.1:1?)")
        board = _Board(health={"ok": False, "error": unreachable})
        error = self.assert_refused(self.ingest(board))
        self.assert_sent_nothing(board)
        self.assertIn("connection failed: [Errno 111] Connection refused", error)

    def test_a_health_answer_that_is_not_ok_sends_nothing_and_names_its_error(self):
        board = _Board(health={"ok": False,
                               "error": "HTTP 503: the store is migrating"})
        error = self.assert_refused(self.ingest(board))
        self.assert_sent_nothing(board)
        self.assertIn("the store is migrating", error)


# ── an older board ──────────────────────────────────────────────────────────

class TheSharedIngestRefusesABoardThatCannotDecodeTheRunTest(_SharedIngestCase):

    def assert_older_board_refusal(self, board, version, **overrides):
        error = self.assert_refused(self.ingest(board, **overrides))
        self.assert_sent_nothing(board)
        self.assertIn(version, error,
                      f"the refusal names the board's version; got {error!r}")
        self.assertIn(FLOOR, error,
                      f"the refusal names the {FLOOR} floor; got {error!r}")
        self.assertIsNone(CR_LITERAL.search(error),
                          f"no CR literal in a client's refusal; got {error!r}")
        return error

    def test_health_without_codecs_is_refused_naming_its_version_and_the_floor(self):
        health = healthy(version="0.3.7")
        del health["codecs"]
        del health["limits"]
        self.assert_older_board_refusal(_Board(health=health), "0.3.7")

    def test_health_whose_test_codecs_lack_the_runs_codec_is_refused(self):
        health = healthy(version="0.3.9")
        health["codecs"] = {"test": ["playwright"], "coverage": ["lcov"]}
        self.assert_older_board_refusal(_Board(health=health), "0.3.9")

    def test_health_whose_coverage_codecs_lack_the_coverage_codec_is_refused(self):
        health = healthy(version="0.3.8")
        health["codecs"] = {"test": ["junit"], "coverage": ["jacoco"]}
        self.assert_older_board_refusal(
            _Board(health=health), "0.3.8",
            coverage_codec="lcov", coverage_paths=[self.lcov])

    def test_a_coverage_codec_the_board_lacks_does_not_refuse_a_run_without_coverage(self):
        health = healthy()
        health["codecs"] = {"test": ["junit"], "coverage": ["jacoco"]}
        board = _Board(health=health)
        resp = self.ingest(board)
        self.assertEqual(len(board.posts(RUNS)), 1,
                         f"a run measuring no coverage needs no coverage codec; "
                         f"posted {board.posts()!r}")
        self.assertIs(resp.get("ok"), True)

    def test_health_with_codecs_but_no_limits_sends_the_run(self):
        health = healthy()
        del health["limits"]
        board = _Board(health=health)
        resp = self.ingest(board)
        self.assertEqual(len(board.posts(RUNS)), 1,
                         f"no limit advertised is no limit: the run is sent; "
                         f"posted {board.posts()!r}")
        self.assertEqual(resp.get("run"), RUN_BLOCK)


# ── the advertised body limit ───────────────────────────────────────────────

class TheSharedIngestRefusesABodyOverTheAdvertisedLimitTest(_SharedIngestCase):
    """The measure is `len(json.dumps(payload).encode())` of the body as
    `post_ingest` stamps it, `stack` and `release` included."""

    STAMPED = {"release": "0.4.0", "tier": "unit", "context": CONTEXT}

    def stamped_body_bytes(self):
        board = _Board()
        self.ingest(board, **self.STAMPED)
        bodies = [body for _p, body in board.posts(RUNS)]
        self.assertEqual(len(bodies), 1)
        self.assertEqual((bodies[0].get("stack"), bodies[0].get("release")),
                         (STACK, "0.4.0"), "the measured body is the stamped one")
        return len(json.dumps(bodies[0]).encode()), bodies[0]

    def test_a_body_at_exactly_the_limit_is_sent(self):
        size, sent_body = self.stamped_body_bytes()
        board = _Board(health=healthy(limit=size))
        resp = self.ingest(board, **self.STAMPED)
        self.assertEqual([body for _p, body in board.posts(RUNS)], [sent_body],
                         f"a body of exactly ingest_body_bytes ({size}) is sent")
        self.assertIs(resp.get("ok"), True)

    def test_a_body_one_byte_over_the_limit_is_refused_naming_the_limit_and_sends_nothing(self):
        size, _sent = self.stamped_body_bytes()
        board = _Board(health=healthy(limit=size - 1))
        error = self.assert_refused(self.ingest(board, **self.STAMPED))
        self.assert_sent_nothing(board)
        self.assertIn("ingest_body_bytes", error)
        self.assertIn(str(size - 1), error,
                      f"the refusal names the limit's value; got {error!r}")
        self.assertIsNone(CR_LITERAL.search(error))

    def test_a_413_from_the_board_is_reported_naming_ingest_body_bytes(self):
        board = _Board(ingest_reply={"ok": False,
                                     "error": "HTTP 413: Payload Too Large"})
        error = self.assert_refused(self.ingest(board))
        self.assertEqual(len(board.posts(RUNS)), 1,
                         "the board was asked once; its 413 is the answer")
        self.assertIn("ingest_body_bytes", error,
                      f"a 413 is reported naming ingest_body_bytes; got {error!r}")
        self.assertEqual(board.aborts(), [], "no run was open: nothing to abort")

    def test_a_413_for_an_open_run_aborts_it_once_through_post_ingest(self):
        board = _Board(ingest_reply={"ok": False,
                                     "error": "HTTP 413: Payload Too Large"})
        self.axi.forget_ingested_run()
        error = self.assert_refused(self.ingest(board, run_id=RUN_ID))
        self.assertIn("ingest_body_bytes", error)
        self.assertEqual(
            [p for p, _b in board.aborts()], [f"/api/v2/runs/{RUN_ID}/abort"],
            f"the refused ingest's run is aborted exactly once; posted "
            f"{[p for p, _ in board.posts()]!r}")


# ── what is sent ────────────────────────────────────────────────────────────

class TheSharedIngestSendsOneRunWithItsReportsInlineTest(_SharedIngestCase):

    def test_the_one_post_carries_the_codec_the_report_texts_in_path_order_and_the_run_fields(self):
        board = _Board()
        self.ingest(board, coverage_codec="lcov", coverage_paths=[self.lcov],
                    tier="unit", context=CONTEXT, run_id=RUN_ID,
                    release="0.4.0", runner_exit=1)
        self.assertEqual([p for p, _b in board.posts()], [RUNS],
                         "exactly one POST, to /api/v2/runs")
        self.assertEqual(board.posts(RUNS)[0][1], {
            "projectKey": PROJECT_KEY,
            "agentId": AGENT,
            "codec": "junit",
            "data": [JUNIT_A, JUNIT_B],
            "coverage": {"codec": "lcov", "data": [LCOV]},
            "raw": RAW,
            "tier": "unit",
            "context": CONTEXT,
            "runId": RUN_ID,
            "release": "0.4.0",
            "runnerExit": 1,
            "stack": STACK,
        })

    def test_fields_not_given_are_not_sent_and_a_zero_runner_exit_is(self):
        board = _Board()
        self.ingest(board, raw=None, runner_exit=0)
        body = board.posts(RUNS)[0][1]
        self.assertEqual(body, {"projectKey": PROJECT_KEY, "agentId": AGENT,
                                "codec": "junit",
                                "data": [JUNIT_A, JUNIT_B],
                                "runnerExit": 0, "stack": STACK})

    def test_no_coverage_block_is_sent_when_no_coverage_was_given(self):
        board = _Board()
        self.ingest(board)
        body = board.posts(RUNS)[0][1]
        self.assertNotIn("coverage", body)
        self.assertNotIn("dataPath", body)
        self.assertNotIn("summary", body)

    def test_the_run_is_sent_through_post_ingest_with_the_stack_and_release(self):
        board = _Board()
        self.axi.forget_ingested_run()
        with mock.patch.object(self.axi, "post_ingest",
                               wraps=self.axi.post_ingest) as spy:
            self.ingest(board, release="0.4.0", run_id=RUN_ID)
        spy.assert_called_once()
        args, kwargs = spy.call_args
        bound = inspect.signature(self.axi.post_ingest).bind(*args, **kwargs)
        self.assertEqual(bound.arguments["post_fn"], board.post,
                         "post_ingest gets the given post seam")
        self.assertEqual(bound.arguments["path"], RUNS)
        self.assertEqual((bound.arguments.get("stack"),
                          bound.arguments.get("release")), (STACK, "0.4.0"))
        self.assertEqual(self.axi.filed_run_events(), ["evt-shared-ingest-1"],
                         "the filed run is recorded as post_ingest records it")

    def test_the_boards_answer_is_returned(self):
        resp = self.ingest(_Board())
        self.assertEqual(resp.get("event"), "evt-shared-ingest-1")
        self.assertEqual(resp.get("run"), RUN_BLOCK)


# ── a refusal before sending settles the run the verb opened ────────────────

class ARefusalBeforeSendingAbortsTheOpenRunTest(_SharedIngestCase):

    def refusing_boards(self):
        no_codecs = healthy(version="0.3.7")
        del no_codecs["codecs"]
        return {
            "health unreadable": _Board(health={"ok": False,
                                                "error": "connection failed: down"}),
            "older board": _Board(health=no_codecs),
            "over the limit": _Board(health=healthy(limit=32)),
        }

    def test_each_refusal_aborts_the_open_run_with_the_refusal_as_its_reason(self):
        for case, board in self.refusing_boards().items():
            with self.subTest(refusal=case):
                self.axi.forget_ingested_run()
                resp = self.ingest(board, run_id=RUN_ID)
                error = self.assert_refused(resp)
                self.assertEqual(board.posts(RUNS), [], "nothing was ingested")
                aborts = board.aborts()
                self.assertEqual([p for p, _b in aborts],
                                 [f"/api/v2/runs/{RUN_ID}/abort"],
                                 f"the open run is aborted once; posted "
                                 f"{[p for p, _ in board.posts()]!r}")
                self.assertEqual(aborts[0][1], {"projectKey": PROJECT_KEY,
                                                "agentId": AGENT,
                                                "reason": error})
                self.assertEqual(self.warning_codes(resp), ["run-aborted"])
                self.assertIn(RUN_ID, resp["warnings"][0].get("detail", ""))

    def test_a_refused_abort_leaves_the_run_open_and_says_so(self):
        board = _Board(health=healthy(limit=32), abort_ok=False)
        resp = self.ingest(board, run_id=RUN_ID)
        self.assert_refused(resp)
        self.assertEqual(len(board.aborts()), 1)
        self.assertEqual(self.warning_codes(resp), ["run-left-open"])

    def test_with_no_run_open_a_refusal_aborts_nothing(self):
        for case, board in self.refusing_boards().items():
            with self.subTest(refusal=case):
                resp = self.ingest(board)
                self.assert_refused(resp)
                self.assert_sent_nothing(board)
                self.assertEqual(
                    [c for c in self.warning_codes(resp)
                     if c in ("run-aborted", "run-left-open")], [])


# ── a report the client cannot read is a refusal before sending ────────────

_RUNNING_AS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0
_ROOT_SKIP_REASON = ("root reads a file whatever its mode bits, so no report "
                     "can be made unreadable to this process")


class AReportTheClientCannotReadIsRefusedBeforeSendingTest(_SharedIngestCase):
    """A report or coverage path `ingest_reports` cannot read (a directory
    where the file should be, a file without read permission) is a refusal
    before sending (§S1): nothing goes to `/api/v2/runs`, the answer is
    `{ok: False, error, warnings}` with the error naming the path and saying
    nothing was sent, and an open run is aborted once with that refusal as
    its reason, exactly as the other refusals before sending settle it."""

    def directory_where_a_report_should_be(self, name):
        path = os.path.join(self.scratch, name)
        os.mkdir(path)
        return path

    def unreadable_report(self, name, text):
        path = self._write(name, text)
        os.chmod(path, 0)
        self.addCleanup(os.chmod, path, 0o600)
        return path

    def ingest_unreadable(self, board, **overrides):
        """The ingest's answer; an `OSError` it lets escape is the defect,
        reported as a failure naming it."""
        try:
            return self.ingest(board, **overrides)
        except OSError as exc:
            self.fail(f"ingest_reports let {type(exc).__name__} escape for a "
                      f"report it cannot read ({exc}); it must refuse before "
                      f"sending and answer {{ok: False, error, warnings}}")

    def assert_refused_naming(self, resp, path):
        error = self.assert_refused(resp)
        self.assertIn(path, error,
                      f"the refusal names the path it cannot read; got {error!r}")
        self.assertIn("nothing was sent", error,
                      f"the refusal says nothing was sent; got {error!r}")
        self.assertIsNone(CR_LITERAL.search(error),
                          f"no CR literal in a client's refusal; got {error!r}")
        return error

    def assert_open_run_aborted_once(self, board, resp, error, code):
        self.assertEqual(board.posts(RUNS), [], "nothing was ingested")
        aborts = board.aborts()
        self.assertEqual([p for p, _b in aborts], [f"/api/v2/runs/{RUN_ID}/abort"],
                         f"the open run is aborted exactly once; posted "
                         f"{[p for p, _ in board.posts()]!r}")
        self.assertEqual([p for p, _b in board.posts()], [p for p, _b in aborts],
                         "the abort is the only POST")
        self.assertEqual(aborts[0][1], {"projectKey": PROJECT_KEY,
                                        "agentId": AGENT, "reason": error},
                         "the abort's reason is the refusal")
        self.assertEqual(self.warning_codes(resp), [code])
        self.assertIn(RUN_ID, resp["warnings"][0].get("detail", ""))

    def assert_nothing_settled(self, resp):
        self.assertEqual(
            [c for c in self.warning_codes(resp)
             if c in ("run-aborted", "run-left-open")], [],
            f"no run was open: nothing to settle; got {resp!r}")

    def test_a_report_path_that_is_a_directory_aborts_the_open_run_and_sends_nothing(self):
        directory = self.directory_where_a_report_should_be("TEST-c.xml")
        board = _Board()
        self.axi.forget_ingested_run()
        resp = self.ingest_unreadable(
            board, run_id=RUN_ID,
            report_paths=[self.report_a, directory, self.report_b])
        error = self.assert_refused_naming(resp, directory)
        self.assert_open_run_aborted_once(board, resp, error, "run-aborted")

    def test_a_report_path_that_is_a_directory_with_no_run_open_posts_nothing(self):
        directory = self.directory_where_a_report_should_be("TEST-c.xml")
        board = _Board()
        resp = self.ingest_unreadable(board, report_paths=[directory])
        self.assert_refused_naming(resp, directory)
        self.assert_sent_nothing(board)
        self.assert_nothing_settled(resp)

    def test_a_coverage_path_that_is_a_directory_aborts_the_open_run_and_sends_nothing(self):
        directory = self.directory_where_a_report_should_be("lcov-dir.info")
        board = _Board()
        self.axi.forget_ingested_run()
        resp = self.ingest_unreadable(board, run_id=RUN_ID, coverage_codec="lcov",
                                      coverage_paths=[directory])
        error = self.assert_refused_naming(resp, directory)
        self.assert_open_run_aborted_once(board, resp, error, "run-aborted")

    def test_an_unreadable_report_whose_abort_is_refused_leaves_the_run_open_and_says_so(self):
        directory = self.directory_where_a_report_should_be("TEST-c.xml")
        board = _Board(abort_ok=False)
        self.axi.forget_ingested_run()
        resp = self.ingest_unreadable(board, run_id=RUN_ID,
                                      report_paths=[directory])
        error = self.assert_refused_naming(resp, directory)
        self.assert_open_run_aborted_once(board, resp, error, "run-left-open")

    @unittest.skipIf(_RUNNING_AS_ROOT, _ROOT_SKIP_REASON)
    def test_a_report_without_read_permission_aborts_the_open_run_and_sends_nothing(self):
        unreadable = self.unreadable_report("TEST-c.xml", JUNIT_B)
        board = _Board()
        self.axi.forget_ingested_run()
        resp = self.ingest_unreadable(board, run_id=RUN_ID,
                                      report_paths=[self.report_a, unreadable])
        error = self.assert_refused_naming(resp, unreadable)
        self.assert_open_run_aborted_once(board, resp, error, "run-aborted")

    @unittest.skipIf(_RUNNING_AS_ROOT, _ROOT_SKIP_REASON)
    def test_a_report_without_read_permission_with_no_run_open_posts_nothing(self):
        unreadable = self.unreadable_report("TEST-c.xml", JUNIT_B)
        board = _Board()
        resp = self.ingest_unreadable(board, report_paths=[unreadable])
        self.assert_refused_naming(resp, unreadable)
        self.assert_sent_nothing(board)
        self.assert_nothing_settled(resp)

    @unittest.skipIf(_RUNNING_AS_ROOT, _ROOT_SKIP_REASON)
    def test_a_coverage_report_without_read_permission_aborts_the_open_run(self):
        unreadable = self.unreadable_report("lcov-locked.info", LCOV)
        board = _Board()
        self.axi.forget_ingested_run()
        resp = self.ingest_unreadable(board, run_id=RUN_ID, coverage_codec="lcov",
                                      coverage_paths=[unreadable])
        error = self.assert_refused_naming(resp, unreadable)
        self.assert_open_run_aborted_once(board, resp, error, "run-aborted")


# ── the shared ingest over real HTTP, against the recording board ──────────

class TheSharedIngestAgainstTheRecordingBoardTest(_SharedIngestCase):
    """The real transport (`http_request`) on both seams, against
    `RecordingBoard`'s health and its scripted `run` block."""

    def setUp(self):
        super().setUp()
        self.boards = []

    def tearDown(self):
        for board in self.boards:
            board.close()

    def board(self, **kwargs):
        board = RecordingBoard(**kwargs)
        self.boards.append(board)
        return board

    def ingest_over_http(self, board, url=None, **overrides):
        base = url or board.url
        axi = self.axi

        class _Wire:
            @staticmethod
            def get(path, *_a, **_k):
                return axi.http_request(base, "GET", path, timeout=10)

            @staticmethod
            def post(path, payload=None, *_a, **_k):
                return axi.http_request(base, "POST", path, payload, timeout=10)

        return self.ingest(_Wire, **overrides)

    def test_a_decoding_board_is_sent_the_reports_and_its_run_block_is_returned(self):
        board = self.board()
        board.script_run(passed=3, failed=1, pending=1, files=2)
        resp = self.ingest_over_http(board, runner_exit=1)
        self.assertEqual(len(board.health_reads()), 1)
        posted = [(p, b) for p, b in board.posts() if p == RUNS]
        self.assertEqual(len(posted), 1, f"posted {board.posts()!r}")
        self.assertEqual((posted[0][1]["codec"], posted[0][1]["data"],
                          posted[0][1]["stack"], posted[0][1]["runnerExit"]),
                         ("junit", [JUNIT_A, JUNIT_B], STACK, 1))
        self.assertEqual(resp.get("run"), {"passed": 3, "failed": 1,
                                           "pending": 1, "total": 5,
                                           "files": 2})

    def test_a_board_whose_health_has_no_codecs_is_sent_nothing(self):
        board = self.board()
        health = board.default_health()
        del health["codecs"]
        health["version"] = "0.3.5"
        board.script_health(health)
        error = self.assert_refused(self.ingest_over_http(board))
        self.assertEqual(board.posts(), [])
        self.assertIn("0.3.5", error)
        self.assertIn(FLOOR, error)

    def test_a_board_advertising_a_small_limit_is_sent_nothing(self):
        board = self.board(ingest_body_bytes=64)
        error = self.assert_refused(self.ingest_over_http(board))
        self.assertEqual(board.posts(), [])
        self.assertIn("ingest_body_bytes", error)
        self.assertIn("64", error)

    def test_a_board_whose_health_fails_is_sent_nothing_and_its_error_is_named(self):
        board = self.board()
        board.fail_health(503, "health unavailable")
        error = self.assert_refused(self.ingest_over_http(board))
        self.assertEqual(board.posts(), [])
        self.assertIn("health unavailable", error)

    def test_an_unreachable_board_is_sent_nothing_and_the_connection_error_is_named(self):
        board = self.board()
        error = self.assert_refused(
            self.ingest_over_http(board, url="http://127.0.0.1:1"))
        self.assertEqual(board.events, [])
        self.assertIn("connection failed", error)

    def test_a_413_from_the_board_is_reported_naming_ingest_body_bytes(self):
        board = self.board()
        board.refuse_ingest_for(RUN_ID, status=413)
        self.axi.forget_ingested_run()
        error = self.assert_refused(self.ingest_over_http(board, run_id=RUN_ID))
        self.assertIn("ingest_body_bytes", error)
        self.assertEqual(len(board.aborts()), 1,
                         f"the refused run is aborted once; posted "
                         f"{[p for p, _ in board.posts()]!r}")

    def test_a_refusal_before_sending_aborts_the_open_run_on_the_board(self):
        board = self.board(ingest_body_bytes=64)
        resp = self.ingest_over_http(board, run_id=RUN_ID)
        error = self.assert_refused(resp)
        self.assertEqual([p for p, _b in board.posts()],
                         [f"/api/v2/runs/{RUN_ID}/abort"])
        self.assertEqual(board.aborts()[0][1].get("reason"), error)
        self.assertEqual(self.warning_codes(resp), ["run-aborted"])


# ── the two local counts ────────────────────────────────────────────────────

class TheTwoJunitCountsTest(_SharedIngestCase):

    def test_non_skipped_count_counts_testcases_without_a_skipped_child(self):
        # A: 2 testcases, 1 skipped; B: 3 testcases, none skipped.
        self.assertEqual(
            self.axi.junit_non_skipped_count([self.report_a, self.report_b]), 4)

    def test_non_skipped_count_of_a_run_whose_every_case_was_skipped_is_zero(self):
        path = self._write("TEST-skipped.xml", JUNIT_ALL_SKIPPED)
        self.assertEqual(self.axi.junit_non_skipped_count([path]), 0)

    def test_non_skipped_count_of_no_reports_is_zero(self):
        self.assertEqual(self.axi.junit_non_skipped_count([]), 0)

    def test_non_skipped_count_of_an_unreadable_report_is_none(self):
        broken = self._write("TEST-broken.xml", "<testsuite><testcase")
        missing = os.path.join(self.scratch, "TEST-missing.xml")
        for paths in ([broken], [missing], [self.report_a, broken]):
            with self.subTest(paths=[os.path.basename(p) for p in paths]), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertIsNone(self.axi.junit_non_skipped_count(paths))

    def test_testcase_count_still_counts_every_testcase_skipped_included(self):
        # The pin a change of `junit_testcase_count` to the non-skipped count
        # would break: 5 testcases, of which 4 are not skipped.
        count = self.axi.junit_testcase_count([self.report_a, self.report_b])
        self.assertEqual(count, 5)
        self.assertIs(type(count), int)

    def test_testcase_count_of_an_unreadable_report_is_still_none(self):
        missing = os.path.join(self.scratch, "TEST-missing.xml")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(self.axi.junit_testcase_count([missing]))


# ── the shared case reader: each case's name and file stem ──────────────────

def _native_report(*cases, wrap=True):
    """A native-harness JUnit report holding `cases`, each the attribute text
    of one `<testcase>` (`name="a" classname="b"`)."""
    body = "".join(f"    <testcase {attrs} time=\"0.001\"/>\n" for attrs in cases)
    suite = f'  <testsuite name="native" tests="{len(cases)}">\n{body}  </testsuite>\n'
    if not wrap:
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + suite
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n'
            + suite + '</testsuites>\n')


class TheJunitCaseSourcesReaderTest(_SharedIngestCase):
    """`junit_case_sources(paths)`: each `<testcase>` across the reports, in
    report order, as `(name, stem)`; `None`, with one warning, when a report
    cannot be read or parsed."""

    def sources(self, *texts):
        paths = [self._write(f"TEST-cases-{i}.xml", text)
                 for i, text in enumerate(texts)]
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            found = self.axi.junit_case_sources(paths)
        self.assertEqual(err.getvalue(), "",
                         "a readable report is read without a warning")
        return found

    def test_the_stem_is_the_cases_classname(self):
        self.assertEqual(
            self.sources(_native_report(
                'name="test_spins_up" classname="test_motor" '
                'file="test/test_other.c"')),
            [("test_spins_up", "test_motor")])

    def test_the_stem_falls_back_to_the_cases_file_without_a_classname(self):
        self.assertEqual(
            self.sources(_native_report(
                'name="test_holds_four_bytes" file="test/test_ring.cpp"')),
            [("test_holds_four_bytes", "test_ring")])

    def test_an_empty_classname_falls_through_to_the_file(self):
        self.assertEqual(
            self.sources(_native_report(
                'name="test_holds_four_bytes" classname="" '
                'file="test/test_ring.cpp"')),
            [("test_holds_four_bytes", "test_ring")])

    def test_a_backslash_is_read_as_a_slash(self):
        self.assertEqual(
            self.sources(_native_report(
                'name="test_settles" file="test\\native\\test_debounce.cpp"',
                'name="test_spins_up" classname="src\\test_motor.c"')),
            [("test_settles", "test_debounce"), ("test_spins_up", "test_motor")])

    def test_the_stem_is_the_basename_without_its_extension(self):
        self.assertEqual(
            self.sources(_native_report(
                'name="test_spins_up" classname="firmware/test/test_motor.ino"',
                'name="test_pid_tunes" file="/abs/path/test_pid.c"',
                'name="test_plain" classname="test_plain"')),
            [("test_spins_up", "test_motor"), ("test_pid_tunes", "test_pid"),
             ("test_plain", "test_plain")])

    def test_an_empty_stem_is_none(self):
        self.assertEqual(
            self.sources(_native_report(
                'name="test_neither"',
                'name="test_both_empty" classname="" file=""',
                'name="test_a_directory" file="test/"')),
            [("test_neither", None), ("test_both_empty", None),
             ("test_a_directory", None)])

    def test_a_nameless_case_is_a_question_mark(self):
        self.assertEqual(
            self.sources(_native_report('classname="test_motor"')),
            [("?", "test_motor")])

    def test_every_testcase_element_in_the_tree_is_walked_in_report_order(self):
        # A testcase directly under the root, one under a nested testsuite and
        # two reports: every one is read, the first report's first.
        nested = ('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n'
                  '  <testcase name="test_at_the_root" classname="test_root"/>\n'
                  '  <testsuite name="outer">\n'
                  '    <testsuite name="inner">\n'
                  '      <testcase name="test_deep" classname="test_deep"/>\n'
                  '    </testsuite>\n'
                  '  </testsuite>\n'
                  '</testsuites>\n')
        bare = _native_report('name="test_bare" classname="test_bare"', wrap=False)
        found = self.sources(nested, bare)
        self.assertEqual(found, [("test_at_the_root", "test_root"),
                                 ("test_deep", "test_deep"),
                                 ("test_bare", "test_bare")])
        self.assertEqual(len(found), self.axi.junit_testcase_count(
            [os.path.join(self.scratch, "TEST-cases-0.xml"),
             os.path.join(self.scratch, "TEST-cases-1.xml")]),
            "the reader walks the cases `junit_testcase_count` counts")

    def test_no_reports_have_no_cases(self):
        self.assertEqual(self.sources(), [])

    def test_an_unreadable_report_is_none_with_one_warning(self):
        readable = self._write("TEST-readable.xml", _native_report(
            'name="test_spins_up" classname="test_motor"'))
        broken = self._write("TEST-broken.xml", "<testsuite><testcase")
        missing = os.path.join(self.scratch, "TEST-missing.xml")
        for paths in ([broken], [missing], [readable, broken]):
            with self.subTest(paths=[os.path.basename(p) for p in paths]):
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    found = self.axi.junit_case_sources(paths)
                self.assertIsNone(found)
                lines = [line for line in err.getvalue().splitlines() if line.strip()]
                self.assertEqual(len(lines), 1,
                                 f"one warning names the unreadable report; "
                                 f"stderr={err.getvalue()!r}")
                self.assertIn("WARN", lines[0] if lines else "")
                self.assertIn(paths[-1], lines[0] if lines else "")


if __name__ == "__main__":
    unittest.main()
