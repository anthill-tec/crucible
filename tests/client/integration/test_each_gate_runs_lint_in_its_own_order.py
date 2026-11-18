"""Each client's `pre-merge-gate` runs `lint` as a stage of its own, in that
client's own order, fail-fast:

| client      | order                                         |
|-------------|-----------------------------------------------|
| python, bun | `check` -> lint -> tests                      |
| arduino     | `compile` -> lint -> tests                    |
| rust        | lint (its former clippy step) -> regression   |
| go          | lint -> `gate_regression`                     |
| maven       | lint -> docker-up -> regression               |

- A failing lint stops the gate there: the tests that would have followed
  never run, maven starts no container, and the envelope names the `lint`
  stage, carries the filed lint event and the warning `lint-gate-abort` (the
  same code in every client).
- A lint with nothing declared and no stack default is skipped and the gate
  goes on, its envelope's warnings carrying `lint-not-declared`.
- `--skip-lint` skips the lint stage; `--skip-check` skips `check` only.
- The rust gate's lint stage is its former clippy step: it reads
  `stage: "lint"` with `errors` and `lints`, warns `lint-gate-abort` and never
  `clippy-gate-abort`, keeps `CARGO_BUILD_JOBS`, is still skipped by
  `--skip-clippy`, and a declared `[lint]` replaces its clippy default.
- A lint post the board refuses warns `ingest-failed` naming the lint step,
  never the bare gate.
- A malformed `[lint]` (`command = []`) stops the gate at its lint stage with
  an `error`, exit 1 and `lint-gate-abort`, and nothing is filed.
- A linter killed by a signal stops the python gate at `lint` with the exit a
  shell reports for it (128 + the signal), never a negative one, and the
  board takes its post.
- The python gate's `check` warnings ride the envelope of a lint abort.
- A go gate on a board that does not decode `go-test` is refused before its
  lint stage: no linter runs and nothing is filed.
- A gate given `--release` beside `--cycle` is refused by the release hard
  stop (`release-run-refused`) before its lint stage, in every client: no
  linter runs and nothing is filed.

Every drive is a real subprocess of a client from a scratch copy of the fleet,
against the recording board double of `tests/client/lint_verb_harness.py`. No
real linter, compiler, test runner or container ever runs:

- the declared linter is the harness's fake linter;
- each gate stage's tool (`python`, `bun`, `cargo`, `go`, `mvn`, `docker`,
  `arduino-cli`, `make`) is a recording wrapper in front of the stage double
  the existing gate suites use: the envelope census's fake toolchains, and
  the python client suites' fake interpreter. The wrapper appends each call
  to the same log the fake linter writes, so one log holds every stage in the
  order it ran. As `cargo clippy` and `go vet` -- the rust and go defaults --
  it prints and exits as the fake linter's script says.

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> --tests \
        tests.client.integration.test_each_gate_runs_lint_in_its_own_order
"""

import json
import re
import shutil
import signal
import sys
import unittest
import urllib.parse
from pathlib import Path
from typing import TYPE_CHECKING

from tests.client.lint_verb_harness import (
    AGENT,
    LintBoard,
    LintDriveMixin,
    lint_table,
    warning_codes,
)
from tests.client.live_run_harness import (
    GO_TEST_STREAM_CODEC,
    HEALTH_PATHS,
    board_health,
)
from tests.client.project_create_harness import ScratchFleet
from tests.client.client_fleet_envelope_census_helpers import (
    _build_fake_bin_dir,
    write_go_module,
)
from tests.client.integration.test_python_client_sends_its_runners_reports import _FAKE_PYTHON

GATE = "pre-merge-gate"

#: The declared linter every declaring project names; never a real tool.
LINTER = "gate-fixture-ruff"
#: The marker its declaration files under (`format` wins over the basename).
MARKER = "ruff"

#: The event the board double answers the lint post with.
LINT_EVENT = "evt-gate-lint-fixture-0001"
#: The decoded counts the board double answers the lint post with.
LINT_ERRORS = 3
LINT_WARNINGS = 2
LINT_EXIT = 1

STAGE = "lint"
LINT_GATE_ABORT = "lint-gate-abort"
CLIPPY_GATE_ABORT = "clippy-gate-abort"
LINT_NOT_DECLARED = "lint-not-declared"
INGEST_FAILED = "ingest-failed"
#: The python `check` stage's warning when it found nothing to compile.
CHECK_COMPILED_NOTHING = "check-compiled-nothing"

#: The exit a shell reports for a process killed by SIGTERM: 128 + 15.
SIGTERM_EXIT = 128 + int(signal.SIGTERM)

#: A release run takes no cycle: the pair a gate refuses before its lint.
RELEASE = "9.9.9-gate-fixture"
CYCLE = 7
#: The release hard stop's code, on its stderr line, and its help's step.
RELEASE_RUN_REFUSED = "release-run-refused"
RELEASE_TAKES_NO_CYCLE = "a release run takes no --cycle"

#: What the failing clippy prints, and the board decodes: errors, warnings.
CLIPPY_ERRORS = 2
CLIPPY_WARNINGS = 1

#: The rust default lint step: the workspace clippy, unchanged.
WORKSPACE_CLIPPY_ARGV = ["clippy", "--workspace", "--all-targets", "--all-features",
                         "--", "-D", "warnings"]


# ── the board double ─────────────────────────────────────────────────────────

RUN_START = "/api/v2/runs/start"
RUN_ID = "run-gate-lint-fixture-1"
_RUN_SUBROUTE = re.compile(r"^/api/v2/runs/[^/]+/(stream|tests|abort)$")


class GateBoard(LintBoard):
    """The lint board double, which also opens the streamed run a gate's
    test stage files through: `POST /api/v2/runs/start` answers a `runId`,
    and that run's stream batches are held as the board holds them (each
    answered with the bytes held so far)."""

    def reset(self):
        super().reset()
        with self.lock:
            self.held = 0

    def route(self, method, path):
        split = urllib.parse.urlsplit(path).path
        if method == "POST" and split == RUN_START:
            return 200, {"ok": True, "changed": True, "runId": RUN_ID}
        match = _RUN_SUBROUTE.match(split) if method == "POST" else None
        if match and match.group(1) == "stream":
            body = self.requests[-1][2] or {}
            data = str(body.get("data") or "").encode("utf-8")
            self.held = max(self.held, int(body.get("from") or 0) + len(data))
            return 200, {"ok": True, "runId": RUN_ID, "held": self.held}
        if match and match.group(1) == "tests":
            return 200, {"ok": True, "runId": RUN_ID, "total": 1}
        return super().route(method, path)


# ── the stage doubles ───────────────────────────────────────────────────────

_STAGE_WRAPPER = r'''
import json
import os
import sys

TOOL = @TOOL@
TARGET = @TARGET@
LINT_WORDS = @LINT_WORDS@

argv = sys.argv[1:]
log = os.environ.get("FAKE_LINT_LOG")
if log:
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({
            "tool": TOOL,
            "argv": argv,
            "cwd": os.getcwd(),
            "env": {"CARGO_BUILD_JOBS": os.environ.get("CARGO_BUILD_JOBS")},
        }) + "\n")
if argv[:1] and argv[0] in LINT_WORDS:
    named = os.environ.get("FAKE_LINT_SCRIPT")
    script = {"chunks": [], "exit": 0}
    if named and os.path.isfile(named):
        with open(named, encoding="utf-8") as handle:
            script = json.load(handle)
    for stream, text in script.get("chunks", []):
        target = sys.stdout if stream == "out" else sys.stderr
        target.write(text)
        target.flush()
    sys.exit(script.get("exit", 0))
os.execv(TARGET, [TARGET, *argv])
'''


def write_stage_double(directory, tool, target, lint_words=()):
    """Write `<directory>/<tool>`: it records each call in the fake linter's
    log, answers a call whose first word is in `lint_words` as the fake linter
    does, and hands every other call to the stage double at `target`."""
    body = (_STAGE_WRAPPER.replace("@TOOL@", json.dumps(tool))
            .replace("@TARGET@", json.dumps(str(target)))
            .replace("@LINT_WORDS@", json.dumps(list(lint_words))))
    path = Path(directory) / tool
    path.write_text(f"#!{sys.executable}\n{body}", encoding="utf-8")
    path.chmod(0o755)
    return path


def _first_word(call):
    return call["argv"][0] if call["argv"] else None


def _index(calls, predicate):
    """The index of the first call matching `predicate`, or None."""
    return next((i for i, call in enumerate(calls) if predicate(call)), None)


def carried_events(axi):
    """Every event id an envelope carries, as `event` or in `events`."""
    found = []
    event = axi.get("event")
    if isinstance(event, str):
        found.append(event)
    for item in axi.get("events") or []:
        if isinstance(item, str):
            found.append(item)
        elif isinstance(item, dict):
            found.extend(str(item[k]) for k in ("id", "event", "eventId") if k in item)
    return found


# ── the drive ───────────────────────────────────────────────────────────────

# The case mixins are `TestCase`s to a type checker, and plain classes at run
# time, so unittest collects only the concrete per-client classes below.
if TYPE_CHECKING:
    _Base = unittest.TestCase
else:
    _Base = object


class _GateDrive(LintDriveMixin, _Base):
    """One client's gate, driven with its stage doubles. A concrete class
    names the client and how its stages are recognised in the call log."""

    CLIENT = ""
    #: Every stage tool the gate runs, wrapped in front of its stage double.
    STAGE_TOOLS = ()
    #: The words a stage tool answers as the fake linter (the defaults).
    LINT_WORDS = {}

    @classmethod
    def setUpClass(cls):
        # The harness's own class set-up, with the board double that also
        # opens a gate's streamed run.
        cls.board = GateBoard()
        try:
            cls.fleet = ScratchFleet(cls.board.base_url)
        except BaseException:
            cls.board.close()
            raise
        cls.toolchain_bin = _build_fake_bin_dir()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.toolchain_bin, ignore_errors=True)
        cls.fleet.close()
        cls.board.close()

    def setUp(self):
        super().setUp()
        self.fake(LINTER)
        self.board.answer_counts(LINT_ERRORS, LINT_WARNINGS, event=LINT_EVENT)
        for tool in self.STAGE_TOOLS:
            write_stage_double(self.bin, tool, self.stage_target(tool),
                               self.LINT_WORDS.get(tool, ()))

    def stage_target(self, tool):
        return self.toolchain_bin / tool

    def prepare(self, root):
        """Lay down what the client's gate needs in the project."""

    def gate_argv(self) -> "tuple[str, ...]":
        return ()

    def gate_env(self) -> "dict[str, str]":
        return {}

    def assertRanBefore(self, first, then, why):
        """Both stages ran, `first` before `then` (call-log indexes)."""
        if first is None or then is None:
            self.fail(f"both stages run (indexes {first!r}, {then!r}); {why}")
        self.assertLess(first, then, why)

    def declaring_project(self):
        root = self.project(lint_table([LINTER, "check", "."], format=MARKER))
        self.prepare(root)
        return root

    def undeclaring_project(self):
        root = self.project()
        self.prepare(root)
        return root

    def gate(self, root, *flags):
        return self.run_client(self.CLIENT, root, "--agent", AGENT,
                               *self.gate_argv(), *flags, verb=GATE,
                               env=self.gate_env())

    def failing_lint(self):
        self.say((("out", "app/a.py:1:1: F401 `os` imported but unused\n"),),
                 exit_code=LINT_EXIT)

    # How each stage shows in the call log.

    def is_lint(self, call):
        return call["tool"] == LINTER

    def is_check(self, call):
        """The stage the lint stage follows; None-like for a client whose lint
        is first."""
        return False

    def is_test(self, call):
        raise NotImplementedError

    def why(self, result, axi):
        return (f"envelope={axi!r}\ncalls={self.calls()!r}\n"
                f"posts={self.board.compile_posts()!r}\nexit={result.returncode}\n"
                f"stderr={result.stderr[-2500:]}")

    def assertGateEnvelope(self, result, axi):
        """Guard: the drive reached the gate and it answered one envelope --
        an argparse refusal or a crash is never read as a verdict."""
        self.assertEqual(axi.get("verb"), GATE,
                         f"the gate answers one envelope; {self.why(result, axi)}")


class _EveryGateLintCases(_GateDrive):
    """The cases every client's gate holds."""

    def test_a_failing_lint_stops_the_gate_at_its_lint_stage(self):
        self.failing_lint()
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        self.assertEqual(axi.get("stage"), STAGE, why)
        self.assertIs(axi.get("ok"), False, why)
        self.assertNotEqual(result.returncode, 0, why)
        self.assertEqual(len(self.calls(LINTER)), 1,
                         f"the declared linter runs exactly once; {why}")

    def test_the_tests_never_run_after_a_failing_lint(self):
        self.failing_lint()
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        self.assertEqual(len(self.calls(LINTER)), 1,
                         f"the gate ran its lint stage; {why}")
        self.assertEqual([c for c in self.calls() if self.is_test(c)], [],
                         f"no test stage runs after a failing lint; {why}")

    def test_a_failing_lint_warns_lint_gate_abort_and_carries_its_event(self):
        self.failing_lint()
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        self.assertEqual(warning_codes(axi).count(LINT_GATE_ABORT), 1, why)
        self.assertNotIn(CLIPPY_GATE_ABORT, warning_codes(axi), why)
        self.assertIn(LINT_EVENT, carried_events(axi), why)

    def test_a_failing_lints_abort_names_its_lint_event_exactly_once_in_events(self):
        # A guard: the gate's lint stage already names its event; the lint
        # verb's own `events` must not make the gate name it twice.
        self.failing_lint()
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        self.assertEqual(axi.get("stage"), STAGE, why)
        events = axi.get("events")
        if not isinstance(events, list):
            self.fail(f"the gate's envelope carries an events list; {why}")
        self.assertEqual(events.count(LINT_EVENT), 1,
                         f"the lint event is named once in the gate's events; {why}")

    def test_a_passing_lints_gate_names_its_lint_event_exactly_once_in_events(self):
        # A guard, as above, for the gate that went on past its lint stage.
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        self.assertGateEnvelope(result, axi)
        self.assertNotEqual(axi.get("stage"), STAGE, why)
        events = axi.get("events")
        if not isinstance(events, list):
            self.fail(f"the gate's envelope carries an events list; {why}")
        self.assertEqual(events.count(LINT_EVENT), 1,
                         f"the lint event is named once in the gate's events; {why}")

    def test_a_failing_lint_is_filed_once_with_its_marker_and_exit(self):
        self.failing_lint()
        result, axi = self.gate(self.declaring_project())
        lint_posts = [b for b in self.board.compile_posts() if b.get("lint")]
        self.assertEqual(
            [(b.get("lint"), b.get("format"), b.get("runnerExit")) for b in lint_posts],
            [(MARKER, MARKER, LINT_EXIT)], self.why(result, axi))

    def test_a_passing_lint_runs_in_the_gates_own_order(self):
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        calls = self.calls()
        lint_at = _index(calls, self.is_lint)
        test_at = _index(calls, self.is_test)
        self.assertIsNotNone(lint_at, f"the gate runs its lint stage; {why}")
        self.assertIsNotNone(test_at, f"the gate goes on to its tests; {why}")
        self.assertRanBefore(lint_at, test_at, f"lint runs before the tests; {why}")
        self.assertLintFollowsItsPredecessor(calls, lint_at, why)
        self.assertNotEqual(axi.get("stage"), STAGE, why)

    def assertLintFollowsItsPredecessor(self, calls, lint_at, why):
        """Lint is the gate's first stage: nothing the gate runs as a stage
        comes before it."""
        before = [c for c in calls[:lint_at] if self.is_test(c) or self.is_check(c)]
        self.assertEqual(before, [], f"lint is the gate's first stage; {why}")

    def test_skip_lint_skips_the_lint_stage(self):
        self.failing_lint()
        result, axi = self.gate(self.declaring_project(), "--skip-lint")
        why = self.why(result, axi)
        self.assertNotIn("unrecognized arguments: --skip-lint", result.stderr,
                         f"the gate takes --skip-lint; {why}")
        self.assertGateEnvelope(result, axi)
        self.assertEqual(self.calls(LINTER), [], f"--skip-lint runs no linter; {why}")
        self.assertEqual([b for b in self.board.compile_posts() if b.get("lint")], [],
                         f"--skip-lint files no lint record; {why}")
        self.assertNotEqual(_index(self.calls(), self.is_test), None,
                            f"the gate goes on to its tests; {why}")
        self.assertNotEqual(axi.get("stage"), STAGE, why)

    def test_a_refused_lint_post_warns_ingest_failed_naming_the_lint_step(self):
        self.failing_lint()
        self.board.refuse_compile(400, "the board double refuses this lint post")
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        self.assertEqual(axi.get("stage"), STAGE, why)
        failed = [w for w in axi.get("warnings") or []
                  if isinstance(w, dict) and w.get("code") == INGEST_FAILED]
        self.assertEqual(len(failed), 1,
                         f"one ingest-failed warning, the lint post's; {why}")
        detail = str(failed[0].get("detail"))
        self.assertRegex(detail, r"\blint\b",
                         f"the warning names the lint step (`{GATE} lint` or "
                         f"`lint`); {why}")
        self.assertNotIn(f"the {GATE} run", detail,
                         f"never the bare gate: its tests never ran; {why}")

    def test_a_release_beside_a_cycle_is_refused_before_the_linter_runs(self):
        result, axi = self.gate(self.declaring_project(),
                                "--release", RELEASE, "--cycle", str(CYCLE))
        why = self.why(result, axi)
        self.assertGateEnvelope(result, axi)
        self.assertIs(axi.get("ok"), False, why)
        self.assertNotEqual(result.returncode, 0, why)
        self.assertIn(RELEASE_RUN_REFUSED, result.stderr,
                      f"the release hard stop answers; {why}")
        error = str(axi.get("error"))
        self.assertIn(RELEASE, error, f"the refusal names the release; {why}")
        self.assertIn("--cycle", error, f"the refusal names --cycle; {why}")
        self.assertTrue(any(str(step).startswith(RELEASE_TAKES_NO_CYCLE)
                            for step in axi.get("help") or []),
                        f"the release hard stop's help; {why}")
        self.assertEqual(self.calls(LINTER), [], f"the linter never runs; {why}")
        filed = [(method, path) for method, path, _body in self.board.writes()
                 if urllib.parse.urlsplit(path).path.startswith("/api/v2/runs")]
        self.assertEqual(filed, [], f"nothing is filed on a run route; {why}")
        self.assertEqual(self.board.compile_posts(), [], why)
        self.assertEqual([c for c in self.calls() if self.is_test(c)], [],
                         f"no test stage runs; {why}")


class _MalformedLintCases(_GateDrive):
    """A gate whose project declares `command = []`: refused at its lint
    stage before any linter runs, and nothing filed."""

    def test_an_empty_lint_command_stops_the_gate_at_lint_with_an_error_and_files_nothing(self):
        root = self.project(lint_table([]))
        self.prepare(root)
        result, axi = self.gate(root)
        why = self.why(result, axi)
        self.assertGateEnvelope(result, axi)
        self.assertEqual((axi.get("stage"), axi.get("ok")), (STAGE, False), why)
        error = axi.get("error")
        self.assertIsInstance(error, str, why)
        self.assertIn("crucible.toml", str(error),
                      f"the refusal names the file declaring the table; {why}")
        self.assertEqual(result.returncode, 1, why)
        self.assertEqual(warning_codes(axi).count(LINT_GATE_ABORT), 1, why)
        # The gate's own outcome (its milestone and heartbeats) is not a
        # filing of a run: nothing reaches the run or compile routes.
        filed = [(method, path) for method, path, _body in self.board.writes()
                 if urllib.parse.urlsplit(path).path.startswith("/api/v2/runs")]
        self.assertEqual(filed, [], f"the gate files nothing; {why}")
        self.assertEqual(self.board.compile_posts(), [], why)
        self.assertEqual(self.calls(LINTER), [], why)
        self.assertEqual([c for c in self.calls() if self.is_test(c)], [],
                         f"no test stage runs; {why}")


class _CheckFirstCases(_GateDrive):
    """The cases of a gate whose lint stage follows its `check` (python, bun)
    or its `compile` (arduino)."""

    def assertLintFollowsItsPredecessor(self, calls, lint_at, why):
        check_at = _index(calls, self.is_check)
        self.assertIsNotNone(check_at, f"the gate runs its check stage; {why}")
        self.assertRanBefore(check_at, lint_at, f"check runs before lint; {why}")

    def test_a_failing_lint_stops_the_gate_after_its_check_ran(self):
        self.failing_lint()
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        calls = self.calls()
        lint_at = _index(calls, self.is_lint)
        check_at = _index(calls, self.is_check)
        self.assertIsNotNone(lint_at, f"the gate runs its lint stage; {why}")
        self.assertIsNotNone(check_at, f"check ran before the failing lint; {why}")
        self.assertRanBefore(check_at, lint_at, why)
        self.assertEqual(axi.get("stage"), STAGE, why)

    def test_skip_check_skips_check_and_still_runs_lint(self):
        self.failing_lint()
        result, axi = self.gate(self.declaring_project(), "--skip-check")
        why = self.why(result, axi)
        self.assertEqual([c for c in self.calls() if self.is_check(c)], [],
                         f"--skip-check skips the check stage; {why}")
        self.assertEqual(len(self.calls(LINTER)), 1,
                         f"--skip-check never skips lint; {why}")
        self.assertEqual(axi.get("stage"), STAGE, why)
        self.assertEqual([c for c in self.calls() if self.is_test(c)], [], why)


class _NoDefaultCases(_GateDrive):
    """The cases of a gate whose stack has no default linter: with nothing
    declared its lint stage is skipped and the gate goes on."""

    def test_an_undeclared_lint_lets_the_gate_go_on_warning_lint_not_declared(self):
        result, axi = self.gate(self.undeclaring_project())
        why = self.why(result, axi)
        self.assertGateEnvelope(result, axi)
        self.assertNotEqual(_index(self.calls(), self.is_test), None,
                            f"a skipped lint lets the gate go on to its tests; {why}")
        self.assertEqual(warning_codes(axi).count(LINT_NOT_DECLARED), 1, why)
        self.assertNotEqual(axi.get("stage"), STAGE, why)
        self.assertEqual([b for b in self.board.compile_posts() if b.get("lint")], [],
                         f"a skipped lint files nothing; {why}")


# ── python ──────────────────────────────────────────────────────────────────

class PythonGateRunsLintAfterCheckTest(_MalformedLintCases, _NoDefaultCases,
                                       _CheckFirstCases, _EveryGateLintCases,
                                       unittest.TestCase):
    CLIENT = "python"
    STAGE_TOOLS = ("python",)

    def stage_target(self, tool):
        target = self.scratch / "fake-python-stage"
        target.write_text(f"#!{sys.executable}\n{_FAKE_PYTHON}", encoding="utf-8")
        target.chmod(0o755)
        return target

    def prepare(self, root):
        tests = root / "tests"
        tests.mkdir()
        (tests / "__init__.py").write_text("", encoding="utf-8")
        (tests / "test_probe.py").write_text(
            "import unittest\n\n\nclass ProbeTest(unittest.TestCase):\n"
            "    def test_probe(self):\n        self.assertTrue(True)\n",
            encoding="utf-8")

    def gate_argv(self) -> "tuple[str, ...]":
        return ("--python", str(self.bin / "python"))

    def is_check(self, call):
        return call["tool"] == "python" and call["argv"][:2] == ["-m", "py_compile"]

    def is_test(self, call):
        return (call["tool"] == "python" and call["argv"][:1] != ["-c"]
                and not self.is_check(call)
                and call["argv"][:3] != ["-m", "coverage", "lcov"])

    def test_a_linter_killed_by_a_signal_stops_the_gate_at_lint_with_a_non_negative_exit(self):
        self.say((("out", "app/a.py:1:1: F401 `os` imported but unused\n"),),
                 kill_signal=signal.SIGTERM)
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        self.assertEqual((axi.get("stage"), axi.get("ok"), axi.get("exit")),
                         (STAGE, False, SIGTERM_EXIT), why)
        self.assertNotEqual(result.returncode, 0, why)
        lint_posts = [b for b in self.board.compile_posts() if b.get("lint")]
        self.assertEqual([b.get("runnerExit") for b in lint_posts], [SIGTERM_EXIT], why)
        self.assertNotIn(INGEST_FAILED, warning_codes(axi),
                         f"the board takes the post; {why}")
        self.assertIn(LINT_EVENT, carried_events(axi), why)
        self.assertEqual([c for c in self.calls() if self.is_test(c)], [], why)

    def test_checks_warning_rides_the_envelope_of_a_lint_abort(self):
        # No `app` or `tests` here: `check` compiles nothing and says so.
        self.failing_lint()
        root = self.project(lint_table([LINTER, "check", "."], format=MARKER))
        result, axi = self.gate(root)
        why = self.why(result, axi)
        self.assertEqual(axi.get("stage"), STAGE, why)
        codes = warning_codes(axi)
        self.assertEqual(codes.count(CHECK_COMPILED_NOTHING), 1,
                         f"check's warning survives the lint abort; {why}")
        self.assertEqual(codes.count(LINT_GATE_ABORT), 1, why)


# ── bun ─────────────────────────────────────────────────────────────────────

class BunGateRunsLintAfterCheckTest(_NoDefaultCases, _CheckFirstCases,
                                    _EveryGateLintCases, unittest.TestCase):
    CLIENT = "bun"
    STAGE_TOOLS = ("bun",)

    def gate_argv(self) -> "tuple[str, ...]":
        return ("--bun", str(self.bin / "bun"))

    def is_check(self, call):
        return call["tool"] == "bun" and call["argv"][:2] == ["x", "tsc"]

    def is_test(self, call):
        return call["tool"] == "bun" and _first_word(call) == "test"


# ── arduino ─────────────────────────────────────────────────────────────────

class ArduinoGateRunsLintAfterCompileTest(_NoDefaultCases, _CheckFirstCases,
                                         _EveryGateLintCases, unittest.TestCase):
    CLIENT = "arduino"
    STAGE_TOOLS = ("arduino-cli", "make")

    def prepare(self, root):
        (root / "tests" / "native").mkdir(parents=True)

    def gate_env(self) -> "dict[str, str]":
        return {"ARDUINO_CLI": str(self.bin / "arduino-cli")}

    def is_check(self, call):
        return call["tool"] == "arduino-cli" and _first_word(call) == "compile"

    def is_test(self, call):
        return call["tool"] == "make"


# ── maven ───────────────────────────────────────────────────────────────────

class MavenGateRunsLintBeforeDockerUpTest(_NoDefaultCases, _EveryGateLintCases,
                                         unittest.TestCase):
    CLIENT = "mvn"
    STAGE_TOOLS = ("mvn", "docker")

    def is_docker_up(self, call):
        return call["tool"] == "docker" and "up" in call["argv"]

    def is_test(self, call):
        # docker-up is the first step of the gate's tests, so a lint failure
        # that brought the stack up would already have spent it.
        return call["tool"] == "mvn" or self.is_docker_up(call)

    def test_a_failing_lint_starts_no_container(self):
        self.failing_lint()
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        self.assertEqual(len(self.calls(LINTER)), 1,
                         f"the gate ran its lint stage; {why}")
        self.assertEqual(self.calls("docker"), [],
                         f"a failing lint never calls docker at all; {why}")
        self.assertEqual(axi.get("stage"), STAGE, why)

    def test_a_passing_lint_runs_before_docker_up_and_the_regression(self):
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        calls = self.calls()
        lint_at = _index(calls, self.is_lint)
        up_at = _index(calls, self.is_docker_up)
        mvn_at = _index(calls, lambda c: c["tool"] == "mvn")
        self.assertIsNotNone(lint_at, f"the gate runs its lint stage; {why}")
        self.assertIsNotNone(up_at, f"the gate goes on to docker-up; {why}")
        self.assertIsNotNone(mvn_at, f"the gate goes on to its regression; {why}")
        self.assertRanBefore(lint_at, up_at, why)
        self.assertRanBefore(up_at, mvn_at, why)


# ── go ──────────────────────────────────────────────────────────────────────

class _GoTestRefusingGateBoard(GateBoard):
    """The gate board double whose health lists no `go-test` codec, as the
    go tier verb refusal test scripts it."""

    def route(self, method, path):
        if method == "GET" and urllib.parse.urlsplit(path).path in HEALTH_PATHS:
            health = board_health()
            for kind in ("test", "stream"):
                health["codecs"][kind] = [c for c in health["codecs"][kind]
                                          if c != GO_TEST_STREAM_CODEC]
            return 200, health
        return super().route(method, path)


class GoGateRefusesABoardWithoutGoTestBeforeItsLintStageTest(_GateDrive,
                                                             unittest.TestCase):
    """The go gate reads the board's health before its lint stage, as the
    rust gate does: a refused gate runs no linter and files nothing."""

    CLIENT = "go"
    STAGE_TOOLS = ("go",)
    LINT_WORDS = {"go": ("vet",)}

    @classmethod
    def setUpClass(cls):
        cls.board = _GoTestRefusingGateBoard()
        try:
            cls.fleet = ScratchFleet(cls.board.base_url)
        except BaseException:
            cls.board.close()
            raise
        cls.toolchain_bin = _build_fake_bin_dir()

    def prepare(self, root):
        write_go_module(root)

    def is_test(self, call):
        return call["tool"] == "go" and _first_word(call) == "test"

    def is_vet(self, call):
        return call["tool"] == "go" and _first_word(call) == "vet"

    def assertRefusedBeforeLint(self, result, axi):
        why = self.why(result, axi)
        self.assertGateEnvelope(result, axi)
        self.assertIs(axi.get("ok"), False, why)
        self.assertNotEqual(result.returncode, 0, why)
        self.assertIn(GO_TEST_STREAM_CODEC, json.dumps(axi),
                      f"the refusal names the codec; {why}")
        self.assertNotEqual(axi.get("stage"), STAGE, why)
        self.assertEqual([b for b in self.board.compile_posts() if b.get("lint")], [],
                         f"no lint post reaches the board; {why}")
        self.assertEqual([c for c in self.calls() if self.is_test(c)], [], why)
        return why

    def test_a_declared_linter_never_runs_on_a_board_without_go_test(self):
        result, axi = self.gate(self.declaring_project())
        why = self.assertRefusedBeforeLint(result, axi)
        self.assertEqual(self.calls(LINTER), [], f"the linter never runs; {why}")

    def test_the_default_go_vet_never_runs_on_a_board_without_go_test(self):
        result, axi = self.gate(self.undeclaring_project())
        why = self.assertRefusedBeforeLint(result, axi)
        self.assertEqual([c for c in self.calls() if self.is_vet(c)], [],
                         f"go vet never runs; {why}")


class GoGateRunsLintFirstTest(_EveryGateLintCases, unittest.TestCase):
    CLIENT = "go"
    STAGE_TOOLS = ("go",)
    LINT_WORDS = {"go": ("vet",)}

    def prepare(self, root):
        write_go_module(root)

    def is_test(self, call):
        return call["tool"] == "go" and _first_word(call) == "test"

    def is_vet(self, call):
        return call["tool"] == "go" and call["argv"][:2] == ["vet", "./..."]

    def test_with_nothing_declared_the_gate_vets_before_its_tests(self):
        result, axi = self.gate(self.undeclaring_project())
        why = self.why(result, axi)
        calls = self.calls()
        vet_at = _index(calls, self.is_vet)
        test_at = _index(calls, self.is_test)
        self.assertIsNotNone(vet_at, f"the go default lint runs in the gate; {why}")
        self.assertIsNotNone(test_at, f"the gate goes on to its tests; {why}")
        self.assertRanBefore(vet_at, test_at, why)
        self.assertNotIn(LINT_NOT_DECLARED, warning_codes(axi),
                         f"go always has a default; {why}")

    def test_a_failing_default_vet_stops_the_gate_before_its_tests(self):
        self.failing_lint()
        result, axi = self.gate(self.undeclaring_project())
        why = self.why(result, axi)
        self.assertEqual(len([c for c in self.calls() if self.is_vet(c)]), 1, why)
        self.assertEqual([c for c in self.calls() if self.is_test(c)], [], why)
        self.assertEqual(axi.get("stage"), STAGE, why)
        self.assertEqual(warning_codes(axi).count(LINT_GATE_ABORT), 1, why)

    def test_a_declared_lint_replaces_go_vet_in_the_gate(self):
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        self.assertEqual(len(self.calls(LINTER)), 1, why)
        self.assertEqual([c for c in self.calls() if self.is_vet(c)], [], why)


# ── rust ────────────────────────────────────────────────────────────────────

class RustGateRunsLintFirstTest(_MalformedLintCases, _EveryGateLintCases,
                                unittest.TestCase):
    CLIENT = "rust"
    STAGE_TOOLS = ("cargo",)
    LINT_WORDS = {"cargo": ("clippy",)}

    def gate_argv(self) -> "tuple[str, ...]":
        return ("--min-free-g", "0", "--keep-target")

    def is_test(self, call):
        # The nextest refusal's version read is the gate's pre-flight, not a
        # test stage.
        return (call["tool"] == "cargo" and call["argv"][:2] != ["nextest", "--version"]
                and ("nextest" in call["argv"] or "llvm-cov" in call["argv"]))

    def is_clippy(self, call):
        return call["tool"] == "cargo" and _first_word(call) == "clippy"


class RustGateMapsItsClippyStepToLintTest(_GateDrive, unittest.TestCase):
    """The rust gate's contract mapping: its clippy step is its lint stage."""

    CLIENT = "rust"
    STAGE_TOOLS = ("cargo",)
    LINT_WORDS = {"cargo": ("clippy",)}

    def gate_argv(self) -> "tuple[str, ...]":
        return ("--min-free-g", "0", "--keep-target")

    def is_test(self, call):
        # The nextest refusal's version read is the gate's pre-flight, not a
        # test stage.
        return (call["tool"] == "cargo" and call["argv"][:2] != ["nextest", "--version"]
                and ("nextest" in call["argv"] or "llvm-cov" in call["argv"]))

    def clippy_calls(self):
        return [c for c in self.calls("cargo") if _first_word(c) == "clippy"]

    def failing_clippy(self):
        """A clippy that fails with two errors and one warning, which the
        board double decodes to the same two counts: the gate's `errors` and
        `lints` read the same whether they are counted from the output or
        taken from the board's answer."""
        self.say((("err", "error: unneeded `return` statement\n"),
                  ("err", "error: redundant clone\n"),
                  ("err", "warning: this let-binding has unit value\n")),
                 exit_code=101)
        self.board.answer_counts(CLIPPY_ERRORS, CLIPPY_WARNINGS, event=LINT_EVENT)

    def test_a_failing_default_lint_reads_stage_lint_with_errors_and_lints(self):
        self.failing_clippy()
        result, axi = self.gate(self.undeclaring_project())
        why = self.why(result, axi)
        self.assertEqual(
            {k: axi.get(k) for k in ("stage", "errors", "lints")},
            {"stage": STAGE, "errors": CLIPPY_ERRORS, "lints": CLIPPY_WARNINGS}, why)
        self.assertEqual([c["argv"] for c in self.clippy_calls()],
                         [WORKSPACE_CLIPPY_ARGV], why)
        self.assertEqual([c for c in self.calls() if self.is_test(c)], [], why)

    def test_an_aborted_lint_step_warns_lint_gate_abort_never_clippy_gate_abort(self):
        self.failing_clippy()
        result, axi = self.gate(self.undeclaring_project())
        codes = warning_codes(axi)
        why = self.why(result, axi)
        self.assertEqual(codes.count(LINT_GATE_ABORT), 1, why)
        self.assertNotIn(CLIPPY_GATE_ABORT, codes, why)

    def test_skip_clippy_still_skips_the_lint_step(self):
        # Guard: `--skip-clippy` skips the step today, and stays its alias.
        self.failing_clippy()
        result, axi = self.gate(self.undeclaring_project(), "--skip-clippy")
        why = self.why(result, axi)
        self.assertGateEnvelope(result, axi)
        self.assertEqual(self.clippy_calls(), [], why)
        self.assertNotEqual(_index(self.calls(), self.is_test), None, why)
        self.assertNotEqual(axi.get("stage"), STAGE, why)

    def test_skip_clippy_skips_a_declared_lint_too(self):
        # Guard: no declared linter runs in the rust gate today either.
        self.failing_lint()
        result, axi = self.gate(self.declaring_project(), "--skip-clippy")
        why = self.why(result, axi)
        self.assertGateEnvelope(result, axi)
        self.assertEqual(self.calls(LINTER), [], why)
        self.assertEqual(self.clippy_calls(), [], why)

    def test_the_default_lint_step_runs_with_cargo_build_jobs_set(self):
        # Guard: today's clippy step sets it; the lint stage keeps it.
        result, axi = self.gate(self.undeclaring_project())
        why = self.why(result, axi)
        calls = self.clippy_calls()
        self.assertEqual(len(calls), 1, why)
        jobs = calls[0]["env"]["CARGO_BUILD_JOBS"]
        self.assertIsNotNone(jobs, why)
        self.assertTrue(str(jobs).isdigit() and int(jobs) > 0,
                        f"CARGO_BUILD_JOBS is a positive job count; {why}")

    def test_a_declared_lint_replaces_the_clippy_default_in_the_gate(self):
        result, axi = self.gate(self.declaring_project())
        why = self.why(result, axi)
        self.assertEqual(len(self.calls(LINTER)), 1, why)
        self.assertEqual(self.clippy_calls(), [], why)
        lint_posts = [b for b in self.board.compile_posts() if b.get("lint")]
        self.assertEqual([b.get("lint") for b in lint_posts], [MARKER], why)


if __name__ == "__main__":
    unittest.main()
