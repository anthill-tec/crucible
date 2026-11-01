"""The shipped Playwright reporter survives a stream it cannot write.

When `CRUCIBLE_STREAM` names a file it cannot open -- inside a directory that
does not exist, or under a path whose parent is a regular file -- the reporter
`clients/reporters/playwright-crucible.ts`:

* prints exactly ONE clear error line, naming the path it could not write;
* does not throw out of `onBegin` (nor out of a later hook): Playwright's own
  reporter wrapper, which prints `Error in reporter` for a hook that throws,
  never fires;
* lets Playwright run the fixture to completion: the run's own JUnit report
  shows every scenario of every project, and the run's outcome is the one the
  fixture is designed to give.

Two drives:

* a REAL Playwright run of a scratch copy of
  `tests/fixtures/playwright-bdd-project`, with the reporter handed in through
  `CRUCIBLE_REPORTERS` and `CRUCIBLE_STREAM` pointing into a directory that
  does not exist;
* the reporter's hooks called directly under `bun`, with a minimal config and
  suite, for both kinds of unwritable path -- so "does not throw" is observed
  on the hook itself, not only through Playwright's wrapper.

INTERFACE CHOICE: the error line goes to the process's stdout or stderr (the
tests read both together), and is counted as the lines that name the path.

The fixture interface these tests drive is stated in
`tests/client/playwright_reporter_scratch.py`.

Invocation:
    python3 -m unittest tests.client.test_playwright_crucible_reporter_survives_an_unwritable_stream -v
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.client.live_run_harness import scrubbed_env
from tests.client.playwright_reporter_scratch import (
    EXPECTED_TOTALS,
    REPORTER,
    REPORTERS_DIR,
    STREAM_FILE_NAME,
    STREAM_VAR,
    TIMEOUT,
    diagnostics,
    junit_report,
    require_playwright_toolchain,
    run_fixture_playwright,
    scratch_fixture,
)

PLAYWRIGHT_REPORTER_WRAPPER = "Error in reporter"
SURVIVED = "REPORTER-HOOKS-RETURNED"

# The reporter's hooks, called in Playwright's order with a run of no tests.
_HOOKS_SCRIPT = (
    "const Reporter = (await import(" + json.dumps(str(REPORTER)) + ")).default;\n"
    "const reporter = new Reporter();\n"
    "const suite = { allTests: () => [] };\n"
    "reporter.onBegin({ rootDir: process.cwd() }, suite);\n"
    "reporter.onEnd({ status: 'passed', duration: 1 });\n"
    "console.log(" + json.dumps(SURVIVED) + ");\n"
)

def _lines_naming(output, path):
    return [line for line in output.splitlines() if path in line]

class PlaywrightRunsToCompletionWithAnUnwritableStreamTest(unittest.TestCase):
    """A real Playwright run, its stream pointed into a missing directory."""

    def setUp(self):
        self.bun = require_playwright_toolchain(self)
        self.scratch, self.project = scratch_fixture("playwright-reporter-unwritable-")
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)

    def test_a_stream_in_a_missing_directory_gives_one_error_line_and_the_run_completes(self):
        missing_dir = os.path.join(self.scratch, "no-such-directory")
        stream = os.path.join(missing_dir, STREAM_FILE_NAME)
        reports = os.path.join(self.scratch, "reports")
        os.makedirs(reports)
        junit = os.path.join(reports, "junit.xml")

        result = run_fixture_playwright(self.bun, self.project, REPORTERS_DIR, stream,
                                        junit_path=junit)
        output = result.stdout + result.stderr

        # The run completed: every scenario of every project is in its JUnit,
        # and its outcome is the one the fixture is designed to give.
        counts, _ = junit_report(self, junit, result)
        self.assertEqual(counts["tests"], EXPECTED_TOTALS["total"],
                         f"Playwright ran the whole fixture; junit={counts!r} "
                         f"{diagnostics(result)}")
        self.assertEqual(result.returncode, 1,
                         f"the fixture's failing scenarios fail the run, as without "
                         f"the reporter; {diagnostics(result)}")

        # No hook threw: Playwright's wrapper printed nothing.
        self.assertNotIn(PLAYWRIGHT_REPORTER_WRAPPER, output,
                         f"the reporter threw out of a hook; {diagnostics(result)}")
        # Exactly one line names the path it could not write.
        naming = _lines_naming(output, stream)
        self.assertEqual(len(naming), 1,
                         f"exactly one error line naming {stream}; found "
                         f"{naming!r}; {diagnostics(result)}")
        # NEGATIVE — the reporter made no directory and no file of its own.
        self.assertFalse(os.path.exists(missing_dir),
                         f"the reporter created {missing_dir}")

class ReporterHooksDoNotThrowOnAnUnwritableStreamTest(unittest.TestCase):
    """The reporter's own hooks, called directly under bun."""

    def setUp(self):
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "this proof needs the real `bun` on PATH")
        self.bun: str = bun or ""
        self.assertTrue(REPORTER.is_file(), f"the shipped reporter is missing: {REPORTER}")
        self.scratch = Path(tempfile.mkdtemp(prefix="playwright-reporter-hooks-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)

    def run_hooks(self, stream):
        env = scrubbed_env(None, NO_COLOR="1", FORCE_COLOR="0")
        env[STREAM_VAR] = str(stream)
        return subprocess.run([self.bun, "-e", _HOOKS_SCRIPT], cwd=self.scratch, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT, check=False)

    def assert_survives_with_one_line(self, stream):
        result = self.run_hooks(stream)
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0,
                         f"a hook threw for {STREAM_VAR}={stream}; {diagnostics(result)}")
        self.assertIn(SURVIVED, result.stdout,
                      f"onBegin and onEnd both returned; {diagnostics(result)}")
        naming = _lines_naming(output, str(stream))
        self.assertEqual(len(naming), 1,
                         f"exactly one error line naming {stream}; found {naming!r}; "
                         f"{diagnostics(result)}")

    def test_a_stream_in_a_missing_directory_does_not_throw_out_of_on_begin(self):
        stream = self.scratch / "no-such-directory" / STREAM_FILE_NAME
        self.assert_survives_with_one_line(stream)
        self.assertFalse(stream.parent.exists(), f"the reporter created {stream.parent}")

    def test_a_stream_under_a_regular_file_does_not_throw_out_of_on_begin(self):
        blocker = self.scratch / "a-regular-file"
        blocker.write_text("not a directory\n")
        stream = blocker / STREAM_FILE_NAME
        self.assert_survives_with_one_line(stream)
        self.assertEqual(blocker.read_text(), "not a directory\n",
                         "the reporter left the regular file untouched")

    def test_a_writable_stream_still_streams_through_the_same_hooks(self):
        # The control: the same direct call DOES write the stream when it can,
        # so the survivals above are the unwritable path, not a hook that
        # never opens anything.
        stream = self.scratch / STREAM_FILE_NAME
        result = self.run_hooks(stream)
        self.assertEqual(result.returncode, 0, diagnostics(result))
        self.assertTrue(stream.is_file(), f"no stream at {stream}; {diagnostics(result)}")
        events = [json.loads(line) for line in stream.read_text().splitlines()]
        self.assertEqual([event.get("event") for event in events], ["run-start", "run-end"],
                         f"events={events!r}")
        self.assertEqual(_lines_naming(result.stdout + result.stderr, str(stream)), [],
                         f"a writable stream prints no error line; {diagnostics(result)}")

if __name__ == "__main__":
    unittest.main()
