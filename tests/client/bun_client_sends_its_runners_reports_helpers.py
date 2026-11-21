"""The helpers of `test_bun_client_sends_its_runners_reports.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
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

PROJECT_KEY = "bun-sends-its-reports-key"

RUNS = "/api/v2/runs"

PARSED = "/api/v2/runs/parsed"

HEALTH = "/api/health"

# The report texts the fake `bun` writes, byte for byte: what the ingest's
# `data` and `coverage.data` must carry.
JUNIT_TEXT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuites name="bun test" tests="1" failures="0">\n'
    '  <testsuite name="math.test.ts" file="math.test.ts" tests="1" failures="0">\n'
    '    <testcase name="adds two numbers" classname="math" time="0.001" '
    'file="math.test.ts" />\n'
    '  </testsuite>\n'
    '</testsuites>\n')

# What `bun test -t <no match>` writes: every test the filter excluded, as a
# skipped case.
SKIPPED_JUNIT_TEXT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuites name="bun test" tests="2" failures="0" skipped="2">\n'
    '  <testsuite name="math.test.ts" file="math.test.ts" tests="2" '
    'failures="0" skipped="2">\n'
    '    <testcase name="adds two numbers" classname="math" time="0" '
    'file="math.test.ts"><skipped /></testcase>\n'
    '    <testcase name="subtracts two numbers" classname="math" time="0" '
    'file="math.test.ts"><skipped /></testcase>\n'
    '  </testsuite>\n'
    '</testsuites>\n')

EMPTY_JUNIT_TEXT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuites name="bun test" tests="0" failures="0"></testsuites>\n')

# Ten lines and two functions, all covered: summed by a client, 100%.
LCOV_TEXT = ("TN:\nSF:src/math.ts\nFN:1,add\nFN:5,sub\nFNDA:1,add\nFNDA:1,sub\n"
             "FNF:2\nFNH:2\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nDA:5,1\nDA:6,1\n"
             "DA:7,1\nDA:8,1\nDA:9,1\nDA:10,1\nLF:10\nLH:10\nend_of_record\n")

# The line the fake prints on stdout: the captured output `raw` carries.
OUTPUT_MARKER = "fake-bun-output-line-7c1e"

JUNIT_VAR = "FAKE_RUNNER_JUNIT_PATH"

PLAIN_MANIFEST = {"name": "bun-sends-its-reports", "private": True}

_SCRUBBED = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
             "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
             "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", JUNIT_VAR)

# A fake `bun`, for `bun test ...` and `bun run <script> ...` alike. It prints
# OUTPUT_MARKER, writes JUNIT_TEXT (SKIPPED_JUNIT_TEXT under `-t`,
# EMPTY_JUNIT_TEXT under FAKE_ZERO=1, nothing under FAKE_REPORT=none, a
# directory in its place under FAKE_REPORT=dir) where
# `--reporter-outfile=` or the declared JUnit variable points, LCOV_TEXT to
# `<--coverage-dir>/lcov.info` when `--coverage` is given (unless
# FAKE_NO_LCOV=1), then exits FAKE_EXIT.
_FAKE_BUN = r'''
import os
import sys

JUNIT_VAR = ''' + repr(JUNIT_VAR) + r'''
JUNIT, SKIPPED, EMPTY, LCOV, MARKER = ''' + repr((
    JUNIT_TEXT, SKIPPED_JUNIT_TEXT, EMPTY_JUNIT_TEXT, LCOV_TEXT,
    OUTPUT_MARKER)) + r'''

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

argv = sys.argv[1:]
junit = os.environ.get(JUNIT_VAR)
coverage_dir = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
    if arg.startswith("--coverage-dir="):
        coverage_dir = arg.split("=", 1)[1]
sys.stdout.write(MARKER + "\nmath.test.ts:\n(pass) math > adds two numbers [0.02ms]\n")
sys.stdout.flush()
if os.environ.get("FAKE_REPORT") == "dir":
    if junit:
        os.makedirs(junit, exist_ok=True)
elif os.environ.get("FAKE_REPORT") != "none":
    if junit:
        if os.environ.get("FAKE_ZERO") == "1":
            write(junit, EMPTY)
        elif "-t" in argv:
            write(junit, SKIPPED)
        else:
            write(junit, JUNIT)
    if "--coverage" in argv and coverage_dir and os.environ.get("FAKE_NO_LCOV") != "1":
        write(os.path.join(coverage_dir, "lcov.info"), LCOV)
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


class _BunProject:
    """A scratch package with the fake `bun`, filing to a RecordingBoard."""

    def make(self, manifest=PLAIN_MANIFEST, board=None):
        self.project = new_scratch("bun-sends-its-reports-")
        self.board = board or RecordingBoard()
        Path(self.project, "package.json").write_text(json.dumps(manifest, indent=2))
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n")
        self.fake_bun = os.path.join(self.project, "fake_bun.py")
        Path(self.fake_bun).write_text("#!" + sys.executable + "\n" + _FAKE_BUN)
        os.chmod(self.fake_bun,
                 os.stat(self.fake_bun).st_mode | stat.S_IXUSR | stat.S_IRUSR)

    def cleanup(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def env(self, **fake_env):
        env = scrubbed_env(None, **fake_env)
        for key in _SCRUBBED:
            if key not in fake_env:
                env.pop(key, None)
        return env

    def argv(self, verb, agent, *extra):
        return [verb, "--agent", agent, "--project-dir", self.project,
                "--package-dir", self.project, "--reports", "reports",
                *(() if verb == "auto-ingest" else ("--bun", self.fake_bun)),
                *extra]

    def drive(self, verb, agent, *extra, **fake_env):
        cmd = [sys.executable, str(BUN_CLIENT), *self.argv(verb, agent, *extra)]
        return subprocess.run(cmd, cwd=self.project, env=self.env(**fake_env),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    @staticmethod
    def diagnostics(result):
        return (f"exit={result.returncode} stdout={result.stdout!r} "
                f"stderr={result.stderr[-2500:]!r}")

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def envelope_of(self, result):
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(  # type: ignore[attr-defined]
            envelope, f"stdout is not one TOON envelope; {self.diagnostics(result)}")
        return envelope or {}

    def the_one_runs_ingest(self, result):
        """The run's one `POST /api/v2/runs`, after asserting that nothing went
        to the parsed route."""
        self.assertEqual(  # type: ignore[attr-defined]
            self.posts_to(PARSED), [],
            f"the bun client never posts to {PARSED}; posts="
            f"{[p for p, _ in self.board.posts()]!r} {self.diagnostics(result)}")
        ingests = self.posts_to(RUNS)
        self.assertEqual(  # type: ignore[attr-defined]
            len(ingests), 1,
            f"the run is filed as exactly one POST {RUNS}; posts="
            f"{[p for p, _ in self.board.posts()]!r} {self.diagnostics(result)}")
        body = ingests[0] if ingests else {}
        self.assertNotIn("dataPath", body,  # type: ignore[attr-defined]
                         f"reports travel inline, never as a path; body={body!r}")
        self.assertEqual(body.get("stack"), "bun",  # type: ignore[attr-defined]
                         f"body={body!r}")
        return body

    def assert_health_read_before_the_ingest(self, result):
        events = [(m, p) for _t, m, p, _b in self.board.events]
        health = [i for i, (m, p) in enumerate(events)
                  if m == "GET" and p in (HEALTH, "/api/v2/health")]
        ingest = [i for i, (m, p) in enumerate(events) if m == "POST" and p == RUNS]
        self.assertTrue(  # type: ignore[attr-defined]
            health and ingest and health[0] < ingest[0],
            f"the board's health is read before the ingest is sent; "
            f"events={events!r} {self.diagnostics(result)}")
