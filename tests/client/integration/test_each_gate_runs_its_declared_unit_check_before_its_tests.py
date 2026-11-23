"""Each client's `pre-merge-gate` runs the project's declared unit-check stage
-- the `[unit-check]` table of its `crucible.toml` -- after its lint stage and
before the stage that follows lint in that client:

| client      | order                                                  |
|-------------|--------------------------------------------------------|
| python, bun | `check` -> lint -> unit-check -> tests                 |
| arduino     | `compile` -> lint -> unit-check -> tests               |
| rust        | lint -> unit-check -> regression                       |
| go          | lint -> unit-check -> `gate_regression`                |
| maven       | lint -> unit-check -> docker-up -> regression          |

- A passing command (exit 0) lets the gate go on. It runs once, as declared
  (its own words, in the directory the lint stage ran in), and with exactly
  the environment the gate process was given: the client adds nothing and
  removes nothing.
- A failing command stops the gate: its one envelope reads `ok: false`,
  `stage: "unit-check"` with the command's exit, the warning
  `unit-check-gate-abort` and a `help` line naming the command. The
  command's output is on stderr, never on the envelope's stdout. No later
  stage runs (no test runner, no container) and no run is started or filed.
- `--skip-unit-check` skips a declared stage; with no table the stage is
  skipped and the gate goes on, warning `unit-check-not-declared`.
- A malformed table (`command` missing, not a list, empty, or holding an
  empty or non-string entry; `name` not a non-empty string) stops the gate at
  `stage: "unit-check"` with an `error` naming `crucible.toml` and the field,
  and `unit-check-gate-abort`; the command never runs and nothing follows.
- A declared `name` names the stage in the abort's help or warning detail;
  without one, the basename of the command's first word does.

The parsing is shared code, so the malformed and name cases are driven
through the python client alone; every other case is driven through all six.

Every drive is a real subprocess of a client from a scratch copy of the
fleet, against the recording board double and the recording stage doubles of
`tests/client/integration/test_each_gate_runs_lint_in_its_own_order.py`
(whose drive this module reuses). The declared unit-check command is a fake
written per test into a temp dir: it appends its argv, cwd and full
environment (read from `/proc/self/environ`, the environment it was
exec'd with) to the same call log every stage writes, then prints and exits
as the test wrote it to.

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> --tests \
        tests.client.integration.test_each_gate_runs_its_declared_unit_check_before_its_tests
"""

# pi-lens-ignore: I001 — pi-lens lints with its own ruff configuration, which sets no target version, so ruff files `tomllib` as third-party whatever the declared floor
import json  # noqa: I001
import os
import sys
import tomllib
import unittest
import urllib.parse
from pathlib import Path

from tests.client.client_fleet_envelope_census_helpers import write_go_module
from tests.client.integration.test_each_gate_runs_lint_in_its_own_order import (
    CHECK_COMPILED_NOTHING,
    GATE,
    LINTER,
    MARKER,
    _GateDrive,
    _first_word,
    _index,
)
from tests.client.lint_verb_harness import (
    COMPILE_ROUTE,
    STRIPPED_ENV,
    lint_table,
    warning_codes,
)
from tests.client.python_client_sends_its_runners_reports_helpers import _FAKE_PYTHON

STAGE = "unit-check"
UNIT_CHECK_GATE_ABORT = "unit-check-gate-abort"
UNIT_CHECK_NOT_DECLARED = "unit-check-not-declared"
SKIP_FLAG = "--skip-unit-check"

#: The declared unit-check command's first word; never a real tool.
UNIT_CHECK = "gate-fixture-unit-check"
#: The words it is declared with after its first: passed through as declared.
UNIT_CHECK_ARGS = ["bun", "python"]
#: The exit a failing unit-check command is written to end with.
UNIT_CHECK_EXIT = 3
#: The line a failing unit-check command prints to its stdout.
UNIT_CHECK_LINE = "unit-check fixture: 4 real timers armed above 0 ms in the unit tier"
#: A declared stage name, never a word of the command.
DECLARED_NAME = "hermetic-unit-tiers"

#: Variables a client must never add to the command's environment.
HOOK_VARS = ("PYTHONPATH", "HERMETIC_EVENTS")

#: A table key left out of the declaration.
_ABSENT = object()

#: The agent every gate drive runs under.
AGENT_ID = "unit-check-gate-fixture-agent"


# ── the declared command ────────────────────────────────────────────────────

_FAKE_UNIT_CHECK = r'''
import json
import os
import sys

TOOL = @TOOL@
LOG = @LOG@
OUT = @OUT@
EXIT = @EXIT@


def exec_environ():
    """The environment this process was exec'd with, before the interpreter
    touched its own copy."""
    try:
        with open("/proc/self/environ", "rb") as handle:
            raw = handle.read()
    except OSError:
        return dict(os.environ)
    found = {}
    for item in raw.split(b"\0"):
        key, sep, value = item.partition(b"=")
        if sep and key:
            found[key.decode("utf-8", "surrogateescape")] = value.decode(
                "utf-8", "surrogateescape")
    return found


with open(LOG, "a", encoding="utf-8") as handle:
    handle.write(json.dumps({
        "tool": TOOL,
        "argv": sys.argv[1:],
        "cwd": os.getcwd(),
        "environ": exec_environ(),
    }) + "\n")
sys.stdout.write(OUT)
sys.stdout.flush()
sys.exit(EXIT)
'''


def write_fake_unit_check(directory, log, out="", exit_code=0):
    """Write `<directory>/gate-fixture-unit-check`, executable: it records its
    call in `log`, prints `out` on its stdout and exits `exit_code`. Every
    value is written into the file, so it reads nothing from its environment."""
    body = (_FAKE_UNIT_CHECK.replace("@TOOL@", json.dumps(UNIT_CHECK))
            .replace("@LOG@", json.dumps(str(log)))
            .replace("@OUT@", json.dumps(out))
            .replace("@EXIT@", str(int(exit_code))))
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / UNIT_CHECK
    path.write_text(f"#!{sys.executable}\n{body}", encoding="utf-8")
    path.chmod(0o755)
    return path


def unit_check_table(command=_ABSENT, name=_ABSENT):
    """A `[unit-check]` table as TOML text; a field left `_ABSENT` is not
    written. Values are written as JSON, which is valid TOML for strings,
    integers and arrays."""
    lines = ["", "[unit-check]"]
    if command is not _ABSENT:
        lines.append(f"command = {json.dumps(command)}")
    if name is not _ABSENT:
        lines.append(f"name = {json.dumps(name)}")
    return "\n".join(lines) + "\n"


# ── the drive ───────────────────────────────────────────────────────────────

class _UnitCheckDrive(_GateDrive):
    """One client's gate with a passing declared lint, and a unit-check
    declaration written per test."""

    #: Tools a gate stopped before its tests never calls at all.
    NEVER_AFTER_ABORT = ()

    def setUp(self):
        super().setUp()
        self.fake_dir = self.scratch / "unit-check-bin"

    def unit_check(self, exit_code=0, out=""):
        """The declared command's path, written to print `out` and exit
        `exit_code`."""
        return write_fake_unit_check(self.fake_dir, self.log, out, exit_code)

    def failing_unit_check(self):
        return self.unit_check(UNIT_CHECK_EXIT, UNIT_CHECK_LINE + "\n")

    def unit_check_project(self, command=_ABSENT, name=_ABSENT):
        """A project declaring the passing fixture lint and the given
        `[unit-check]` table, guarded to parse back as written."""
        root = self.project(lint_table([LINTER, "check", "."], format=MARKER)
                            + unit_check_table(command, name))
        with open(root / "crucible.toml", "rb") as handle:
            declared = tomllib.load(handle).get(STAGE)
        expected = {k: v for k, v in (("command", command), ("name", name))
                    if v is not _ABSENT}
        self.assertEqual(declared, expected,
                         "fixture guard: the project declares the table as written")
        self.prepare(root)
        return root

    def declared_project(self, path, name=_ABSENT):
        return self.unit_check_project([str(path), *UNIT_CHECK_ARGS], name)

    def lint_only_project(self):
        root = self.project(lint_table([LINTER, "check", "."], format=MARKER))
        self.prepare(root)
        return root

    def drive_gate(self, root, *flags, env=None):
        return self.run_client(self.CLIENT, root, "--agent", AGENT_ID,
                               *self.gate_argv(), *flags, verb=GATE,
                               env={**self.gate_env(), **(env or {})})

    def gate_process_env(self, extra):
        """The environment the drive hands the gate process: the harness's
        drive (`drive`, `LintDriveMixin.run_client`) passes this process's
        environment without `STRIPPED_ENV`, its bin dirs in front of PATH,
        the fake linter's log and script, then the gate's own env."""
        env = {k: v for k, v in os.environ.items() if k not in STRIPPED_ENV}
        env["PATH"] = os.pathsep.join(
            [str(self.bin), str(self.toolchain_bin), env.get("PATH", "")])
        env.update({"FAKE_LINT_LOG": str(self.log),
                    "FAKE_LINT_SCRIPT": str(self.script)})
        env.update(self.gate_env())
        env.update(extra)
        return env

    def unit_check_calls(self):
        return self.calls(UNIT_CHECK)

    def run_route_writes(self):
        """Every write on a run route other than the compile route the lint
        post goes to: a run started, streamed, filed or aborted."""
        return [(method, path) for method, path, _body in self.board.writes()
                if urllib.parse.urlsplit(path).path.startswith("/api/v2/runs")
                and urllib.parse.urlsplit(path).path != COMPILE_ROUTE]

    def help_and_detail(self, axi):
        """The abort's `help` lines and its `unit-check-gate-abort` detail,
        as one text."""
        details = [str(w.get("detail")) for w in axi.get("warnings") or []
                   if isinstance(w, dict) and w.get("code") == UNIT_CHECK_GATE_ABORT]
        return json.dumps(axi.get("help")) + "\n" + "\n".join(details)

    def assertStoppedAtUnitCheck(self, result, axi, why):
        """The gate's one envelope stopped at the unit-check stage, and
        nothing after the stage ran or was filed."""
        self.assertGateEnvelope(result, axi)
        self.assertEqual((axi.get("ok"), axi.get("stage")), (False, STAGE), why)
        self.assertNotEqual(result.returncode, 0, why)
        self.assertEqual(warning_codes(axi).count(UNIT_CHECK_GATE_ABORT), 1, why)
        self.assertEqual([c for c in self.calls() if self.is_test(c)], [],
                         f"no test stage runs after the unit-check stage; {why}")
        for tool in self.NEVER_AFTER_ABORT:
            self.assertEqual(self.calls(tool), [],
                             f"a gate stopped at unit-check never calls {tool}; {why}")
        self.assertEqual(self.run_route_writes(), [],
                         f"no run is started or filed; {why}")


class _EveryGateUnitCheckCases(_UnitCheckDrive):
    """The cases every client's gate holds."""

    def test_a_passing_unit_check_runs_once_after_lint_and_before_the_next_stage(self):
        path = self.unit_check(exit_code=0)
        result, axi = self.drive_gate(self.declared_project(path))
        why = self.why(result, axi)
        calls = self.calls()
        lint_at = _index(calls, self.is_lint)
        unit_at = _index(calls, lambda c: c["tool"] == UNIT_CHECK)
        next_at = _index(calls, self.is_test)
        self.assertEqual(len(self.unit_check_calls()), 1,
                         f"the declared unit-check runs exactly once; {why}")
        self.assertRanBefore(lint_at, unit_at, f"lint runs before unit-check; {why}")
        self.assertRanBefore(unit_at, next_at,
                             f"unit-check runs before the gate's next stage; {why}")
        assert lint_at is not None  # assertRanBefore failed otherwise
        self.assertEqual(self.unit_check_calls()[0]["argv"], UNIT_CHECK_ARGS,
                         f"the command runs with its declared words; {why}")
        self.assertEqual(self.unit_check_calls()[0]["cwd"], calls[lint_at]["cwd"],
                         f"unit-check runs in the directory lint ran in; {why}")
        self.assertGateEnvelope(result, axi)
        self.assertNotEqual(axi.get("stage"), STAGE, why)
        self.assertNotIn(UNIT_CHECK_GATE_ABORT, warning_codes(axi), why)
        self.assertNotIn(UNIT_CHECK_NOT_DECLARED, warning_codes(axi), why)

    def test_a_failing_unit_check_stops_the_gate_at_its_stage_with_its_exit(self):
        path = self.failing_unit_check()
        result, axi = self.drive_gate(self.declared_project(path))
        why = self.why(result, axi)
        self.assertEqual(len(self.unit_check_calls()), 1,
                         f"the declared unit-check runs exactly once; {why}")
        self.assertStoppedAtUnitCheck(result, axi, why)
        self.assertEqual(axi.get("exit"), UNIT_CHECK_EXIT,
                         f"the envelope carries the command's exit; {why}")
        self.assertTrue(any(UNIT_CHECK in str(step) for step in axi.get("help") or []),
                        f"a help line names the command; {why}")
        self.assertIn(UNIT_CHECK_LINE, result.stderr,
                      f"the command's output is on stderr; {why}")
        self.assertNotIn(UNIT_CHECK_LINE, result.stdout,
                         f"the command's output never reaches stdout; {why}")

    def test_skip_unit_check_skips_a_declared_stage_and_the_gate_goes_on(self):
        path = self.failing_unit_check()
        result, axi = self.drive_gate(self.declared_project(path), SKIP_FLAG)
        why = self.why(result, axi)
        self.assertNotIn(f"unrecognized arguments: {SKIP_FLAG}", result.stderr,
                         f"the gate takes {SKIP_FLAG}; {why}")
        self.assertGateEnvelope(result, axi)
        self.assertEqual(self.unit_check_calls(), [],
                         f"{SKIP_FLAG} never runs the command; {why}")
        self.assertIsNotNone(_index(self.calls(), self.is_test),
                             f"the gate goes on to its next stage; {why}")
        self.assertNotEqual(axi.get("stage"), STAGE, why)
        self.assertNotIn(UNIT_CHECK_GATE_ABORT, warning_codes(axi), why)
        self.assertNotIn(UNIT_CHECK_NOT_DECLARED, warning_codes(axi),
                         f"a skipped declared stage is not an undeclared one; {why}")

    def test_with_no_table_the_gate_goes_on_warning_unit_check_not_declared(self):
        result, axi = self.drive_gate(self.lint_only_project())
        why = self.why(result, axi)
        self.assertGateEnvelope(result, axi)
        self.assertEqual(warning_codes(axi).count(UNIT_CHECK_NOT_DECLARED), 1,
                         f"one unit-check-not-declared warning; {why}")
        self.assertIsNotNone(_index(self.calls(), self.is_test),
                             f"the gate goes on to its next stage; {why}")
        self.assertNotEqual(axi.get("stage"), STAGE, why)
        self.assertNotIn(UNIT_CHECK_GATE_ABORT, warning_codes(axi), why)

    def test_the_command_runs_with_the_gate_processs_environment_unchanged(self):
        # LC_ALL is set so neither interpreter coerces its locale (PEP 538),
        # which would add LC_CTYPE to the environment it hands on.
        extra = {"LC_ALL": "C.UTF-8"}
        path = self.unit_check(exit_code=0)
        result, axi = self.drive_gate(self.declared_project(path), env=extra)
        why = self.why(result, axi)
        calls = self.unit_check_calls()
        self.assertEqual(len(calls), 1, f"the declared unit-check runs once; {why}")
        seen = calls[0]["environ"]
        expected = self.gate_process_env(extra)
        added = sorted(set(seen) - set(expected))
        removed = sorted(set(expected) - set(seen))
        changed = sorted(k for k in set(seen) & set(expected) if seen[k] != expected[k])
        self.assertEqual((added, removed, changed), ([], [], []),
                         f"the client adds, removes and changes nothing in the "
                         f"command's environment; {why}")
        for name in HOOK_VARS:
            self.assertEqual(seen.get(name), expected.get(name),
                             f"no {name} is added for the command; {why}")


class _SharedParsingCases(_UnitCheckDrive):
    """The table's parsing and the stage's name: shared code, driven through
    one client."""

    def assertRefusedNaming(self, root, says):
        """The gate refused the declaration: its `error` names the file and
        says `says`, the text naming the offending field and what is wrong
        with it -- never a word the refusal's remedy hint holds whatever the
        field."""
        result, axi = self.drive_gate(root)
        why = self.why(result, axi)
        self.assertStoppedAtUnitCheck(result, axi, why)
        error = axi.get("error")
        self.assertIsInstance(error, str, f"the refusal is an error; {why}")
        self.assertIn("crucible.toml", str(error),
                      f"the refusal names the file declaring the table; {why}")
        self.assertIn(says, str(error),
                      f"the refusal names the field and what is wrong with it; {why}")
        self.assertEqual(self.unit_check_calls(), [],
                         f"a refused declaration runs nothing; {why}")

    def test_a_table_without_command_is_refused_naming_the_file_and_command(self):
        self.unit_check()
        self.assertRefusedNaming(self.unit_check_project(name=DECLARED_NAME),
                                 "`command` is None, not a list")

    def test_a_command_that_is_not_a_list_is_refused_naming_the_file_and_command(self):
        path = self.unit_check()
        self.assertRefusedNaming(self.unit_check_project(command=str(path)),
                                 f"`command` is {str(path)!r}, not a list")

    def test_an_empty_command_is_refused_naming_the_file_and_command(self):
        self.unit_check()
        self.assertRefusedNaming(self.unit_check_project(command=[]),
                                 "`command` is an empty list")

    def test_a_command_with_an_empty_entry_is_refused_naming_the_file_and_command(self):
        path = self.unit_check()
        command = [str(path), ""]
        self.assertRefusedNaming(self.unit_check_project(command=command),
                                 f"`command` {command!r} holds an empty or non-string entry")

    def test_a_command_with_a_non_string_entry_is_refused_naming_the_file_and_command(self):
        path = self.unit_check()
        command = [str(path), 3]
        self.assertRefusedNaming(self.unit_check_project(command=command),
                                 f"`command` {command!r} holds an empty or non-string entry")

    def test_an_empty_name_is_refused_naming_the_file_and_name(self):
        path = self.unit_check()
        self.assertRefusedNaming(self.unit_check_project(command=[str(path)], name=""),
                                 "`name` is '', not a non-empty string")

    def test_a_non_string_name_is_refused_naming_the_file_and_name(self):
        path = self.unit_check()
        self.assertRefusedNaming(self.unit_check_project(command=[str(path)], name=7),
                                 "`name` is 7, not a non-empty string")

    def test_a_bare_table_header_is_refused_naming_the_file_and_command(self):
        # An empty `[unit-check]` is declared, so it is refused, never read
        # as "not declared".
        self.unit_check()
        self.assertRefusedNaming(self.unit_check_project(),
                                 "`command` is None, not a list")

    def test_a_key_that_is_not_a_table_is_refused_naming_the_file_and_the_key(self):
        root = self.lint_only_project()
        config = root / "crucible.toml"
        # A top-level key goes before the file's first table header.
        config.write_text(f'{STAGE} = "x"\n' + config.read_text(encoding="utf-8"),
                          encoding="utf-8")
        with open(config, "rb") as handle:
            self.assertEqual(tomllib.load(handle).get(STAGE), "x",
                             "fixture guard: the project declares the key as written")
        self.assertRefusedNaming(root, "`unit-check` is 'x', not a table")

    def test_a_command_that_is_not_found_stops_the_gate_at_its_stage_with_an_error(self):
        missing = self.scratch / "no-such-unit-check"
        result, axi = self.drive_gate(self.unit_check_project(command=[str(missing)]))
        why = self.why(result, axi)
        self.assertStoppedAtUnitCheck(result, axi, why)
        self.assertEqual(axi.get("exit"), 1,
                         f"a command not found stops the gate with exit 1; {why}")
        error = axi.get("error")
        self.assertIsInstance(error, str, f"the stop is an error; {why}")
        self.assertIn(repr(str(missing)), str(error),
                      f"the error names the command not found; {why}")
        self.assertIn(f"no executable at {missing}", str(error),
                      f"the error keeps why the command was not found; {why}")

    def test_a_declared_name_names_the_stage_in_the_abort(self):
        path = self.failing_unit_check()
        result, axi = self.drive_gate(self.declared_project(path, name=DECLARED_NAME))
        why = self.why(result, axi)
        self.assertStoppedAtUnitCheck(result, axi, why)
        self.assertIn(DECLARED_NAME, self.help_and_detail(axi),
                      f"the declared name names the stage; {why}")

    def test_without_a_name_the_commands_basename_names_the_stage_in_the_abort(self):
        path = self.failing_unit_check()
        result, axi = self.drive_gate(self.declared_project(path))
        why = self.why(result, axi)
        self.assertStoppedAtUnitCheck(result, axi, why)
        self.assertIn(UNIT_CHECK, self.help_and_detail(axi),
                      f"the command's basename names the stage; {why}")
        self.assertNotIn(DECLARED_NAME, self.help_and_detail(axi), why)


# ── python ──────────────────────────────────────────────────────────────────

class PythonGateRunsItsDeclaredUnitCheckTest(_SharedParsingCases,
                                             _EveryGateUnitCheckCases,
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

    def test_checks_warning_rides_the_envelope_of_a_unit_check_abort(self):
        # No `app` or `tests` here: `check` compiles nothing and says so.
        path = self.failing_unit_check()
        root = self.project(lint_table([LINTER, "check", "."], format=MARKER)
                            + unit_check_table([str(path), *UNIT_CHECK_ARGS]))
        result, axi = self.drive_gate(root)
        why = self.why(result, axi)
        self.assertStoppedAtUnitCheck(result, axi, why)
        self.assertEqual(warning_codes(axi).count(CHECK_COMPILED_NOTHING), 1,
                         f"check's warning survives the unit-check abort; {why}")


# ── bun ─────────────────────────────────────────────────────────────────────

class BunGateRunsItsDeclaredUnitCheckTest(_EveryGateUnitCheckCases, unittest.TestCase):
    CLIENT = "bun"
    STAGE_TOOLS = ("bun",)

    def gate_argv(self) -> "tuple[str, ...]":
        return ("--bun", str(self.bin / "bun"))

    def is_check(self, call):
        return call["tool"] == "bun" and call["argv"][:2] == ["x", "tsc"]

    def is_test(self, call):
        return call["tool"] == "bun" and _first_word(call) == "test"


# ── arduino ─────────────────────────────────────────────────────────────────

class ArduinoGateRunsItsDeclaredUnitCheckTest(_EveryGateUnitCheckCases,
                                              unittest.TestCase):
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


# ── rust ────────────────────────────────────────────────────────────────────

class RustGateRunsItsDeclaredUnitCheckTest(_EveryGateUnitCheckCases, unittest.TestCase):
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


# ── go ──────────────────────────────────────────────────────────────────────

class GoGateRunsItsDeclaredUnitCheckTest(_EveryGateUnitCheckCases, unittest.TestCase):
    CLIENT = "go"
    STAGE_TOOLS = ("go",)
    LINT_WORDS = {"go": ("vet",)}

    def prepare(self, root):
        write_go_module(root)

    def is_test(self, call):
        return call["tool"] == "go" and _first_word(call) == "test"


# ── maven ───────────────────────────────────────────────────────────────────

class MavenGateRunsItsDeclaredUnitCheckTest(_EveryGateUnitCheckCases,
                                            unittest.TestCase):
    CLIENT = "mvn"
    STAGE_TOOLS = ("mvn", "docker")
    #: A gate stopped at unit-check starts no container: no docker call at all.
    NEVER_AFTER_ABORT = ("docker",)

    def is_docker_up(self, call):
        return call["tool"] == "docker" and "up" in call["argv"]

    def is_test(self, call):
        # docker-up is the stage after unit-check, then the regression.
        return call["tool"] == "mvn" or self.is_docker_up(call)


if __name__ == "__main__":
    unittest.main()
