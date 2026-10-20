"""`test --name <pattern>` runs only the tests whose name matches.

On the default path -- no declared test script -- the bun client's `test` verb
runs `bun test`. `--name <pattern>` is a regular expression handed to it
unchanged as `-t <pattern>`. Bun reports every test the filter excludes as
`<skipped/>`, and the client files those as pending, exactly as the runner
reported them. The envelope's `name` field names the filter.

A filtered run in which nothing passed and nothing failed ran nothing: it is
aborted rather than filed, the envelope reads `ok: false`, the command exits 1,
and a warning names the pattern. (Bun exits 1 on a pattern that matches no
test, but it still writes a JUnit report holding every test as skipped.)

Without `--name`, the `bun test` invocation and its report flags are unchanged,
and `_bun_test_cmd` still takes its five positional arguments.

The behaviour is proved with the REAL installed `bun` on a tiny scratch package
written into a temporary directory (no install, no network). The argv shape is
pinned with a fake `bun` that records every invocation. Every test drives the
real `clients/bun-crucible.py` as an OS subprocess, filing to a
`RecordingBoard` on loopback that the scratch project's own `crucible.toml`
points the client at.

Invocation:
    python3 -m unittest tests.client.test_bun_test_name_filter -v
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    load_client,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
BUN_CLIENT = CLIENTS / "bun-crucible.py"
TIMEOUT = 120
AGENT = "name-filter-fixture-agent"
PROJECT_KEY = "name-filter-fixture-key"
PARSED_INGEST = "/api/v2/runs/parsed"
START = "/api/v2/runs/start"

_CLIENT_RESOLUTION_KEYS = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
                           "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE")

ALPHA = "alpha matches the filter"
BETA = "beta stays out of the filter"
# A regular expression with an anchor and a space: it must reach bun as ONE
# argument, unchanged.
MATCHING_PATTERN = "^alpha match"
NO_MATCH_PATTERN = "zeta-matches-no-test"

_PAIR_TEST = f'''import {{ expect, test }} from "bun:test";

test("{ALPHA}", () => {{
  expect(1 + 1).toBe(2);
}});

test("{BETA}", () => {{
  expect(2 + 2).toBe(4);
}});
'''

# A fake `bun` recording each invocation's argv to `$FAKE_BUN_LOG` and writing
# a one-case passing JUnit report to `--reporter-outfile=`.
_FAKE_BUN_BODY = r'''
import json
import os
import sys

argv = sys.argv[1:]
log = os.environ.get("FAKE_BUN_LOG")
if log:
    with open(log, "a") as handle:
        handle.write(json.dumps(argv) + "\n")
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        outfile = arg.split("=", 1)[1]
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


def _write_project(project, board_url):
    """A package with no `crucible.testScript`: `test` takes the default
    `bun test` path. The board is named by the project's own config."""
    Path(project, "package.json").write_text(
        json.dumps({"name": "name-filter-fixture"}, indent=2))
    Path(project, "pair.test.ts").write_text(_PAIR_TEST)
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


class _RealBunCase(unittest.TestCase):
    """The scratch package, the real `bun`, and a recording board."""

    def setUp(self):
        self.real_bun = shutil.which("bun")
        self.assertIsNotNone(
            self.real_bun,
            "this proof needs the real `bun` on PATH: what is filed is what "
            "bun's own `-t` filter reported")
        self.project = new_scratch("name-filter-real-")
        self.board = RecordingBoard()
        _write_project(self.project, self.board.url)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def drive(self, *extra):
        cmd = [sys.executable, str(BUN_CLIENT), "test", "--agent", AGENT,
               "--project-dir", self.project, "--package-dir", self.project,
               "--bun", self.real_bun, "--reports", "reports", *extra]
        return subprocess.run(cmd, cwd=self.project, env=_client_env(),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def parsed_ingests(self):
        return [body for path, body in self.board.posts() if path == PARSED_INGEST]

    @staticmethod
    def diagnostics(result):
        return (f"exit={result.returncode} stdout={result.stdout!r} "
                f"stderr={result.stderr[-2500:]!r}")


class NameFilterOnTheDefaultBunTestPathTest(_RealBunCase):
    """`test --name <pattern>` on a two-test file with one match files
    1 passed and 1 pending, and the envelope names the filter."""

    def assert_one_passed_one_pending(self, result):
        ingests = self.parsed_ingests()
        self.assertEqual(
            len(ingests), 1,
            f"the filtered run must be filed exactly once; "
            f"{self.diagnostics(result)}")
        body = ingests[0]
        summary = body.get("summary") or {}
        self.assertEqual(
            (summary.get("passed"), summary.get("pending"),
             summary.get("failed"), summary.get("total")),
            (1, 1, 0, 2),
            f"only the matching test runs (1 passed); the one the filter "
            f"excluded is filed as pending; summary={summary!r}")
        self.assertEqual(
            _leaf_statuses(body.get("tree")), {ALPHA: "pass", BETA: "pending"},
            f"tree={body.get('tree')!r}")
        self.assertNotIn(
            "tier", body,
            f"a `test` run claims no tier, filtered or not; body={body!r}")

        self.assertEqual(result.returncode, 0, self.diagnostics(result))
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(envelope, self.diagnostics(result))
        envelope = envelope or {}
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
        self.assertEqual(
            envelope.get("name"), MATCHING_PATTERN,
            f"the envelope's `name` field names the filter; envelope={envelope!r}")
        run = envelope.get("run") or {}
        self.assertEqual((run.get("passed"), run.get("pending"), run.get("failed")),
                         (1, 1, 0), f"envelope run={run!r}")

    def test_a_targeted_run_filtered_by_name_files_one_passed_and_one_pending(self):
        result = self.drive("--tests", "pair.test.ts", "--name", MATCHING_PATTERN)
        self.assert_one_passed_one_pending(result)

    def test_a_whole_suite_run_filtered_by_name_files_one_passed_and_one_pending(self):
        result = self.drive("--name", MATCHING_PATTERN)
        self.assert_one_passed_one_pending(result)


class NameFilterMatchingNothingAbortsTheRunTest(_RealBunCase):
    """A filtered run in which nothing passed and nothing failed ran nothing:
    it is aborted, never filed, `ok: false`, exit 1, a warning naming the
    pattern."""

    def test_a_pattern_matching_no_test_aborts_the_run_and_names_the_pattern(self):
        result = self.drive("--tests", "pair.test.ts", "--name", NO_MATCH_PATTERN)
        diagnostics = self.diagnostics(result)

        self.assertEqual(result.returncode, 1,
                         f"a run that ran nothing exits 1; {diagnostics}")
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(envelope, f"stdout is not one TOON envelope; {diagnostics}")
        envelope = envelope or {}
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        warnings = json.dumps(envelope.get("warnings") or [])
        self.assertIn(
            NO_MATCH_PATTERN, warnings,
            f"a warning must name the pattern that matched nothing; "
            f"envelope={envelope!r}")

        self.assertEqual(
            self.parsed_ingests(), [],
            f"a run that ran nothing is never filed -- two skipped tests are "
            f"not a green run; posts={self.board.posts()!r}")
        started = [p for p, _ in self.board.posts() if p == START]
        self.assertEqual(len(started), 1,
                         f"the run is opened once; posts={self.board.posts()!r}")
        opened = self.board.run_ids_opened()
        aborts = self.board.aborts()
        self.assertEqual(
            len(aborts), 1,
            f"the opened run is aborted exactly once; aborts={aborts!r}; "
            f"posts={self.board.posts()!r}")
        self.assertIn(opened[0], aborts[0][0],
                      f"the abort closes the run this verb opened; "
                      f"opened={opened!r} aborts={aborts!r}")


class NameFilterArgvTest(unittest.TestCase):
    """The argv `test` hands `bun`, with and without `--name`."""

    def setUp(self):
        self.project = new_scratch("name-filter-argv-")
        self.board = RecordingBoard()
        _write_project(self.project, self.board.url)
        self.bun_log = os.path.join(self.project, "bun-calls.jsonl")
        self.fake_bun = os.path.join(self.project, "fake_bun.py")
        Path(self.fake_bun).write_text("#!" + sys.executable + "\n" + _FAKE_BUN_BODY)
        os.chmod(self.fake_bun,
                 os.stat(self.fake_bun).st_mode | stat.S_IXUSR | stat.S_IRUSR)
        self.timeout_ms = str(load_client("bun-crucible.py").DEFAULT_TEST_TIMEOUT_MS)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def drive(self, *extra):
        cmd = [sys.executable, str(BUN_CLIENT), "test",
               "--project-dir", self.project, "--package-dir", self.project,
               "--bun", self.fake_bun, "--reports", "reports", *extra]
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
            f"`test` must spawn bun exactly once; calls={calls!r} "
            f"exit={result.returncode} stderr={result.stderr[-2000:]!r}")
        return calls[0]

    def test_name_reaches_bun_test_unchanged_as_one_dash_t_argument(self):
        pattern = "^alpha (one|two) match$"
        result = self.drive("--tests", "pair.test.ts", "--name", pattern)
        argv = self.only_bun_call(result)
        self.assertEqual(argv[:3], ["test", "--timeout", self.timeout_ms],
                         f"the default path is still `bun test` on the default "
                         f"budget; argv={argv!r}")
        self.assertEqual(argv.count("-t"), 1, f"argv={argv!r}")
        position = argv.index("-t")
        self.assertEqual(
            argv[position + 1], pattern,
            f"the pattern is passed unchanged, as one argument; argv={argv!r}")
        self.assertIn("pair.test.ts", argv, f"argv={argv!r}")
        self.assertIn("--reporter=junit", argv, f"argv={argv!r}")
        self.assertNotIn("--", argv, f"argv={argv!r}")
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])

    def test_without_name_the_bun_test_invocation_and_report_flags_are_unchanged(self):
        # Pins today's invocation: the name filter adds nothing when absent.
        result = self.drive("--tests", "pair.test.ts")
        argv = self.only_bun_call(result)
        self.assertEqual(len(argv), 6, f"argv={argv!r}")
        self.assertEqual(
            argv[:5],
            ["test", "--timeout", self.timeout_ms, "pair.test.ts", "--reporter=junit"],
            f"argv={argv!r}")
        self.assertRegex(argv[5], r"^--reporter-outfile=.+junit\.xml$",
                         f"argv={argv!r}")
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])

    def test_the_bun_test_command_builder_still_takes_five_positional_arguments(self):
        # Pins the builder's existing callers: a positional call, no filter.
        module = load_client("bun-crucible.py")
        targeted = module._bun_test_cmd("bun", ["pair.test.ts"], "/r/junit.xml",
                                        False, None)
        self.assertEqual(
            targeted,
            ["bun", "test", "--timeout", self.timeout_ms, "pair.test.ts",
             "--reporter=junit", "--reporter-outfile=/r/junit.xml"])
        suite = module._bun_test_cmd("bun", None, "/r/junit.xml", False, None)
        self.assertEqual(
            suite,
            ["bun", "test", "--timeout", self.timeout_ms,
             "--reporter=junit", "--reporter-outfile=/r/junit.xml"])


if __name__ == "__main__":
    unittest.main()
