"""A declared maven run relays its console to the open run, and keeps its
record.

A project that declares a maven run's console —

    [targets.<tier>]
    framework = "surefire"
    console = "surefire-console"

— on a board whose health lists `surefire-console` under `codecs.view` gets,
for a run with `--agent`:

  - the relay: maven's combined stdout and stderr are written, as read, to
    `<reports dir>/surefire-console.log`, and the shared `StreamRelay` sends
    that file to the open run's stream route under codec `surefire-console`
    while maven runs, in each of the four run bodies: the surefire tier
    (`unit`, `module`, `bdd` through its declared-profile cell), the failsafe
    tier (`integration`, `e2e`), `regression` (and `pre-merge-gate`'s
    regression) and `test`;
  - the console still reaches the terminal, and the capture, `--log` and the
    close's `raw` are byte-identical to an unrelayed run's;
  - finish before close: on every exit path (the JUnit close, the compile
    fallback, ran-nothing, a signal, an exception) every relayed batch lands
    before the run is closed or aborted; on an exception the relay finishes
    with 0 s and the exception is re-raised;
  - the heartbeat steps back: no in-run `running N/M classes` tick while the
    relay lands; the ticks come back when the board stops holding batches;
    the closing `ran N/M classes` and `ingesting…` are always posted;
  - the record: the close is today's JUnit close, the same bytes, plus the
    run's framework `surefire`.

An undeclared run is today's run: no relay, today's heartbeat, today's posts.

Each drive runs the real client as a subprocess against `ViewBoard`, a
`RecordingBoard` that holds a `surefire-console` stream as it holds any
stream, with a fake `mvnw` that prints surefire's lines (and can park until
the test releases it) and a fake `docker` on PATH. The exception path is
driven in-process, with the shared `run_streamed` replaced by one that raises
once a batch has landed.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_declared_maven_run_relays_its_surefire_console
"""

import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from tests.client.live_run_harness import (
    CLIENTS,
    STREAM_CODEC,
    RecordingBoard,
    load_client,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
MVN_CLIENT = CLIENTS / "mvn-crucible.py"
PROJECT_KEY = "mvn-console-relay-key"
AGENT = "mvn-console-relay"
VIEW_CODEC = "surefire-console"
CONSOLE_FILE = "surefire-console.log"
FRAMEWORK = "surefire"
START = "/api/v2/runs/start"
RUNS = "/api/v2/runs"
COMPILE = "/api/v2/runs/compile"
HEARTBEAT = "/api/v2/agents/heartbeat"
STREAM_ROUTE = re.compile(r"^/api/v2/runs/([^/]+)/stream$")
ABORT_ROUTE = re.compile(r"^/api/v2/runs/([^/]+)/abort$")
COMPOSE = ("--compose-file", "compose.yaml")
#: The tier a verb's run start states, where it is not the verb's own name.
START_TIER = {"test": None, "pre-merge-gate": "regression"}
INGESTING = "ingesting\u2026"

ENTRY = f'framework = "{FRAMEWORK}"\nconsole = "{VIEW_CODEC}"\n'

#: Every run body's verbs: (label, verb, extra argv, the key it reads).
VERBS = (
    ("test", "test", (), "unit"),
    ("unit", "unit", (), "unit"),
    ("module", "module", (), "module"),
    ("bdd", "bdd", (), "bdd"),
    ("integration", "integration", (), "integration"),
    ("e2e", "e2e", (), "e2e"),
    ("regression", "regression", (), "regression"),
    ("pre-merge-gate", "pre-merge-gate", COMPOSE, "regression"),
)

MARKER = "MVN_CONSOLE_RELAY_PARKED"
BANNER = "WARNING: the fake mvnw speaks on stderr too"
TIMEOUT = 120
MARKER_WAIT = 30
# The relay sends every 2 s: a live relay's first batch lands well inside this.
RELAY_WAIT = 10

_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_COVERAGE_PROFILE",
             "MVN_CRUCIBLE_PROJECT_DIR", "MVN_CRUCIBLE_MAVEN_DIR", "MVN_CRUCIBLE_COMPOSE_FILE")

# A fake `mvnw`. It appends its argv to FAKE_MVN_LOG and prints BANNER on
# stderr. A `test-compile` build with no test goal prints one javac error and
# exits 1 (the compile fallback's build). Otherwise it prints surefire's lines
# for FAKE_CLASSES classes (`com.acme.C01Test`, ...), parking after the first
# FAKE_PARK_AFTER of them (FAKE_MARKER_LINE, then a wait for FAKE_RELEASE_FILE)
# when a release file is named; FAKE_FAIL_LAST=1 makes the last class fail.
# FAKE_SHAPE picks the reports: `junit` (one report per class into the
# directory the client named, plus one failsafe report when the goals reach
# failsafe; exit 1 when a class failed), `no-report` (none, exit 1) or
# `zero-report` (one report holding no test case, exit 1). It writes a JaCoCo
# CSV either way.
_FAKE_MVNW = r'''
import json
import os
import sys
import time

args = sys.argv[1:]
with open(os.environ["FAKE_MVN_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")

def say(text, stream=sys.stdout):
    stream.write(text + "\n")
    stream.flush()

def write(path, text):
    if os.path.dirname(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

say(os.environ.get("FAKE_BANNER", "fake mvnw"), sys.stderr)
if "test-compile" in args and "test" not in args:
    say("[ERROR] /src/test/java/com/acme/C01Test.java:[3,5] cannot find symbol")
    say("[INFO] BUILD FAILURE")
    sys.exit(1)

dirs = {}
for arg in args:
    for plugin in ("surefire", "failsafe"):
        flag = "-D%s.reportsDirectory=" % plugin
        if arg.startswith(flag):
            dirs[plugin] = arg[len(flag):]
shape = os.environ.get("FAKE_SHAPE", "junit")
classes = int(os.environ.get("FAKE_CLASSES", "2"))
park_after = int(os.environ.get("FAKE_PARK_AFTER", "1"))
fail_last = os.environ.get("FAKE_FAIL_LAST") == "1"
release = os.environ.get("FAKE_RELEASE_FILE")
marker = os.environ.get("FAKE_MARKER_LINE")

def park():
    if marker:
        say(marker)
    deadline = time.time() + 30
    while not os.path.exists(release) and time.time() < deadline:
        time.sleep(0.02)

reports = []
failed_any = False
for i in range(1, classes + 1):
    name = "com.acme.C%02dTest" % i
    failed = fail_last and i == classes
    failed_any = failed_any or failed
    say("[INFO] Running %s" % name)
    if failed:
        say("[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.01 s "
            "<<< FAILURE! -- in %s" % name)
        say("[ERROR] %s.breaks -- Time elapsed: 0.005 s <<< FAILURE!" % name)
        say("org.opentest4j.AssertionFailedError: planted failure")
        cases = ('<testcase name="holds" classname="%s" time="0.005"/>'
                 '<testcase name="breaks" classname="%s" time="0.005">'
                 '<failure message="planted failure" type="AssertionFailedError"/>'
                 '</testcase>' % (name, name))
        reports.append((name, 2, 1, cases))
    else:
        say("[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.01 s "
            "-- in %s" % name)
        cases = ('<testcase name="holds" classname="%s" time="0.005"/>'
                 '<testcase name="works" classname="%s" time="0.005"/>' % (name, name))
        reports.append((name, 2, 0, cases))
    if release and i == park_after:
        park()

surefire_dir = dirs.get("surefire") or os.path.join("target", "surefire-reports")
if shape == "junit":
    for name, tests, failures, cases in reports:
        write(os.path.join(surefire_dir, "TEST-%s.xml" % name),
              '<?xml version="1.0" encoding="UTF-8"?>\n'
              '<testsuite name="%s" tests="%d" failures="%d" errors="0" skipped="0">%s'
              '</testsuite>\n' % (name, tests, failures, cases))
    if any(goal in args for goal in ("integration-test", "verify", "failsafe:integration-test")):
        name = "com.acme.WidgetIT"
        say("[INFO] Running %s" % name)
        say("[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.01 s "
            "-- in %s" % name)
        directory = dirs.get("failsafe") or os.path.join("target", "failsafe-reports")
        write(os.path.join(directory, "TEST-%s.xml" % name),
              '<?xml version="1.0" encoding="UTF-8"?>\n'
              '<testsuite name="%s" tests="1" failures="0" errors="0" skipped="0">'
              '<testcase name="works" classname="%s" time="0.01"/></testsuite>\n'
              % (name, name))
elif shape == "zero-report":
    write(os.path.join(surefire_dir, "TEST-com.acme.Empty.xml"),
          '<?xml version="1.0" encoding="UTF-8"?>\n'
          '<testsuite name="com.acme.Empty" tests="0" failures="0" errors="0" skipped="0">'
          '</testsuite>\n')
write(os.path.join("target", "jacoco-report", "jacoco.csv"),
      "GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED,BRANCH_MISSED,"
      "BRANCH_COVERED,LINE_MISSED,LINE_COVERED,COMPLEXITY_MISSED,COMPLEXITY_COVERED,"
      "METHOD_MISSED,METHOD_COVERED\nalpha,com.acme,Alpha,1,9,0,0,1,9,0,1,0,1\n")
if shape != "junit":
    say("[INFO] BUILD FAILURE")
    sys.exit(1)
say("[INFO] BUILD %s" % ("FAILURE" if failed_any else "SUCCESS"))
sys.exit(1 if failed_any else 0)
'''

# A fake `docker`: it appends its argv to FAKE_DOCKER_LOG and exits 0.
_FAKE_DOCKER = r'''
import json
import os
import sys

with open(os.environ["FAKE_DOCKER_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")
sys.exit(0)
'''

# A POM declaring the `bdd` profile, so `bdd` reaches its declared-profile cell.
_POM = ('<?xml version="1.0" encoding="UTF-8"?>\n'
        '<project xmlns="http://maven.apache.org/POM/4.0.0">\n'
        '  <modelVersion>4.0.0</modelVersion>\n'
        '  <profiles><profile><id>bdd</id></profile></profiles>\n'
        '</project>\n')


def _write_script(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _read(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _wait_until(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class ViewBoard(RecordingBoard):
    """`RecordingBoard` as a board that reads the `surefire-console` view.

    - `view`: health lists `bun-console` and `surefire-console` under
      `codecs.view` (None: health as `RecordingBoard` answers it, no view).
    - A `surefire-console` batch is held exactly as the stand-in holds a
      stream (offsets, overlap, gap, `stream_limit`); any other codec on the
      stream route is a 400.
    - `refuse_stream`: every batch is answered with that `(status, error)`
      instead, with the board's `held` (0) beside it."""

    def __init__(self, view=("bun-console", VIEW_CODEC), refuse_stream=None, **options):
        super().__init__(**options)
        self.refuse_stream = refuse_stream
        if view is not None:
            health = self.default_health()
            health["codecs"]["view"] = list(view)
            self.script_health(health)

    def _append_stream(self, run_id, body):
        if self.refuse_stream is not None:
            status, error = self.refuse_stream
            return status, {"ok": False, "error": error, "held": 0}
        body = dict(body) if isinstance(body, dict) else {}
        if body.get("codec") != VIEW_CODEC:
            return 400, {"ok": False, "error": "not a codec this board holds — nothing stored"}
        body["codec"] = STREAM_CODEC
        return super()._append_stream(run_id, body)


class Drive:
    """One client run: its exit, its output, and whether the runner was let
    go on its cue (what the test waited for reached the board while maven was
    still parked)."""

    def __init__(self, returncode, stdout, stderr, cued):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.cued = cued

    def diag(self):
        return (f"exit={self.returncode} stdout={self.stdout[-700:]!r} "
                f"stderr={self.stderr[-1500:]!r}")


def _a_batch_landed(board):
    return any(isinstance(b, dict) and b.get("data") for _p, b in board.stream_posts())


def _a_stream_post_was_answered(board):
    return bool(board.stream_posts())


class _MavenProject(unittest.TestCase):
    """A scratch maven project with the fake `mvnw`, a compose file and the
    fake `docker` on PATH, filing to a `ViewBoard`."""

    maxDiff = 6000

    def setUp(self):
        self.project = new_scratch("mvn-console-relay-")
        self.bin_dir = new_scratch("mvn-console-relay-bin-")
        self.logs = new_scratch("mvn-console-relay-logs-")
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        Path(self.project, "compose.yaml").write_text("services: {}\n")
        _write_script(os.path.join(self.project, "mvnw"), _FAKE_MVNW)
        _write_script(os.path.join(self.bin_dir, "docker"), _FAKE_DOCKER)
        self.board = ViewBoard()
        self.entries = {}
        self.client = str(MVN_CLIENT)
        self._drives = 0
        self.rewrite_toml()

    def tearDown(self):
        self.board.close()
        for path in (self.project, self.bin_dir, self.logs):
            shutil.rmtree(path, ignore_errors=True)

    # ── the project ─────────────────────────────────────────────────────────

    def use_board(self, board):
        self.board.close()
        self.board = board
        self.rewrite_toml()
        Path(self.logs, "mvn.jsonl").unlink(missing_ok=True)
        return board

    def declare(self, entries):
        self.entries = dict(entries)
        self.rewrite_toml()

    def rewrite_toml(self):
        tables = "".join(f"\n[targets.{key}]\n{body}" for key, body in self.entries.items())
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n{tables}")

    def reports_dir(self):
        return os.path.join(self.project, "test-reports", AGENT)

    def console_path(self):
        return os.path.join(self.reports_dir(), CONSOLE_FILE)

    # ── driving ─────────────────────────────────────────────────────────────

    def command(self, verb, *extra, agent=True):
        argv = [sys.executable, self.client, verb]
        if agent:
            argv += ["--agent", AGENT]
        return argv + ["--project-dir", self.project, *extra]

    def environment(self, **fake):
        env = scrubbed_env(self.bin_dir, FAKE_MVN_LOG=os.path.join(self.logs, "mvn.jsonl"),
                           FAKE_DOCKER_LOG=os.path.join(self.logs, "docker.jsonl"),
                           FAKE_BANNER=BANNER, **fake)
        for key in _SCRUBBED:
            env.pop(key, None)
        return env

    def drive(self, verb, *extra, agent=True, release_when=None, interrupt=False, **fake):
        """Run the client. With `release_when`, maven parks after its first
        FAKE_PARK_AFTER classes until `release_when(board)` holds (or
        RELAY_WAIT passes), then is released — or, with `interrupt`, the
        client is sent SIGINT instead."""
        self._drives += 1
        pom = Path(self.project, "pom.xml")
        if verb == "bdd":
            pom.write_text(_POM)
        else:
            pom.unlink(missing_ok=True)
        cmd = self.command(verb, *extra, agent=agent)
        if release_when is None:
            result = subprocess.run(cmd, cwd=self.project, env=self.environment(**fake),
                                    capture_output=True, text=True, timeout=TIMEOUT,
                                    check=False)
            return Drive(result.returncode, result.stdout, result.stderr, None)
        release = os.path.join(self.logs, f"release-{self._drives}")
        stderr_path = os.path.join(self.logs, f"client-stderr-{self._drives}.txt")
        env = self.environment(FAKE_RELEASE_FILE=release, FAKE_MARKER_LINE=MARKER, **fake)
        cued = False
        with open(stderr_path, "w", encoding="utf-8") as err:
            proc = subprocess.Popen(cmd, cwd=self.project, env=env,
                                    stdout=subprocess.PIPE, stderr=err, text=True)
            try:
                if _wait_until(lambda: MARKER in _read(stderr_path), MARKER_WAIT):
                    cued = _wait_until(lambda: release_when(self.board), RELAY_WAIT)
                    if interrupt:
                        proc.send_signal(signal.SIGINT)
                    else:
                        Path(release).write_text("go")
                stdout, _ = proc.communicate(timeout=TIMEOUT)
            finally:
                Path(release).write_text("go")
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        return Drive(proc.returncode, stdout, _read(stderr_path), cued)

    # ── reading the board ───────────────────────────────────────────────────

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def starts(self):
        return self.posts_to(START)

    def run_of(self, verb):
        """The run id the board opened for `verb`'s run: the one start of the
        tier the verb states (`test` states none; `pre-merge-gate`'s run is
        its regression)."""
        tier = START_TIER.get(verb, verb)
        tiers = [(b or {}).get("tier") for b in self.starts()]
        self.assertEqual(tiers.count(tier), 1,
                         f"one run of tier {tier} was opened for {verb}; starts={tiers!r}")
        return self.board.run_ids_opened()[tiers.index(tier)]

    def close_of(self, run_id):
        closes = [b for b in self.posts_to(RUNS) if (b or {}).get("runId") == run_id]
        self.assertEqual(len(closes), 1, f"the run {run_id} is closed once from its JUnit; "
                                         f"paths={self.paths()!r}")
        return closes[0]

    def paths(self):
        return [p for p, _b in self.board.posts()]

    def heartbeats(self):
        return [(b or {}).get("message") for b in self.posts_to(HEARTBEAT)]

    def ticks(self):
        return [m for m in self.heartbeats() if isinstance(m, str) and m.startswith("running ")]

    def index_of(self, predicate):
        for i, (path, body) in enumerate(self.board.posts()):
            if predicate(path, body):
                return i
        return -1

    def stream_indexes(self, run_id):
        return [i for i, (p, _b) in enumerate(self.board.posts())
                if (m := STREAM_ROUTE.match(p)) and m.group(1) == run_id]

    def posted_to_the_run_after(self, index, run_id):
        return [(p, b) for p, b in self.board.posts()[index + 1:]
                if p.startswith(f"/api/v2/runs/{run_id}/")
                or (isinstance(b, dict) and b.get("runId") == run_id)]

    # ── assertions ──────────────────────────────────────────────────────────

    def assert_relayed_live(self, drive, where):
        self.assertTrue(drive.cued,
                        f"{where}: a `{VIEW_CODEC}` batch reached the run's stream while maven "
                        f"was still running; stream posts={len(self.board.stream_posts())} "
                        f"{drive.diag()}")

    def assert_relayed_to(self, run_id, where):
        streams = self.board.stream_posts()
        self.assertGreaterEqual(len(streams), 1, f"{where}: the console was relayed")
        self.assertEqual({p for p, _b in streams}, {f"/api/v2/runs/{run_id}/stream"},
                         f"{where}: every batch goes to the open run's stream route")
        self.assertEqual({(b or {}).get("codec") for _p, b in streams}, {VIEW_CODEC},
                         f"{where}: every batch is sent under the view codec")
        self.assertEqual({((b or {}).get("projectKey"), (b or {}).get("agentId"))
                          for _p, b in streams}, {(PROJECT_KEY, AGENT)}, where)

    def assert_relay_ended_before(self, close_index, run_id, where):
        self.assertGreaterEqual(close_index, 0, f"{where}: the run was closed or aborted; "
                                                f"paths={self.paths()!r}")
        batches = self.stream_indexes(run_id)
        self.assertTrue(batches, f"{where}: the relay sent nothing")
        self.assertLess(max(batches), close_index,
                        f"{where}: every batch lands before the run's close; "
                        f"paths={self.paths()!r}")
        self.assertEqual(self.posted_to_the_run_after(close_index, run_id), [],
                         f"{where}: nothing is posted to the run after its close")

    def assert_framework_surefire(self, run_id, where):
        """The run states framework `surefire`, on its start or its close,
        and no other framework anywhere."""
        tiers_runs = dict(zip(self.board.run_ids_opened(), self.starts(), strict=False))
        start = tiers_runs.get(run_id) or {}
        stated = [start.get("framework")] + [c.get("framework") for c in self.posts_to(RUNS)
                                             if (c or {}).get("runId") == run_id]
        self.assertIn(FRAMEWORK, stated, f"{where}: the run states framework surefire")
        self.assertEqual({s for s in stated if s is not None}, {FRAMEWORK}, where)


# ── the relay, in each of the four run bodies ──────────────────────────────

class EachRunBodyRelaysItsDeclaredConsoleTest(_MavenProject):

    def test_every_verb_relays_its_console_under_surefire_console_while_maven_runs(self):
        for label, verb, extra, key in VERBS:
            with self.subTest(verb=label):
                self.use_board(ViewBoard())
                self.declare({key: ENTRY})
                drive = self.drive(verb, *extra, release_when=_a_batch_landed)
                self.assert_relayed_live(drive, label)
                run_id = self.run_of(verb)
                self.assert_relayed_to(run_id, label)
                close = self.close_of(run_id)
                self.assertEqual(self.board.held_stream(run_id), close.get("raw"),
                                 f"{label}: the board holds the whole console, as captured")
                self.assertIn(BANNER, self.board.held_stream(run_id),
                              f"{label}: maven's stderr is part of the console relayed")
                self.assertEqual(_read(self.console_path()), close.get("raw"),
                                 f"{label}: the console is teed to <reports dir>/{CONSOLE_FILE}")
                self.assertEqual(drive.returncode, 0, f"{label}: {drive.diag()}")

    def test_mavens_console_still_reaches_the_terminal_unchanged(self):
        self.declare({"unit": ENTRY})
        drive = self.drive("test", release_when=_a_batch_landed)
        self.assert_relayed_live(drive, "test")
        close = self.close_of(self.run_of("test"))
        self.assertIn(close.get("raw"), drive.stderr,
                      "every line maven printed reaches the client's stderr, in order")


# ── the record and the bytes are unchanged ──────────────────────────────────

class TheRecordIsTodaysJUnitPlusTheFrameworkTest(_MavenProject):

    _CLOSE_KEYS = ("codec", "data", "raw", "runnerExit", "tier", "stack", "coverage",
                   "coverageCodec", "runId", "context")

    def observe(self, declared, log_name, verb="test", key="unit", **fake):
        self.use_board(ViewBoard())
        self.declare({key: ENTRY} if declared else {})
        log = os.path.join(self.logs, log_name)
        drive = self.drive(verb, "--log", log, **fake)
        run_id = self.run_of(verb)
        close = self.close_of(run_id)
        return drive, run_id, close, _read(log)

    def test_a_declared_runs_close_is_the_undeclared_close_plus_framework_surefire(self):
        for label, fake in (("a green run", {}), ("a red run", {"FAKE_FAIL_LAST": "1"})):
            with self.subTest(run=label):
                today, _rid, plain, plain_log = self.observe(False, "plain.log", **fake)
                self.assertNotIn("framework", plain, "today's close states no framework")
                drive, run_id, close, log = self.observe(True, "declared.log", **fake)
                self.assertGreaterEqual(len(self.board.stream_posts()), 1,
                                        f"{label}: the declared run relayed; {drive.diag()}")
                self.assertEqual({k: close.get(k) for k in self._CLOSE_KEYS},
                                 {k: plain.get(k) for k in self._CLOSE_KEYS},
                                 f"{label}: the record is the same JUnit close")
                self.assert_framework_surefire(run_id, label)
                self.assertEqual(log, plain_log, f"{label}: --log is byte-identical")
                self.assertEqual(close.get("raw"), plain.get("raw"),
                                 f"{label}: raw is byte-identical")
                self.assertEqual(drive.returncode, today.returncode, label)

    def test_a_declared_failsafe_and_regression_run_states_framework_surefire(self):
        for verb, key in (("integration", "integration"), ("regression", "regression")):
            with self.subTest(verb=verb):
                _drive, run_id, close, _log = self.observe(True, f"{verb}.log", verb, key)
                self.assertEqual(close.get("codec"), "junit")
                self.assert_framework_surefire(run_id, verb)


# ── finish before close, on every exit path ─────────────────────────────────

class EveryExitFinishesTheRelayBeforeTheCloseTest(_MavenProject):

    def setUp(self):
        super().setUp()
        self.declare({"unit": ENTRY})

    def test_a_green_runs_junit_close_comes_after_every_batch_landed(self):
        drive = self.drive("test", release_when=_a_batch_landed, FAKE_CLASSES="3")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_relayed_live(drive, "green")
        run_id = self.run_of("test")
        close = self.index_of(lambda p, b: p == RUNS and (b or {}).get("runId") == run_id)
        self.assert_relay_ended_before(close, run_id, "green")
        self.assertEqual(self.board.held_stream(run_id), self.close_of(run_id).get("raw"))

    def test_a_red_runs_junit_close_comes_after_every_batch_landed(self):
        drive = self.drive("test", release_when=_a_batch_landed, FAKE_CLASSES="3",
                           FAKE_FAIL_LAST="1")
        self.assertEqual(drive.returncode, 1, drive.diag())
        self.assert_relayed_live(drive, "red")
        run_id = self.run_of("test")
        close = self.index_of(lambda p, b: p == RUNS and (b or {}).get("runId") == run_id)
        self.assert_relay_ended_before(close, run_id, "red")
        self.assertIn("<<< FAILURE!", self.board.held_stream(run_id))

    def test_the_compile_fallbacks_close_comes_after_every_batch_landed(self):
        drive = self.drive("test", release_when=_a_batch_landed, FAKE_SHAPE="no-report")
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        self.assert_relayed_live(drive, "compile fallback")
        run_id = self.run_of("test")
        close = self.index_of(lambda p, b: p == COMPILE and (b or {}).get("runId") == run_id)
        self.assert_relay_ended_before(close, run_id, "compile fallback")

    def test_a_run_that_ran_nothing_is_aborted_after_every_batch_landed(self):
        drive = self.drive("test", release_when=_a_batch_landed, FAKE_SHAPE="zero-report")
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        self.assert_relayed_live(drive, "ran nothing")
        run_id = self.run_of("test")
        abort = self.index_of(lambda p, _b: (m := ABORT_ROUTE.match(p)) is not None
                              and m.group(1) == run_id)
        self.assert_relay_ended_before(abort, run_id, "ran nothing")

    def test_a_signalled_run_is_aborted_after_every_batch_landed(self):
        drive = self.drive("test", release_when=_a_batch_landed, interrupt=True)
        self.assertEqual(drive.returncode, 128 + signal.SIGINT, drive.diag())
        self.assert_relayed_live(drive, "signalled")
        run_id = self.run_of("test")
        abort = self.index_of(lambda p, _b: (m := ABORT_ROUTE.match(p)) is not None
                              and m.group(1) == run_id)
        self.assert_relay_ended_before(abort, run_id, "signalled")


class AnExceptionFromTheRunFinishesTheRelayAndIsReRaisedTest(unittest.TestCase):
    """Driven in-process: the shared `run_streamed` is replaced by one that
    feeds maven's lines to the observer it is handed, waits for a batch to
    land, then raises."""

    def setUp(self):
        self.project = new_scratch("mvn-console-relay-raise-")
        self.addCleanup(shutil.rmtree, self.project, ignore_errors=True)
        self.board = ViewBoard()
        self.addCleanup(self.board.close)
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n\n[targets.unit]\n{ENTRY}")
        _write_script(os.path.join(self.project, "mvnw"), "import sys\nsys.exit(0)\n")
        self.mvn = load_client("mvn-crucible.py")
        self.core = self.mvn._axi()

    def _raising_run(self, cmd, cwd, env, log_path, narrator=None, *args, **kwargs):
        for line in ("[INFO] Running com.acme.C01Test\n",
                     ("[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, "
                      "Time elapsed: 0.01 s -- in com.acme.C01Test\n")):
            if narrator is not None:
                narrator.observe(line)
        _wait_until(lambda: _a_batch_landed(self.board), RELAY_WAIT)
        raise RuntimeError("planted run failure")

    def test_the_relay_finishes_with_zero_seconds_and_the_exception_propagates(self):
        deadlines = []
        real_finish = self.core.StreamRelay.finish

        def recording_finish(relay, deadline_seconds):
            deadlines.append(deadline_seconds)
            return real_finish(relay, deadline_seconds)

        env = {k: v for k, v in os.environ.items() if k not in _SCRUBBED}
        argv = ["mvn-crucible.py", "test", "--agent", AGENT, "--project-dir", self.project]
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(sys, "argv", argv), \
                mock.patch.object(self.core, "run_streamed", self._raising_run), \
                mock.patch.object(self.core.StreamRelay, "finish", recording_finish), \
                mock.patch("sys.stdout"), mock.patch("sys.stderr"), \
                self.assertRaises(RuntimeError) as raised:
            self.mvn.main()
        self.assertEqual(str(raised.exception), "planted run failure",
                         "the run's own exception is re-raised")
        self.assertTrue(_a_batch_landed(self.board),
                        f"the console was relayed before the run raised; "
                        f"paths={[p for p, _b in self.board.posts()]!r}")
        self.assertEqual(deadlines, [0], "the relay is finished once, with 0 s")
        relays = [t for t in threading.enumerate()
                  if t.name.startswith("crucible-stream-relay-")]
        for thread in relays:
            thread.join(15)
        self.assertEqual([t.name for t in relays if t.is_alive()], [],
                         "no relay is left running after the exception")


# ── the heartbeat steps back while the relay lands ──────────────────────────

class TheHeartbeatStepsBackWhileTheRelayLandsTest(_MavenProject):

    def setUp(self):
        super().setUp()
        self.declare({"unit": ENTRY})

    def test_no_in_run_tick_is_posted_while_batches_land_and_the_close_is_narrated(self):
        drive = self.drive("test", release_when=_a_batch_landed, FAKE_CLASSES="13")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_relayed_live(drive, "landing")
        self.assertEqual(self.ticks(), [], "no `running N/M classes` tick while batches land")
        closing = [m for m in self.heartbeats() if m in ("ran 13/13 classes", INGESTING)]
        self.assertEqual(closing, ["ran 13/13 classes", INGESTING],
                         f"the closing count, then ingesting; heartbeats={self.heartbeats()!r}")

    def assert_ticks_resume(self, board, where):
        self.use_board(board)
        drive = self.drive("test", release_when=_a_stream_post_was_answered, FAKE_CLASSES="13")
        self.assertTrue(drive.cued, f"{where}: a batch was sent while maven ran; "
                                    f"{drive.diag()}")
        first_batch = self.index_of(lambda p, _b: STREAM_ROUTE.match(p) is not None)
        ticks_after = [i for i, (p, b) in enumerate(self.board.posts())
                       if p == HEARTBEAT and i > first_batch
                       and str((b or {}).get("message")).startswith("running ")]
        self.assertGreaterEqual(len(ticks_after), 1,
                                f"{where}: the ticks come back once the board stops holding "
                                f"batches; heartbeats={self.heartbeats()!r}")
        self.assertEqual(self.heartbeats()[-2:], ["ran 13/13 classes", INGESTING], where)
        run_id = self.run_of("test")
        self.assertEqual(self.close_of(run_id).get("codec"), "junit",
                         f"{where}: the JUnit record is still filed")

    def test_a_relay_refused_with_a_4xx_gives_the_ticks_back(self):
        self.assert_ticks_resume(ViewBoard(refuse_stream=(400, "refused by the fixture")),
                                 "a 400")

    def test_a_relay_answered_503_gives_the_ticks_back(self):
        self.assert_ticks_resume(ViewBoard(refuse_stream=(503, "unavailable")), "a 503")


# ── undeclared runs are today's runs ────────────────────────────────────────

class AnUndeclaredRunIsTodaysRunTest(_MavenProject):

    def assert_todays_run(self, drive, where, agent=True):
        detail = f"{where}: {drive.diag()}"
        self.assertEqual(self.board.stream_posts(), [], f"nothing is relayed; {detail}")
        written = [str(path) for path in Path(self.project).rglob(CONSOLE_FILE)]
        self.assertEqual(written, [], f"no console file is written; {detail}")
        if not agent:
            return
        self.assertEqual(drive.returncode, 0, detail)
        self.assertEqual(len(self.ticks()), 1,
                         f"today's in-run tick is posted; heartbeats={self.heartbeats()!r}")
        self.assertEqual(self.heartbeats()[-2:], ["ran 13/13 classes", INGESTING], detail)
        self.assertEqual([(s or {}).get("framework") for s in self.starts()], [None], detail)
        self.assertNotIn("framework", self.posts_to(RUNS)[0] or {}, detail)

    def test_no_entry_relays_nothing_and_keeps_todays_heartbeat(self):
        self.declare({"regression": ENTRY})
        self.assert_todays_run(self.drive("test", FAKE_CLASSES="13"), "no unit entry")

    def test_no_crucible_toml_relays_nothing(self):
        install = os.path.join(self.logs, "install")
        shutil.copytree(CLIENTS, os.path.join(install, "clients"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        Path(install, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n\n[targets.unit]\n{ENTRY}")
        self.client = os.path.join(install, "clients", "mvn-crucible.py")
        Path(self.project, "crucible.toml").unlink()
        self.assert_todays_run(self.drive("test", FAKE_CLASSES="13"), "no crucible.toml")

    def test_another_stacks_entry_relays_nothing(self):
        self.declare({"unit": 'framework = "nextest"\nstream = { codec = "nextest", '
                              'path = "stdout" }\n'})
        self.assert_todays_run(self.drive("test", FAKE_CLASSES="13"), "a nextest entry")

    def test_a_run_with_no_agent_relays_nothing(self):
        self.declare({"unit": ENTRY})
        drive = self.drive("test", agent=False, FAKE_CLASSES="13")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.starts(), [], "a run with no agent opens no run")
        self.assert_todays_run(drive, "no --agent", agent=False)

    def test_an_unreadable_health_relays_nothing_and_keeps_the_heartbeat(self):
        self.declare({"unit": ENTRY})
        self.board.fail_health()
        drive = self.drive("test", FAKE_CLASSES="13")
        self.assertEqual(self.board.stream_posts(), [], f"nothing is relayed; {drive.diag()}")
        self.assertEqual(len(self.ticks()), 1,
                         f"today's in-run tick is posted; heartbeats={self.heartbeats()!r}")

    def test_an_undeclared_run_posts_what_it_posted_before(self):
        observed: dict[str, Any] = {}
        for label, entries in (("declaring nothing", {}),
                               ("declaring another verb", {"regression": ENTRY})):
            self.use_board(ViewBoard())
            self.declare(entries)
            drive = self.drive("test", FAKE_CLASSES="13")
            axi = _envelope(drive.stdout) or {}
            observed[label] = {
                "exit": drive.returncode,
                "paths": [p for p in self.paths() if p != HEARTBEAT],
                "starts": self.starts(),
                "close": [{k: (c or {}).get(k) for k in ("codec", "data", "raw", "runnerExit",
                                                         "tier", "framework")}
                          for c in self.posts_to(RUNS)],
                # The in-run ticks' total ratchets with the reports on disk,
                # so the ticks are compared by number; the close by text.
                "ticks": len(self.ticks()),
                "closing": [m for m in self.heartbeats()
                            if isinstance(m, str) and (m.startswith("ran ") or m == INGESTING)],
                "envelope": {k: axi.get(k) for k in ("ok", "run", "warnings")},
            }
        self.assertEqual(observed["declaring another verb"], observed["declaring nothing"])


if __name__ == "__main__":
    unittest.main()
