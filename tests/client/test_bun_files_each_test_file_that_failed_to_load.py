"""Every bun test file that failed to load is filed as a failing case.

bun counts a test file that cannot be loaded — one importing a missing
module, one throwing at import, one rejecting at import — on its console,
under a `<path>:` header followed by one or more `# Unhandled error between
tests` blocks, and exits 1; but its JUnit report holds only the cases that
ran, and when every file fails to load it writes no report at all. The bun
client reads its captured console, in both wire forms (plain under
`NO_COLOR=1`, ANSI under `FORCE_COLOR=1`), and adds one failing case per such
file to the run it files: in the suite for that file (a new suite named by
the path when the report has none), case `?`, message the first block's
`error:` line, trace every block for that file. The load-error case makes the
run failed, so the board adds no `runner / exit` case beside it, and the verb
exits non-zero.

Every run here is a REAL `bun test`, over a scratch project built in a temp
directory this suite creates and removes, driven through the real
`clients/bun-crucible.py test --agent` and filed to a REAL scratch board
(`tests/client/real_board.py`), whose stored run is what is compared.

Invocation:
    python3 -m unittest tests.client.test_bun_files_each_test_file_that_failed_to_load -v
"""

import json
import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import CLIENTS, load_toon, new_scratch, scrubbed_env
from tests.client.real_board import RealBoard

TOON = load_toon()
BUN_CLIENT = CLIENTS / "bun-crucible.py"
TIMEOUT = 180
UNHANDLED = "# Unhandled error between tests"
_SGR = re.compile(r"\x1b\[[0-9;]*m")

# The scratch test files, by behaviour.
PASSING = ("a_passes.test.ts", (
    'import { test, expect } from "bun:test";\n'
    'test("passes", () => { expect(1).toBe(1); });\n'))
MISSING_IMPORT = ("b_imports_a_missing_module.test.ts", (
    'import { test } from "bun:test";\n'
    'import { nope } from "./does-not-exist";\n'
    'test("never runs", () => { nope(); });\n'))
THROWS = ("c_throws_at_import.test.ts", (
    'import { test } from "bun:test";\n'
    'throw new Error("boom at import");\n'
    'test("never runs", () => {});\n'))
REJECTS = ("d_rejects_at_import.test.ts", (
    'import { test } from "bun:test";\n'
    'Promise.reject(new Error("rejected at import"));\n'
    'test("never runs", () => {});\n'))
TWO_BLOCKS = ("e_two_error_blocks.test.ts", (
    'import { test } from "bun:test";\n'
    'Promise.reject(new Error("first block"));\n'
    'Promise.reject(new Error("second block"));\n'
    'test("never runs", () => {});\n'))
# Its test runs and passes; the rejection lands after it, still under this
# file's header — bun files the passing case in this file's suite and reports
# the rejection as an unhandled error between tests.
RAN_THEN_REJECTED = ("f_ran_then_rejected.test.ts", (
    'import { test, expect, afterAll } from "bun:test";\n'
    'test("ran first", () => { expect(1).toBe(1); });\n'
    'afterAll(() => { Promise.reject(new Error("rejected after its test ran")); });\n'))

_SCRUBBED = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
             "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
             "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "NO_COLOR", "FORCE_COLOR")

_BUN: str | None = None
_BOARD: RealBoard | None = None


def setUpModule():
    global _BUN, _BOARD
    _BUN = shutil.which("bun")
    if _BUN is None:
        raise unittest.SkipTest(
            "these are real `bun test` runs filed to a real board — without "
            "`bun` there is neither; a missing toolchain, not a passing "
            "assertion")
    _BOARD = RealBoard(_BUN, "bun-load-errors-e2e")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _message_text(message):
    """The first block's `error:` line, read with or without its `error:`
    label — either reading of "message = the first block's `error:` line"."""
    text = (message or "").strip()
    if text.startswith("error:"):
        text = text[len("error:"):].strip()
    return text


class _Forms:
    """A holder, so the loader never collects the base class itself."""

    class LoadErrorsCase(unittest.TestCase):
        """One console form; the subclasses run every scenario in each."""

        FORM = ""
        COLOR_ENV: dict = {}
        ANSI_EXPECTED = False

        def setUp(self):
            board, bun = _BOARD, _BUN
            if board is None or bun is None:
                self.fail("the module's real board was never booted")
            self.board: RealBoard = board
            self.bun: str = bun
            self.project = new_scratch("bun-load-errors-")

        def tearDown(self):
            shutil.rmtree(self.project, ignore_errors=True)

        # -- driving ---------------------------------------------------------

        def run_files(self, agent, *files):
            Path(self.project, "package.json").write_text(json.dumps(
                {"name": "bun-load-errors-fixture", "private": True}))
            for name, body in files:
                Path(self.project, name).write_text(body)
            self.board.install(self.project)
            self.log_path = os.path.join(self.project, "run.log")
            env = scrubbed_env(None)
            for key in _SCRUBBED:
                env.pop(key, None)
            env.update(self.COLOR_ENV)
            self.result = subprocess.run(
                [sys.executable, str(BUN_CLIENT), "test", "--agent", agent,
                 "--project-dir", self.project, "--package-dir", self.project,
                 "--bun", self.bun, "--reports", "reports", "--log", self.log_path],
                cwd=self.project, env=env, capture_output=True, text=True,
                timeout=TIMEOUT, check=False)
            return self.result

        def diagnostics(self):
            r = self.result
            return (f"exit={r.returncode} stdout={r.stdout!r} "
                    f"stderr={r.stderr[-3000:]!r}")

        def assert_console_form(self):
            """Fixture guard: bun printed the load errors, in the wire form this
            class is about."""
            log = Path(self.log_path).read_text(errors="replace")
            self.assertIn(UNHANDLED, _SGR.sub("", log),
                          f"bun reported no unhandled error; {self.diagnostics()}")
            self.assertEqual("\x1b[" in log, self.ANSI_EXPECTED,
                             f"the console was not in the expected wire form "
                             f"(ANSI expected: {self.ANSI_EXPECTED})")

        # -- reading what was filed --------------------------------------------

        def stored_run(self, agent):
            events = self.board.test_events(agent)
            self.assertEqual(len(events), 1,
                             f"exactly one test run is filed; events={events!r} "
                             f"{self.diagnostics()}")
            return self.board.event(events[0]["id"])

        def suites_named(self, event, name):
            return [s for s in (event.get("tree") or []) if s.get("name") == name]

        def the_load_error_case(self, event, file_name):
            suites = self.suites_named(event, file_name)
            self.assertEqual(len(suites), 1,
                             f"exactly one suite for {file_name}; "
                             f"tree={event.get('tree')!r} {self.diagnostics()}")
            cases = [c for c in suites[0].get("children") or [] if c.get("name") == "?"]
            self.assertEqual(len(cases), 1,
                             f"exactly one `?` case for {file_name}; "
                             f"suite={suites[0]!r}")
            case = cases[0]
            self.assertEqual(case.get("status"), "fail", f"case={case!r}")
            failure = case.get("failure") or {}
            self.assertNotIn("\x1b", failure.get("message") or "",
                             "the message is stored without escape codes")
            self.assertNotIn("\x1b", failure.get("trace") or "",
                             "the trace is stored without escape codes")
            return suites[0], case

        def assert_no_runner_case(self, event):
            self.assertEqual(self.suites_named(event, "runner"), [],
                             f"a load-error case makes the run failed, so no "
                             f"`runner / exit` case is added beside it; "
                             f"tree={event.get('tree')!r}")

        def assert_counts(self, counts, total, passed, failed, where):
            self.assertEqual(
                (counts.get("total"), counts.get("passed"), counts.get("failed")),
                (total, passed, failed),
                f"{where} (total, passed, failed); got {counts!r} {self.diagnostics()}")

        # -- the scenarios -----------------------------------------------------

        def test_each_file_that_failed_to_load_is_one_failing_case_beside_the_passing_one(self):
            agent = f"load-errors-four-files-{self.FORM}"
            self.run_files(agent, PASSING, MISSING_IMPORT, THROWS, REJECTS)
            self.assert_console_form()
            self.assertNotEqual(self.result.returncode, 0,
                                f"files that failed to load never exit green; "
                                f"{self.diagnostics()}")
            event = self.stored_run(agent)

            passing = self.suites_named(event, PASSING[0])
            self.assertEqual(len(passing), 1, f"tree={event.get('tree')!r}")
            self.assertEqual([(c.get("name"), c.get("status"))
                              for c in passing[0].get("children") or []],
                             [("passes", "pass")], f"suite={passing[0]!r}")

            _, missing = self.the_load_error_case(event, MISSING_IMPORT[0])
            self.assertTrue(
                _message_text(missing["failure"].get("message")).startswith(
                    "Cannot find module './does-not-exist'"),
                f"case={missing!r}")
            self.assertIn(MISSING_IMPORT[0], missing["failure"].get("message") or "")

            _, throws = self.the_load_error_case(event, THROWS[0])
            self.assertEqual(_message_text(throws["failure"].get("message")),
                             "boom at import", f"case={throws!r}")
            self.assertIn("boom at import", throws["failure"].get("trace") or "")
            self.assertNotIn("rejected at import", throws["failure"].get("trace") or "",
                             "a file's trace holds only its own blocks")

            _, rejects = self.the_load_error_case(event, REJECTS[0])
            self.assertEqual(_message_text(rejects["failure"].get("message")),
                             "rejected at import", f"case={rejects!r}")
            self.assertIn("rejected at import", rejects["failure"].get("trace") or "")
            self.assertNotIn("boom at import", rejects["failure"].get("trace") or "",
                             "a file's trace holds only its own blocks")

            self.assert_no_runner_case(event)
            self.assert_counts(event.get("summary") or {}, 4, 1, 3, "the stored run's")
            envelope = _envelope(self.result.stdout)
            self.assertIsNotNone(envelope, f"no envelope; {self.diagnostics()}")
            self.assert_counts((envelope or {}).get("run") or {}, 4, 1, 3,
                               "the envelope's run")

        def test_a_file_with_two_error_blocks_is_one_case_with_the_first_message_and_both_traces(self):
            agent = f"load-errors-two-blocks-{self.FORM}"
            self.run_files(agent, PASSING, TWO_BLOCKS)
            self.assert_console_form()
            self.assertNotEqual(self.result.returncode, 0, self.diagnostics())
            event = self.stored_run(agent)
            suite, case = self.the_load_error_case(event, TWO_BLOCKS[0])
            self.assertEqual(len(suite.get("children") or []), 1,
                             f"two blocks are one case, not two; suite={suite!r}")
            self.assertEqual(_message_text(case["failure"].get("message")),
                             "first block", f"case={case!r}")
            trace = case["failure"].get("trace") or ""
            self.assertIn("first block", trace, f"case={case!r}")
            self.assertIn("second block", trace, f"every block is in the trace; case={case!r}")
            self.assert_no_runner_case(event)
            self.assert_counts(event.get("summary") or {}, 2, 1, 1, "the stored run's")

        def test_a_file_whose_test_ran_then_rejected_gets_its_case_in_its_existing_suite(self):
            agent = f"load-errors-ran-then-rejected-{self.FORM}"
            self.run_files(agent, PASSING, RAN_THEN_REJECTED)
            self.assert_console_form()
            self.assertNotEqual(self.result.returncode, 0, self.diagnostics())
            event = self.stored_run(agent)
            suite, case = self.the_load_error_case(event, RAN_THEN_REJECTED[0])
            self.assertEqual(
                sorted((c.get("name"), c.get("status")) for c in suite.get("children") or []),
                [("?", "fail"), ("ran first", "pass")],
                f"the case joins the suite the report already holds; suite={suite!r}")
            self.assertEqual(_message_text(case["failure"].get("message")),
                             "rejected after its test ran", f"case={case!r}")
            self.assert_no_runner_case(event)
            self.assert_counts(event.get("summary") or {}, 3, 2, 1, "the stored run's")

        def test_a_run_where_every_file_fails_to_load_exits_non_zero(self):
            agent = f"load-errors-all-fail-{self.FORM}"
            self.run_files(agent, MISSING_IMPORT, THROWS)
            self.assert_console_form()
            self.assertFalse(
                os.path.exists(os.path.join(self.project, "reports", agent, "junit.xml"))
                or os.path.exists(os.path.join(self.project, "reports", "junit.xml")),
                "fixture guard: bun writes no report when every file fails to load")
            self.assertNotEqual(
                self.result.returncode, 0,
                f"a run where no file loaded exits non-zero — the compile "
                f"ingest's code never decides it; {self.diagnostics()}")


class LoadErrorsInThePlainConsoleTest(_Forms.LoadErrorsCase):
    """bun's plain wire form: `NO_COLOR=1`."""

    FORM = "plain"
    COLOR_ENV = {"NO_COLOR": "1"}
    ANSI_EXPECTED = False


class LoadErrorsInTheAnsiConsoleTest(_Forms.LoadErrorsCase):
    """bun's ANSI wire form: `FORCE_COLOR=1`."""

    FORM = "ansi"
    COLOR_ENV = {"FORCE_COLOR": "1"}
    ANSI_EXPECTED = True


if __name__ == "__main__":
    unittest.main()
