"""A board that drops the connection is answered, never raised.

The fleet's one transport, `http_request`, answers a connection-level failure
as it answers an unreachable board: `{ok: False, error}`, the error naming the
failure by its type and `repr` and naming the board
(`connection lost: <Type>(...) (is Crucible at <board> reachable? ...)`).
That covers a `ConnectionError` (a board that closes after reading the
request, or resets it) and an `http.client.HTTPException` (a body cut short of
its `Content-Length`, a status line that is not HTTP), and an HTTP error whose
body cannot be read in full answers `HTTP <code>: <body unreadable: <Type>>`.
A non-JSON body and a bare `OSError` still raise.

Through a client, a run whose ingest POST is dropped is reported as any run
the board could not take: one `ingest:` line with no figures, an envelope
whose `run` figures are null beside the error, the open run's abort attempted,
exit 1 and no traceback. When the board refuses that abort because the run is
already settled, it may hold the run (it can have filed it before the
connection dropped): the envelope says so and names `run <id>`, never
`run-left-open`. A `pre-merge-gate` whose declared suite's ingest is cut short
names that suite `gate-suite-unreported` and is not green.

Every board here is a `RecordingBoard` on loopback, its drops scripted with
`RecordingBoard.drop_next`; nothing reaches a live board.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_a_dropped_connection_is_answered
"""

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    install_project,
    load_client,
    load_toon,
    new_scratch,
    scrubbed_env,
    write_fake_bun,
    write_fake_cargo,
    write_fake_mvnw,
    write_fake_native,
    write_fake_python,
)
from tests.client.test_gate_names_an_unfiled_suite_unreported_end_to_end import (
    _FAKE_BUN as GATE_FAKE_BUN,
)
from tests.client.test_gate_names_an_unfiled_suite_unreported_end_to_end import (
    _FAKE_PYTHON as GATE_FAKE_PYTHON,
)
from tests.client.test_gate_names_an_unfiled_suite_unreported_end_to_end import (
    _SCRUBBED as GATE_SCRUBBED,
)

AGENT = "dropped-connection-fixture"
PROJECT_KEY = "test-key-dropped-connection"
PROJECT_NAME = "dropped-connection-fixture"
RUN_ID = "run-live-1"
RUNS = "/api/v2/runs"
PARSED = "/api/v2/runs/parsed"
TIMEOUT = 120
TOON = load_toon()
COUNT_KEYS = ("passed", "failed", "pending", "total", "files")
NO_FIGURES = " ".join(f"{key}=None" for key in COUNT_KEYS)
CONNECTION_LOST = "connection lost: "
TRACEBACK = "Traceback (most recent call last)"
# The board's own refusal of an abort for a run an ingest already filed: the
# 409 `resolveRunClose` (src/v2.ts) answers for a settled run.
SETTLED_ABORT_REFUSAL = (f"run {RUN_ID} is already ended \u2014 a settled run "
                         f"cannot be closed twice; run NOT aborted")


def _codes(envelope):
    return [w.get("code") for w in (envelope or {}).get("warnings") or []
            if isinstance(w, dict)]


def _warnings_naming(envelope, needle):
    return [w for w in (envelope or {}).get("warnings") or []
            if isinstance(w, dict) and needle in (w.get("detail") or "")]


# ── the transport ───────────────────────────────────────────────────────────

class _NotJsonResponse:
    """A response double whose body is not JSON."""

    def read(self):
        return b"<html>not json</html>"

    def close(self):
        return None


class TheTransportAnswersADroppedConnectionTest(unittest.TestCase):

    def setUp(self):
        self.core = load_client("_crucible_axi.py")
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)

    def request_dropped(self, shape):
        """`http_request` against a board that drops the POST in `shape`;
        a failure, never an error, when it raises."""
        self.board.drop_next("/api/v2/probe", shape)
        try:
            resp = self.core.http_request(self.board.url, "POST", "/api/v2/probe",
                                          {"probe": shape})
        except Exception as exc:  # the defect under test is that it escapes
            self.fail(f"http_request raised {exc!r} on a board that dropped the "
                      f"connection ({shape}); it answers {{ok: False, error}}")
        self.assertEqual([p for p, _b in self.board.posts()], ["/api/v2/probe"],
                         "the request reached the board before it was dropped")
        return resp

    def assert_connection_lost(self, resp, type_names):
        self.assertIsInstance(resp, dict, f"got {resp!r}")
        self.assertIs(resp.get("ok"), False, f"got {resp!r}")
        error = resp.get("error")
        self.assertIsInstance(error, str, f"got {resp!r}")
        self.assertTrue(error.startswith(CONNECTION_LOST), f"got {error!r}")
        named = error[len(CONNECTION_LOST):].split("(", 1)[0]
        self.assertIn(named, type_names,
                      f"the error names the failure by its type; got {error!r}")
        self.assertIn(f"(is Crucible at {self.board.url} reachable?", error,
                      f"the error names the board; got {error!r}")

    def test_a_board_that_closes_after_reading_the_request_is_answered(self):
        self.assert_connection_lost(self.request_dropped("close"),
                                    ("RemoteDisconnected",))

    def test_a_board_that_resets_the_connection_is_answered(self):
        self.assert_connection_lost(self.request_dropped("reset"),
                                    ("ConnectionResetError", "RemoteDisconnected"))

    def test_a_body_cut_short_of_its_length_is_answered(self):
        self.assert_connection_lost(self.request_dropped("truncate"),
                                    ("IncompleteRead",))

    def test_a_status_line_that_is_not_http_is_answered(self):
        self.assert_connection_lost(self.request_dropped("garble"),
                                    ("BadStatusLine",))

    def test_an_http_error_whose_body_is_cut_short_is_answered_with_its_status(self):
        resp = self.request_dropped("truncate-error")
        self.assertIsInstance(resp, dict, f"got {resp!r}")
        self.assertIs(resp.get("ok"), False, f"got {resp!r}")
        error = resp.get("error") or ""
        self.assertTrue(error.startswith("HTTP 500: "),
                        f"the error keeps the board's status; got {error!r}")
        self.assertIn("body unreadable: IncompleteRead", error,
                      f"the error says the body could not be read and why; "
                      f"got {error!r}")

    def test_a_body_that_is_not_json_still_raises(self):
        with mock.patch("urllib.request.urlopen", return_value=_NotJsonResponse()):
            with self.assertRaises(ValueError):
                self.core.http_request(self.board.url, "GET", "/api/v2/probe")

    def test_a_bare_os_error_still_raises(self):
        failure = OSError(28, "No space left on device")
        with mock.patch("urllib.request.urlopen", side_effect=failure):
            with self.assertRaises(OSError) as raised:
                self.core.http_request(self.board.url, "GET", "/api/v2/probe")
        self.assertIs(raised.exception, failure)


# ── through the clients ─────────────────────────────────────────────────────

class _DroppedIngestCase(unittest.TestCase):
    """A scratch project filing to a `RecordingBoard`, and each client's main
    suite verb over its fake runner."""

    def setUp(self):
        self.project = new_scratch("dropped-ingest-")
        self.bin_dir = new_scratch("dropped-ingest-bin-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)
        self.addCleanup(shutil.rmtree, self.project, ignore_errors=True)
        self.addCleanup(shutil.rmtree, self.bin_dir, ignore_errors=True)
        self.addCleanup(self.board.close)

    def run_client(self, client, argv):
        return subprocess.run(
            [sys.executable, str(CLIENTS / client), *argv],
            cwd=self.project, env=scrubbed_env(self.bin_dir, FAKE_TOTAL=3),
            capture_output=True, text=True, timeout=TIMEOUT, check=False)

    def bun_test(self):
        fake = write_fake_bun(self.project, 3)
        return "test", self.run_client("bun-crucible.py", [
            "test", "--bun", fake, "--project-dir", self.project,
            "--package-dir", self.project, "--reports", "reports",
            "--agent", AGENT])

    def python_test(self):
        fake = write_fake_python(self.project)
        return "test", self.run_client("python-crucible.py", [
            "test", "--python", fake, "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT])

    def mvn_unit(self):
        write_fake_mvnw(self.project)
        return "unit", self.run_client("mvn-crucible.py", [
            "unit", "--test", "LiveCase*", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT])

    def rust_test(self):
        write_fake_cargo(self.bin_dir)
        return "test", self.run_client("rust-crucible.py", [
            "test", "--crate", "fake-crate", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT])

    def arduino_unit(self):
        write_fake_native(self.project)
        return "unit", self.run_client("arduino-crucible.py", [
            "unit", "--dir", "tests/native", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT])

    @staticmethod
    def diagnostics(result):
        return (f"exit={result.returncode} stdout={result.stdout!r} "
                f"stderr={result.stderr[-3000:]!r}")

    def envelope(self, result):
        try:
            decoded = TOON.decode(result.stdout)
        except ValueError:
            decoded = None
        self.assertIsInstance(decoded, dict,
                              f"stdout is one TOON envelope; {self.diagnostics(result)}")
        self.assertIn("axi", decoded or {}, self.diagnostics(result))
        return (decoded or {}).get("axi") or {}

    def assert_answered_without_figures(self, verb, result, ingest_path=RUNS):
        """The dropped ingest reached the board, and the verb reported the run
        as one the board could not take: exit 1, no traceback, one `ingest:`
        line with no figures, an envelope with null figures and the error."""
        where = self.diagnostics(result)
        ingests = [p for p, _b in self.board.posts() if p == ingest_path]
        self.assertEqual(ingests, [ingest_path],
                         f"the run's one ingest reached the board; {where}")
        self.assertNotIn(TRACEBACK, result.stderr, where)
        self.assertEqual(result.returncode, 1, where)
        ingest_lines = [line for line in result.stderr.splitlines()
                        if line.startswith("ingest:")]
        self.assertEqual(len(ingest_lines), 1,
                         f"one `ingest:` line on every path; {where}")
        self.assertIn(NO_FIGURES, ingest_lines[0] if ingest_lines else "",
                      f"the ingest line states no figures; {where}")
        envelope = self.envelope(result)
        self.assertEqual(envelope.get("verb"), verb, where)
        self.assertIs(envelope.get("ok"), False, where)
        self.assertEqual(envelope.get("run"), dict.fromkeys(COUNT_KEYS),
                         f"a run the board did not answer states null figures; {where}")
        error = envelope.get("error") or ""
        self.assertTrue(error.startswith(CONNECTION_LOST),
                        f"the envelope says the connection was lost; {where}")
        self.assertIn(self.board.url, error,
                      f"the envelope's error names the board; {where}")
        return envelope

    def assert_the_open_run_was_aborted(self, envelope, result):
        where = self.diagnostics(result)
        self.assertEqual([p for p, _b in self.board.aborts()],
                         [f"/api/v2/runs/{RUN_ID}/abort"],
                         f"the open run's abort is attempted once; {where}")
        aborted = [w for w in envelope.get("warnings") or []
                   if isinstance(w, dict) and w.get("code") == "run-aborted"]
        self.assertEqual(len(aborted), 1, f"the board took the abort; {where}")
        self.assertIn(RUN_ID, (aborted[0] if aborted else {}).get("detail") or "", where)
        self.assertNotIn("run-left-open", _codes(envelope), where)

    def assert_the_board_may_hold_the_run(self, envelope, result):
        where = self.diagnostics(result)
        self.assertEqual([p for p, _b in self.board.aborts()],
                         [f"/api/v2/runs/{RUN_ID}/abort"],
                         f"the open run's abort is attempted once; {where}")
        codes = _codes(envelope)
        self.assertNotIn("run-left-open", codes,
                         f"a run the board refused to abort as settled is not "
                         f"left open; {where}")
        self.assertNotIn("run-aborted", codes,
                         f"the board aborted nothing; {where}")
        naming = _warnings_naming(envelope, RUN_ID)
        self.assertEqual(len(naming), 1,
                         f"one warning speaks for the run; {where}")
        detail = (naming[0] if naming else {}).get("detail") or ""
        self.assertIn(f"run {RUN_ID}", detail,
                      f"the warning names how to read the run back; {where}")
        self.assertTrue("filed" in detail or "hold" in detail,
                        f"the warning says the board may hold the run; {where}")


class ADroppedIngestIsReportedAsAnUnfiledRunTest(_DroppedIngestCase):
    """The board closes the ingest POST's connection after reading it, and
    takes the abort that follows."""

    def drive(self, run):
        self.board.drop_next(RUNS, "close")
        verb, result = run()
        envelope = self.assert_answered_without_figures(verb, result)
        self.assert_the_open_run_was_aborted(envelope, result)

    def test_bun_test_whose_ingest_is_dropped_reports_an_unfiled_run(self):
        self.drive(self.bun_test)

    def test_python_test_whose_ingest_is_dropped_reports_an_unfiled_run(self):
        self.drive(self.python_test)

    def test_mvn_unit_whose_ingest_is_dropped_reports_an_unfiled_run(self):
        self.drive(self.mvn_unit)

    def test_rust_test_whose_ingest_is_dropped_reports_an_unfiled_run(self):
        self.drive(self.rust_test)

    def test_python_test_whose_ingest_and_abort_are_both_dropped_leaves_the_run_open(self):
        self.board.drop_next(RUNS, "close")
        self.board.drop_next(f"/api/v2/runs/{RUN_ID}/abort", "close")
        verb, result = self.python_test()
        envelope = self.assert_answered_without_figures(verb, result)
        left_open = [w for w in envelope.get("warnings") or []
                     if isinstance(w, dict) and w.get("code") == "run-left-open"]
        self.assertEqual(len(left_open), 1,
                         f"an abort that cannot reach the board leaves the run "
                         f"to the server's sweep; {self.diagnostics(result)}")
        self.assertIn(RUN_ID, (left_open[0] if left_open else {}).get("detail") or "")


class ARunTheBoardMayHoldSaysSoTest(_DroppedIngestCase):
    """The board files the run, its answer is cut short, and it refuses the
    abort that follows because the run is already settled."""

    def drive(self, run):
        self.board.drop_next(RUNS, "truncate")
        self.board.refuse_next_abort(status=409, error=SETTLED_ABORT_REFUSAL)
        verb, result = run()
        envelope = self.assert_answered_without_figures(verb, result)
        self.assert_the_board_may_hold_the_run(envelope, result)

    def test_bun_test_whose_filed_run_lost_its_answer_says_the_board_may_hold_it(self):
        self.drive(self.bun_test)

    def test_python_test_whose_filed_run_lost_its_answer_says_the_board_may_hold_it(self):
        self.drive(self.python_test)

    def test_mvn_unit_whose_filed_run_lost_its_answer_says_the_board_may_hold_it(self):
        self.drive(self.mvn_unit)

    def test_rust_test_whose_filed_run_lost_its_answer_says_the_board_may_hold_it(self):
        self.drive(self.rust_test)


class TheArduinoClientAnswersADroppedIngestTest(_DroppedIngestCase):
    """arduino still posts to the parsed route: its envelope is `ok: false`
    naming the board, and it exits 1 with no traceback."""

    def test_arduino_unit_whose_parsed_ingest_is_dropped_names_the_board(self):
        self.board.drop_next(PARSED, "close")
        verb, result = self.arduino_unit()
        where = self.diagnostics(result)
        self.assertEqual([p for p, _b in self.board.posts() if p == PARSED], [PARSED],
                         f"the run's one ingest reached the board; {where}")
        self.assertNotIn(TRACEBACK, result.stderr, where)
        self.assertEqual(result.returncode, 1, where)
        envelope = self.envelope(result)
        self.assertEqual(envelope.get("verb"), verb, where)
        self.assertIs(envelope.get("ok"), False, where)
        error = envelope.get("error") or ""
        self.assertTrue(error.startswith(CONNECTION_LOST), where)
        self.assertIn(self.board.url, error, f"the error names the board; {where}")


# ── a gate's declared suite ─────────────────────────────────────────────────

class ADeclaredSuiteWhoseIngestIsCutShortIsUnreportedTest(_DroppedIngestCase):
    """bun's `pre-merge-gate` composes its declared suites; the one whose
    ingest answer is cut short is named `gate-suite-unreported`."""

    def setUp(self):
        super().setUp()
        self.board.script_run(passed=1)
        self.fake_bun = self._executable("fake_bun.py", GATE_FAKE_BUN)
        self.fake_python = self._executable("fake_python.py", GATE_FAKE_PYTHON)

    def _executable(self, name, body):
        path = Path(self.bin_dir, name)
        path.write_text("#!" + sys.executable + "\n" + body, encoding="utf-8")
        path.chmod(0o755)
        return str(path)

    def manifest(self, scripts):
        Path(self.project, "package.json").write_text(json.dumps(
            {"name": "dropped-gate", "private": True, "scripts": scripts}, indent=2))

    def bun_gate(self):
        env = scrubbed_env(None)
        for key in GATE_SCRUBBED:
            env.pop(key, None)
        return subprocess.run(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "pre-merge-gate",
             "--agent", AGENT, "--skip-check", "--bun", self.fake_bun,
             "--project-dir", self.project, "--package-dir", self.project,
             "--reports", "reports"],
            cwd=self.project, env=env, capture_output=True, text=True,
            timeout=TIMEOUT, check=False)

    def assert_suite_unreported(self, result, suite, stack):
        where = self.diagnostics(result)
        dropped = [b for p, b in self.board.posts()
                   if p == RUNS and isinstance(b, dict) and b.get("stack") == stack]
        self.assertGreaterEqual(len(dropped), 1,
                                f"the {stack} suite's ingest reached the board; {where}")
        self.assertNotIn(TRACEBACK, result.stderr, where)
        envelope = self.envelope(result)
        self.assertEqual(envelope.get("verb"), "pre-merge-gate", where)
        self.assertIs(envelope.get("ok"), False, f"the gate is not green; {where}")
        self.assertNotEqual(result.returncode, 0, where)
        unreported = [w for w in envelope.get("warnings") or []
                      if isinstance(w, dict) and w.get("code") == "gate-suite-unreported"]
        self.assertEqual(len(unreported), 1,
                         f"the gate names the one suite it could not file; {where}")
        self.assertIn(suite, (unreported[0] if unreported else {}).get("detail") or "",
                      where)
        self.assertNotIn("gate-suite-failed", _codes(envelope),
                         f"a run that was never filed did not fail; {where}")

    def test_a_declared_bun_suite_whose_ingest_is_cut_short_is_unreported(self):
        self.manifest({"test:unit": "bun test"})
        self.board.drop_next(RUNS, "truncate", stack="bun")
        self.assert_suite_unreported(self.bun_gate(), "test:unit", "bun")

    def test_a_declared_python_suite_whose_ingest_is_cut_short_is_unreported(self):
        command = (f"{sys.executable} {CLIENTS / 'python-crucible.py'} regression "
                   f"--python {self.fake_python} --project-dir {self.project} "
                   f"--reports reports-python")
        self.manifest({"test:python": command})
        self.board.drop_next(RUNS, "truncate", stack="python")
        self.assert_suite_unreported(self.bun_gate(), "test:python", "python")


if __name__ == "__main__":
    unittest.main()
