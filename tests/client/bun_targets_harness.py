"""The stand-in board and runner the bun client's `crucible.targets` tests drive.

Shared by the targets-table and Vitest-stream test modules (it is not itself a
test module: no `test_*.py` discovery collects it).

* `TargetsBoard` is the `ConsoleBoard` of the bun console-relay tests (itself a
  `RecordingBoard`), answering health as a board built with the run's
  framework and `codecs.stream` does: `codecs.stream` lists the record stream
  codecs (`crucible-events`), `codecs.view` the view codecs (`bun-console`),
  and `codecs.coverage` the coverage codecs. Each list can be scripted, or left
  out of the answer altogether (an older board's health). Its stream route
  holds a `crucible-events` stream and a `bun-console` view stream alike.
  With `start_route=False` it is a board with no `/api/v2/runs/start` route:
  every run start is answered 404, recorded as any other POST.
* `FAKE_TARGET_BUN` is a stand-in `bun`, a small python program. It records
  every spawn (its argv and the `CRUCIBLE_STREAM`, `CRUCIBLE_REPORTERS` and
  `FIXTURE_JUNIT_PATH` it was handed) to `FAKE_SPAWN_LOG`, prints bun's piped
  console (a banner on stderr, one `(pass)` line per case), and then writes:
  - a `crucible-events` stream (one `run-start` stating its total, one
    passing `test-end` per case, one `run-end`) to the file `CRUCIBLE_STREAM`
    names, when it is handed that variable;
  - a JUnit report to `--reporter-outfile=` or `FIXTURE_JUNIT_PATH`;
  - an lcov report under `--coverage-dir=`;
  - nothing at all, exiting 1, under `FAKE_SHAPE=no-report`;
  - for `x tsc` (the `check` verb's typecheck), one planted tsc error, exit 2.
* `TargetsCase` is a scratch package pointed at a `TargetsBoard`, run with the
  fake `bun` through the REAL `clients/bun-crucible.py` as an OS subprocess.
"""

import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

from tests.client.live_run_harness import (
    CLIENTS,
    START,
    STREAM_CODEC,
    RecordingBoard,
    install_project,
    load_toon,
    scrubbed_env,
)
from tests.client.test_a_bun_run_relays_its_console_to_the_board import ConsoleBoard

TOON = load_toon()
BUN_CLIENT = CLIENTS / "bun-crucible.py"
REPORTERS_DIR = CLIENTS / "reporters"

AGENT = "bun-targets-table-agent"
PROJECT_KEY = "bun-targets-table-key"
RUN_ID = "run-live-1"
RUN_STREAM = f"/api/v2/runs/{RUN_ID}/stream"
CLOSE = "/api/v2/runs"
COMPILE = "/api/v2/runs/compile"
PARSED = "/api/v2/runs/parsed"
HEARTBEAT = "/api/v2/agents/heartbeat"
VIEW_CODEC = "bun-console"
TABLE = "crucible.targets"
STREAM_FILE = "crucible-events.ndjson"
STREAM_VAR = "CRUCIBLE_STREAM"
REPORTERS_VAR = "CRUCIBLE_REPORTERS"
JUNIT_VAR = "FIXTURE_JUNIT_PATH"
STREAM_PATH_DECLARATION = f"env:{STREAM_VAR}"
NO_TEST_REPORTS = "no-test-reports"
INGESTING = "ingesting\u2026"

RUN_TIMEOUT = 120

# A table entry for each record shape the tests declare.
VITEST_STREAM_ENTRY = {"framework": "vitest",
                       "stream": {"codec": STREAM_CODEC, "path": STREAM_PATH_DECLARATION}}

_SCRUBBED = ("BUN_CRUCIBLE_NO_LIFECYCLE", "BUN_CRUCIBLE_PACKAGE_DIR",
             "BUN_CRUCIBLE_PROJECT_DIR", "BUN_CRUCIBLE_BUN", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY", STREAM_VAR, REPORTERS_VAR, JUNIT_VAR)

PLANTED_LCOV = "TN:\nSF:src/planted.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n"

FAKE_TARGET_BUN = r'''
import json
import os
import sys

WATCHED = ("CRUCIBLE_STREAM", "CRUCIBLE_REPORTERS", "FIXTURE_JUNIT_PATH")
argv = sys.argv[1:]
log = os.environ.get("FAKE_SPAWN_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"argv": argv,
                                 "env": {k: os.environ.get(k) for k in WATCHED}}) + "\n")

if argv[:2] == ["x", "tsc"]:
    print("src/planted.ts(1,1): error TS2322: planted type error")
    sys.exit(2)

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)

cases = int(os.environ.get("FAKE_CASES", "3"))
sys.stderr.write("bun test v1.4.2 (targets fixture)\n")
sys.stderr.flush()
print("")
print("targets.test.ts:")
for i in range(1, cases + 1):
    print("(pass) targets > case_%d [0.01ms]" % i)
print("")
print(" %d pass" % cases)
print("Ran %d tests across 1 file. [3.00ms]" % cases)
sys.stdout.flush()

if os.environ.get("FAKE_SHAPE") == "no-report":
    sys.exit(1)

stream = os.environ.get("CRUCIBLE_STREAM")
if stream:
    events = [{"event": "run-start", "total": cases}]
    events += [{"event": "test-end", "id": "targets.test.ts#case_%d" % i,
                "name": "case_%d" % i, "suite": "targets", "file": "targets.test.ts",
                "status": "pass", "duration_ms": 1} for i in range(1, cases + 1)]
    events.append({"event": "run-end", "total": cases, "passed": cases,
                   "failed": 0, "pending": 0, "duration_ms": 3})
    write(stream, "".join(json.dumps(event) + "\n" for event in events))

junit = os.environ.get("FIXTURE_JUNIT_PATH")
coverage_dir = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
    if arg.startswith("--coverage-dir="):
        coverage_dir = arg.split("=", 1)[1]
if junit:
    cases_xml = "".join('<testcase name="case_%d" classname="targets" '
                        'file="targets.test.ts" time="0.001" />' % i
                        for i in range(1, cases + 1))
    write(junit, '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>'
                 '<testsuite name="targets.test.ts" file="targets.test.ts" '
                 'tests="%d" failures="0">%s</testsuite></testsuites>\n'
                 % (cases, cases_xml))
if coverage_dir:
    write(os.path.join(coverage_dir, "lcov.info"), os.environ["FAKE_LCOV"])
sys.exit(0)
'''


class TargetsBoard(ConsoleBoard):
    """`ConsoleBoard` answering the health of a board that lists the record
    stream codecs (`codecs.stream`), the view codecs (`codecs.view`) and the
    coverage codecs (`codecs.coverage`). `None` leaves a list out of the
    answer; `start_route=False` answers every run start 404."""

    def __init__(self, stream=(STREAM_CODEC,), view=(VIEW_CODEC,), coverage=None,
                 start_route=True, **options):
        super().__init__(view=False, **options)
        self.start_route = start_route
        health = self.default_health()
        codecs = health["codecs"]
        if stream is not None:
            codecs["stream"] = list(stream)
        if view is not None:
            codecs["view"] = list(view)
        if coverage is not None:
            codecs["coverage"] = list(coverage)
        self.script_health(health)
        board = self
        server: Any = self._httpd
        base: Any = server.RequestHandlerClass

        class _Routes(base):
            def do_POST(self):
                if self.path == START and not board.start_route:
                    body = self._body()
                    with board._lock:
                        board.events.append((time.time(), "POST", self.path, body))
                    self._reply_status(404, {"ok": False,
                                             "error": f"no route: POST {START}"})
                    return
                base.do_POST(self)

        server.RequestHandlerClass = _Routes

    def _append_stream(self, run_id, body):
        codec = body.get("codec") if isinstance(body, dict) else None
        if codec == STREAM_CODEC:
            return RecordingBoard._append_stream(self, run_id, body)
        return super()._append_stream(run_id, body)


def envelope_of(stdout):
    """The one TOON envelope on stdout, or None when stdout is not one."""
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


class Drive:
    """One client run: its exit, its output and its decoded envelope."""

    def __init__(self, returncode, stdout, stderr):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.envelope = envelope_of(stdout)

    def diag(self):
        return (f"exit={self.returncode} stdout={self.stdout!r} "
                f"stderr={self.stderr[-3000:]!r}")


def client_env(**extra):
    """The environment a client run is spawned with: the suite's own shell
    variables that would decide what the client resolves, and every stream,
    reporter and report variable, removed."""
    env = scrubbed_env(None, **extra)
    for key in _SCRUBBED:
        env.pop(key, None)
    return env


class TargetsCase(unittest.TestCase):
    """A scratch package pointed at a `TargetsBoard`, the fake `bun`, and an
    explicit reports dir outside the package."""

    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="bun-targets-table-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.project = self.scratch / "package"
        self.project.mkdir()
        self.reports = self.scratch / "reports"
        self.spawn_log = self.scratch / "spawns.jsonl"
        self.fake = self.project / "fake_bun.py"
        self.fake.write_text(f"#!{sys.executable}\n" + FAKE_TARGET_BUN, encoding="utf-8")
        self.fake.chmod(0o755)
        self.board = TargetsBoard()
        self.addCleanup(self.board.close)
        install_project(str(self.project), self.board.url, PROJECT_KEY)
        (self.project / "targets.test.ts").write_text(
            "".join(f'test("case_{i}", () => {{}});\n' for i in range(1, 4)),
            encoding="utf-8")

    # ── fixture ────────────────────────────────────────────────────────────

    def declare(self, scripts, crucible=None):
        manifest = {"name": "bun-targets-table-fixture", "scripts": scripts}
        if crucible is not None:
            manifest["crucible"] = crucible
        (self.project / "package.json").write_text(json.dumps(manifest), encoding="utf-8")

    def declare_unit_target(self, entry, **crucible):
        """`test:unit` in the script table and `entry` as its table entry."""
        self.declare({"test:unit": "bun test"},
                     {"targets": {"test:unit": entry}, **crucible})

    def use_board(self, board):
        self.board = board
        self.addCleanup(board.close)
        install_project(str(self.project), board.url, PROJECT_KEY)

    # ── drive ──────────────────────────────────────────────────────────────

    def drive(self, verb, *flags, agent=True, reports=True, **fake):
        cmd = [sys.executable, str(BUN_CLIENT), verb, *flags,
               "--bun", str(self.fake), "--project-dir", str(self.project),
               "--package-dir", str(self.project)]
        if reports:
            cmd += ["--reports", str(self.reports)]
        if agent:
            cmd += ["--agent", AGENT]
        env = client_env(FAKE_SPAWN_LOG=self.spawn_log, FAKE_LCOV=PLANTED_LCOV, **fake)
        result = subprocess.run(cmd, cwd=str(self.project), env=env, capture_output=True,
                                text=True, timeout=RUN_TIMEOUT, check=False)
        return Drive(result.returncode, result.stdout, result.stderr)

    # ── reading the board and the runner ───────────────────────────────────

    def spawns(self):
        """Every spawn of the fake `bun`, in order: `{argv, env}`."""
        try:
            text = self.spawn_log.read_text(encoding="utf-8")
        except OSError:
            return []
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def only(self, path, drive):
        bodies = self.posts_to(path)
        self.assertEqual(len(bodies), 1,
                         f"exactly one POST {path}; posts={self.board.posts()!r}; "
                         f"{drive.diag()}")
        return bodies[0] if bodies and isinstance(bodies[0], dict) else {}

    def view_batches(self):
        return [b for _p, b in self.board.stream_posts()
                if isinstance(b, dict) and b.get("codec") == VIEW_CODEC]

    def envelope(self, drive):
        self.assertIsNotNone(drive.envelope,
                             f"stdout is one TOON envelope; {drive.diag()}")
        return drive.envelope or {}

    def assert_refused_before_anything_is_posted(self, drive, script, *also_named):
        """The refusal of a table entry: a non-zero exit, nothing posted to the
        board, the runner never spawned, and ONE `ok: false` envelope naming
        the script's key, `crucible.targets` and whatever else is given."""
        self.assertNotEqual(drive.returncode, 0, f"a refusal exits non-zero; {drive.diag()}")
        self.assertEqual(self.board.posts(), [],
                         f"a refusal comes before anything is posted; {drive.diag()}")
        self.assertEqual(self.spawns(), [],
                         f"a refused run never spawns its runner; {drive.diag()}")
        envelope = self.envelope(drive)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        said = json.dumps(envelope)
        for name in (TABLE, script, *also_named):
            self.assertIn(name, said,
                          f"the refusal names {name!r}; envelope={envelope!r}")
