"""A `test` run through a declared test script: the name filter on the
board-decoded route, the run's own narration, and the top-level help line.

A project declares `crucible.testScript` in `package.json`; every `test` run
then goes through that script. Three contracts are pinned here:

`FilteredRunThroughARawReportScriptTest`
    A declared script that also declares `crucible.rawReport` (its runner's
    full report, decoded on the board) is still handed a JUnit path, and a
    filtered run is counted from the JUnit report the same run wrote. A
    pattern matching nothing aborts the run -- `ok: false`, exit 1, a warning
    naming the pattern, one abort -- and NEITHER report is posted. A matching
    pattern still files once, through the raw route. A filtered run that wrote
    NO JUnit report cannot be counted: it is aborted too, its warning naming
    the script and the missing JUnit report, and nothing is posted as a
    report. An unfiltered run that wrote no JUnit report is unaffected: it
    still files its raw report.

`DeclaredScriptRunNarratesItselfAsATestRunTest`
    A `test` run through a declared script announces itself as a `test` run,
    never as a `regression` run, in the identity heartbeat that opens it; and
    its stderr exit line does not claim `bun test` when the runner is a
    declared script.

`TopLevelHelpTestLineNamesTheDeclaredScriptTest`
    The `test` line of the top-level `--help` summary names the declared test
    script, not only `bun test`.

Every run drives the real `clients/bun-crucible.py` as an OS subprocess with a
recording fake `bun` (it logs its argv and the NAMES of the report variables it
was handed, never their values) and files to a `RecordingBoard` on loopback
that the scratch project's own `crucible.toml` points the client at -- never
the live board, never a URL on the command line. Wording is pinned as words,
never as exact text.

Invocation:
    python3 -m unittest tests.client.test_bun_declared_test_script_name_filter_raw_report_and_narration -v
"""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    INGEST_PATHS,
    RecordingBoard,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
BUN_CLIENT = CLIENTS / "bun-crucible.py"
TIMEOUT = 120
AGENT = "declared-script-filter-narration-agent"
PROJECT_KEY = "declared-script-filter-narration-project-key"
PARSED_INGEST = "/api/v2/runs/parsed"
RAW_INGEST = "/api/v2/runs"
HEARTBEAT = "/api/v2/agents/heartbeat"

ALPHA = "alpha matches the filter"
BETA = "beta stays out of the filter"
MATCHING_PATTERN = "^alpha match"
NO_MATCH_PATTERN = "zeta-matches-no-test"

# The report variables the fake `bun` looks for.
JUNIT_VAR = "DECLARED_FILTER_JUNIT_PATH"
RAW_VAR = "DECLARED_FILTER_RAW_PATH"
_WATCHED_VARS = (JUNIT_VAR, RAW_VAR)

# The client's own resolution variables: a value inherited from the shell
# running this suite would silently decide the directory or binary under test.
_CLIENT_RESOLUTION_KEYS = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
                           "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
                           *_WATCHED_VARS)

# A fake `bun` that honours `-t <pattern>` the way a real runner does: the two
# cases are reported, the one the pattern excludes as skipped. It writes its
# JUnit report wherever the flag or the declared variable points, unless
# FAKE_BUN_JUNIT=none, and a raw report wherever the raw variable points.
_FAKE_BUN_BODY = r'''
import json
import os
import re
import sys

JUNIT_VAR, RAW_VAR = ''' + repr(_WATCHED_VARS) + r'''
CASES = ''' + repr((ALPHA, BETA)) + r'''

argv = sys.argv[1:]
log = os.environ.get("FAKE_BUN_LOG")
if log:
    handed = sorted(name for name in (JUNIT_VAR, RAW_VAR) if name in os.environ)
    with open(log, "a") as handle:
        handle.write(json.dumps({"argv": argv, "vars": handed}) + "\n")

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

pattern = argv[argv.index("-t") + 1] if "-t" in argv[:-1] else None
junit = os.environ.get(JUNIT_VAR)
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
if junit and os.environ.get("FAKE_BUN_JUNIT") != "none":
    cases = []
    for name in CASES:
        ran = pattern is None or re.search(pattern, name) is not None
        cases.append('<testcase name="%s" file="pair.test.ts" time="0.001">%s'
                     '</testcase>' % (name, "" if ran else "<skipped/>"))
    write(junit,
          '<?xml version="1.0" encoding="UTF-8"?><testsuites>'
          '<testsuite name="pair.test.ts" tests="2" failures="0">'
          + "".join(cases) + '</testsuite></testsuites>')
if RAW_VAR in os.environ:
    write(os.environ[RAW_VAR], "{}")
sys.exit(0)
'''


def _client_env(**extra):
    env = scrubbed_env(None, **extra)
    for key in _CLIENT_RESOLUTION_KEYS:
        env.pop(key, None)
    return env


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout!r} "
            f"stderr={result.stderr[-2500:]!r}")


class _DeclaredScriptCase(unittest.TestCase):
    """A scratch project declaring `SCRIPTS`/`CRUCIBLE`, a recording fake
    `bun`, and a recording board named by the project's own config."""

    SCRIPTS = {}
    CRUCIBLE = None

    def setUp(self):
        self.project = new_scratch("declared-script-filter-narration-")
        manifest = {"name": "declared-script-filter-narration-fixture",
                    "private": True, "scripts": self.SCRIPTS}
        if self.CRUCIBLE is not None:
            manifest["crucible"] = self.CRUCIBLE
        Path(self.project, "package.json").write_text(json.dumps(manifest, indent=2))
        self.board = RecordingBoard()
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n\n"
            "[limits.truncate_field_chars]\nvalue = 4000\n")
        self.bun_log = os.path.join(self.project, "bun-calls.jsonl")
        self.fake_bun = os.path.join(self.project, "fake_bun.py")
        Path(self.fake_bun).write_text("#!" + sys.executable + "\n" + _FAKE_BUN_BODY)
        os.chmod(self.fake_bun,
                 os.stat(self.fake_bun).st_mode | stat.S_IXUSR | stat.S_IRUSR)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def drive(self, *extra, **env):
        cmd = [sys.executable, str(BUN_CLIENT), "test", "--agent", AGENT,
               "--project-dir", self.project, "--package-dir", self.project,
               "--bun", self.fake_bun, "--reports", "reports", *extra]
        return subprocess.run(cmd, cwd=self.project,
                              env=_client_env(FAKE_BUN_LOG=self.bun_log, **env),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def bun_calls(self):
        if not os.path.exists(self.bun_log):
            return []
        with open(self.bun_log) as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def envelope_of(self, result):
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(envelope,
                             f"stdout is not one TOON envelope; {_diagnostics(result)}")
        return envelope or {}

    def report_posts(self):
        """Every POST that files a report (raw, parsed or compile)."""
        return [(p, b) for p, b in self.board.posts() if p in INGEST_PATHS]


# ── The name filter on the board-decoded route ─────────────────────────────

class FilteredRunThroughARawReportScriptTest(_DeclaredScriptCase):
    """A declared test script whose runner's full report is decoded on the
    board, beside the JUnit report the same run writes."""

    RAW_SCRIPT = "test:decoded"
    SCRIPTS = {RAW_SCRIPT: "some-runner"}
    CRUCIBLE = {"testScript": RAW_SCRIPT,
                "reportPath": {RAW_SCRIPT: f"env:{JUNIT_VAR}"},
                "rawReport": {RAW_SCRIPT: {"codec": "stub", "file": "stub.json",
                                           "path": f"env:{RAW_VAR}"}}}

    def assert_ran_through_the_script_with_both_report_variables(self, result):
        calls = self.bun_calls()
        self.assertEqual(len(calls), 1,
                         f"the script runs exactly once; calls={calls!r} "
                         f"{_diagnostics(result)}")
        self.assertEqual(calls[0]["argv"][:2], ["run", self.RAW_SCRIPT],
                         f"argv={calls[0]['argv']!r}")
        self.assertEqual(calls[0]["vars"], sorted(_WATCHED_VARS),
                         f"the script is handed a JUnit path AND the raw "
                         f"report's path; handed={calls[0]['vars']!r}")

    def assert_aborted_and_nothing_filed(self, result):
        diagnostics = _diagnostics(result)
        self.assertEqual(result.returncode, 1,
                         f"a filtered run that cannot be counted as having "
                         f"run something exits 1; {diagnostics}")
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertEqual(
            self.report_posts(), [],
            f"neither the raw report nor a parsed JUnit report may be posted; "
            f"posts={self.board.posts()!r}")
        self.assertEqual(
            len(self.board.aborts()), 1,
            f"the run this verb opened is aborted exactly once; "
            f"posts={self.board.posts()!r}")
        return envelope

    def test_a_pattern_matching_no_test_aborts_the_run_counted_from_the_junit_report(self):
        result = self.drive("--tests", "pair.test.ts", "--name", NO_MATCH_PATTERN)
        self.assert_ran_through_the_script_with_both_report_variables(result)
        envelope = self.assert_aborted_and_nothing_filed(result)
        warnings = json.dumps(envelope.get("warnings") or [])
        self.assertIn(NO_MATCH_PATTERN, warnings,
                      f"the warning names the pattern; envelope={envelope!r}")
        self.assertEqual(envelope.get("name"), NO_MATCH_PATTERN,
                         f"the envelope's `name` field names the filter; "
                         f"envelope={envelope!r}")

    def test_a_matching_pattern_still_files_once_through_the_raw_route(self):
        result = self.drive("--tests", "pair.test.ts", "--name", MATCHING_PATTERN)
        self.assert_ran_through_the_script_with_both_report_variables(result)
        diagnostics = _diagnostics(result)
        self.assertEqual(result.returncode, 0, diagnostics)
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
        self.assertEqual(envelope.get("name"), MATCHING_PATTERN,
                         f"envelope={envelope!r}")
        raw = [b for p, b in self.report_posts() if p == RAW_INGEST]
        self.assertEqual(len(raw), 1,
                         f"the raw report is filed exactly once; "
                         f"posts={self.board.posts()!r}")
        self.assertEqual(raw[0].get("codec"), "stub", f"body={raw[0]!r}")
        self.assertEqual(
            [p for p, _ in self.report_posts() if p != RAW_INGEST], [],
            f"a board-decoded report is never also filed parsed; "
            f"posts={self.board.posts()!r}")
        self.assertEqual(self.board.aborts(), [],
                         f"a run that ran a test is not aborted; "
                         f"posts={self.board.posts()!r}")

    def test_a_filtered_run_that_wrote_no_junit_report_is_aborted_naming_the_script(self):
        result = self.drive("--tests", "pair.test.ts", "--name", MATCHING_PATTERN,
                            FAKE_BUN_JUNIT="none")
        self.assert_ran_through_the_script_with_both_report_variables(result)
        envelope = self.assert_aborted_and_nothing_filed(result)
        warnings = json.dumps(envelope.get("warnings") or [])
        self.assertIn(self.RAW_SCRIPT, warnings,
                      f"the warning names the script; envelope={envelope!r}")
        self.assertIn("junit", warnings.lower(),
                      f"the warning names the missing JUnit report; "
                      f"envelope={envelope!r}")

    def test_an_unfiltered_run_that_wrote_no_junit_report_still_files_its_raw_report(self):
        result = self.drive("--tests", "pair.test.ts", FAKE_BUN_JUNIT="none")
        self.assert_ran_through_the_script_with_both_report_variables(result)
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
        raw = [b for p, b in self.report_posts() if p == RAW_INGEST]
        self.assertEqual(len(raw), 1,
                         f"only a FILTERED run needs the JUnit count; an "
                         f"unfiltered one files its raw report once; "
                         f"posts={self.board.posts()!r}")
        self.assertEqual(self.board.aborts(), [],
                         f"posts={self.board.posts()!r}")


# ── The run narrates itself as a `test` run ────────────────────────────────

class DeclaredScriptRunNarratesItselfAsATestRunTest(_DeclaredScriptCase):
    """A `test` run through a declared Vitest-style script (nothing appended,
    the JUnit path rides a variable)."""

    # A script name that does not itself carry the word `test`, so only the
    # verb can put it in the run's narration.
    SCRIPT = "spec:vitest"
    SCRIPTS = {SCRIPT: "bun --bun vitest run"}
    CRUCIBLE = {"testScript": SCRIPT,
                "reportPath": {SCRIPT: f"env:{JUNIT_VAR}"}}

    def opening_heartbeat_message(self, result):
        beats = [b for p, b in self.board.posts() if p == HEARTBEAT]
        self.assertGreaterEqual(
            len(beats), 1,
            f"the run opens its identity with a heartbeat; "
            f"posts={self.board.posts()!r} {_diagnostics(result)}")
        return str((beats[0] or {}).get("message") or "")

    def test_the_opening_heartbeat_names_a_test_run_not_a_regression_run(self):
        result = self.drive("--tests", "a.vitest.ts")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        message = self.opening_heartbeat_message(result)
        self.assertNotIn(
            "regression", message.lower(),
            f"a `test` run through a declared script must not announce itself "
            f"as a regression run; message={message!r}")
        self.assertRegex(
            message.lower(), r"\btest\b",
            f"the run-start message names the `test` verb; message={message!r}")

    def test_the_exit_line_does_not_claim_bun_test_for_a_declared_script(self):
        result = self.drive("--tests", "a.vitest.ts")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        lines = result.stderr.splitlines()
        claims = [line for line in lines if "bun test exit" in line]
        self.assertEqual(
            claims, [],
            f"the runner is the declared script `{self.SCRIPT}`, not `bun "
            f"test`; stderr lines claiming it: {claims!r}")
        named = [line for line in lines
                 if self.SCRIPT in line and re.search(r"\bexit", line)]
        self.assertEqual(
            len(named), 1,
            f"exactly one stderr line reports the declared script's exit; "
            f"stderr={result.stderr[-2500:]!r}")


# ── The top-level help's `test` line ───────────────────────────────────────

def _subcommand_summary(help_text, verb):
    """The one-line summary argparse prints for `verb` in the top-level help:
    the line that introduces it and any continuation lines indented deeper,
    whitespace collapsed. Empty when the verb is not listed."""
    lines = help_text.splitlines()
    for index, line in enumerate(lines):
        match = re.match(rf"^(\s+){re.escape(verb)}\s{{2,}}(\S.*)$", line)
        if not match:
            continue
        indent = len(match.group(1))
        parts = [match.group(2)]
        for follow in lines[index + 1:]:
            lead = len(follow) - len(follow.lstrip())
            if not follow.strip() or lead <= indent + len(verb):
                break
            parts.append(follow.strip())
        return re.sub(r"\s+", " ", " ".join(parts)).strip()
    return ""


class TopLevelHelpTestLineNamesTheDeclaredScriptTest(unittest.TestCase):

    def test_the_test_summary_line_names_the_declared_test_script(self):
        scratch = new_scratch("declared-script-help-")
        try:
            result = subprocess.run(
                [sys.executable, str(BUN_CLIENT), "--help"], cwd=scratch,
                env=_client_env(COLUMNS="200", NO_COLOR="1", PYTHON_COLORS="0"),
                capture_output=True, text=True, timeout=TIMEOUT, check=False)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        summary = _subcommand_summary(result.stdout, "test")
        self.assertNotEqual(summary, "",
                            f"the top-level help lists `test`; "
                            f"stdout={result.stdout!r}")
        self.assertTrue(
            "testScript" in summary
            or re.search(r"declared\s+(test\s+)?script", summary, re.IGNORECASE),
            f"the top-level `test` summary must name the declared test script "
            f"(`testScript` or a declared script), not only `bun test`; "
            f"summary={summary!r}")


if __name__ == "__main__":
    unittest.main()
