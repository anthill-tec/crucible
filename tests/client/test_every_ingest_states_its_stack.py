"""Every ingest a client sends states the stack that produced it.

Three layers, each driven for real:

* the shared ingest path (`post_ingest` in `clients/_crucible_axi.py`) refuses
  a call that names no stack, and puts the stack it is given on the body it
  sends to each run-ingest route, whether or not the body closes a started run;
* a census over the five clients' sources finds every `post_ingest` call, however
  it is reached, and requires each to hand over the client's own `_STACK`;
* each client x route cell is driven through the client's own code with a
  recording `_post`, once with the run's start accepted (a runId came back) and
  once with it refused, and the ingest body must name that client's stack.

Every HTTP call goes to the recording `_post`/`_get` stubs, and each fixture
project declares an unreachable board besides, so no live board is touched.
"""

import argparse
import ast
import contextlib
import importlib.util
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.test_client_fleet_envelope_census import (
    declare_board,
    install_project_limits,
)

REPO = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO / "clients"
AXI_PATH = CLIENTS_DIR / "_crucible_axi.py"

RUN_START = "/api/v2/runs/start"
RUNS = "/api/v2/runs"
PARSED = "/api/v2/runs/parsed"
COMPILE = "/api/v2/runs/compile"
INGEST_ROUTES = (RUNS, PARSED, COMPILE)

# Each client's own stack name, as the board will store it.
CLIENT_STACKS = {"arduino": "arduino", "bun": "bun", "mvn": "mvn",
                 "python": "python", "rust": "rust"}

AGENT = "stack-census-probe"
PROJECT_KEY = "stack-census-project-key"
RUN_ID = "run-stack-census-0001"
UNREACHABLE_BOARD = "http://127.0.0.1:1"

START_ACCEPTED = {"ok": True, "runId": RUN_ID}
START_REFUSED = {"ok": False, "error": "run lifecycle unavailable on this board"}
# A board that answers the start `ok` but opens no run: the ingest is then the
# single-shot body, exactly as after a refusal.
START_OPENED_NONE = {"ok": True}
INGEST_OK = {"ok": True, "event": "evt-stack-census",
             "run": {"total": 1, "passed": 1, "failed": 0, "pending": 0}}
BOARD_OFFLINE = {"ok": False, "error": "connection failed: board offline"}

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE")

JUNIT_ONE_PASS = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuites name="probe" tests="1" failures="0" errors="0">\n'
    '  <testsuite name="probe::probe_tests" tests="1" failures="0" errors="0">\n'
    '    <testcase name="it_passes" classname="probe::probe_tests" time="0.001"/>\n'
    '  </testsuite>\n'
    '</testsuites>\n')

SUMMARY_ONE_PASS = {"total": 1, "passed": 1, "failed": 0, "pending": 0,
                    "duration_ms": 1}
TREE_ONE_PASS = [{"name": "probe", "status": "pass",
                  "children": [{"name": "it_passes", "status": "pass"}]}]


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client(client):
    return _load(CLIENTS_DIR / f"{client}-crucible.py",
                 f"{client}_crucible_under_stack_census")


class _RecordingPost:
    """A client's `_post` seam: records every (path, body) and answers the run
    start with the reply the test chose, every other POST with `ok`."""

    def __init__(self, start_reply=START_ACCEPTED):
        self.start_reply = start_reply
        self.calls = []

    def __call__(self, path, payload=None, *_args, **_kwargs):
        self.calls.append((path, dict(payload or {})))
        if path == RUN_START:
            return dict(self.start_reply)
        return dict(INGEST_OK)

    def bodies(self, path):
        return [body for posted, body in self.calls if posted == path]

    def paths(self):
        return [posted for posted, _body in self.calls]


# ── the shared ingest path ────────────────────────────────────────────────


class PostIngestRequiresAndCarriesTheStackTest(unittest.TestCase):
    """`post_ingest(post_fn, path, payload, *, stack, release=None)`."""

    def setUp(self):
        self.axi = _load(AXI_PATH, "crucible_axi_under_stack_census")

    def _send(self, path, payload, **kwargs):
        recorder = _RecordingPost()
        with contextlib.redirect_stderr(io.StringIO()):
            self.axi.post_ingest(recorder, path, payload, **kwargs)
        return recorder

    def _body(self, payload_run_id=None):
        body = {"projectKey": PROJECT_KEY, "agentId": AGENT,
                "summary": dict(SUMMARY_ONE_PASS)}
        if payload_run_id:
            body["runId"] = payload_run_id
        return body

    def test_a_call_naming_no_stack_is_refused_with_a_type_error_and_posts_nothing(self):
        recorder = _RecordingPost()
        with self.assertRaises(TypeError) as raised, \
                contextlib.redirect_stderr(io.StringIO()):
            self.axi.post_ingest(recorder, PARSED, self._body())
        self.assertIn("stack", str(raised.exception),
                      "the refusal must name the missing `stack` keyword")
        self.assertEqual(recorder.calls, [],
                         "a refused call must send nothing to the board")

    def _assert_route_carries_the_stack(self, path):
        for run_id in (None, RUN_ID):
            with self.subTest(route=path, run_id=run_id):
                recorder = self._send(path, self._body(run_id), stack="x")
                bodies = recorder.bodies(path)
                self.assertEqual(
                    len(bodies), 1,
                    f"exactly one body must go to {path}; posted to "
                    f"{recorder.paths()!r}")
                self.assertEqual(
                    bodies[0].get("stack"), "x",
                    f"the body sent to {path} must carry the stack it was "
                    f"given; got keys={sorted(bodies[0])!r}")
                self.assertEqual(bodies[0].get("runId"), run_id,
                                 "the runId (or its absence) is left as given")
                self.assertEqual(bodies[0].get("projectKey"), PROJECT_KEY,
                                 "the rest of the body is left as given")

    def test_a_raw_run_ingest_carries_the_given_stack_with_and_without_a_run_id(self):
        self._assert_route_carries_the_stack(RUNS)

    def test_a_parsed_run_ingest_carries_the_given_stack_with_and_without_a_run_id(self):
        self._assert_route_carries_the_stack(PARSED)

    def test_a_compile_ingest_carries_the_given_stack_with_and_without_a_run_id(self):
        self._assert_route_carries_the_stack(COMPILE)

    def test_a_release_run_ingest_carries_the_stack_beside_the_release(self):
        for path in INGEST_ROUTES:
            with self.subTest(route=path):
                recorder = self._send(path, self._body(RUN_ID), stack="x",
                                      release="0.4.0")
                bodies = recorder.bodies(path)
                self.assertEqual(len(bodies), 1)
                self.assertEqual(
                    (bodies[0].get("stack"), bodies[0].get("release")),
                    ("x", "0.4.0"),
                    f"a release run's ingest states both its stack and its "
                    f"release; got keys={sorted(bodies[0])!r}")


# ── the census over the five clients' sources ─────────────────────────────


def _post_ingest_calls(source):
    """Every call of `post_ingest` in `source`, however it is reached
    (`_axi().post_ingest(...)`, `axi.post_ingest(...)`, `post_ingest(...)`),
    each paired with the name of the function it sits in."""
    found = []

    def visit(node, owner):
        for child in ast.iter_child_nodes(node):
            child_owner = owner
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                child_owner = child.name
            if isinstance(child, ast.Call):
                func = child.func
                name = (func.attr if isinstance(func, ast.Attribute)
                        else func.id if isinstance(func, ast.Name) else None)
                if name == "post_ingest":
                    found.append((child_owner, child))
            visit(child, child_owner)

    visit(ast.parse(source), "<module>")
    return found


def _states_its_own_stack(call):
    """True only for an explicit `stack=_STACK` keyword."""
    for keyword in call.keywords:
        if keyword.arg == "stack":
            return (isinstance(keyword.value, ast.Name)
                    and keyword.value.id == "_STACK")
    return False


def _route_of(call):
    if len(call.args) >= 2 and isinstance(call.args[1], ast.Constant):
        return call.args[1].value
    return "<computed route>"


def _call_sites_without_own_stack(source):
    return [f"{owner} -> {_route_of(call)}"
            for owner, call in _post_ingest_calls(source)
            if not _states_its_own_stack(call)]


_SYNTHETIC_CLIENT = '''
def states_it():
    return _axi().post_ingest(_post, "/api/v2/runs", body, stack=_STACK)

def names_none():
    return axi.post_ingest(_post, "/api/v2/runs/parsed", body)

def names_a_literal():
    return post_ingest(_post, "/api/v2/runs/compile", body, stack="rust")

def hides_it_in_kwargs():
    return _axi().post_ingest(_post, "/api/v2/runs", body, release=r, **extra)
'''


class EveryPostIngestCallStatesTheClientsOwnStackTest(unittest.TestCase):
    """Zero `post_ingest` call sites without `stack=_STACK`, in any client."""

    def assert_census_reads_the_synthetic_client(self):
        found = _post_ingest_calls(_SYNTHETIC_CLIENT)
        self.assertEqual(
            [owner for owner, _call in found],
            ["states_it", "names_none", "names_a_literal", "hides_it_in_kwargs"],
            "the census must find a call however `post_ingest` is reached")
        self.assertEqual(
            _call_sites_without_own_stack(_SYNTHETIC_CLIENT),
            ["names_none -> /api/v2/runs/parsed",
             "names_a_literal -> /api/v2/runs/compile",
             "hides_it_in_kwargs -> /api/v2/runs"],
            "the census must flag every call that does not pass `stack=_STACK` "
            "and only those")

    def assert_client_states_its_stack_everywhere(self, client):
        self.assert_census_reads_the_synthetic_client()
        source = (CLIENTS_DIR / f"{client}-crucible.py").read_text()
        found = _post_ingest_calls(source)
        self.assertTrue(
            found,
            f"the census found no `post_ingest` call in {client}-crucible.py, "
            f"so it measured nothing; every ingest goes through it")
        missing = _call_sites_without_own_stack(source)
        self.assertEqual(
            missing, [],
            f"{len(missing)} of {len(found)} `post_ingest` calls in "
            f"{client}-crucible.py do not pass `stack=_STACK`: {missing!r}")

    def test_every_arduino_ingest_call_passes_its_own_stack(self):
        self.assert_client_states_its_stack_everywhere("arduino")

    def test_every_bun_ingest_call_passes_its_own_stack(self):
        self.assert_client_states_its_stack_everywhere("bun")

    def test_every_mvn_ingest_call_passes_its_own_stack(self):
        self.assert_client_states_its_stack_everywhere("mvn")

    def test_every_python_ingest_call_passes_its_own_stack(self):
        self.assert_client_states_its_stack_everywhere("python")

    def test_every_rust_ingest_call_passes_its_own_stack(self):
        self.assert_client_states_its_stack_everywhere("rust")


# ── each client x route, driven through the client ────────────────────────


class _ClientIngestCase(unittest.TestCase):
    """One throwaway project per test, the client loaded fresh, and every POST
    and GET it makes answered by stubs."""

    CLIENT = ""

    def setUp(self):
        self.module = _load_client(self.CLIENT)
        self.stack = CLIENT_STACKS[self.CLIENT]
        self.project_dir = tempfile.mkdtemp(prefix=f"stack-census-{self.CLIENT}-")
        self.addCleanup(shutil.rmtree, self.project_dir, ignore_errors=True)
        with open(os.path.join(self.project_dir, ".env"), "w") as handle:
            handle.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        install_project_limits(self.project_dir)
        declare_board(Path(self.project_dir) / "crucible.toml", UNREACHABLE_BOARD)
        saved = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        self.addCleanup(self._restore_env, saved)

    @staticmethod
    def _restore_env(saved):
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def drive(self, start_reply, body):
        """Run `body` with the client's `_post` recording and its `_get` offline;
        a verb's exit is part of the drive, not an error of it."""
        recorder = _RecordingPost(start_reply)
        with mock.patch.object(self.module, "_post", side_effect=recorder,
                               create=True), \
                mock.patch.object(self.module, "_get", return_value=BOARD_OFFLINE,
                                  create=True), \
                contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()), \
                contextlib.suppress(SystemExit):
            body()
        return recorder

    def start_then(self, start_reply, ingest):
        """Open the run through the client's own `_start_run`, then hand
        whatever runId came back (None when refused) to `ingest`."""
        def body():
            run_id, _warnings = self.module._start_run(self.project_dir, AGENT)
            ingest(run_id)
        return self.drive(start_reply, body)

    def assert_ingest_states_the_stack(self, recorder, route, start_reply):
        bodies = recorder.bodies(route)
        self.assertEqual(
            len(bodies), 1,
            f"{self.CLIENT}: exactly one body must reach {route}; posted to "
            f"{recorder.paths()!r}")
        body = bodies[0]
        if start_reply is START_ACCEPTED:
            self.assertEqual(
                body.get("runId"), RUN_ID,
                f"{self.CLIENT} {route}: the accepted start's runId must ride "
                f"the ingest, or this drive closed no started run; "
                f"got keys={sorted(body)!r}")
        else:
            self.assertNotIn(
                "runId", body,
                f"{self.CLIENT} {route}: with no run opened the ingest is the "
                f"single-shot body; got keys={sorted(body)!r}")
        self.assertEqual(
            body.get("stack"), self.stack,
            f"{self.CLIENT} {route}: the ingest body must name the stack that "
            f"produced it ({self.stack!r}); got stack={body.get('stack')!r} "
            f"keys={sorted(body)!r}")

    def write_junit(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Path(path).write_text(JUNIT_ONE_PASS)
        return path


class ArduinoStatesItsStackOnEveryIngestTest(_ClientIngestCase):
    """arduino: `/runs/compile` through `_ingest_compile`, `/runs/parsed`
    through the native-test body `_run_native_tests_body` (its `make` spawn
    replaced by a fake that writes one passing report)."""

    CLIENT = "arduino"

    def _compile(self):
        self.module._ingest_compile(self.project_dir, PROJECT_KEY, AGENT,
                                    "probe.ino:1:1: error: boom", context={})

    def test_a_compile_ingest_states_the_arduino_stack_with_no_run_opened(self):
        """The arduino compile ingest closes no run: it is sent before any run
        opens, so it is always the single-shot body."""
        recorder = self.drive(START_ACCEPTED, self._compile)
        self.assertNotIn(RUN_START, recorder.paths(),
                         "the arduino compile ingest opens no run")
        self.assert_ingest_states_the_stack(recorder, COMPILE, START_REFUSED)

    def _native_tests(self):
        native_dir = os.path.join(self.project_dir, "tests", "native")
        os.makedirs(native_dir, exist_ok=True)
        args = argparse.Namespace(agent=AGENT, release=None, dir=None,
                                  reports=None, log=None, cycle=None)

        def fake_make(cmd, _cwd, env, _log_path, _narrator=None, capture=False):
            self.write_junit(os.path.join(env["REPORTS_DIR"], "TEST-probe.xml"))
            return subprocess.CompletedProcess(cmd, 0, stdout="1 Tests 0 Failures\n",
                                               stderr="")

        with mock.patch.object(self.module._axi(), "run_streamed",
                               side_effect=fake_make):
            self.module._run_native_tests_body(args, "test", None, False,
                                               self.project_dir)

    def test_a_parsed_ingest_states_the_arduino_stack_when_its_start_was_accepted(self):
        recorder = self.drive(START_ACCEPTED, self._native_tests)
        self.assert_ingest_states_the_stack(recorder, PARSED, START_ACCEPTED)

    def test_a_parsed_ingest_states_the_arduino_stack_when_its_start_was_refused(self):
        recorder = self.drive(START_REFUSED, self._native_tests)
        self.assert_ingest_states_the_stack(recorder, PARSED, START_REFUSED)


class BunStatesItsStackOnEveryIngestTest(_ClientIngestCase):
    """bun: `_start_run`, then `_ingest_parsed` / `_ingest_raw` /
    `_ingest_compile` with whatever runId came back."""

    CLIENT = "bun"

    def _parsed(self, run_id):
        self.module._ingest_parsed(self.project_dir, AGENT, dict(SUMMARY_ONE_PASS),
                                   list(TREE_ONE_PASS), run_id=run_id)

    def _raw(self, run_id):
        report = self.write_junit(os.path.join(self.project_dir, "report.xml"))
        self.module._ingest_raw(self.project_dir, AGENT,
                                {"codec": "junit", "path": report}, run_id=run_id)

    def _compile(self, run_id):
        self.module._ingest_compile(self.project_dir, AGENT,
                                    "src/a.ts(1,1): error TS2304: boom",
                                    run_id=run_id)

    def test_a_parsed_ingest_states_the_bun_stack_when_its_start_was_accepted(self):
        recorder = self.start_then(START_ACCEPTED, self._parsed)
        self.assert_ingest_states_the_stack(recorder, PARSED, START_ACCEPTED)

    def test_a_parsed_ingest_states_the_bun_stack_when_its_start_was_refused(self):
        recorder = self.start_then(START_REFUSED, self._parsed)
        self.assert_ingest_states_the_stack(recorder, PARSED, START_REFUSED)

    def test_a_raw_run_ingest_states_the_bun_stack_when_its_start_was_accepted(self):
        recorder = self.start_then(START_ACCEPTED, self._raw)
        self.assert_ingest_states_the_stack(recorder, RUNS, START_ACCEPTED)

    def test_a_raw_run_ingest_states_the_bun_stack_when_its_start_was_refused(self):
        recorder = self.start_then(START_REFUSED, self._raw)
        self.assert_ingest_states_the_stack(recorder, RUNS, START_REFUSED)

    def test_a_compile_ingest_states_the_bun_stack_when_its_start_was_accepted(self):
        recorder = self.start_then(START_ACCEPTED, self._compile)
        self.assert_ingest_states_the_stack(recorder, COMPILE, START_ACCEPTED)

    def test_a_compile_ingest_states_the_bun_stack_when_its_start_was_refused(self):
        recorder = self.start_then(START_REFUSED, self._compile)
        self.assert_ingest_states_the_stack(recorder, COMPILE, START_REFUSED)


class MvnStatesItsStackOnEveryIngestTest(_ClientIngestCase):
    """mvn: `_start_run`, then `_ingest_junit_dir` / `_ingest_parsed` /
    `_ingest_compile` with whatever runId came back."""

    CLIENT = "mvn"

    def _junit_dir(self, run_id):
        report_dir = os.path.dirname(self.write_junit(os.path.join(
            self.project_dir, "target", "surefire-reports", "TEST-probe.xml")))
        self.module._ingest_junit_dir(self.project_dir, AGENT, report_dir,
                                      context={}, run_id=run_id)

    def _parsed(self, run_id):
        self.module._ingest_parsed(self.project_dir, AGENT, dict(SUMMARY_ONE_PASS),
                                   list(TREE_ONE_PASS), context={}, run_id=run_id)

    def _compile(self, run_id):
        self.module._ingest_compile(self.project_dir, AGENT,
                                    "[ERROR] /src/A.java:[1,1] boom",
                                    context={}, run_id=run_id)

    def test_a_raw_run_ingest_states_the_mvn_stack_when_its_start_was_accepted(self):
        recorder = self.start_then(START_ACCEPTED, self._junit_dir)
        self.assert_ingest_states_the_stack(recorder, RUNS, START_ACCEPTED)

    def test_a_raw_run_ingest_states_the_mvn_stack_when_its_start_was_refused(self):
        recorder = self.start_then(START_REFUSED, self._junit_dir)
        self.assert_ingest_states_the_stack(recorder, RUNS, START_REFUSED)

    def test_a_parsed_ingest_states_the_mvn_stack_when_its_start_was_accepted(self):
        recorder = self.start_then(START_ACCEPTED, self._parsed)
        self.assert_ingest_states_the_stack(recorder, PARSED, START_ACCEPTED)

    def test_a_parsed_ingest_states_the_mvn_stack_when_its_start_was_refused(self):
        recorder = self.start_then(START_REFUSED, self._parsed)
        self.assert_ingest_states_the_stack(recorder, PARSED, START_REFUSED)

    def test_a_compile_ingest_states_the_mvn_stack_when_its_start_was_accepted(self):
        recorder = self.start_then(START_ACCEPTED, self._compile)
        self.assert_ingest_states_the_stack(recorder, COMPILE, START_ACCEPTED)

    def test_a_compile_ingest_states_the_mvn_stack_when_its_start_was_refused(self):
        recorder = self.start_then(START_REFUSED, self._compile)
        self.assert_ingest_states_the_stack(recorder, COMPILE, START_REFUSED)


_PYTHON_FIXTURE_PKG = "stack_census_python_fixture_pkg"
_PYTHON_FIXTURE_TEST = """import unittest


class FixtureTest(unittest.TestCase):
    def test_passes(self):
        self.assertTrue(True)
"""
# An interpreter that dies before writing any report: the client's
# collection-failure path, which files the captured output as a compile ingest.
_PYTHON_DIES_BEFORE_ANY_REPORT = (
    "#!/bin/sh\n"
    "echo 'SyntaxError: invalid syntax (stack census probe)' >&2\n"
    "exit 1\n")


class PythonStatesItsStackOnEveryIngestTest(_ClientIngestCase):
    """python: the whole `test` verb (`main`), which opens the run itself — a
    real unittest run over a one-test fixture for `/runs/parsed`, and an
    interpreter that dies before writing a report for `/runs/compile`."""

    CLIENT = "python"

    def _test_verb(self, python):
        argv = ["python-crucible.py", "test", "--project-dir", self.project_dir,
                "--python", python, "--tests", f"{_PYTHON_FIXTURE_PKG}.test_fixture",
                "--reports", "reports", "--agent", AGENT]
        with mock.patch.object(sys, "argv", argv):
            self.module.main()

    def _passing_suite(self):
        pkg = Path(self.project_dir, _PYTHON_FIXTURE_PKG)
        pkg.mkdir(parents=True, exist_ok=True)
        (pkg / "__init__.py").write_text("")
        (pkg / "test_fixture.py").write_text(_PYTHON_FIXTURE_TEST)
        self._test_verb(sys.executable)

    def _dying_interpreter(self):
        fake = Path(self.project_dir, "python-that-dies")
        fake.write_text(_PYTHON_DIES_BEFORE_ANY_REPORT)
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        self._test_verb(str(fake))

    def test_a_parsed_ingest_states_the_python_stack_when_its_start_was_accepted(self):
        recorder = self.drive(START_ACCEPTED, self._passing_suite)
        self.assert_ingest_states_the_stack(recorder, PARSED, START_ACCEPTED)

    def test_a_refused_start_still_leaves_the_python_stack_on_the_parsed_ingest(self):
        """Regression guard — python already names its stack on a parsed ingest
        whose start was refused; that must survive the change."""
        recorder = self.drive(START_REFUSED, self._passing_suite)
        self.assert_ingest_states_the_stack(recorder, PARSED, START_REFUSED)

    def test_a_parsed_ingest_states_the_python_stack_when_its_start_opened_no_run(self):
        """A board that answers the start `ok` with no runId opened nothing:
        the ingest is the single-shot body and must still name the stack."""
        recorder = self.drive(START_OPENED_NONE, self._passing_suite)
        self.assert_ingest_states_the_stack(recorder, PARSED, START_OPENED_NONE)

    def test_a_compile_ingest_states_the_python_stack_when_its_start_was_accepted(self):
        recorder = self.drive(START_ACCEPTED, self._dying_interpreter)
        self.assert_ingest_states_the_stack(recorder, COMPILE, START_ACCEPTED)

    def test_a_compile_ingest_states_the_python_stack_when_its_start_was_refused(self):
        recorder = self.drive(START_REFUSED, self._dying_interpreter)
        self.assert_ingest_states_the_stack(recorder, COMPILE, START_REFUSED)


class RustStatesItsStackOnEveryIngestTest(_ClientIngestCase):
    """rust: `_start_run`, then `_ingest_rustc_stderr` / `_ingest_junit_axi`
    with whatever runId came back; `/runs/parsed` through the regression body
    `_regression_ingest_run`, which opens the run itself (its `cargo clean`
    and `cargo llvm-cov nextest` replaced by fakes that write one passing
    report)."""

    CLIENT = "rust"

    def _compile(self, run_id):
        self.module._ingest_rustc_stderr(self.project_dir, AGENT,
                                         "error[E0425]: cannot find value `x`",
                                         run_id=run_id)

    def _junit(self, run_id):
        junit = self.write_junit(os.path.join(
            self.project_dir, "target", "nextest", "ci", "junit.xml"))
        self.module._ingest_junit_axi(self.project_dir, AGENT, junit,
                                      run_id=run_id)

    def _regression(self):
        args = argparse.Namespace(project_dir=self.project_dir, crates="probe",
                                  features=None, agent=AGENT, release=None,
                                  reports=None, cycle=None)
        real_run = subprocess.run

        def no_cargo(cmd, *a, **kw):
            if cmd and cmd[0] == "cargo":
                return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
            return real_run(cmd, *a, **kw)

        def fake_nextest(cmd, cwd, _env, _log_path, _narrator=None, capture=False):
            self.write_junit(os.path.join(cwd, "target", "nextest", "ci",
                                          "junit.xml"))
            return subprocess.CompletedProcess(cmd, 0, stdout="PASS [ 0.001s]\n",
                                               stderr="")

        with mock.patch.object(self.module.subprocess, "run", side_effect=no_cargo), \
                mock.patch.object(self.module, "_run_logged",
                                  side_effect=fake_nextest):
            self.module._regression_ingest_run(args)

    def test_a_compile_ingest_states_the_rust_stack_when_its_start_was_accepted(self):
        recorder = self.start_then(START_ACCEPTED, self._compile)
        self.assert_ingest_states_the_stack(recorder, COMPILE, START_ACCEPTED)

    def test_a_compile_ingest_states_the_rust_stack_when_its_start_was_refused(self):
        recorder = self.start_then(START_REFUSED, self._compile)
        self.assert_ingest_states_the_stack(recorder, COMPILE, START_REFUSED)

    def test_a_parsed_ingest_states_the_rust_stack_when_its_start_was_accepted(self):
        recorder = self.drive(START_ACCEPTED, self._regression)
        self.assert_ingest_states_the_stack(recorder, PARSED, START_ACCEPTED)

    def test_a_parsed_ingest_states_the_rust_stack_when_its_start_was_refused(self):
        recorder = self.drive(START_REFUSED, self._regression)
        self.assert_ingest_states_the_stack(recorder, PARSED, START_REFUSED)

    def test_a_raw_run_ingest_states_the_rust_stack_when_its_start_was_accepted(self):
        recorder = self.start_then(START_ACCEPTED, self._junit)
        self.assert_ingest_states_the_stack(recorder, RUNS, START_ACCEPTED)

    def test_a_raw_run_ingest_states_the_rust_stack_when_its_start_was_refused(self):
        recorder = self.start_then(START_REFUSED, self._junit)
        self.assert_ingest_states_the_stack(recorder, RUNS, START_REFUSED)


if __name__ == "__main__":
    unittest.main()
