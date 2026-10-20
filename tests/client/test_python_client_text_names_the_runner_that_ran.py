"""The python client's printed text names the runners it runs.

The client runs `unittest` (through xmlrunner) by default and `pytest` when
the project declares `[python] runner = "pytest"` in its own `crucible.toml`
or the caller passes `--runner pytest`. What it prints must say so:

`TheRootHelpNamesBothRunnersTest`
    The root `--help`'s description, and the `regression` line in the root
    `--help`'s verb list, each name both runners (`unittest`, `pytest`) and
    the `[python] runner` declaration -- never `unittest`/xmlrunner alone.

`TheEmptyCaptureFallbackNamesTheRunnerTest`
    When the runner wrote no JUnit XML and printed nothing at all, the text
    the client files as the compile record is its own fallback line. Under
    pytest that line names pytest and never xmlrunner (on `test` and on
    `regression`); under unittest it stays exactly what it was.

A runner that produced no report and no output is made real by the
interpreter the client is handed: a wrapper that hands every call to this
suite's interpreter, except the run itself (the call carrying pytest's
`--junitxml`, or the client's unittest runner script), which it ends at once
with exit 1, writing nothing. pytest's import probe still goes through, so
the pytest path is genuinely chosen.

Every test drives the REAL `clients/python-crucible.py` as an OS subprocess;
the runs file to a `RecordingBoard` on loopback named by the scratch
project's own `crucible.toml`, never the live board. Wording is pinned only as
far as the requirement fixes it: words and names, never a full-text snapshot.

Invocation:
    python3 -m unittest tests.client.test_python_client_text_names_the_runner_that_ran -v
"""

import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import CLIENTS, scrubbed_env
from tests.client.pytest_project_harness import (
    ScratchProject,
    diag,
    envelope,
    require_pytest_and_coverage,
)

TIMEOUT = 180
UNITTEST = "unittest"
PYTEST = "pytest"
RUNNER_DECLARATION = "[python] runner"
SILENT_AGENT = "silent-runner-proof-agent"

#: The unittest path's fallback line, unchanged.
UNITTEST_FALLBACK = ("xmlrunner produced no JUnit XML "
                     "(import/syntax failure, no output captured)")

_INHERITED_KEYS = ("PY_CRUCIBLE_PYTHON", "PY_CRUCIBLE_PROJECT_DIR", "PYTEST_ADDOPTS",
                   "PYTEST_PLUGINS", "COVERAGE_RCFILE", "COVERAGE_PROCESS_START")

# The silent-runner interpreter: every call is handed to `{real}` except the
# run itself, which exits 1 having written nothing.
_SILENT_RUNNER_INTERPRETER = '''#!{real}
import os
import sys

argv = sys.argv[1:]
is_run = (any(a.startswith("--junitxml") for a in argv)
          or any(os.path.basename(a) == "subtest_runner.py" for a in argv))
if is_run:
    sys.exit(1)
os.execv({real!r}, [{real!r}, *argv])
'''

_PROBE_TEST = '''import unittest


class ProbeTest(unittest.TestCase):

    def test_probe_passes(self):
        self.assertEqual(1 + 1, 2)
'''

_ENTRY_START = re.compile(r"^ {2,6}(?P<verb>[a-z][\w-]*)(?: {2,}(?P<text>\S.*))?$")
_CONTINUATION = re.compile(r"^ {8,}(?P<text>\S.*)$")


def _word(name):
    return re.compile(rf"(?<![\w-]){re.escape(name)}(?![\w-])")


def _root_help():
    env = scrubbed_env(None, COLUMNS="200", NO_COLOR="1", PYTHON_COLORS="0")
    for key in _INHERITED_KEYS:
        env.pop(key, None)
    scratch = ScratchProject("python-root-help-", from_fixture=False)
    try:
        scratch.declare()
        return subprocess.run(
            [sys.executable, str(CLIENTS / "python-crucible.py"), "--help"],
            cwd=scratch.dir, env=env, capture_output=True, text=True,
            timeout=TIMEOUT, check=False)
    finally:
        scratch.close()


def _description(text):
    """The root help's description: what argparse prints between the usage
    block and the first argument section."""
    lines = text.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == "")
        end = next(i for i, line in enumerate(lines)
                   if i > start and line.rstrip().endswith(":")
                   and not line.startswith(" ")
                   and line.rstrip()[:-1] in ("positional arguments", "options",
                                              "subcommands", "commands"))
    except StopIteration:
        return ""
    return "\n".join(lines[start:end])


def _verb_line(text, verb):
    """One verb's entry in the root help's verb list, its wrapped lines
    joined with whitespace normalised."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = _ENTRY_START.match(line)
        if not m or m.group("verb") != verb:
            continue
        parts = [m.group("text") or ""]
        for nxt in lines[i + 1:]:
            if _ENTRY_START.match(nxt) and not _CONTINUATION.match(nxt):
                break
            c = _CONTINUATION.match(nxt)
            if not c:
                break
            parts.append(c.group("text"))
        return " ".join(" ".join(parts).split())
    return ""


class TheRootHelpNamesBothRunnersTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.result = _root_help()

    def printed(self):
        self.assertEqual(self.result.returncode, 0,
                         f"python-crucible --help must exit 0; {diag(self.result)}")
        self.assertIn("usage:", self.result.stdout, diag(self.result))
        return self.result.stdout

    def description(self):
        text = _description(self.printed())
        self.assertNotEqual(text.strip(), "",
                            f"the root help prints a description; {diag(self.result)}")
        return text

    def regression_line(self):
        text = _verb_line(self.printed(), "regression")
        self.assertNotEqual(text, "",
                            f"the root help lists `regression`; {diag(self.result)}")
        return text

    def test_the_description_names_both_runners(self):
        text = self.description()
        for runner in (UNITTEST, PYTEST):
            self.assertRegex(text, _word(runner),
                             f"the root description must name {runner}: {text!r}")

    def test_the_description_names_the_python_runner_declaration(self):
        text = self.description()
        self.assertIn(RUNNER_DECLARATION, text,
                      f"the root description must name the `{RUNNER_DECLARATION}` "
                      f"declaration: {text!r}")

    def test_the_regression_line_names_both_runners(self):
        text = self.regression_line()
        for runner in (UNITTEST, PYTEST):
            self.assertRegex(text, _word(runner),
                             f"the root help's `regression` line must name {runner}: "
                             f"{text!r}")

    def test_the_regression_line_names_the_python_runner_declaration(self):
        text = self.regression_line()
        self.assertIn(RUNNER_DECLARATION, text,
                      f"the root help's `regression` line must name the "
                      f"`{RUNNER_DECLARATION}` declaration: {text!r}")


class TheEmptyCaptureFallbackNamesTheRunnerTest(unittest.TestCase):
    """A scratch project with one test under `tests/`, and the silent-runner
    interpreter the client is handed."""

    def setUp(self):
        require_pytest_and_coverage()
        self.project = ScratchProject("python-silent-runner-", from_fixture=False)
        self.addCleanup(self.project.close)
        self.project.write("tests/__init__.py", "")
        self.project.write("tests/test_probe.py", _PROBE_TEST)
        self.python = os.path.join(self.project.root, "silent_runner_python")
        Path(self.python).write_text(
            _SILENT_RUNNER_INTERPRETER.format(real=sys.executable))
        os.chmod(self.python, 0o700)

    def drive(self, *argv):
        env = scrubbed_env(None)
        for key in _INHERITED_KEYS:
            env.pop(key, None)
        cmd = [sys.executable, str(CLIENTS / "python-crucible.py"), *argv,
               "--agent", SILENT_AGENT, "--reports", "reports",
               "--python", self.python, "--project-dir", self.project.dir]
        return subprocess.run(cmd, cwd=self.project.dir, env=env, capture_output=True,
                              text=True, timeout=TIMEOUT, check=False)

    def the_one_compile_text(self, result):
        why = diag(result)
        self.assertNotEqual(result.returncode, 0,
                            f"a runner that produced nothing fails the run; {why}")
        self.assertIsNotNone(envelope(result.stdout),
                             f"stdout must be one AXI envelope; {why}")
        self.assertEqual(self.project.parsed_ingests(), [],
                         f"no report, so no parsed ingest; {why}")
        compiled = self.project.compile_ingests()
        self.assertEqual(len(compiled), 1,
                         f"exactly one compile record is filed; {why}")
        text = compiled[0].get("errors")
        if not isinstance(text, str):
            self.fail(f"the compile record carries its text; record={compiled[0]!r}")
        return text

    def assert_names_pytest_not_xmlrunner(self, verb):
        self.project.declare(PYTEST)
        result = self.drive(verb)
        text = self.the_one_compile_text(result)
        self.assertRegex(text, _word(PYTEST),
                         f"under pytest the `{verb}` fallback must name pytest: {text!r}")
        self.assertNotIn("xmlrunner", text,
                         f"under pytest the `{verb}` fallback must not name "
                         f"xmlrunner: {text!r}")

    def test_a_silent_pytest_test_run_files_a_fallback_naming_pytest(self):
        self.assert_names_pytest_not_xmlrunner("test")

    def test_a_silent_pytest_regression_files_a_fallback_naming_pytest(self):
        self.assert_names_pytest_not_xmlrunner("regression")

    def test_a_silent_unittest_test_run_files_the_unchanged_xmlrunner_fallback(self):
        self.project.declare()
        result = self.drive("test")
        self.assertEqual(self.the_one_compile_text(result), UNITTEST_FALLBACK,
                         diag(result))


if __name__ == "__main__":
    unittest.main()
