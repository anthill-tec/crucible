"""The shared ingest prints a run's one ingest line, on every path it returns by.

`ingest_reports` (`clients/_crucible_run.py`) prints ONE line on stderr, the
last line it prints before it returns:

    ingest: ok=<ok> codec=<codec> passed=<p> failed=<f> pending=<n> total=<t> files=<files>

followed, space-separated, by `lines=<pct>%` and `funcs=<pct>%` for each of
those axes the answer's `run.coverage` carries, then by `error=<error>` when
the answer carries an error. The figures are the answer's `run` block's,
`None` when it has none. On a refusal before sending the line follows the
`[crucible] ERROR:` line, and, with a run open, the line the abort prints.

Driven directly, with recording `get`/`post` seams (and, for a board that
cannot be reached at the POST, the real transport against a closed port),
stderr captured whole, for: a run filed with coverage, a run filed without
it, each refusal before sending (an unreadable health, an older board, a
report or coverage file it cannot read, a body over the limit) with no run
open and with one, a 413, and a board unreachable at the POST.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_the_shared_ingest_prints_one_ingest_line_on_every_path
"""

import contextlib
import copy
import io
import os
import shutil
import socket
import tempfile
import unittest

from tests.client.live_run_harness import load_client

RUNS = "/api/v2/runs"
PROJECT_KEY = "ingest-line-project-key"
AGENT = "ingest-line-agent"
RUN_ID = "run-ingest-line-1"
STACK = "python"
LINE_PREFIX = "ingest: "

JUNIT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuite name="tests.test_a" tests="1">\n'
    '  <testcase classname="tests.test_a.A" name="test_one" time="0.001"/>\n'
    '</testsuite>\n')
LCOV = "TN:\nSF:clients/x.py\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n"
RAW = "Ran 1 test in 0.001s\n\nOK\n"

# The board's answer deliberately disagrees with the one-case report, so a
# line that reads anything but the answer is caught.
RUN_BLOCK = {"passed": 3, "failed": 1, "pending": 1, "total": 5, "files": 2}
COVERAGE = {"lines": {"total": 200, "covered": 175, "percent": 87.5},
            "functions": {"total": 30, "covered": 20, "percent": 66.7}}
NO_FIGURES = ("passed=None failed=None pending=None total=None files=None")


def healthy(limit=128 * 1024 * 1024, version="0.4.0"):
    return {"ok": True, "status": "healthy", "version": version,
            "codecs": {"test": ["junit", "playwright"],
                       "coverage": ["jacoco", "lcov"]},
            "limits": {"ingest_body_bytes": limit}}


def filed(run):
    return {"ok": True, "changed": True, "event": "evt-ingest-line-1",
            "run": run, "warnings": []}


def closed_port_url():
    """A loopback URL nothing listens on."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}"


class _Board:
    """The `get`/`post` seams: every call recorded, with the answers a test
    chose."""

    def __init__(self, health=None, ingest_reply=None, abort_ok=True):
        self.health = healthy() if health is None else health
        self.ingest_reply = filed(RUN_BLOCK) if ingest_reply is None else ingest_reply
        self.abort_ok = abort_ok
        self.posted = []

    def get(self, _path, *_args, **_kwargs):
        return copy.deepcopy(self.health)

    def post(self, path, payload=None, *_args, **_kwargs):
        self.posted.append(path)
        if path.endswith("/abort"):
            return ({"ok": True, "changed": True, "status": "aborted"}
                    if self.abort_ok else {"ok": False, "error": "abort refused"})
        return copy.deepcopy(self.ingest_reply)


class _IngestLineCase(unittest.TestCase):
    """A fresh shared module per test, and one report and one coverage file
    on disk."""

    def setUp(self):
        self.axi = load_client("_crucible_axi.py")
        self.scratch = tempfile.mkdtemp(prefix="ingest-line-")
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.report = self._write("TEST-a.xml", JUNIT)
        self.lcov = self._write("lcov.info", LCOV)

    def _write(self, name, text):
        path = os.path.join(self.scratch, name)
        with open(path, "w") as handle:
            handle.write(text)
        return path

    def directory(self, name):
        path = os.path.join(self.scratch, name)
        os.mkdir(path)
        return path

    def ingest(self, post_fn, get_fn, **overrides):
        """`(resp, stderr_lines, stdout)` of one `ingest_reports` call."""
        kwargs = {"stack": STACK, "project_key": PROJECT_KEY,
                  "agent_id": AGENT, "codec": "junit",
                  "report_paths": [self.report], "raw": RAW}
        kwargs.update(overrides)
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            resp = self.axi.ingest_reports(post_fn, get_fn, **kwargs)
        return resp, err.getvalue().splitlines(), out.getvalue()

    def the_one_ingest_line(self, lines, stdout):
        """The one `ingest: ` line, asserted to be the last line printed."""
        printed = "\n".join(f"  {line}" for line in lines)
        ingest_lines = [line for line in lines if line.startswith(LINE_PREFIX)]
        self.assertEqual(
            len(ingest_lines), 1,
            f"ingest_reports prints exactly one `ingest: ` line; stderr:\n{printed}")
        self.assertEqual(
            lines[-1], ingest_lines[0],
            f"the ingest line is the last line ingest_reports prints; "
            f"stderr:\n{printed}")
        self.assertNotIn(LINE_PREFIX, stdout,
                         "the ingest line goes to stderr, never stdout")
        return ingest_lines[0]


# ── a run the board filed ──────────────────────────────────────────────────

class AFiledRunPrintsTheAnswersFiguresTest(_IngestLineCase):

    def test_a_run_filed_with_coverage_prints_its_files_and_both_coverage_axes(self):
        board = _Board(ingest_reply=filed({**RUN_BLOCK, "coverage": COVERAGE}))
        resp, lines, stdout = self.ingest(board.post, board.get,
                                          coverage_codec="lcov",
                                          coverage_paths=[self.lcov])
        self.assertIs(resp.get("ok"), True)
        self.assertEqual(
            self.the_one_ingest_line(lines, stdout),
            "ingest: ok=True codec=junit passed=3 failed=1 pending=1 total=5 "
            "files=2 lines=87.5% funcs=66.7%")

    def test_a_run_filed_without_coverage_prints_no_coverage_figure(self):
        board = _Board()
        _resp, lines, stdout = self.ingest(board.post, board.get)
        line = self.the_one_ingest_line(lines, stdout)
        self.assertEqual(
            line,
            "ingest: ok=True codec=junit passed=3 failed=1 pending=1 total=5 files=2")
        self.assertNotIn("lines=", line)
        self.assertNotIn("funcs=", line)
        self.assertNotIn("error=", line)

    def test_a_coverage_block_with_only_lines_prints_only_lines(self):
        board = _Board(ingest_reply=filed(
            {**RUN_BLOCK, "coverage": {"lines": COVERAGE["lines"]}}))
        _resp, lines, stdout = self.ingest(board.post, board.get,
                                           coverage_codec="lcov",
                                           coverage_paths=[self.lcov])
        self.assertEqual(
            self.the_one_ingest_line(lines, stdout),
            "ingest: ok=True codec=junit passed=3 failed=1 pending=1 total=5 "
            "files=2 lines=87.5%")

    def test_the_line_names_the_codec_the_run_was_sent_with(self):
        board = _Board(ingest_reply=filed(
            {"passed": 4, "failed": 0, "pending": 0, "total": 4, "files": 1}))
        _resp, lines, stdout = self.ingest(board.post, board.get, codec="playwright")
        self.assertEqual(
            self.the_one_ingest_line(lines, stdout),
            "ingest: ok=True codec=playwright passed=4 failed=0 pending=0 total=4 "
            "files=1")


# ── a refusal before sending ───────────────────────────────────────────────

class ARefusalBeforeSendingPrintsTheLineAfterItsErrorTest(_IngestLineCase):
    """Each refusal: `ok=False`, no figures, `error=` the refusal — the line
    following the `[crucible] ERROR:` line and, with a run open, the abort's."""

    def refusals(self):
        """`{case: (board, overrides, what the error names)}`."""
        no_codecs = healthy(version="0.3.7")
        del no_codecs["codecs"]
        del no_codecs["limits"]
        report_dir = self.directory("TEST-dir.xml")
        coverage_dir = self.directory("lcov-dir.info")
        return {
            "health unreadable": (
                _Board(health={"ok": False, "error": "connection failed: down"}),
                {}, ("could not be read", "connection failed: down")),
            "older board": (_Board(health=no_codecs), {}, ("0.3.7", "0.4.0")),
            "unreadable report": (
                _Board(), {"report_paths": [self.report, report_dir]},
                (report_dir, "nothing was sent")),
            "unreadable coverage": (
                _Board(), {"coverage_codec": "lcov", "coverage_paths": [coverage_dir]},
                (coverage_dir, "nothing was sent")),
            "over the limit": (
                _Board(health=healthy(limit=32)), {}, ("ingest_body_bytes", "32")),
        }

    def assert_refusal_line(self, resp, line, names):
        self.assertIs(resp.get("ok"), False)
        error = resp.get("error")
        self.assertIsInstance(error, str)
        self.assertEqual(line, f"ingest: ok=False codec=junit {NO_FIGURES} error={error}")
        for named in names:
            self.assertIn(named, line.split(" error=", 1)[1],
                          f"the line's error= names the cause; got {line!r}")
        return error

    def test_each_refusal_with_no_run_open_prints_the_line_right_after_its_error(self):
        for case, (board, overrides, names) in self.refusals().items():
            with self.subTest(refusal=case):
                resp, lines, stdout = self.ingest(board.post, board.get, **overrides)
                line = self.the_one_ingest_line(lines, stdout)
                error = self.assert_refusal_line(resp, line, names)
                self.assertGreaterEqual(len(lines), 2, f"stderr: {lines!r}")
                self.assertEqual(lines[-2], f"[crucible] ERROR: {error}",
                                 "the ingest line follows the refusal's ERROR line")
                self.assertEqual(board.posted, [], "a refusal sends nothing")

    def test_each_refusal_with_a_run_open_prints_the_line_after_the_abort(self):
        for case, (board, overrides, names) in self.refusals().items():
            with self.subTest(refusal=case):
                resp, lines, stdout = self.ingest(board.post, board.get,
                                                  run_id=RUN_ID, **overrides)
                line = self.the_one_ingest_line(lines, stdout)
                error = self.assert_refusal_line(resp, line, names)
                self.assertGreaterEqual(len(lines), 3, f"stderr: {lines!r}")
                self.assertEqual(lines[-3], f"[crucible] ERROR: {error}")
                self.assertEqual(lines[-2], f"[crucible] run {RUN_ID} aborted: {error}",
                                 "the ingest line follows the abort's line")
                self.assertEqual(board.posted, [f"/api/v2/runs/{RUN_ID}/abort"])

    def test_a_refused_abort_still_ends_with_the_ingest_line(self):
        board = _Board(health=healthy(limit=32), abort_ok=False)
        resp, lines, stdout = self.ingest(board.post, board.get, run_id=RUN_ID)
        line = self.the_one_ingest_line(lines, stdout)
        self.assert_refusal_line(resp, line, ("ingest_body_bytes",))
        self.assertTrue(
            lines[-2].startswith(f"[crucible] WARN: the abort of run {RUN_ID} "
                                 f"was not accepted"),
            f"the abort's WARN line precedes the ingest line; stderr: {lines!r}")


# ── the board answered the POST, or could not be reached for it ───────────

class TheBoardsAnswerToThePostIsPrintedTest(_IngestLineCase):

    def test_a_413_prints_the_line_with_an_error_naming_ingest_body_bytes(self):
        board = _Board(ingest_reply={"ok": False, "error": "HTTP 413: Payload Too Large"})
        resp, lines, stdout = self.ingest(board.post, board.get)
        line = self.the_one_ingest_line(lines, stdout)
        self.assertEqual(line, f"ingest: ok=False codec=junit {NO_FIGURES} "
                               f"error={resp['error']}")
        self.assertIn("HTTP 413", resp["error"])
        self.assertIn("ingest_body_bytes", line.split(" error=", 1)[1])
        self.assertEqual(board.posted, [RUNS])

    def test_a_413_for_an_open_run_prints_the_line_after_the_abort(self):
        board = _Board(ingest_reply={"ok": False, "error": "HTTP 413: Payload Too Large"})
        resp, lines, stdout = self.ingest(board.post, board.get, run_id=RUN_ID)
        line = self.the_one_ingest_line(lines, stdout)
        self.assertEqual(line, f"ingest: ok=False codec=junit {NO_FIGURES} "
                               f"error={resp['error']}")
        self.assertIn("ingest_body_bytes", line)
        self.assertTrue(lines[-2].startswith(f"[crucible] run {RUN_ID} aborted: "),
                        f"the abort's line precedes the ingest line; stderr: {lines!r}")

    def test_a_board_unreachable_at_the_post_prints_the_transports_error(self):
        url = closed_port_url()
        transport_answers = []

        def post(path, payload=None, *_args, **_kwargs):
            answer = self.axi.http_request(url, "POST", path, payload, timeout=10)
            transport_answers.append(answer)
            return answer

        resp, lines, stdout = self.ingest(post, _Board().get)
        self.assertEqual(len(transport_answers), 1, "one POST, to the runs route")
        transport_error = transport_answers[0].get("error")
        self.assertTrue(str(transport_error).startswith("connection failed: "),
                        f"the transport could not reach {url}; got {transport_error!r}")
        line = self.the_one_ingest_line(lines, stdout)
        self.assertEqual(line, f"ingest: ok=False codec=junit {NO_FIGURES} "
                               f"error={transport_error}")
        self.assertIs(resp.get("ok"), False)


if __name__ == "__main__":
    unittest.main()
