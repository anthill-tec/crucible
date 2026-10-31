"""A bun run relays its console to the board (CR-CRU-201 §S4, AC4).

Drives the REAL `clients/bun-crucible.py` as an OS subprocess against the
shared stand-in board (`RecordingBoard`, tests/client/live_run_harness.py),
extended here as `ConsoleBoard`: its health lists `bun-console` under
`codecs.view` (a board built with §S1), and it holds a `bun-console` stream as
it holds a `crucible-events` one (offsets, gap, overlap, the size bound), or
refuses every batch with a scripted status. The runner is `FAKE_BUN` below, a
small python program speaking bun's piped console shape: a banner on stderr, a
`<file>:` header, one `(pass)`/`(fail)`/`(skip)` result line per test (an
`error:` block ahead of each `(fail)`), and a JUnit report where it is told to
write one. It prints a marker and waits for a release file at the point a test
names, so a test can let it go on only once the board has seen what the relay
sent while the runner was still working.

What is pinned, by AC4 bullet:
- which runs relay: `test`, `regression`, a declared script with no report
  declaration (a tier verb's `test:unit`, and `crucible.testScript`) relay
  the runner's whole console, as written, under codec `bun-console`; a script
  declaring an env report path or a raw report does not;
- the total: the run start carries the prescanned `total` for the client's own
  `bun test` (`test`'s targets when given) and none for a declared script or a
  `--name` filter;
- no relay: a board whose health lists no view codec, a refused or missing
  `runId`, and `--no-lifecycle` run as today (no stream, `running N/M` ticks,
  the JUnit close);
- the wipe: a previous run's console file is gone before the runner starts;
- every exit of §S4 step 4: the JUnit close, the compile close, the ran-nothing
  exit, the filter-ran-nothing exit, the starved no-report exit and the signal
  exit each stop the relay, and nothing is posted to the run after its close;
- a relay failure is said once on stderr and never changes the exit;
- narration: a relayed run posts no `running N/M`, and posts `ran N/M` then
  `ingesting…`; a relay stopped mid-run (a 413, a 4xx) gives the ticks back and
  the run still files its JUnit record.

`_emit_filter_uncounted` is the one §S4 step 4 exit with no test here: it is
reached only through a declared script that declares a raw report, and such a
script never relays (pinned below), so there is no relay for it to stop.

Interface choices (the spec leaves these names open; GREEN is asked to use them):
- `CONSOLE_FILE = "bun-console.log"` and `CONSOLE_CODEC = "bun-console"`,
  module constants of clients/bun-crucible.py: the console file under the run's
  reports dir, and the view codec the relay sends it under. The tests below
  assert the file path and the codec on the wire, not the constants.
- `_board_reads_console(health)`, clients/bun-crucible.py: the health check,
  a pure reading of one health answer — True only when `codecs.view` is a list
  holding `bun-console`. Pinned in-process by `TheHealthCheckHelperTest`.
- `_console_relay(project_dir, agent_id, run_id, reports_dir, health)`,
  clients/bun-crucible.py: the relay hookup, answering a started `StreamRelay`
  (clients/_crucible_run.py) following the console file, or None when the run
  does not relay; `_finish_console_relay(relay, deadline_seconds)` finishes it
  at every exit. No test here calls them: they are driven only through the
  verbs.
"""

import json
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.live_run_harness import (
    START,
    STREAM_CODEC,
    RecordingBoard,
    heartbeat_index,
    install_project,
    load_client,
    scrubbed_env,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
BUN_SCRIPT = REPO_ROOT / "clients" / "bun-crucible.py"

AGENT = "bun-console-relay-agent"
PROJECT_KEY = "bun-console-relay-key"
RUN_ID = "run-live-1"
STREAM = f"/api/v2/runs/{RUN_ID}/stream"
ABORT = f"/api/v2/runs/{RUN_ID}/abort"
CLOSE = "/api/v2/runs"
COMPILE = "/api/v2/runs/compile"
HEARTBEAT = "/api/v2/agents/heartbeat"
VIEW_CODEC = "bun-console"
CONSOLE_FILE = "bun-console.log"

MARKER = "BUN_CONSOLE_RELAY_MARKER"
BANNER = "bun test v1.4.2 (relay fixture)"
STALE = "STALE_CONSOLE_FROM_A_PREVIOUS_RUN"
REFUSAL = "STREAM_REFUSED_BY_THE_FIXTURE_BOARD"
PLANTED = "planted relay failure"

RUN_TIMEOUT = 120
MARKER_WAIT = 20
# The relay sends every RELAY_SECONDS (2 s): a live relay's first batch lands
# well inside this.
RELAY_WAIT = 8

_SCRUBBED = ("BUN_CRUCIBLE_NO_LIFECYCLE", "BUN_CRUCIBLE_PACKAGE_DIR",
             "BUN_CRUCIBLE_PROJECT_DIR", "BUN_CRUCIBLE_BUN", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY")

# bun's piped console, spoken by a stand-in. FAKE_BEFORE result lines, then
# (with FAKE_RELEASE_FILE) the marker and a wait for the release file, then
# FAKE_AFTER result lines FAKE_AFTER_DELAY seconds apart; the last
# FAKE_FAIL_LAST of them fail. FAKE_SHAPE picks the exit: `junit` (the report,
# exit 1 when a test failed), `all-skipped` (every line a skip, exit 0),
# `no-report` (nothing written, exit 1) or `zero-report` (a report holding no
# test case, exit 1). The JUnit path comes from `--reporter-outfile=` or from
# FIXTURE_JUNIT_PATH (an env report-path declaration); FIXTURE_RAW_PATH, when
# set, gets a Playwright JSON report holding one spec. FAKE_PROBE records, at
# spawn, what FAKE_PROBE_TARGET held (`<absent>` when nothing).
FAKE_BUN = r'''
import os
import sys
import time

def env_int(name, default):
    return int(os.environ.get(name, default))

stamp = os.environ.get("FAKE_SPAWN_STAMP")
if stamp:
    with open(stamp, "w") as handle:
        handle.write(repr(time.time()))
probe = os.environ.get("FAKE_PROBE")
if probe:
    try:
        with open(os.environ.get("FAKE_PROBE_TARGET", ""), encoding="utf-8",
                  errors="replace") as handle:
            seen = handle.read()
    except OSError:
        seen = "<absent>"
    with open(probe, "w", encoding="utf-8") as handle:
        handle.write(seen)

outfile = os.environ.get("FIXTURE_JUNIT_PATH")
for arg in sys.argv[1:]:
    if arg.startswith("--reporter-outfile="):
        outfile = arg.split("=", 1)[1]
raw_path = os.environ.get("FIXTURE_RAW_PATH")
shape = os.environ.get("FAKE_SHAPE", "junit")
before = env_int("FAKE_BEFORE", "3")
after = env_int("FAKE_AFTER", "0")
fail_last = env_int("FAKE_FAIL_LAST", "0")
after_delay = float(os.environ.get("FAKE_AFTER_DELAY", "0"))
release = os.environ.get("FAKE_RELEASE_FILE")
marker = os.environ.get("FAKE_MARKER_LINE")

def say(text, stream=sys.stdout):
    stream.write(text + "\n")
    stream.flush()

say(os.environ.get("FAKE_BANNER", "bun test"), sys.stderr)
say("")
say("relay.test.ts:")
total = before + after
cases = []
any_failed = False
for i in range(1, total + 1):
    if i == before + 1 and release:
        if marker:
            say(marker)
        deadline = time.time() + 30
        while not os.path.exists(release) and time.time() < deadline:
            time.sleep(0.02)
    if i > before and after_delay:
        time.sleep(after_delay)
    name = "case_%d" % i
    if shape == "all-skipped":
        say("(skip) relay > %s" % name)
        cases.append('<testcase name="%s" classname="relay" file="relay.test.ts" '
                     'time="0"><skipped /></testcase>' % name)
    elif i > total - fail_last:
        any_failed = True
        say("error: planted relay failure in %s" % name)
        say("      at <anonymous> (/tmp/relay-fixture/relay.test.ts:%d:1)" % i)
        say("(fail) relay > %s [0.01ms]" % name)
        cases.append('<testcase name="%s" classname="relay" file="relay.test.ts" '
                     'time="0.001"><failure message="planted relay failure" '
                     'type="AssertionError" /></testcase>' % name)
    else:
        say("(pass) relay > %s [0.01ms]" % name)
        cases.append('<testcase name="%s" classname="relay" file="relay.test.ts" '
                     'time="0.001" />' % name)
if release and after == 0:
    if marker:
        say(marker)
    deadline = time.time() + 30
    while not os.path.exists(release) and time.time() < deadline:
        time.sleep(0.02)
say("")
say(" %d pass" % (total - fail_last))
say("Ran %d tests across 1 file. [3.00ms]" % total)

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)

if raw_path:
    write(raw_path, '{"suites": [{"title": "relay", "specs": [{"title": "case_1"}]}]}')
if shape == "no-report":
    sys.exit(1)
if shape == "zero-report":
    if outfile:
        write(outfile, '<?xml version="1.0"?><testsuites><testsuite name="relay.test.ts" '
                       'tests="0" failures="0"></testsuite></testsuites>')
    sys.exit(1)
if outfile:
    write(outfile, '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>'
                   '<testsuite name="relay.test.ts" file="relay.test.ts" tests="%d" '
                   'failures="%d">%s</testsuite></testsuites>\n'
                   % (total, fail_last, "".join(cases)))
sys.exit(1 if any_failed else 0)
'''


class ConsoleBoard(RecordingBoard):
    """`RecordingBoard` as a board built with §S1 answers a bun client.

    - `view`: health lists `bun-console` under `codecs.view` (False: the
      health of a board that has no view registry, unchanged).
    - A `bun-console` batch is held exactly as the stand-in holds a stream
      (offsets, overlap, gap, `stream_limit`); any other codec on the stream
      route is a 400.
    - `refuse_stream`: every batch is answered with that `(status, error)`
      instead, with the board's `held` (0) beside it.
    - `open_no_run`: `/api/v2/runs/start` answers `ok` with no `runId`."""

    def __init__(self, view=True, refuse_stream=None, open_no_run=False, **options):
        super().__init__(**options)
        self.refuse_stream = refuse_stream
        self.open_no_run = open_no_run
        if view:
            health = self.default_health()
            health["codecs"]["view"] = [VIEW_CODEC]
            self.script_health(health)
        board = self
        server: Any = self._httpd
        base: Any = server.RequestHandlerClass

        class _OpensNoRun(base):
            def do_POST(self):
                if self.path == START and board.open_no_run:
                    body = self._body()
                    with board._lock:
                        board.events.append((time.time(), "POST", self.path, body))
                    self._reply({"ok": True, "changed": False})
                    return
                base.do_POST(self)

        server.RequestHandlerClass = _OpensNoRun

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
    """One client run: its exit, its output, and whether the runner was let go
    on its cue (the board saw what the test waited for while the runner was
    still parked on its release file)."""

    def __init__(self, returncode, stdout, stderr, cued):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.cued = cued

    def diag(self):
        return f"exit={self.returncode} stdout={self.stdout!r} stderr={self.stderr[-3000:]!r}"


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


def _console_batches(board):
    """Every stream batch carrying data, `[(path, body)]`, in wire order."""
    return [(p, b) for p, b in board.stream_posts()
            if isinstance(b, dict) and b.get("data")]


def _a_console_batch_landed(board):
    return bool(_console_batches(board))


def _a_stream_post_landed(board):
    return bool(board.stream_posts())


class ConsoleRelayCase(unittest.TestCase):
    """A scratch package pointed at a `ConsoleBoard`, the fake bun, and an
    explicit reports dir outside the package."""

    BOARD_OPTIONS: dict = {}

    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="bun-console-relay-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.project = self.scratch / "package"
        self.project.mkdir()
        self.reports = self.scratch / "reports"
        self.console = self.reports / CONSOLE_FILE
        self.board = ConsoleBoard(**self.BOARD_OPTIONS)
        self.addCleanup(self.board.close)
        install_project(str(self.project), self.board.url, PROJECT_KEY)
        self.fake = self.project / "fake_bun.py"
        self.fake.write_text(f"#!{sys.executable}\n" + FAKE_BUN, encoding="utf-8")
        self.fake.chmod(0o755)
        self._drives = 0

    # ── fixture ────────────────────────────────────────────────────────────

    def declare_tests(self, filename, count):
        """`count` real `test(...)` declarations in a test file of the
        package, so the client's prescan counts them."""
        (self.project / filename).write_text(
            "".join(f'test("case{i}", () => {{}});\n' for i in range(1, count + 1)),
            encoding="utf-8")

    def declare_manifest(self, scripts, crucible=None):
        manifest = {"name": "bun-console-relay-fixture", "scripts": scripts}
        if crucible is not None:
            manifest["crucible"] = crucible
        (self.project / "package.json").write_text(json.dumps(manifest), encoding="utf-8")

    def use_board(self, board):
        self.board = board
        self.addCleanup(board.close)
        install_project(str(self.project), board.url, PROJECT_KEY)

    # ── drive ──────────────────────────────────────────────────────────────

    def command(self, verb, *flags, agent=True):
        cmd = [sys.executable, str(BUN_SCRIPT), verb, *flags,
               "--bun", str(self.fake), "--project-dir", str(self.project),
               "--package-dir", str(self.project), "--reports", str(self.reports)]
        return cmd + (["--agent", AGENT] if agent else [])

    def environment(self, **fake):
        env = scrubbed_env(FAKE_BANNER=BANNER, **fake)
        for key in _SCRUBBED:
            env.pop(key, None)
        return env

    def drive(self, verb, *flags, release_when=None, interrupt=False, **fake):
        """Run the client. With `release_when`, the runner parks after its
        FAKE_BEFORE lines until `release_when(board)` holds (or RELAY_WAIT
        passes), then is released — or, with `interrupt`, the client is sent
        SIGINT instead."""
        self._drives += 1
        cmd = self.command(verb, *flags)
        if release_when is None:
            result = subprocess.run(cmd, cwd=str(self.project), env=self.environment(**fake),
                                    capture_output=True, text=True, timeout=RUN_TIMEOUT,
                                    check=False)
            return Drive(result.returncode, result.stdout, result.stderr, None)
        release = self.scratch / f"release-{self._drives}"
        stderr_path = self.scratch / f"client-stderr-{self._drives}.txt"
        env = self.environment(FAKE_RELEASE_FILE=release, FAKE_MARKER_LINE=MARKER, **fake)
        cued = False
        with open(stderr_path, "w", encoding="utf-8") as err:
            proc = subprocess.Popen(cmd, cwd=str(self.project), env=env,
                                    stdout=subprocess.PIPE, stderr=err, text=True)
            try:
                if _wait_until(lambda: MARKER in _read(stderr_path), MARKER_WAIT):
                    cued = _wait_until(lambda: release_when(self.board), RELAY_WAIT)
                    if interrupt:
                        proc.send_signal(signal.SIGINT)
                    else:
                        release.write_text("go", encoding="utf-8")
                stdout, _ = proc.communicate(timeout=RUN_TIMEOUT)
            finally:
                release.write_text("go", encoding="utf-8")
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        return Drive(proc.returncode, stdout, _read(stderr_path), cued)

    # ── reading the board ──────────────────────────────────────────────────

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def index_of(self, predicate):
        for i, (path, body) in enumerate(self.board.posts()):
            if predicate(path, body):
                return i
        return -1

    def stream_indexes(self):
        return [i for i, (p, _b) in enumerate(self.board.posts()) if p == STREAM]

    def posted_to_the_run_after(self, index):
        """Every POST after wire position `index` that is addressed to the
        run: its stream, its abort, or any body carrying its `runId`."""
        return [(p, b) for p, b in self.board.posts()[index + 1:]
                if p.startswith(f"/api/v2/runs/{RUN_ID}/")
                or (isinstance(b, dict) and b.get("runId") == RUN_ID)]

    def start_body(self):
        starts = self.posts_to(START)
        self.assertEqual(len(starts), 1, f"one run start; posts={self.board.posts()!r}")
        return starts[0] or {}

    def assert_relayed_live(self, drive):
        self.assertTrue(
            drive.cued,
            f"a `{VIEW_CODEC}` batch reached the run's stream while the runner was still "
            f"working; stream posts={self.board.stream_posts()!r}; {drive.diag()}")

    def assert_relay_ended_before(self, close_index, drive):
        self.assertGreaterEqual(close_index, 0, f"no close; posts={self.board.posts()!r}")
        batches = self.stream_indexes()
        self.assertTrue(batches, f"the relay sent nothing; {drive.diag()}")
        self.assertLess(max(batches), close_index,
                        f"the relay ends before the run's close; posts={self.board.posts()!r}")
        self.assertEqual(self.posted_to_the_run_after(close_index), [],
                         "nothing is posted to the run after its close")


# ── which runs relay ────────────────────────────────────────────────────────


class WhichRunsRelayTest(ConsoleRelayCase):
    """Only a run whose console is bun's own relays."""

    def assert_relays_the_whole_console(self, drive):
        self.assert_relayed_live(drive)
        self.assertEqual({p for p, _b in self.board.stream_posts()}, {STREAM},
                         "every batch goes to the open run's stream route")
        codecs = {(b or {}).get("codec") for _p, b in self.board.stream_posts()}
        self.assertEqual(codecs, {VIEW_CODEC}, "every batch is sent under the view codec")
        for _p, body in self.board.stream_posts():
            self.assertEqual(((body or {}).get("projectKey"), (body or {}).get("agentId")),
                             (PROJECT_KEY, AGENT))
        held = self.board.held_stream(RUN_ID)
        self.assertIn(BANNER, held, "the runner's stderr is part of the console relayed")
        self.assertIn("relay.test.ts:\n", held)
        self.assertIn("(pass) relay > case_1 [0.01ms]\n", held)
        self.assertIn("(pass) relay > case_4 [0.01ms]\n", held, "lines written after the cue")
        self.assertEqual(held.count("(pass) relay > case_1 [0.01ms]\n"), 1,
                         "nothing is relayed twice")
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, drive.diag())
        self.assertEqual((closes[0].get("codec"), closes[0].get("runId")), ("junit", RUN_ID),
                         "the record is still the JUnit report, closing the run")
        self.assertEqual(held, closes[0].get("raw"),
                         "the board holds the whole console, as the run's capture holds it")
        self.assertEqual(_read(self.console), held,
                         f"the console relayed is the file at <reports>/{CONSOLE_FILE}")

    def test_the_clients_own_bun_test_relays_its_whole_console_under_the_view_codec(self):
        self.declare_tests("relay.test.ts", 4)
        drive = self.drive("test", release_when=_a_console_batch_landed,
                           FAKE_BEFORE=2, FAKE_AFTER=2)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_relays_the_whole_console(drive)

    def test_a_regression_with_no_declared_script_relays_its_whole_console(self):
        self.declare_tests("relay.test.ts", 4)
        drive = self.drive("regression", release_when=_a_console_batch_landed,
                           FAKE_BEFORE=2, FAKE_AFTER=2)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_relays_the_whole_console(drive)

    def test_a_declared_script_with_no_report_declaration_relays_its_whole_console(self):
        self.declare_tests("relay.test.ts", 4)
        self.declare_manifest({"test:unit": "bun test"})
        drive = self.drive("unit", release_when=_a_console_batch_landed,
                           FAKE_BEFORE=2, FAKE_AFTER=2)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_relays_the_whole_console(drive)

    def test_a_test_run_through_a_declared_test_script_with_no_report_declaration_relays(self):
        self.declare_tests("relay.test.ts", 4)
        self.declare_manifest({"test:unit": "bun test"}, {"testScript": "test:unit"})
        drive = self.drive("test", release_when=_a_console_batch_landed,
                           FAKE_BEFORE=2, FAKE_AFTER=2)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_relays_the_whole_console(drive)

    def test_a_declared_script_with_an_env_report_path_does_not_relay(self):
        self.declare_tests("relay.test.ts", 4)
        self.declare_manifest({"test:unit": "bun test"},
                              {"reportPath": {"test:unit": "env:FIXTURE_JUNIT_PATH"}})
        drive = self.drive("unit", FAKE_BEFORE=4)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.board.stream_posts(), [], "nothing is relayed")
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, drive.diag())
        self.assertEqual((closes[0].get("codec"), closes[0].get("runId")), ("junit", RUN_ID),
                         "the run files exactly as today")

    def test_a_declared_script_with_a_raw_report_does_not_relay(self):
        self.declare_tests("relay.test.ts", 4)
        self.declare_manifest({"test:unit": "bun test"},
                              {"rawReport": {"test:unit": {"codec": "playwright",
                                                           "file": "results.json",
                                                           "path": "env:FIXTURE_RAW_PATH"}}})
        drive = self.drive("unit", FAKE_BEFORE=4)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.board.stream_posts(), [], "nothing is relayed")
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, drive.diag())
        self.assertEqual((closes[0].get("codec"), closes[0].get("runId")),
                         ("playwright", RUN_ID), "the run files exactly as today")


# ── the run start's total ───────────────────────────────────────────────────


class TheRunStartCarriesTheScansTotalTest(ConsoleRelayCase):
    """The start carries `total` only when the scan covers what runs."""

    def setUp(self):
        super().setUp()
        self.declare_tests("relay.test.ts", 3)
        self.declare_tests("other.test.ts", 5)

    def test_a_whole_suite_test_run_starts_with_the_packages_prescanned_total(self):
        drive = self.drive("test", FAKE_BEFORE=3)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.start_body().get("total"), 8,
                         "both test files' declarations, counted before the run")

    def test_a_targeted_test_run_starts_with_the_prescanned_total_of_its_targets(self):
        drive = self.drive("test", "--tests", "relay.test.ts", FAKE_BEFORE=3)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.start_body().get("total"), 3,
                         "only the targeted file's declarations")

    def test_a_regression_run_starts_with_the_packages_prescanned_total(self):
        drive = self.drive("regression", FAKE_BEFORE=3)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.start_body().get("total"), 8)

    def test_a_declared_script_run_starts_with_no_total(self):
        self.declare_manifest({"test:unit": "bun test"})
        drive = self.drive("unit", FAKE_BEFORE=3)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertNotIn("total", self.start_body(),
                         "a declared script's scan does not cover what it runs")

    def test_a_name_filtered_test_run_starts_with_no_total(self):
        drive = self.drive("test", "--name", "case_1", FAKE_BEFORE=3)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertNotIn("total", self.start_body(),
                         "a name filter runs fewer tests than the scan counts")


# ── when nothing relays ─────────────────────────────────────────────────────


class WhenNothingRelaysTheRunIsAsTodayTest(ConsoleRelayCase):
    """A board with no view codec, a refused or missing `runId`, and
    `--no-lifecycle`: no stream, today's `running N/M` ticks, today's close."""

    TOTAL = 25

    def setUp(self):
        super().setUp()
        self.declare_tests("relay.test.ts", self.TOTAL)

    def assert_as_today(self, drive, run_id):
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.board.stream_posts(), [], "nothing is relayed")
        running = [m for m in self.board.messages() if str(m).startswith("running ")]
        self.assertTrue(running, f"today's in-run ticks; messages={self.board.messages()!r}")
        self.assertIn(f"ran {self.TOTAL}/{self.TOTAL}", self.board.messages())
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, drive.diag())
        self.assertEqual(closes[0].get("codec"), "junit")
        self.assertEqual(closes[0].get("runId"), run_id)

    def test_a_board_whose_health_lists_no_view_codec_gets_todays_run(self):
        self.use_board(ConsoleBoard(view=False))
        drive = self.drive("test", FAKE_BEFORE=self.TOTAL)
        self.assert_as_today(drive, RUN_ID)

    def test_a_board_that_refuses_the_run_start_gets_todays_single_shot_run(self):
        self.board.refuse_next_start()
        drive = self.drive("test", FAKE_BEFORE=self.TOTAL)
        self.assert_as_today(drive, None)

    def test_a_board_that_opens_no_run_gets_todays_single_shot_run(self):
        self.use_board(ConsoleBoard(open_no_run=True))
        drive = self.drive("test", FAKE_BEFORE=self.TOTAL)
        self.assertEqual(len(self.posts_to(START)), 1, "the start was asked for")
        self.assert_as_today(drive, None)

    def test_a_run_with_no_lifecycle_gets_todays_single_shot_run(self):
        drive = self.drive("test", "--no-lifecycle", FAKE_BEFORE=self.TOTAL)
        self.assertEqual(self.posts_to(START), [], "no run is opened")
        self.assert_as_today(drive, None)


# ── the wipe ────────────────────────────────────────────────────────────────


class TheWipeRemovesAnOldConsoleFileTest(ConsoleRelayCase):

    def test_a_previous_runs_console_file_is_gone_before_the_runner_starts_and_never_relayed(self):
        self.declare_tests("relay.test.ts", 4)
        self.reports.mkdir()
        self.console.write_text(f"{STALE}\n(pass) stale > ghost [0.01ms]\n", encoding="utf-8")
        probe = self.scratch / "console-at-spawn.txt"
        drive = self.drive("test", release_when=_a_console_batch_landed,
                           FAKE_BEFORE=2, FAKE_AFTER=2,
                           FAKE_PROBE=probe, FAKE_PROBE_TARGET=self.console)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertNotIn(STALE, _read(probe),
                         "the old console file is removed before the runner starts")
        self.assert_relayed_live(drive)
        held = self.board.held_stream(RUN_ID)
        self.assertNotIn(STALE, held, "a previous run's console is never relayed")
        self.assertIn("(pass) relay > case_1 [0.01ms]", held)
        after = _read(self.console)
        self.assertNotIn(STALE, after)
        self.assertIn("(pass) relay > case_4 [0.01ms]", after,
                      "the file holds this run's console")


# ── every exit stops the relay ──────────────────────────────────────────────


class EveryExitStopsTheRelayTest(ConsoleRelayCase):
    """Each exit of §S4 step 4: the relay was live, it ends before the run's
    close, and nothing is posted to the run after that close."""

    def setUp(self):
        super().setUp()
        self.declare_tests("relay.test.ts", 4)

    def test_the_junit_close_comes_after_the_relay_has_sent_the_whole_console(self):
        drive = self.drive("test", release_when=_a_console_batch_landed,
                           FAKE_BEFORE=2, FAKE_AFTER=2)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_relayed_live(drive)
        close = self.index_of(lambda p, b: p == CLOSE and (b or {}).get("runId") == RUN_ID)
        self.assert_relay_ended_before(close, drive)
        self.assertEqual(self.board.held_stream(RUN_ID), _read(self.console),
                         "finished before the close: the board holds the whole console")

    def test_the_compile_close_of_a_run_with_no_junit_comes_after_the_relay_has_finished(self):
        drive = self.drive("test", release_when=_a_console_batch_landed,
                           FAKE_BEFORE=2, FAKE_AFTER=2, FAKE_SHAPE="no-report")
        self.assertEqual(drive.returncode, 1, drive.diag())
        self.assert_relayed_live(drive)
        compiles = self.posts_to(COMPILE)
        self.assertEqual(len(compiles), 1, drive.diag())
        self.assertEqual(compiles[0].get("runId"), RUN_ID, "the record is unchanged")
        self.assertEqual(self.posts_to(CLOSE), [])
        close = self.index_of(lambda p, _b: p == COMPILE)
        self.assert_relay_ended_before(close, drive)
        self.assertEqual(self.board.held_stream(RUN_ID), _read(self.console),
                         "finished before the close: the board holds the whole console")

    def test_a_run_that_ran_nothing_is_aborted_after_the_relay_stopped(self):
        drive = self.drive("test", release_when=_a_console_batch_landed,
                           FAKE_BEFORE=2, FAKE_AFTER=2, FAKE_SHAPE="zero-report")
        self.assertEqual(drive.returncode, 1, drive.diag())
        self.assert_relayed_live(drive)
        self.assertEqual(self.posts_to(CLOSE), [], "nothing is filed, as today")
        self.assertEqual(len(self.board.aborts()), 1, drive.diag())
        self.assert_relay_ended_before(self.index_of(lambda p, _b: p == ABORT), drive)

    def test_a_name_filter_that_ran_nothing_is_aborted_after_the_relay_stopped(self):
        drive = self.drive("test", "--name", "no_such_case", release_when=_a_console_batch_landed,
                           FAKE_BEFORE=2, FAKE_AFTER=2, FAKE_SHAPE="all-skipped")
        self.assertEqual(drive.returncode, 1, drive.diag())
        self.assert_relayed_live(drive)
        self.assertEqual(self.posts_to(CLOSE), [], "nothing is filed, as today")
        self.assertEqual(len(self.board.aborts()), 1, drive.diag())
        self.assertIn("no_such_case", self.board.aborts()[0][1].get("reason") or "")
        self.assert_relay_ended_before(self.index_of(lambda p, _b: p == ABORT), drive)

    def test_a_starved_regression_with_no_report_is_aborted_after_the_relay_stopped(self):
        drive = self.drive("regression", release_when=_a_console_batch_landed,
                           FAKE_BEFORE=2, FAKE_AFTER=2, FAKE_SHAPE="no-report")
        self.assertEqual(drive.returncode, 1, drive.diag())
        self.assert_relayed_live(drive)
        self.assertEqual(self.posts_to(CLOSE), [], "nothing is filed, as today")
        self.assertEqual(self.posts_to(COMPILE), [], "a starved regression is not a compile")
        self.assertEqual(len(self.board.aborts()), 1, drive.diag())
        self.assert_relay_ended_before(self.index_of(lambda p, _b: p == ABORT), drive)

    def test_a_signalled_run_is_aborted_after_the_relay_stopped(self):
        drive = self.drive("test", release_when=_a_console_batch_landed, interrupt=True,
                           FAKE_BEFORE=2, FAKE_AFTER=2)
        self.assertEqual(drive.returncode, 128 + signal.SIGINT, drive.diag())
        self.assert_relayed_live(drive)
        self.assertEqual(self.posts_to(CLOSE), [], "nothing is filed, as today")
        self.assertEqual(len(self.board.aborts()), 1, drive.diag())
        self.assert_relay_ended_before(self.index_of(lambda p, _b: p == ABORT), drive)
        self.assertIn("(pass) relay > case_2 [0.01ms]", self.board.held_stream(RUN_ID),
                      "what the runner wrote before the signal was relayed")


# ── a relay failure ─────────────────────────────────────────────────────────


class ARelayFailureNeverChangesTheRunTest(ConsoleRelayCase):

    def setUp(self):
        super().setUp()
        self.declare_tests("relay.test.ts", 4)

    def said(self, drive):
        return [line for line in drive.stderr.splitlines() if REFUSAL in line]

    def test_a_refused_relay_is_said_once_and_a_green_run_still_exits_zero(self):
        self.use_board(ConsoleBoard(refuse_stream=(400, REFUSAL)))
        drive = self.drive("test", release_when=_a_stream_post_landed,
                           FAKE_BEFORE=2, FAKE_AFTER=2)
        self.assertTrue(drive.cued, f"the relay tried the board; {drive.diag()}")
        self.assertEqual(len(self.said(drive)), 1,
                         f"the refusal is said once on stderr; {drive.diag()}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, drive.diag())
        self.assertEqual((closes[0].get("codec"), closes[0].get("runId")), ("junit", RUN_ID))

    def test_a_stream_route_that_keeps_failing_is_said_once_and_a_failing_run_still_exits_one(self):
        self.use_board(ConsoleBoard(refuse_stream=(503, REFUSAL)))
        drive = self.drive("test", release_when=lambda b: len(b.stream_posts()) >= 2,
                           FAKE_BEFORE=2, FAKE_AFTER=2, FAKE_FAIL_LAST=1)
        self.assertTrue(drive.cued, f"the relay tried the board more than once; {drive.diag()}")
        self.assertEqual(len(self.said(drive)), 1,
                         f"a failure retried on every tick is said once; {drive.diag()}")
        self.assertEqual(drive.returncode, 1, drive.diag())
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, drive.diag())
        self.assertEqual((closes[0].get("codec"), closes[0].get("runnerExit")), ("junit", 1))


# ── narration ───────────────────────────────────────────────────────────────


class ARelayedRunNarratesItsCloseOnlyTest(ConsoleRelayCase):

    def test_a_relayed_run_posts_no_running_count_and_closes_with_ran_then_ingesting(self):
        self.declare_tests("relay.test.ts", 50)
        drive = self.drive("test", release_when=_a_console_batch_landed,
                           FAKE_BEFORE=25, FAKE_AFTER=25)
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_relayed_live(drive)
        messages = self.board.messages()
        self.assertEqual([m for m in messages if str(m).startswith("running ")], [],
                         "no in-run count while the relay is live")
        posts = self.board.posts()
        ran = heartbeat_index(posts, "ran 50/50")
        ingesting = heartbeat_index(posts, "ingesting\u2026")
        close = self.index_of(lambda p, _b: p == CLOSE)
        self.assertIsNotNone(ran, f"the closing count; messages={messages!r}")
        self.assertIsNotNone(ingesting, f"then `ingesting…`; messages={messages!r}")
        assert ran is not None and ingesting is not None
        self.assertLess(ran, ingesting)
        self.assertLess(ingesting, close, "both before the close")


class ARelayStoppedMidRunGivesTheTicksBackTest(ConsoleRelayCase):
    """Once the board stops the relay, the narrator's `running N/M` ticks
    resume, and the run still files its JUnit record."""

    BEFORE = 3
    AFTER = 30

    def assert_ticks_resume(self, drive):
        self.assertTrue(drive.cued, f"the relay sent a batch the board stopped; {drive.diag()}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        posts = self.board.posts()
        stopped_at = min(self.stream_indexes())
        close = self.index_of(lambda p, _b: p == CLOSE)
        total = self.BEFORE + self.AFTER
        ticks = [i for i, (p, b) in enumerate(posts)
                 if p == HEARTBEAT and isinstance(b, dict)
                 and str(b.get("message") or "").startswith("running ")]
        self.assertTrue([i for i in ticks if stopped_at < i < close],
                        f"`running N/{total}` ticks after the relay stopped; "
                        f"messages={self.board.messages()!r}")
        self.assertTrue(all(str(posts[i][1].get("message")).startswith("running ")
                            and f"/{total}" in str(posts[i][1].get("message")) for i in ticks))
        self.assertIn(f"ran {total}/{total}", self.board.messages())
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, drive.diag())
        self.assertEqual((closes[0].get("codec"), closes[0].get("runId")), ("junit", RUN_ID),
                         "the run still files its JUnit record")

    def run_stopped(self, board):
        self.use_board(board)
        self.declare_tests("relay.test.ts", self.BEFORE + self.AFTER)
        return self.drive("test", release_when=_a_stream_post_landed,
                          FAKE_BEFORE=self.BEFORE, FAKE_AFTER=self.AFTER,
                          FAKE_AFTER_DELAY="0.1")

    def test_a_relay_cut_by_a_413_gives_the_ticks_back_and_files_the_junit_record(self):
        drive = self.run_stopped(ConsoleBoard(stream_limit=8))
        self.assertTrue(self.board.stream_posts(), drive.diag())
        self.assert_ticks_resume(drive)

    def test_a_relay_refused_with_a_4xx_gives_the_ticks_back_and_files_the_junit_record(self):
        drive = self.run_stopped(ConsoleBoard(refuse_stream=(400, REFUSAL)))
        self.assert_ticks_resume(drive)


# ── the health check ────────────────────────────────────────────────────────


class TheHealthCheckHelperTest(unittest.TestCase):
    """`_board_reads_console(health)`: the run relays only when health lists
    `bun-console` under `codecs.view`."""

    def setUp(self):
        self.bun = load_client("bun-crucible.py")

    def test_only_a_health_listing_the_console_codec_under_view_reads_the_console(self):
        reads = self.bun._board_reads_console
        listed = {"ok": True, "codecs": {"test": ["junit"], "coverage": ["lcov"],
                                         "view": ["bun-console"]}}
        self.assertIs(reads(listed), True)
        unlisted = [
            ("no view list (a board built before view codecs)",
             {"ok": True, "codecs": {"test": ["junit"], "coverage": ["lcov"]}}),
            ("an empty view list", {"ok": True, "codecs": {"view": []}}),
            ("another view codec", {"ok": True, "codecs": {"view": ["maven-console"]}}),
            ("the console codec listed as a test codec",
             {"ok": True, "codecs": {"test": ["bun-console"]}}),
            ("a view that is not a list", {"ok": True, "codecs": {"view": "bun-console"}}),
            ("no codecs", {"ok": True}),
            ("an unread health", {"ok": False, "error": "connection failed"}),
            ("no answer", None),
        ]
        for label, health in unlisted:
            with self.subTest(label):
                self.assertIs(reads(health), False)


if __name__ == "__main__":
    unittest.main()
