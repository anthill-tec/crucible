"""An arduino `test`/`unit` run narrowed by `--tests` and `--name` reaches
`make`, and only those flags ever narrow a run.

`arduino-crucible.py test` and `unit` take two narrowing flags:

  * `--tests <stem> [<stem> ...]` — the test files to run, by stem, handed to
    `make` as `TESTS="<stem> <stem>"`;
  * `--name <names>` — comma-separated test-name fragments, handed to `make`
    as `TEST_NAME`, which a Makefile passes to each Unity binary as `-f`.

The client owns both variables: it sets them from its flags (with or without
an own reports directory) and removes them from `make`'s environment on every
other native run — `test`/`unit` without the flags, `regression`, the
pre-merge gate and a declared tier verb — so a variable exported in the shell
never narrows a run.

Ill-formed narrowing input is the typed `narrowing-refused` hard stop, decided
before anything reaches the board (no registration heartbeat, no run start,
no ingest) and ahead of the unattributed-run refusal: one `ok:false` envelope
with `error` and `help[]`, a non-zero exit, `make` never run. A bare `--tests`
is argparse's own usage error (exit 2), as on bun.

A narrowed run whose reports hold zero cases is the ran-nothing failure even
when `make` exits 0 (Unity with a `-f` that matches nothing does): the open
run is aborted, nothing is filed, the exit is non-zero. An unnarrowed
zero-case run that exits 0 is filed as before.

Every case drives the real `clients/arduino-crucible.py` as a subprocess over
a scratch firmware project whose `tests/native/Makefile` runs a small python
stand-in for the Unity binaries. The stand-in reads a fixed catalogue of
cases, honours `TESTS` and `TEST_NAME` the way the documented contract asks
(stems from `TESTS`; Unity's name-or-file contains-match for `TEST_NAME`),
appends what it saw — whether each variable was present, and the value the
test itself set — to a record file, and writes one combined JUnit report
whose cases carry the file stem as `classname` and the test function as
`name` (Unity's stylizer shape). The board is steered only by the scratch
project's own `crucible.toml`: a REAL throwaway board where the stored run is
read back, a recording stand-in where the requests are counted, and a
stand-in that reports an active cycle for the refusals.

Invocation:
    python3 -m unittest tests.client.test_an_arduino_run_narrowed_by_tests_and_name_reaches_make -v
"""

import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    INGEST_PATHS,
    START,
    RecordingBoard,
    install_project,
    load_toon,
    new_scratch,
    scrubbed_env,
)
from tests.client.real_board import RealBoard

TOON = load_toon()
ARDUINO_CLIENT = CLIENTS / "arduino-crucible.py"
TIMEOUT = 120
NATIVE_DIR = "tests/native"
PARSED_INGEST = "/api/v2/runs/parsed"

REFUSED_CODE = "narrowing-refused"
UNATTRIBUTED_CODE = "unattributed-run-refused"
RAN_NOTHING_CODE = "no-test-reports"
STEM_HINT = "give a stem, not a path or file name"
NAME_HINT = "--name takes comma-separated test-name fragments"

# Keys that would let the shell running this suite steer or identify the
# client, plus the two narrowing variables, which a test sets only on purpose.
_SCRUBBED = ("ARDUINO_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY", "AGENT_ID", "TESTS", "TEST_NAME")

#: The fixture project's test files and their test functions.
CATALOGUE = (
    ("test_a", "test_stall_detected"),
    ("test_a", "test_init"),
    ("test_b", "test_limit_clamped"),
    ("test_b", "test_reset"),
    ("test_c", "test_stall_recovery"),
    ("test_c", "test_speed"),
)

#: `--tests test_a test_b`: every case of those two files, and no other.
ONLY_A_AND_B = {"test_a": ["test_init", "test_stall_detected"],
                "test_b": ["test_limit_clamped", "test_reset"]}
#: `--name stall,limit`: the cases whose name or file contains either element.
ONLY_STALL_OR_LIMIT = {"test_a": ["test_stall_detected"],
                       "test_b": ["test_limit_clamped"],
                       "test_c": ["test_stall_recovery"]}

# The stand-in for the native test binaries a Makefile runs. Its first
# argument is the make target that ran it.
_FAKE_NATIVE = r'''
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
target = sys.argv[1] if len(sys.argv) > 1 else "?"
tests = os.environ.get("TESTS")
names = os.environ.get("TEST_NAME")
with open(os.path.join(here, "make_runs.jsonl"), "a") as handle:
    handle.write(json.dumps({
        "target": target,
        "tests_present": "TESTS" in os.environ, "tests": tests,
        "test_name_present": "TEST_NAME" in os.environ, "test_name": names,
    }) + "\n")
with open(os.path.join(here, "catalogue.json")) as handle:
    catalogue = json.load(handle)

selected = []
for stem, name in catalogue:
    if tests is not None and stem not in tests.split():
        continue
    if names is not None:
        elements = [e.split("*", 1)[0] for e in names.split(",")]
        if not any(e in name or e in stem for e in elements):
            continue
    selected.append((stem, name))

for line, (stem, name) in enumerate(selected, start=10):
    sys.stdout.write("test/%s.c:%d:%s:PASS\n" % (stem, line, name))
sys.stdout.write("-----------------------\n%d Tests 0 Failures 0 Ignored\nOK\n"
                 % len(selected))
sys.stdout.flush()

reports_dir = os.environ.get("REPORTS_DIR") or "reports"
os.makedirs(reports_dir, exist_ok=True)
if selected:
    suites = []
    for stem in sorted({s for s, _ in selected}):
        cases = [n for s, n in selected if s == stem]
        suites.append(
            '<testsuite name="%s" tests="%d" failures="0">%s</testsuite>'
            % (stem, len(cases), "".join(
                '<testcase classname="%s" name="%s" time="0.001"/>' % (stem, n)
                for n in cases)))
    body = "<testsuites>%s</testsuites>" % "".join(suites)
else:
    body = '<testsuite name="native" tests="0" failures="0"></testsuite>'
with open(os.path.join(reports_dir, "TEST-native.xml"), "w") as handle:
    handle.write('<?xml version="1.0"?>' + body)
sys.exit(0)
'''


def _envelope_count(stdout):
    return len(re.findall(r"(?m)^axi:", stdout or ""))


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={(result.stdout or '')[:1500]!r} "
            f"stderr={(result.stderr or '')[-2000:]!r}")


class ActiveCycleBoard:
    """A loopback stand-in board that records EVERY request (GET and POST)
    and answers that the project has one active cycle while the agent asking
    is bound to none — the board state that makes an unbound run with no
    `--cycle` the unattributed-run refusal."""

    ACTIVE_CYCLE_ID = 4242

    def __init__(self):
        self.requests = []
        self._lock = threading.Lock()
        board = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _reply(self, payload):
                encoded = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                with board._lock:
                    board.requests.append(("GET", self.path))
                if "/plans" in self.path:
                    self._reply({"ok": True, "plans": [{
                        "id": 1, "status": "open",
                        "cycles": [{"id": board.ACTIVE_CYCLE_ID,
                                    "status": "active"}]}]})
                elif "/agents" in self.path:
                    self._reply({"ok": True, "agents": []})
                else:
                    self._reply({"ok": True})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                with board._lock:
                    board.requests.append(("POST", self.path))
                if self.path == START:
                    self._reply({"ok": True, "changed": True,
                                 "runId": "run-active-cycle-1"})
                else:
                    self._reply({"ok": True, "changed": True})

            def do_PATCH(self):
                self.do_POST()

            def log_message(self, format, *args):
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        daemon=True)
        self._thread.start()

    def seen(self):
        with self._lock:
            return list(self.requests)

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


_REAL_BOARD = None


def _real_board():
    """The module's one throwaway REAL board, booted on first use."""
    global _REAL_BOARD
    if _REAL_BOARD is None:
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the run a narrowed run filed is read back from a REAL board, "
                "and without `bun` there is none to boot — a missing "
                "toolchain, not a passing assertion")
        _REAL_BOARD = RealBoard(bun, "arduino-narrowed-run")
    return _REAL_BOARD


def tearDownModule():
    global _REAL_BOARD
    if _REAL_BOARD is not None:
        _REAL_BOARD.close()
        _REAL_BOARD = None


class _NarrowingProject:
    """A scratch firmware project whose Makefile runs the stand-in native
    binaries, driven through the real client."""

    VERB = ""

    def make_project(self, *, declare_integration=False, catalogue=CATALOGUE):
        self.project = new_scratch("arduino-narrowed-run-")
        self.addCleanup(shutil.rmtree, self.project, True)  # type: ignore[attr-defined]
        self.native_dir = os.path.join(self.project, *NATIVE_DIR.split("/"))
        os.makedirs(self.native_dir)
        Path(self.native_dir, "run_native.py").write_text(_FAKE_NATIVE)
        Path(self.native_dir, "catalogue.json").write_text(
            json.dumps([list(case) for case in catalogue]))
        targets = ["junit"] + (["junit-integration"] if declare_integration else [])
        Path(self.native_dir, "Makefile").write_text(
            ".PHONY: " + " ".join(targets) + "\n" + "".join(
                f"{t}:\n\t{sys.executable} run_native.py {t}\n" for t in targets))

    def drive(self, verb, *extra, agent=None, client_env=None):
        env = scrubbed_env()
        for key in _SCRUBBED:
            env.pop(key, None)
        env.update(client_env or {})
        cmd = [sys.executable, str(ARDUINO_CLIENT), verb,
               "--project-dir", self.project, "--dir", NATIVE_DIR,
               *(["--agent", agent] if agent else []), *extra]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def make_runs(self):
        """Every `make` run the stand-in recorded, in order."""
        path = Path(self.native_dir, "make_runs.jsonl")
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()
                if line.strip()]

    def the_one_make_run(self, result):
        runs = self.make_runs()
        self.assertEqual(  # type: ignore[attr-defined]
            len(runs), 1,
            f"`make` runs exactly once for one {self.VERB or 'verb'} run; "
            f"recorded runs={runs!r} {_diagnostics(result)}")
        return runs[0] if runs else {}

    def envelope_of(self, result):
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(  # type: ignore[attr-defined]
            envelope, f"stdout is one TOON envelope; {_diagnostics(result)}")
        return envelope or {}

    def assert_saw_neither(self, record, result):
        self.assertEqual(  # type: ignore[attr-defined]
            (record.get("tests_present"), record.get("test_name_present")),
            (False, False),
            f"`make` runs with neither TESTS nor TEST_NAME in its environment "
            f"unless the client's own flag set it; recorded={record!r} "
            f"{_diagnostics(result)}")


def _tree_cases(tree):
    """`{suite name: sorted case names}` of a filed tree."""
    return {suite.get("name"): sorted(c.get("name") for c in
                                      (suite.get("children") or []))
            for suite in (tree or [])}


# ── the flags reach `make`, and the run filed holds only their cases ───────

class _NarrowedRunFiled(_NarrowingProject):
    """`--tests` and `--name` reach `make` and narrow the run the REAL board
    stores; without an own reports directory they reach `make` all the same."""

    def setUp(self):
        self.make_project()

    def drive_filed(self, *extra, agent):
        board = _real_board()
        board.install(self.project)
        return board, self.drive(self.VERB, *extra, agent=agent)

    def the_one_stored_run(self, board, agent, result):
        events = board.test_events(agent)
        self.assertEqual(  # type: ignore[attr-defined]
            len(events), 1,
            f"exactly one test run is filed for this agent; events={events!r} "
            f"{_diagnostics(result)}")
        return board.event(events[0]["id"]) if events else {}

    def drive_without_own_reports(self, *extra):
        board = RecordingBoard()
        self.addCleanup(board.close)  # type: ignore[attr-defined]
        install_project(self.project, board.url, "arduino-narrowed-no-own-dir")
        result = self.drive(self.VERB, *extra)
        return board, result

    def test_tests_flag_reaches_make_and_the_filed_run_holds_only_those_files(self):
        agent = f"ard-narrow-{self.VERB}-tests-filed"
        board, result = self.drive_filed("--tests", "test_a", "test_b", agent=agent)
        record = self.the_one_make_run(result)
        self.assertEqual(  # type: ignore[attr-defined]
            (record.get("tests"), record.get("test_name_present")),
            ("test_a test_b", False),
            f"`--tests test_a test_b` runs `make` with TESTS=\"test_a test_b\" "
            f"and no TEST_NAME; recorded={record!r} {_diagnostics(result)}")
        self.assertEqual(result.returncode, 0,  # type: ignore[attr-defined]
                         _diagnostics(result))
        event = self.the_one_stored_run(board, agent, result)
        self.assertEqual(  # type: ignore[attr-defined]
            _tree_cases(event.get("tree")), ONLY_A_AND_B,
            f"the stored run holds only test_a's and test_b's cases; "
            f"tree={event.get('tree')!r}")
        summary = event.get("summary") or {}
        self.assertEqual(  # type: ignore[attr-defined]
            (summary.get("total"), summary.get("passed"), summary.get("failed")),
            (4, 4, 0), f"stored summary={summary!r}")

    def test_name_flag_reaches_make_and_the_filed_run_holds_only_matching_cases(self):
        agent = f"ard-narrow-{self.VERB}-name-filed"
        board, result = self.drive_filed("--name", "stall,limit", agent=agent)
        record = self.the_one_make_run(result)
        self.assertEqual(  # type: ignore[attr-defined]
            (record.get("test_name"), record.get("tests_present")),
            ("stall,limit", False),
            f"`--name stall,limit` runs `make` with TEST_NAME=\"stall,limit\" "
            f"and no TESTS; recorded={record!r} {_diagnostics(result)}")
        self.assertEqual(result.returncode, 0,  # type: ignore[attr-defined]
                         _diagnostics(result))
        event = self.the_one_stored_run(board, agent, result)
        self.assertEqual(  # type: ignore[attr-defined]
            _tree_cases(event.get("tree")), ONLY_STALL_OR_LIMIT,
            f"the stored run holds only the cases whose name or file contains "
            f"`stall` or `limit`; tree={event.get('tree')!r}")
        summary = event.get("summary") or {}
        self.assertEqual(  # type: ignore[attr-defined]
            (summary.get("total"), summary.get("passed"), summary.get("failed")),
            (3, 3, 0), f"stored summary={summary!r}")

    def test_tests_flag_reaches_make_without_an_own_reports_directory(self):
        board, result = self.drive_without_own_reports("--tests", "test_a", "test_b")
        record = self.the_one_make_run(result)
        self.assertEqual(  # type: ignore[attr-defined]
            (record.get("tests"), record.get("test_name_present")),
            ("test_a test_b", False),
            f"with no --agent and no --reports, `--tests test_a test_b` still "
            f"runs `make` with TESTS=\"test_a test_b\"; recorded={record!r} "
            f"{_diagnostics(result)}")
        self.assertEqual(result.returncode, 0,  # type: ignore[attr-defined]
                         _diagnostics(result))
        self.assertRegex(  # type: ignore[attr-defined]
            result.stderr, r"\b4/4 passed, 0 failed\b",
            f"the run's own summary counts only test_a's and test_b's four "
            f"cases; {_diagnostics(result)}")
        self.assertEqual(  # type: ignore[attr-defined]
            [p for p, _ in board.posts() if p in INGEST_PATHS], [],
            "a run without --agent files nothing")

    def test_name_flag_reaches_make_without_an_own_reports_directory(self):
        board, result = self.drive_without_own_reports("--name", "stall,limit")
        record = self.the_one_make_run(result)
        self.assertEqual(  # type: ignore[attr-defined]
            (record.get("test_name"), record.get("tests_present")),
            ("stall,limit", False),
            f"with no --agent and no --reports, `--name stall,limit` still runs "
            f"`make` with TEST_NAME=\"stall,limit\"; recorded={record!r} "
            f"{_diagnostics(result)}")
        self.assertEqual(result.returncode, 0,  # type: ignore[attr-defined]
                         _diagnostics(result))
        self.assertRegex(  # type: ignore[attr-defined]
            result.stderr, r"\b3/3 passed, 0 failed\b",
            f"the run's own summary counts only the three matching cases; "
            f"{_diagnostics(result)}")
        self.assertEqual(  # type: ignore[attr-defined]
            [p for p, _ in board.posts() if p in INGEST_PATHS], [],
            "a run without --agent files nothing")


class TestVerbNarrowedRunFiledTest(_NarrowedRunFiled, unittest.TestCase):
    VERB = "test"


class UnitVerbNarrowedRunFiledTest(_NarrowedRunFiled, unittest.TestCase):
    VERB = "unit"


# ── ill-formed narrowing input is refused before anything reaches the board ─

class _NarrowingRefused(_NarrowingProject):
    """Each ill-formed input is the typed `narrowing-refused` hard stop. Every
    case runs with `--agent` and no `--cycle` against a board reporting an
    active cycle, so a check placed after the board is consulted would surface
    as a request, or as the unattributed-run refusal instead."""

    def setUp(self):
        self.make_project()
        self.board = ActiveCycleBoard()
        self.addCleanup(self.board.close)  # type: ignore[attr-defined]
        install_project(self.project, self.board.url, "arduino-narrowing-refused")

    def refused(self, case, *narrowing, hint):
        agent = f"ard-refuse-{self.VERB}-{case}"
        result = self.drive(self.VERB, *narrowing, agent=agent)
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(  # type: ignore[attr-defined]
            envelope,
            f"{narrowing!r} is the typed {REFUSED_CODE} hard stop, which "
            f"prints an envelope — not argparse's usage error; "
            f"{_diagnostics(result)}")
        envelope = envelope or {}
        self.assertEqual(  # type: ignore[attr-defined]
            _envelope_count(result.stdout), 1,
            f"exactly one envelope; {_diagnostics(result)}")
        self.assertEqual(  # type: ignore[attr-defined]
            (envelope.get("verb"), envelope.get("ok")), (self.VERB, False),
            f"an ok:false {self.VERB} envelope; envelope={envelope!r}")
        self.assertIn(REFUSED_CODE, result.stderr,  # type: ignore[attr-defined]
                      f"the refusal names its code; {_diagnostics(result)}")
        self.assertNotIn(UNATTRIBUTED_CODE, result.stderr,  # type: ignore[attr-defined]
                         f"the narrowing refusal comes before the unattributed-"
                         f"run refusal; {_diagnostics(result)}")
        error = envelope.get("error")
        self.assertIsInstance(error, str,  # type: ignore[attr-defined]
                              f"the refusal states an error; envelope={envelope!r}")
        self.assertTrue((error or "").strip(),  # type: ignore[attr-defined]
                        f"envelope={envelope!r}")
        help_steps = envelope.get("help")
        self.assertIsInstance(help_steps, list,  # type: ignore[attr-defined]
                              f"the refusal states help[]; envelope={envelope!r}")
        help_text = " ".join(str(h) for h in (help_steps or [])).replace("`", "")
        self.assertIn(hint, help_text.lower(),  # type: ignore[attr-defined]
                      f"help[] names the fix; help={help_steps!r}")
        self.assertNotEqual(result.returncode, 0,  # type: ignore[attr-defined]
                            f"a refusal exits non-zero; {_diagnostics(result)}")
        self.assertEqual(  # type: ignore[attr-defined]
            self.board.seen(), [],
            f"refused before anything reaches the board — no registration "
            f"heartbeat, no run start, no ingest; {_diagnostics(result)}")
        self.assertEqual(  # type: ignore[attr-defined]
            self.make_runs(), [], f"`make` never runs; {_diagnostics(result)}")

    def test_a_stem_with_a_path_is_refused(self):
        self.refused("path-stem", "--tests", "src/test_a", hint=STEM_HINT)

    def test_a_stem_with_an_extension_is_refused(self):
        self.refused("extension-stem", "--tests", "test_a.c", hint=STEM_HINT)

    def test_a_stem_outside_the_stem_characters_is_refused(self):
        self.refused("bad-char-stem", "--tests", "bad stem!", hint=STEM_HINT)

    def test_an_empty_name_is_refused(self):
        self.refused("empty-name", "--name", "", hint=NAME_HINT)

    def test_a_name_with_an_empty_element_is_refused(self):
        self.refused("empty-element", "--name", "stall,,limit", hint=NAME_HINT)

    def test_a_name_element_with_a_colon_is_refused(self):
        self.refused("colon-element", "--name", "a:b", hint=NAME_HINT)

    def test_a_name_element_with_a_space_is_refused(self):
        self.refused("space-element", "--name", "a b", hint=NAME_HINT)

    def test_a_bare_tests_flag_is_argparses_usage_error(self):
        result = self.drive(self.VERB, "--tests",
                            agent=f"ard-refuse-{self.VERB}-bare-tests")
        self.assertEqual(result.returncode, 2,  # type: ignore[attr-defined]
                         f"a bare --tests is argparse's usage error; "
                         f"{_diagnostics(result)}")
        self.assertIn(  # type: ignore[attr-defined]
            "argument --tests: expected at least one argument", result.stderr,
            f"argparse rejects --tests for its missing value, as bun does — "
            f"not as an unknown flag; {_diagnostics(result)}")
        self.assertEqual(self.board.seen(), [],  # type: ignore[attr-defined]
                         f"nothing reaches the board; {_diagnostics(result)}")
        self.assertEqual(self.make_runs(), [],  # type: ignore[attr-defined]
                         f"`make` never runs; {_diagnostics(result)}")

    def test_guard_an_unnarrowed_run_on_this_board_is_the_unattributed_refusal(self):
        """GUARD — the stand-in's active cycle is what makes the refusal
        ordering observable: an unnarrowed run with no `--cycle` against it is
        the unattributed-run refusal, and `make` never runs."""
        result = self.drive(self.VERB, agent=f"ard-refuse-{self.VERB}-guard")
        self.assertIn(UNATTRIBUTED_CODE, result.stderr,  # type: ignore[attr-defined]
                      f"an unbound run with no --cycle while cycle "
                      f"{ActiveCycleBoard.ACTIVE_CYCLE_ID} is active is "
                      f"refused; {_diagnostics(result)}")
        self.assertNotEqual(result.returncode, 0,  # type: ignore[attr-defined]
                            _diagnostics(result))
        self.assertEqual(self.make_runs(), [],  # type: ignore[attr-defined]
                         _diagnostics(result))


class TestVerbNarrowingRefusedTest(_NarrowingRefused, unittest.TestCase):
    VERB = "test"


class UnitVerbNarrowingRefusedTest(_NarrowingRefused, unittest.TestCase):
    VERB = "unit"


# ── a narrowed run that ran nothing fails ───────────────────────────────────

class _NarrowedRunThatRanNothing(_NarrowingProject):
    """A narrowed run whose Makefile exits 0 over a zero-case report is the
    ran-nothing failure; an unnarrowed one is filed as before."""

    def setUp(self):
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)  # type: ignore[attr-defined]

    def install(self):
        install_project(self.project, self.board.url, "arduino-narrowed-ran-nothing")

    def test_a_narrowed_run_that_matches_nothing_fails_and_files_nothing(self):
        self.make_project()
        self.install()
        result = self.drive(self.VERB, "--name", "nomatch",
                            agent=f"ard-ran-nothing-{self.VERB}-narrowed")
        record = self.the_one_make_run(result)
        self.assertEqual(  # type: ignore[attr-defined]
            record.get("test_name"), "nomatch",
            f"`make` ran narrowed by TEST_NAME=\"nomatch\"; recorded={record!r} "
            f"{_diagnostics(result)}")
        envelope = self.envelope_of(result)
        self.assertEqual(  # type: ignore[attr-defined]
            (envelope.get("verb"), envelope.get("ok")), (self.VERB, False),
            f"a narrowed run that ran nothing is ok:false even though `make` "
            f"exited 0; envelope={envelope!r}")
        ran_nothing = [w for w in (envelope.get("warnings") or [])
                       if isinstance(w, dict) and w.get("code") == RAN_NOTHING_CODE]
        self.assertEqual(  # type: ignore[attr-defined]
            len(ran_nothing), 1,
            f"exactly one {RAN_NOTHING_CODE} (ran-nothing) warning; "
            f"warnings={envelope.get('warnings')!r}")
        posts = self.board.posts()
        self.assertEqual(  # type: ignore[attr-defined]
            [p for p, _ in posts if p in INGEST_PATHS], [],
            f"nothing is filed; posts={[p for p, _ in posts]!r}")
        starts = [p for p, _ in posts if p == START]
        self.assertEqual(  # type: ignore[attr-defined]
            (len(starts), len(self.board.aborts())), (1, 1),
            f"the one run opened before `make` is aborted; "
            f"posts={[p for p, _ in posts]!r}")
        self.assertNotEqual(result.returncode, 0,  # type: ignore[attr-defined]
                            f"a narrowed run that ran nothing exits non-zero; "
                            f"{_diagnostics(result)}")

    def test_guard_an_unnarrowed_zero_case_run_that_exits_0_is_filed_as_before(self):
        """GUARD — no narrowing flag: a zero-case report from a `make` that
        exited 0 is filed, and the verb exits 0."""
        self.make_project(catalogue=())
        self.install()
        result = self.drive(self.VERB, agent=f"ard-ran-nothing-{self.VERB}-guard")
        self.assertEqual(result.returncode, 0, _diagnostics(result))  # type: ignore[attr-defined]
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), True,  # type: ignore[attr-defined]
                      f"envelope={envelope!r}")
        ingests = [b for p, b in self.board.posts() if p == PARSED_INGEST]
        self.assertEqual(len(ingests), 1,  # type: ignore[attr-defined]
                         f"exactly one ingest; {_diagnostics(result)}")
        summary = (ingests[0] or {}).get("summary") if ingests else {}
        self.assertEqual((summary or {}).get("total"), 0,  # type: ignore[attr-defined]
                         f"the zero-case run is filed as it ran; summary={summary!r}")
        self.assertEqual(self.board.aborts(), [],  # type: ignore[attr-defined]
                         "a filed run is never aborted")


class TestVerbNarrowedRunThatRanNothingTest(_NarrowedRunThatRanNothing,
                                            unittest.TestCase):
    VERB = "test"


class UnitVerbNarrowedRunThatRanNothingTest(_NarrowedRunThatRanNothing,
                                            unittest.TestCase):
    VERB = "unit"


# ── a TESTS / TEST_NAME exported in the shell never reaches `make` ──────────

class AShellNarrowingVariableNeverReachesMakeTest(_NarrowingProject,
                                                  unittest.TestCase):
    """With TESTS and TEST_NAME set in the client's own environment, every
    native run without the flags runs `make` with neither — and so runs the
    whole catalogue."""

    SHELL_NARROWING = {"TESTS": "test_c", "TEST_NAME": "speed"}

    def setUp(self):
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)

    def assert_unnarrowed(self, verb, *extra, declare_integration=False):
        self.VERB = verb
        self.make_project(declare_integration=declare_integration)
        install_project(self.project, self.board.url, "arduino-shell-narrowing")
        result = self.drive(verb, *extra, agent=f"ard-shell-{verb}",
                            client_env=self.SHELL_NARROWING)
        record = self.the_one_make_run(result)
        self.assert_saw_neither(record, result)
        ingests = [b for p, b in self.board.posts() if p == PARSED_INGEST]
        self.assertEqual(len(ingests), 1,
                         f"exactly one ingest; {_diagnostics(result)}")
        summary = (ingests[0] or {}).get("summary") if ingests else {}
        self.assertEqual((summary or {}).get("total"), len(CATALOGUE),
                         f"the run covers the whole catalogue; summary={summary!r}")
        return record

    def test_test_without_the_flags_runs_make_with_neither_variable(self):
        self.assert_unnarrowed("test")

    def test_unit_without_the_flags_runs_make_with_neither_variable(self):
        self.assert_unnarrowed("unit")

    def test_regression_runs_make_with_neither_variable(self):
        self.assert_unnarrowed("regression")

    def test_pre_merge_gate_runs_make_with_neither_variable(self):
        self.assert_unnarrowed("pre-merge-gate", "--skip-check")

    def test_a_declared_tier_verb_runs_make_with_neither_variable(self):
        record = self.assert_unnarrowed("integration", declare_integration=True)
        self.assertEqual(record.get("target"), "junit-integration",
                         f"the declared tier verb ran its own target; "
                         f"recorded={record!r}")


if __name__ == "__main__":
    unittest.main()
