"""An arduino run reads its stream declaration from the project's own
`crucible.toml`, keyed by native dir and make target, and keeps the make
contract it declares.

A declared target (`[targets."<dir>/<target>"]` with `framework =
"arduino-native"` and `stream = { codec = "crucible-events", path =
"env:CRUCIBLE_STREAM" }`):
  - hands `make` `CRUCIBLE_STREAM`, the absolute
    `<REPORTS_DIR>/crucible-events.ndjson`, emptied before `make` spawns and
    set only on a run with an agent;
  - states `arduino-native`, relays the file under `crucible-events`, appends
    the `run-end` stating its `TEST-*.xml` totals, closes from the stream, and
    narrates the stream's `test-end`s, never Unity's lines;
  - does so on `test`, every tier verb and `pre-merge-gate`.

A declared run with no stream is not hidden: nothing held is filed from its
JUnit with one warning naming the key; a build failure is the no-report
envelope with no compile ingest; a narrowed run that streamed nothing ran
nothing; a run the board opened none for is filed single-shot.

Refused before any board call, the `arduino-cli` compile and `make`: an entry
under the run's own key naming another arduino framework, codec or path,
lacking a required field or declaring `junit`, `console` or `coverage`; a
project file that does not parse; a board whose health lists no
`crucible-events` stream codec, or no `lcov` for a coverage run. An unreadable
health refuses nothing. Another stack's entry is skipped; an undeclared
target runs as before.

Driven on a fake `make` and a fake `arduino-cli` against a `RecordingBoard`.
A project whose own file is absent or does not parse runs a COPIED install
whose `crucible.toml` points at that board.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_an_arduino_run_reads_its_projects_stream_declaration
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
    HEALTH_PATHS,
    RecordingBoard,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
ARDUINO_CLIENT = CLIENTS / "arduino-crucible.py"
TIMEOUT = 120
PROJECT_KEY = "arduino-stream-declaration-key"
STREAM_CODEC = "crucible-events"
FRAMEWORK = "arduino-native"
STREAM_FILE = "crucible-events.ndjson"
RUNS = "/api/v2/runs"
COMPILE = "/api/v2/runs/compile"
HEARTBEAT = "/api/v2/agents/heartbeat"
TIERS = ("module", "integration", "e2e", "bdd")

ENTRY = ('framework = "arduino-native"\n'
         'stream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }\n')

# Entries refused under the run's own key: (label, body, the texts the
# refusal names beside the key).
REFUSED_ENTRIES = (
    ("an arduino framework misnamed",
     'framework = "arduino"\nstream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }\n',
     ("framework", "arduino")),
    ("an unknown framework",
     'framework = "unity"\nstream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }\n',
     ("framework", "unity")),
    ("another codec",
     'framework = "arduino-native"\nstream = { codec = "bun-console", path = "env:CRUCIBLE_STREAM" }\n',
     ("codec", "bun-console")),
    ("another path",
     'framework = "arduino-native"\nstream = { codec = "crucible-events", path = "stdout" }\n',
     ("path", "stdout")),
    ("another variable",
     'framework = "arduino-native"\nstream = { codec = "crucible-events", path = "env:OTHER_STREAM" }\n',
     ("path", "env:OTHER_STREAM")),
    ("a junit key", ENTRY + 'junit = "reports"\n', ("junit",)),
    ("a console key", ENTRY + 'console = "stdout"\n', ("console",)),
    ("a coverage key", ENTRY + 'coverage = "lcov"\n', ("coverage",)),
    ("no framework",
     'stream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }\n', ("framework",)),
    ("no stream", 'framework = "arduino-native"\n', ("stream",)),
)

# Another stack's entries, each skipped under the run's own key.
OTHER_STACKS = (
    ('framework = "nextest"\nstream = { codec = "nextest", path = "stdout" }\n'),
    ('framework = "surefire"\n'),
    ('framework = "vitest"\nstream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }\n'),
)

_CASES = (("spins_up", "pass"), ("stops", "pass"), ("brakes", "pass"))

# A fake `make`. It logs what it was handed (argv, cwd, CRUCIBLE_STREAM and
# the stream file's size at spawn, REPORTS_DIR, COVERAGE_DIR) to
# FAKE_MAKE_LOG, prints one Unity PASS/FAIL line per case, appends one
# `test-end` per case to CRUCIBLE_STREAM when it is set (FAKE_STREAM `all`;
# `two` writes the first two; `none` writes nothing), writes
# `TEST-test_motor.xml` into REPORTS_DIR (FAKE_JUNIT `none` writes none;
# `other` writes `TEST-test_pid.xml` with one test_pid case instead), the lcov
# into COVERAGE_DIR, and exits FAKE_EXIT. FAKE_VARIANT `fail` fails the last
# case. FAKE_BUILD_FAIL=1 is a binary that does not build: a compiler error
# on stderr, nothing written, exit 2.
_FAKE_MAKE = r'''
import json, os, sys

CASES = ''' + repr(_CASES) + r'''
stream = os.environ.get("CRUCIBLE_STREAM")
size = None
if stream and os.path.exists(stream):
    size = os.path.getsize(stream)
with open(os.environ["FAKE_MAKE_LOG"], "a") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(),
                          "has_stream": "CRUCIBLE_STREAM" in os.environ,
                          "stream": stream, "stream_bytes": size,
                          "reports": os.environ.get("REPORTS_DIR"),
                          "coverage": os.environ.get("COVERAGE_DIR")}) + "\n")
if os.environ.get("FAKE_BUILD_FAIL") == "1":
    sys.stderr.write("test_motor.cpp:3:1: error: 'motor' was not declared\n")
    sys.exit(2)
variant = os.environ.get("FAKE_VARIANT", "pass")
cases = [(name, "fail" if variant == "fail" and i == len(CASES) - 1 else outcome)
         for i, (name, outcome) in enumerate(CASES)]
for name, outcome in cases:
    sys.stdout.write(f"test/test_motor.cpp:12:{name}:{'PASS' if outcome == 'pass' else 'FAIL: Expected 4 Was 8'}\n")
sys.stdout.flush()
mode = os.environ.get("FAKE_STREAM", "all")
if stream and mode != "none":
    with open(stream, "a") as handle:
        for name, outcome in cases[:2] if mode == "two" else cases:
            event = {"event": "test-end", "suite": "test_motor", "name": name,
                     "status": outcome, "duration_ms": 1}
            if outcome == "fail":
                event["failure"] = {"message": "Expected 4 Was 8"}
            handle.write(json.dumps(event) + "\n")
            handle.flush()
reports = os.environ.get("REPORTS_DIR") or "reports"
junit = os.environ.get("FAKE_JUNIT", "yes")
if junit != "none":
    stem = "test_pid" if junit == "other" else "test_motor"
    chosen = [("tunes", "pass")] if junit == "other" else cases
    body = "".join(
        f'<testcase name="{n}" classname="{stem}" time="0.001">'
        + ('<failure message="Expected 4 Was 8">Expected 4 Was 8</failure>' if o == "fail" else "")
        + "</testcase>\n" for n, o in chosen)
    failures = sum(1 for _n, o in chosen if o == "fail")
    os.makedirs(reports, exist_ok=True)
    with open(os.path.join(reports, f"TEST-{stem}.xml"), "w") as handle:
        handle.write('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n'
                     f'<testsuite name="{stem}" tests="{len(chosen)}" failures="{failures}">\n'
                     + body + "</testsuite>\n</testsuites>\n")
coverage = os.environ.get("COVERAGE_DIR")
if coverage:
    os.makedirs(coverage, exist_ok=True)
    with open(os.path.join(coverage, "lcov.info"), "w") as handle:
        handle.write("TN:\nSF:src/motor.cpp\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n")
sys.exit(int(os.environ.get("FAKE_EXIT", "2" if variant == "fail" else "0")))
'''

# A fake `arduino-cli`: logs its argv to FAKE_CLI_LOG and compiles clean.
_FAKE_CLI = r'''
import json, os, sys
with open(os.environ["FAKE_CLI_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")
sys.exit(0)
'''

_SCRUBBED = ("ARDUINO_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "CRUCIBLE_STREAM", "AGENT_ID", "TESTS", "TEST_NAME", "FAKE_STREAM",
             "FAKE_JUNIT", "FAKE_VARIANT", "FAKE_EXIT", "FAKE_BUILD_FAIL")


def _write_script(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _codes(axi):
    return [w.get("code") for w in (axi or {}).get("warnings") or [] if isinstance(w, dict)]


def _said(axi):
    """The refusal as the envelope says it: its error and its warnings."""
    parts = [str((axi or {}).get("error") or "")]
    parts += [str(w.get("detail") or "") for w in (axi or {}).get("warnings") or []
              if isinstance(w, dict)]
    return " ".join(parts)


class _DeclaredProject(unittest.TestCase):
    """A scratch firmware project: `tests/native` and `tests/native-b` each
    with a `junit` target, `tests/native-tiers` with a `junit-<tier>` target
    per declared tier, the fake `make` and `arduino-cli` on PATH, filing to a
    RecordingBoard."""

    maxDiff = 6000

    def setUp(self):
        self.project = new_scratch("arduino-stream-declaration-")
        self.bin_dir = new_scratch("arduino-stream-declaration-bin-")
        self.logs = new_scratch("arduino-stream-declaration-logs-")
        for sub, rules in (("tests/native", "junit:\n\t@echo junit\n"),
                           ("tests/native-b", "junit:\n\t@echo junit\n"),
                           ("tests/native-tiers", "".join(
                               f"junit-{tier}:\n\t@echo {tier}\n" for tier in TIERS))):
            native = os.path.join(self.project, *sub.split("/"))
            os.makedirs(native)
            Path(native, "Makefile").write_text(rules)
            for stem in ("test_motor", "test_pid"):
                Path(native, f"{stem}.cpp").write_text("// a native test source\n")
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        _write_script(os.path.join(self.bin_dir, "make"), _FAKE_MAKE)
        self.cli = os.path.join(self.bin_dir, "arduino-cli")
        _write_script(self.cli, _FAKE_CLI)
        self.board = RecordingBoard()
        self.client = str(ARDUINO_CLIENT)
        self.declare({"tests/native/junit": ENTRY})

    def tearDown(self):
        self.board.close()
        for path in (self.project, self.bin_dir, self.logs):
            shutil.rmtree(path, ignore_errors=True)

    def fresh_board(self, board=None):
        self.board.close()
        self.board = board or RecordingBoard()
        self.rewrite_toml()
        return self.board

    def declare(self, entries):
        """The project's own `crucible.toml`: the board, then one
        `[targets."<key>"]` table per entry."""
        self.entries = dict(entries)
        self.rewrite_toml()

    def rewrite_toml(self):
        tables = "".join(f'\n[targets."{key}"]\n{body}' for key, body in self.entries.items())
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n{tables}")

    def copied_install(self, install_toml):
        """A copy of the clients whose install-level `crucible.toml` is
        `install_toml`; the drives that follow run the copied client."""
        install = os.path.join(self.logs, "install")
        shutil.copytree(CLIENTS, os.path.join(install, "clients"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        Path(install, "crucible.toml").write_text(install_toml)
        self.client = os.path.join(install, "clients", "arduino-crucible.py")

    def drive(self, verb, *extra, agent: str | None = "arduino-declared", env=None, **fake):
        argv = [sys.executable, self.client, verb]
        if agent:
            argv += ["--agent", agent]
        argv += ["--project-dir", self.project, *extra]
        run_env = scrubbed_env(self.bin_dir, ARDUINO_CLI=self.cli,
                               FAKE_MAKE_LOG=os.path.join(self.logs, "make.jsonl"),
                               FAKE_CLI_LOG=os.path.join(self.logs, "cli.jsonl"))
        for key in _SCRUBBED:
            run_env.pop(key, None)
        run_env.update(env or {})
        run_env.update({key: str(value) for key, value in fake.items()})
        return subprocess.run(argv, cwd=self.project, env=run_env, capture_output=True,
                              text=True, timeout=TIMEOUT, check=False)

    def make_calls(self):
        path = os.path.join(self.logs, "make.jsonl")
        if not os.path.exists(path):
            return []
        return [json.loads(line) for line in Path(path).read_text().splitlines()]

    def cli_calls(self):
        path = os.path.join(self.logs, "cli.jsonl")
        if not os.path.exists(path):
            return []
        return [json.loads(line) for line in Path(path).read_text().splitlines()]

    def requests(self):
        return [(method, path) for _at, method, path, _body in list(self.board.events)]

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def starts(self):
        return self.posts_to("/api/v2/runs/start")

    def heartbeats(self):
        return [(body or {}).get("message") for body in self.posts_to(HEARTBEAT)]

    def where(self, result):
        return (f"exit={result.returncode} requests={self.requests()!r} "
                f"make={self.make_calls()!r} stdout={result.stdout[-900:]!r} "
                f"stderr={result.stderr[-900:]!r}")

    def own_reports(self, agent="arduino-declared"):
        return os.path.join(self.project, "test-reports", agent)

    def junit_text(self, agent="arduino-declared", stem="test_motor"):
        return Path(self.own_reports(agent), f"TEST-{stem}.xml").read_text()

    def assert_streamed(self, result, where):
        detail = f"{where}: {self.where(result)}"
        calls = self.make_calls()
        self.assertEqual(len(calls), 1, f"make ran once; {detail}")
        self.assertTrue(calls[0]["has_stream"], f"make was handed CRUCIBLE_STREAM; {detail}")
        self.assertEqual([s.get("framework") for s in self.starts()], [FRAMEWORK],
                         f"the run states framework arduino-native; {detail}")
        streams = self.board.stream_posts()
        self.assertTrue(streams, f"the stream was relayed; {detail}")
        self.assertEqual({(b or {}).get("codec") for _p, b in streams}, {STREAM_CODEC}, detail)
        closes = self.posts_to(RUNS)
        self.assertEqual([(c.get("codec"), "data" in c, bool(c.get("runId"))) for c in closes],
                         [(STREAM_CODEC, False, True)],
                         f"the run is closed once from its stream; {detail}")

    def assert_ran_undeclared(self, result, where):
        detail = f"{where}: {self.where(result)}"
        self.assertEqual(len(self.make_calls()), 1, f"make ran once; {detail}")
        self.assertEqual(self.board.stream_posts(), [], f"nothing is streamed; {detail}")
        closes = self.posts_to(RUNS)
        self.assertEqual([c.get("codec") for c in closes], ["junit"],
                         f"the JUnit is filed at exit, as before; {detail}")
        self.assertNotEqual([s.get("framework") for s in self.starts()], [FRAMEWORK], detail)

    def assert_refused_before_anything(self, result, where, *named, health_read=False):
        detail = f"{where}: {self.where(result)} cli={self.cli_calls()!r}"
        self.assertEqual(result.returncode, 1, f"the refusal exits 1; {detail}")
        axi = _envelope(result.stdout)
        self.assertIsNotNone(axi, f"one envelope on stdout; {detail}")
        self.assertIs((axi or {}).get("ok"), False, detail)
        said = _said(axi)
        for text in named:
            self.assertIn(text, said, f"the refusal names {text!r}; {detail}")
        self.assertEqual(self.make_calls(), [], f"make never ran; {detail}")
        self.assertEqual(self.cli_calls(), [], f"arduino-cli never compiled; {detail}")
        allowed = [("GET", path) for path in HEALTH_PATHS] if health_read else []
        stray = [r for r in self.requests() if r not in allowed]
        self.assertEqual(stray, [], f"no board call before the refusal; {detail}")


# ── the make contract a declared run keeps ───────────────────────────────────

class ADeclaredRunHandsMakeItsStreamFileTest(_DeclaredProject):

    def test_crucible_stream_is_the_absolute_stream_file_in_the_runs_reports_dir(self):
        result = self.drive("test")
        calls = self.make_calls()
        self.assertEqual(len(calls), 1, self.where(result))
        reports = self.own_reports()
        self.assertEqual(calls[0]["reports"], reports, self.where(result))
        self.assertEqual(calls[0]["stream"], os.path.join(reports, STREAM_FILE),
                         self.where(result))
        self.assertTrue(os.path.isabs(calls[0]["stream"] or ""))

    def test_the_stream_file_is_emptied_before_make_spawns(self):
        os.makedirs(self.own_reports())
        stale = json.dumps({"event": "test-end", "suite": "stale", "name": "left_over",
                            "status": "pass"}) + "\n"
        Path(self.own_reports(), STREAM_FILE).write_text(stale)
        result = self.drive("test")
        calls = self.make_calls()
        self.assertEqual(len(calls), 1, self.where(result))
        self.assertIn(calls[0]["stream_bytes"], (0, None),
                      f"make found the stream file empty; {self.where(result)}")
        held = self.board.held_stream("run-live-1")
        self.assertNotIn("left_over", held)
        self.assertEqual(held.count('"test-end"'), 3, f"held={held!r}")

    def test_a_coverage_run_hands_make_coverage_dir_beside_the_stream(self):
        result = self.drive("regression", "--coverage")
        calls = self.make_calls()
        self.assertEqual(len(calls), 1, self.where(result))
        self.assertEqual(calls[0]["coverage"], os.path.join(self.own_reports(), "coverage"))
        self.assertEqual(calls[0]["stream"], os.path.join(self.own_reports(), STREAM_FILE),
                         self.where(result))
        closes = self.posts_to(RUNS)
        self.assertEqual([(c.get("codec"), (c.get("coverage") or {}).get("codec"))
                          for c in closes], [(STREAM_CODEC, "lcov")], self.where(result))

    def test_a_run_without_agent_leaves_crucible_stream_unset(self):
        result = self.drive("test", agent=None)
        self.assertEqual([c["has_stream"] for c in self.make_calls()], [False],
                         self.where(result))

    def test_a_run_without_agent_unsets_a_crucible_stream_the_shell_exported(self):
        exported = os.path.join(self.logs, "a-parents-stream.ndjson")
        result = self.drive("test", agent=None, env={"CRUCIBLE_STREAM": exported})
        self.assertEqual([c["has_stream"] for c in self.make_calls()], [False],
                         self.where(result))
        self.assertFalse(os.path.exists(exported), "the harness wrote no stream")


class EveryTestVerbStreamsADeclaredTargetTest(_DeclaredProject):

    def test_test_unit_and_regression_stream_the_declared_junit_target(self):
        for verb in ("test", "unit", "regression"):
            with self.subTest(verb=verb):
                Path(self.logs, "make.jsonl").unlink(missing_ok=True)
                self.fresh_board()
                result = self.drive(verb)
                self.assert_streamed(result, verb)

    def test_each_declared_tier_verb_streams_its_declared_tier_target(self):
        self.declare({f"tests/native-tiers/junit-{tier}": ENTRY for tier in TIERS})
        for tier in TIERS:
            with self.subTest(verb=tier):
                Path(self.logs, "make.jsonl").unlink(missing_ok=True)
                self.fresh_board()
                result = self.drive(tier, "--dir", "tests/native-tiers")
                self.assert_streamed(result, tier)
                self.assertEqual(self.make_calls()[0]["argv"], [f"junit-{tier}"])

    def test_the_pre_merge_gate_compiles_then_streams_its_regression(self):
        result = self.drive("pre-merge-gate")
        self.assertEqual(len(self.cli_calls()), 1, f"the compile step ran; {self.where(result)}")
        self.assert_streamed(result, "pre-merge-gate")
        self.assertEqual(self.posts_to(COMPILE), [])

    def test_the_client_appends_one_run_end_stating_the_junits_totals(self):
        for variant, totals in (("pass", (3, 3, 0, 0)), ("fail", (3, 2, 1, 0))):
            with self.subTest(variant=variant):
                self.fresh_board()
                self.drive("test", FAKE_VARIANT=variant)
                lines = [json.loads(line) for line in
                         self.board.held_stream("run-live-1").splitlines() if line]
                kinds = [line.get("event") for line in lines]
                self.assertEqual(kinds, ["test-end"] * 3 + ["run-end"], f"lines={lines!r}")
                self.assertEqual(tuple(lines[-1].get(k) for k in
                                       ("total", "passed", "failed", "pending")), totals)

    def test_the_heartbeat_counts_the_streams_test_ends_not_unitys_lines(self):
        result = self.drive("test", FAKE_STREAM="two")
        closing = [m for m in self.heartbeats() if isinstance(m, str) and m.startswith("ran ")]
        self.assertEqual(len(closing), 1, f"heartbeats={self.heartbeats()!r} {self.where(result)}")
        self.assertTrue(closing[0].startswith("ran 2/"),
                        f"the closing count is the stream's two test-ends, not Unity's three "
                        f"PASS lines; heartbeats={self.heartbeats()!r}")


# ── a declared run with no stream is not hidden ─────────────────────────────

class ADeclaredRunWithNoStreamIsNotHiddenTest(_DeclaredProject):

    def assert_filed_from_junit(self, result, where, key="tests/native/junit"):
        detail = f"{where}: {self.where(result)}"
        closes = self.posts_to(RUNS)
        self.assertEqual([c.get("codec") for c in closes], ["junit"],
                         f"the run is filed from its TEST-*.xml; {detail}")
        self.assertEqual(closes[0].get("data"), [self.junit_text()], detail)
        axi = _envelope(result.stdout) or {}
        named = [w for w in axi.get("warnings") or []
                 if isinstance(w, dict) and key in str(w.get("detail"))]
        self.assertEqual(len(named), 1, f"one warning names the declared key; {detail}")
        self.assertIn("stream", str(named[0].get("detail")).lower(), detail)

    def test_an_empty_stream_file_is_filed_from_its_junit_with_one_warning(self):
        result = self.drive("test", FAKE_STREAM="none")
        self.assert_filed_from_junit(result, "empty stream")
        self.assertEqual(result.returncode, 0, "a green runner exits 0")

    def test_an_empty_stream_over_a_failing_runner_exits_with_the_runners_failure(self):
        result = self.drive("test", FAKE_STREAM="none", FAKE_VARIANT="fail")
        self.assert_filed_from_junit(result, "empty stream, failing runner")
        self.assertEqual(result.returncode, 1, self.where(result))

    def test_a_stream_the_board_stopped_taking_is_filed_from_its_junit(self):
        self.fresh_board(RecordingBoard(stream_route=False))
        result = self.drive("test")
        self.assert_filed_from_junit(result, "relay stopped")
        self.assertEqual(result.returncode, 0, self.where(result))

    def test_a_build_failure_is_the_no_report_envelope_as_an_undeclared_one_with_no_compile(self):
        outcomes = {}
        for label, sub in (("declared", "tests/native"), ("undeclared", "tests/native-b")):
            self.fresh_board()
            result = self.drive("test", "--dir", sub, FAKE_BUILD_FAIL="1")
            axi = _envelope(result.stdout) or {}
            outcomes[label] = (result.returncode, axi.get("ok"), sorted(map(str, _codes(axi))),
                               len(self.board.aborts()))
            self.assertEqual(self.posts_to(COMPILE), [], f"{label}: no compile ingest")
            self.assertEqual(self.posts_to(RUNS), [], f"{label}: nothing filed")
        self.assertEqual(outcomes["declared"], outcomes["undeclared"])
        self.assertIs(outcomes["declared"][1], False)

    def test_a_narrowed_run_whose_stream_holds_no_test_end_ran_nothing(self):
        result = self.drive("test", "--tests", "test_motor", FAKE_STREAM="none",
                            FAKE_JUNIT="other")
        axi = _envelope(result.stdout) or {}
        self.assertIs(axi.get("ok"), False, self.where(result))
        self.assertEqual(self.posts_to(RUNS), [], f"nothing is filed; {self.where(result)}")
        self.assertEqual(len(self.board.aborts()), 1, "the open run is aborted")
        self.assertIn("makefile-ignored-tests", _codes(axi),
                      "the narrowing warning still reads the JUnit")
        self.assertNotEqual(result.returncode, 0)

    def test_a_run_the_board_opened_none_for_is_filed_single_shot_with_one_warning(self):
        self.board.refuse_next_start(error="runs are paused")
        result = self.drive("test")
        closes = self.posts_to(RUNS)
        self.assertEqual([(c.get("codec"), c.get("runId")) for c in closes], [("junit", None)],
                         self.where(result))
        self.assertEqual(closes[0].get("data"), [self.junit_text()])
        self.assertEqual(self.board.stream_posts(), [])
        self.assertEqual(_codes(_envelope(result.stdout)), ["run-lifecycle-unavailable"],
                         self.where(result))


# ── the declaration is read and refused as specified ─────────────────────────

class ADeclarationAtFaultIsRefusedBeforeAnythingRunsTest(_DeclaredProject):

    def test_each_entry_at_fault_under_the_runs_key_is_refused_naming_key_and_field(self):
        for label, body, named in REFUSED_ENTRIES:
            with self.subTest(entry=label):
                Path(self.logs, "make.jsonl").unlink(missing_ok=True)
                self.fresh_board()
                self.declare({"tests/native/junit": body})
                result = self.drive("test")
                self.assert_refused_before_anything(result, label, "tests/native/junit", *named)

    def test_unit_regression_and_the_pre_merge_gate_refuse_before_the_compile(self):
        self.declare({"tests/native/junit": REFUSED_ENTRIES[0][1]})
        for verb, extra in (("unit", ()), ("regression", ("--coverage",)),
                            ("pre-merge-gate", ())):
            with self.subTest(verb=verb):
                self.fresh_board()
                result = self.drive(verb, *extra)
                self.assert_refused_before_anything(result, verb, "tests/native/junit",
                                                    "framework")

    def test_a_tier_verb_refuses_its_own_key_at_fault(self):
        self.declare({"tests/native-tiers/junit-integration": REFUSED_ENTRIES[3][1]})
        result = self.drive("integration", "--dir", "tests/native-tiers")
        self.assert_refused_before_anything(result, "integration",
                                            "tests/native-tiers/junit-integration", "stdout")

    def test_a_project_file_that_does_not_parse_is_refused(self):
        self.copied_install(f"[client]\nurl = {json.dumps(self.board.url)}\n")
        Path(self.project, "crucible.toml").write_text('[targets."tests/native/junit"\n')
        for verb in ("test", "pre-merge-gate"):
            with self.subTest(verb=verb):
                result = self.drive(verb)
                self.assert_refused_before_anything(result, verb, "crucible.toml")

    def test_a_board_listing_no_crucible_events_stream_codec_is_refused(self):
        health = self.board.default_health()
        health["codecs"]["stream"] = [c for c in health["codecs"]["stream"] if c != STREAM_CODEC]
        for verb in ("test", "pre-merge-gate"):
            with self.subTest(verb=verb):
                self.fresh_board().script_health(health)
                result = self.drive(verb)
                self.assert_refused_before_anything(result, verb, STREAM_CODEC,
                                                    "codecs.stream", health_read=True)

    def test_a_declared_coverage_run_on_a_board_listing_no_lcov_is_refused(self):
        health = self.board.default_health()
        health["codecs"]["coverage"] = [c for c in health["codecs"]["coverage"] if c != "lcov"]
        for verb, extra in (("regression", ("--coverage",)), ("pre-merge-gate", ())):
            with self.subTest(verb=verb):
                self.fresh_board().script_health(health)
                result = self.drive(verb, *extra)
                self.assert_refused_before_anything(result, verb, "lcov", health_read=True)

    def test_a_declared_run_without_coverage_is_not_refused_for_lacking_lcov(self):
        health = self.board.default_health()
        health["codecs"]["coverage"] = [c for c in health["codecs"]["coverage"] if c != "lcov"]
        self.board.script_health(health)
        result = self.drive("test")
        self.assert_streamed(result, "test, no coverage")

    def test_an_unreadable_health_refuses_nothing(self):
        self.board.fail_health()
        result = self.drive("test")
        calls = self.make_calls()
        self.assertEqual(len(calls), 1, f"make ran; {self.where(result)}")
        self.assertTrue(calls[0]["has_stream"], self.where(result))


class OnlyTheRunsOwnArduinoEntryDeclaresItTest(_DeclaredProject):

    def test_of_two_native_dirs_with_a_junit_target_only_the_declared_one_streams(self):
        result = self.drive("test", "--dir", "tests/native")
        self.assert_streamed(result, "declared tests/native")
        Path(self.logs, "make.jsonl").unlink()
        self.fresh_board()
        result = self.drive("test", "--dir", "tests/native-b")
        self.assert_ran_undeclared(result, "undeclared tests/native-b")

    def test_an_entry_at_fault_under_another_key_refuses_nothing(self):
        self.declare({"tests/native/junit": ENTRY,
                      "tests/native-b/junit": REFUSED_ENTRIES[1][1]})
        result = self.drive("test")
        self.assert_streamed(result, "a faulty entry for tests/native-b")

    def test_another_stacks_entry_under_the_runs_key_is_skipped_not_refused(self):
        for body in OTHER_STACKS:
            with self.subTest(entry=body.splitlines()[0]):
                Path(self.logs, "make.jsonl").unlink(missing_ok=True)
                self.fresh_board()
                self.declare({"tests/native/junit": body})
                result = self.drive("test")
                self.assertEqual(result.returncode, 0, self.where(result))
                self.assert_ran_undeclared(result, body)

    def test_a_project_with_no_crucible_toml_runs_undeclared_whatever_the_install_declares(self):
        self.copied_install(f"[client]\nurl = {json.dumps(self.board.url)}\n"
                            f'\n[targets."tests/native/junit"]\n{ENTRY}')
        Path(self.project, "crucible.toml").unlink()
        result = self.drive("test")
        self.assert_ran_undeclared(result, "no project crucible.toml")

    def test_an_undeclared_target_posts_what_a_project_declaring_nothing_posts(self):
        observed = {}
        for label, entries in (("declaring nothing", {}),
                               ("declaring another dir", {"tests/native/junit": ENTRY})):
            self.declare(entries)
            self.fresh_board()
            result = self.drive("test", "--dir", "tests/native-b")
            axi = _envelope(result.stdout) or {}
            closes = self.posts_to(RUNS)
            observed[label] = {
                "exit": result.returncode,
                "paths": [p for p, _b in self.board.posts() if p != HEARTBEAT],
                "starts": self.starts(),
                "close": [{k: c.get(k) for k in ("codec", "data", "raw", "runnerExit",
                                                 "tier", "framework")} for c in closes],
                "envelope": {k: axi.get(k) for k in ("ok", "run", "warnings", "help")},
                "narration": self.heartbeats()[-2:],
            }
        self.assertEqual(observed["declaring another dir"], observed["declaring nothing"])
        self.assertEqual(observed["declaring nothing"]["narration"][0], "ran 3/3",
                         "the Unity narrator counts the three PASS lines")


if __name__ == "__main__":
    unittest.main()
