"""A declared script's passthrough reaches the script under every mechanism.

A tier verb runs a declared `package.json` script by name (`bun run <script>`)
and hands the script whatever the operator typed after `--`. Under the default
`flag` report mechanism the client appends `bun test`'s report flags to the
invocation; the passthrough must then follow those flags with NO `--` between
them, because `bun run` forwards a literal `--` to the script and `bun test`
reads everything after it as a file filter -- so `unit -- -t <pattern>` would
otherwise find no tests at all. Under an `env:<VAR>` mechanism nothing is
appended, and the invocation stays exactly what it was.

Two kinds of proof:

* The behaviour itself is proved with the REAL installed `bun` on a tiny
  scratch package written into a temporary directory (no install, no network):
  the defect lives in how bun treats `--`, which no fake can show. A two-test
  file where only one test matches `-t alpha` must be filed as 1 passed and
  1 pending (bun reports a filter-excluded test as `<skipped/>`).
* The argv shape is pinned with a fake `bun` that records every invocation.

Every test drives the real `clients/bun-crucible.py` as an OS subprocess. A run
that files evidence files it to a `RecordingBoard` on loopback that the
scratch project's own `crucible.toml` points the client at -- never the live
board, never a URL on the command line.

Invocation:
    python3 -m unittest tests.client.test_bun_declared_script_passthrough_reaches_the_script -v
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
    RecordingBoard,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
BUN_CLIENT = CLIENTS / "bun-crucible.py"
TIMEOUT = 120
AGENT = "declared-passthrough-fixture-agent"
PROJECT_KEY = "declared-passthrough-fixture-key"
PARSED_INGEST = "/api/v2/runs/parsed"

# The client's own resolution variables: a value inherited from the shell
# running this suite would silently decide the directory or binary under test.
_CLIENT_RESOLUTION_KEYS = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
                           "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE")

ALPHA = "alpha matches the filter"
BETA = "beta stays out of the filter"

# Two passing tests; only the first matches the pattern `alpha`.
_PAIR_TEST = f'''import {{ expect, test }} from "bun:test";

test("{ALPHA}", () => {{
  expect(1 + 1).toBe(2);
}});

test("{BETA}", () => {{
  expect(2 + 2).toBe(4);
}});
'''

ENV_REPORT_VAR = "UNIT_JUNIT_OUT"

# A fake `bun` that records the argv of every invocation to `$FAKE_BUN_LOG`
# and writes a one-case passing JUnit report wherever it was told to: the
# `--reporter-outfile=` flag (the flag mechanism) or the variable an
# `env:<VAR>` declaration names. It never executes the script body: these
# tests read only the argv the client handed bun.
_FAKE_BUN_BODY = r'''
import json
import os
import sys

argv = sys.argv[1:]
log = os.environ.get("FAKE_BUN_LOG")
if log:
    with open(log, "a") as handle:
        handle.write(json.dumps(argv) + "\n")
outfile = os.environ.get("''' + ENV_REPORT_VAR + r'''")
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        outfile = arg.split("=", 1)[1]
if outfile:
    directory = os.path.dirname(outfile)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(outfile, "w") as handle:
        handle.write(
            '<?xml version="1.0" encoding="UTF-8"?><testsuites>'
            '<testsuite name="pair.test.ts" tests="1" failures="0">'
            '<testcase name="fixture_case" file="pair.test.ts" time="0.001">'
            '</testcase></testsuite></testsuites>')
sys.exit(0)
'''


def _write_manifest(directory, report_path=None):
    manifest = {"name": "declared-passthrough-fixture",
                "scripts": {"test:unit": "bun test"}}
    if report_path is not None:
        manifest["crucible"] = {"reportPath": {"test:unit": report_path}}
    Path(directory, "package.json").write_text(json.dumps(manifest, indent=2))


def _write_project_config(project, board_url):
    """The project's own `.env` and `crucible.toml`: the board the client
    files to is named by the project, never by the command line."""
    Path(project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
    Path(project, "crucible.toml").write_text(
        f"[client]\nurl = {json.dumps(board_url)}\n\n"
        "[limits.truncate_field_chars]\nvalue = 4000\n")


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


def _leaf_statuses(tree):
    return {leaf.get("name"): leaf.get("status")
            for suite in tree or [] for leaf in suite.get("children") or []}


class FlagMechanismPassthroughRunsOnlyTheMatchingTestTest(unittest.TestCase):
    """`unit -- -t alpha` on a declared `bun test` script under the default
    `flag` mechanism runs only the matching test, on the real `bun`."""

    def setUp(self):
        self.real_bun = shutil.which("bun")
        self.assertIsNotNone(
            self.real_bun,
            "this proof needs the real `bun` on PATH: the defect is in how "
            "bun itself treats `--`, which no fake can show")
        self.project = new_scratch("declared-passthrough-real-")
        _write_manifest(self.project)
        Path(self.project, "pair.test.ts").write_text(_PAIR_TEST)
        self.board = RecordingBoard()
        _write_project_config(self.project, self.board.url)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def drive(self, *passthrough):
        cmd = [sys.executable, str(BUN_CLIENT), "unit", "--agent", AGENT,
               "--project-dir", self.project, "--package-dir", self.project,
               "--bun", self.real_bun, "--reports", "reports", *passthrough]
        return subprocess.run(cmd, cwd=self.project, env=_client_env(),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def parsed_ingests(self):
        return [body for path, body in self.board.posts() if path == PARSED_INGEST]

    def test_unit_passthrough_name_filter_files_one_passed_and_one_pending(self):
        result = self.drive("--", "-t", "alpha")
        diagnostics = (f"exit={result.returncode} stdout={result.stdout!r} "
                       f"stderr={result.stderr[-2500:]!r}")

        ingests = self.parsed_ingests()
        self.assertEqual(
            len(ingests), 1,
            f"the filtered run must be filed exactly once as a parsed JUnit "
            f"result -- a passthrough lost behind `--` makes bun find no "
            f"test file and write no report; {diagnostics}")
        body = ingests[0]
        summary = body.get("summary") or {}
        self.assertEqual(
            (summary.get("passed"), summary.get("pending"),
             summary.get("failed"), summary.get("total")),
            (1, 1, 0, 2),
            f"`-t alpha` must run only the matching test (1 passed) and leave "
            f"the other filtered out (1 pending); summary={summary!r}")
        self.assertEqual(
            _leaf_statuses(body.get("tree")), {ALPHA: "pass", BETA: "pending"},
            f"the matching test passes and the excluded one is pending; "
            f"tree={body.get('tree')!r}")
        self.assertEqual(body.get("tier"), "unit",
                         f"a tier verb's run rides its own tier; body={body!r}")

        self.assertEqual(result.returncode, 0, diagnostics)
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(envelope, f"stdout is not one TOON envelope; {diagnostics}")
        envelope = envelope or {}
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
        run = envelope.get("run") or {}
        self.assertEqual((run.get("passed"), run.get("pending"), run.get("failed")),
                         (1, 1, 0), f"envelope run={run!r}")


class _FakeBunCase(unittest.TestCase):
    """A scratch project whose `bun` is a recording fake."""

    REPORT_PATH = None

    def setUp(self):
        self.project = new_scratch("declared-passthrough-argv-")
        _write_manifest(self.project, self.REPORT_PATH)
        self.board = RecordingBoard()
        _write_project_config(self.project, self.board.url)
        self.bun_log = os.path.join(self.project, "bun-calls.jsonl")
        self.fake_bun = os.path.join(self.project, "fake_bun.py")
        Path(self.fake_bun).write_text("#!" + sys.executable + "\n" + _FAKE_BUN_BODY)
        os.chmod(self.fake_bun,
                 os.stat(self.fake_bun).st_mode | stat.S_IXUSR | stat.S_IRUSR)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def drive_unit(self, *passthrough):
        cmd = [sys.executable, str(BUN_CLIENT), "unit",
               "--project-dir", self.project, "--package-dir", self.project,
               "--bun", self.fake_bun, "--reports", "reports", *passthrough]
        return subprocess.run(cmd, cwd=self.project,
                              env=_client_env(FAKE_BUN_LOG=self.bun_log),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def only_bun_call(self, result):
        calls = []
        if os.path.exists(self.bun_log):
            with open(self.bun_log) as handle:
                calls = [json.loads(line) for line in handle if line.strip()]
        self.assertEqual(
            len(calls), 1,
            f"the tier verb must spawn bun exactly once; calls={calls!r} "
            f"exit={result.returncode} stderr={result.stderr[-2000:]!r}")
        return calls[0]


class FlagMechanismPassthroughArgvTest(_FakeBunCase):
    """Under `flag` the report flags are appended and the passthrough follows
    them with no `--`, so `bun run` hands it to the script as written."""

    REPORT_PATH = None  # no declaration: the flag default

    def test_passthrough_follows_the_report_flags_with_no_dashdash(self):
        result = self.drive_unit("--", "-t", "alpha")
        argv = self.only_bun_call(result)
        self.assertEqual(argv[:2], ["run", "test:unit"],
                         f"the declared script runs by name; argv={argv!r}")
        self.assertNotIn(
            "--", argv,
            f"under the flag mechanism no `--` may separate the report flags "
            f"from the passthrough: bun forwards it and `bun test` reads what "
            f"follows as a file filter; argv={argv!r}")
        self.assertEqual(argv[-2:], ["-t", "alpha"],
                         f"the passthrough rides the end, as typed; argv={argv!r}")
        report_flags = argv[2:-2]
        self.assertEqual(len(report_flags), 2, f"argv={argv!r}")
        self.assertEqual(report_flags[0], "--reporter=junit", f"argv={argv!r}")
        self.assertRegex(report_flags[1], r"^--reporter-outfile=.+junit\.xml$",
                         f"argv={argv!r}")
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])

    def test_a_file_and_a_filter_in_the_passthrough_keep_their_order(self):
        result = self.drive_unit("--", "pair.test.ts", "-t", "^alpha (one|two)$")
        argv = self.only_bun_call(result)
        self.assertNotIn("--", argv, f"argv={argv!r}")
        self.assertEqual(
            argv[-3:], ["pair.test.ts", "-t", "^alpha (one|two)$"],
            f"each passthrough token arrives intact and in order; argv={argv!r}")
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])

    def test_without_passthrough_the_invocation_is_the_script_and_its_report_flags(self):
        # Pins today's shape: no passthrough, nothing after the report flags.
        result = self.drive_unit()
        argv = self.only_bun_call(result)
        self.assertEqual(len(argv), 4, f"argv={argv!r}")
        self.assertEqual(argv[:3], ["run", "test:unit", "--reporter=junit"],
                         f"argv={argv!r}")
        self.assertRegex(argv[3], r"^--reporter-outfile=.+junit\.xml$",
                         f"argv={argv!r}")
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])


class EnvMechanismPassthroughIsUnchangedTest(_FakeBunCase):
    """Under `env:<VAR>` nothing is appended, so the invocation is unchanged:
    `bun run <script> -- <passthrough>`."""

    REPORT_PATH = f"env:{ENV_REPORT_VAR}"

    def test_env_mechanism_keeps_the_dashdash_ahead_of_the_passthrough(self):
        result = self.drive_unit("--", "-t", "alpha")
        argv = self.only_bun_call(result)
        self.assertEqual(
            argv, ["run", "test:unit", "--", "-t", "alpha"],
            f"under env:<VAR> nothing is appended and the invocation is "
            f"unchanged; argv={argv!r}")
        self.assertFalse(
            any(re.match(r"^--reporter", a) for a in argv),
            f"the env mechanism appends no report flag; argv={argv!r}")
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
