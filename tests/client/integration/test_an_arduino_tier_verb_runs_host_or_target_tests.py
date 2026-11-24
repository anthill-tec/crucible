"""An arduino tier verb runs host or target tests by its tier.

`arduino-crucible.py` translates a tier to the place its tests run:

  * `unit` runs `make junit` in `tests/native` (the native host tests);
  * `integration` runs `make junit` in `tests/sim` (tests under a simulator);
  * `e2e` runs `make junit` in `tests/hil` (tests on the board);
  * `--dir` overrides the place on each verb;
  * a `junit-<tier>:` target declared in the Makefile read (`tests/native`
    without `--dir`, the `--dir` directory with it) wins, and runs where it is
    declared;
  * with no place and no declaration, `integration`, `e2e`, `module` and `bdd`
    are refused (`tier-run-undeclared`) before anything runs;
  * `TESTS` and `TEST_NAME` reach `make` only from `--tests`/`--name`;
  * a `unit`, `integration` or `e2e` run whose reports hold no case, or only
    skipped cases, is refused (`tier-selection-empty`) and filed nowhere;
  * `regression` and `pre-merge-gate` are unchanged.

Every test drives the real `clients/arduino-crucible.py` as a subprocess from a
scratch firmware project it owns, against a loopback `RecordingBoard` the
project declares in its own `crucible.toml`. `make` is a stand-in first on
`PATH`: it records its argv, working directory and the two narrowing variables,
and writes a JUnit report of the cases the test scripted (narrowed by `TESTS`
and `TEST_NAME` as a native Makefile narrows them) to `REPORTS_DIR`, else to
`reports/` under its working directory. Each place's `Makefile` is real, so the
client reads the declarations a firmware project would write.

TIER: integration (a client subprocess, a stand-in `make` subprocess, a
loopback HTTP board).

Invocation:
    .venv/bin/python clients/python-crucible.py integration \
        --start-dir tests/client/integration \
        --pattern test_an_arduino_tier_verb_runs_host_or_target_tests.py
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.an_arduino_run_narrowed_by_tests_and_name_reaches_make_helpers import (
    ARDUINO_CLIENT,
    RUNS_INGEST,
    TIMEOUT,
    _diagnostics,
    _envelope,
    sent_case_count,
)
from tests.client.live_run_harness import (
    INGEST_PATHS,
    RecordingBoard,
    install_project,
    new_scratch,
    scrubbed_env,
)

PROJECT_KEY = "arduino-tier-places-key"

TIER_RUN_UNDECLARED = "tier-run-undeclared"
TIER_SELECTION_EMPTY = "tier-selection-empty"
# The refusal's help line naming the tier verbs that run on this project.
RUNS_TODAY = "tier verbs this client runs today: "

NATIVE = "tests/native"
SIM = "tests/sim"
HIL = "tests/hil"
RIG = "tests/rig"

# Keys that would let the shell running this suite steer or identify the
# client, plus the two narrowing variables, which a test sets only on purpose.
_SCRUBBED = ("ARDUINO_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY", "AGENT_ID", "TESTS", "TEST_NAME")

# The cases the stand-in `make` reports, each `(file stem, name, outcome)`.
ONE_PASS = (("test_a", "test_stall_detected", "pass"),)
SKIPPED_ONLY = (("test_rig", "test_motor_spins", "skip"),
                ("test_rig", "test_led_blinks", "skip"))
NO_CASE = ()
ONE_PASS_REST_SKIPPED = (("test_rig", "test_board_answers", "pass"),
                         ("test_rig", "test_motor_spins", "skip"),
                         ("test_rig", "test_led_blinks", "skip"))
# `--tests test_a --name foo` selects exactly `test_a`'s `test_foo_works`.
NARROWABLE = (("test_a", "test_foo_works", "pass"),
              ("test_a", "test_bar_works", "pass"),
              ("test_b", "test_foo_other", "pass"))

# The stand-in `make`: records what it was asked to run, then writes the
# scripted cases, narrowed by TESTS (file stems) and TEST_NAME (comma-separated
# name fragments), as one JUnit report.
_STAND_IN_MAKE = r'''
import json
import os
import sys

tests = os.environ.get("TESTS")
names = os.environ.get("TEST_NAME")
with open(os.environ["ARDUINO_TIER_MAKE_LOG"], "a") as handle:
    handle.write(json.dumps({
        "argv": sys.argv[1:], "cwd": os.getcwd(),
        "tests_present": "TESTS" in os.environ, "tests": tests,
        "test_name_present": "TEST_NAME" in os.environ, "test_name": names,
    }) + "\n")
with open(os.environ["ARDUINO_TIER_MAKE_CASES"]) as handle:
    cases = json.load(handle)

selected = []
for stem, name, outcome in cases:
    if tests is not None and stem not in tests.split():
        continue
    if names is not None:
        fragments = [f.split("*", 1)[0] for f in names.split(",")]
        if not any(f in name or f in stem for f in fragments):
            continue
    selected.append((stem, name, outcome))

for line, (stem, name, outcome) in enumerate(selected, start=10):
    verdict = "IGNORE" if outcome == "skip" else "PASS"
    sys.stdout.write("test/%s.c:%d:%s:%s\n" % (stem, line, name, verdict))
skipped = sum(1 for _s, _n, outcome in selected if outcome == "skip")
sys.stdout.write("-----------------------\n%d Tests 0 Failures %d Ignored\nOK\n"
                 % (len(selected), skipped))
sys.stdout.flush()

body = "".join(
    '<testcase classname="%s" name="%s" time="0.001">%s</testcase>'
    % (stem, name, '<skipped message="no board answered"/>'
       if outcome == "skip" else "")
    for stem, name, outcome in selected)
reports_dir = os.environ.get("REPORTS_DIR") or "reports"
os.makedirs(reports_dir, exist_ok=True)
with open(os.path.join(reports_dir, "TEST-native.xml"), "w") as handle:
    handle.write('<?xml version="1.0"?><testsuites><testsuite name="native" '
                 'tests="%d" failures="0" skipped="%d">%s</testsuite></testsuites>'
                 % (len(selected), skipped, body))
sys.exit(0)
'''


def _codes(value):
    """Every value of a `code` key anywhere in an envelope."""
    found = []
    if isinstance(value, dict):
        for key, inner in value.items():
            if key == "code" and isinstance(inner, str):
                found.append(inner)
            else:
                found.extend(_codes(inner))
    elif isinstance(value, list):
        for inner in value:
            found.extend(_codes(inner))
    return found


class _TierProject(unittest.TestCase):
    """A scratch firmware project, the stand-in `make` first on PATH, and a
    recording board the project declares. Holds no test of its own."""

    maxDiff = 4000

    def setUp(self):
        self.project = new_scratch("arduino-tier-places-")
        self.bin_dir = new_scratch("arduino-tier-places-bin-")
        for path in (self.project, self.bin_dir):
            self.addCleanup(shutil.rmtree, path, True)
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        install_project(self.project, self.board.url, PROJECT_KEY)
        self.make_log = os.path.join(self.bin_dir, "make-runs.jsonl")
        self.cases_path = os.path.join(self.bin_dir, "cases.json")
        self.script_cases(ONE_PASS)
        make = os.path.join(self.bin_dir, "make")
        Path(make).write_text("#!" + sys.executable + "\n" + _STAND_IN_MAKE)
        os.chmod(make, os.stat(make).st_mode | stat.S_IXUSR | stat.S_IRUSR)
        # Every firmware project here has its native host tests.
        self.place(NATIVE)

    # ── the project ────────────────────────────────────────────────────────

    def place(self, sub, *declared):
        """A real `Makefile` in `sub` with `junit` and a `junit-<tier>` rule
        for each of `declared`."""
        directory = os.path.join(self.project, *sub.split("/"))
        os.makedirs(directory, exist_ok=True)
        rules = "".join(f"junit-{tier}:\n\t@echo {tier}\n" for tier in declared)
        Path(directory, "Makefile").write_text("junit:\n\t@echo junit\n" + rules)

    def script_cases(self, cases):
        Path(self.cases_path).write_text(json.dumps([list(c) for c in cases]))

    def path_of(self, sub):
        return os.path.realpath(os.path.join(self.project, *sub.split("/")))

    # ── the drive ──────────────────────────────────────────────────────────

    def drive(self, verb, *extra, agent=None, client_env=None):
        env = scrubbed_env(self.bin_dir)
        for key in _SCRUBBED:
            env.pop(key, None)
        env.update({"ARDUINO_TIER_MAKE_LOG": self.make_log,
                    "ARDUINO_TIER_MAKE_CASES": self.cases_path})
        env.update(client_env or {})
        cmd = [sys.executable, str(ARDUINO_CLIENT), verb,
               "--project-dir", self.project,
               *(["--agent", agent] if agent else []), *extra]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    # ── what `make` was asked ──────────────────────────────────────────────

    def make_runs(self):
        path = Path(self.make_log)
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()
                if line.strip()]

    def the_one_make_run(self, result):
        runs = self.make_runs()
        self.assertEqual(len(runs), 1,
                         f"`make` runs exactly once; runs={runs!r} "
                         f"{_diagnostics(result)}")
        return runs[0] if runs else {}

    def assertRanMake(self, result, target, place):
        """`make <target>` ran once, in `place`, and nothing else ran."""
        record = self.the_one_make_run(result)
        self.assertEqual(
            (record.get("argv"), os.path.realpath(record.get("cwd") or "")),
            ([target], self.path_of(place)),
            f"`make {target}` runs in {place}; recorded={record!r} "
            f"{_diagnostics(result)}")
        return record

    # ── what the board was sent ────────────────────────────────────────────

    def ingests(self):
        return [b for p, b in self.board.posts() if p == RUNS_INGEST]

    def envelope_of(self, result):
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(envelope, f"stdout is one TOON envelope; "
                                       f"{_diagnostics(result)}")
        return envelope or {}

    def assertFiledUnder(self, result, tier, agent, cases=None):
        """The run is filed: exit 0, `ok: true`, exactly one `/api/v2/runs`
        for `agent` under `tier`, and no abort."""
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
        ingests = self.ingests()
        self.assertEqual(len(ingests), 1, f"exactly one run is filed; "
                                          f"{_diagnostics(result)}")
        body = ingests[0] if ingests else {}
        self.assertEqual((body.get("agentId"), body.get("tier")), (agent, tier),
                         f"filed for {agent} under {tier}; "
                         f"body keys={sorted(body)!r}")
        if cases is not None:
            self.assertEqual(sent_case_count(body), cases,
                             f"the filed run carries {cases} case(s)")
        self.assertEqual(self.board.aborts(), [], "a filed run is never aborted")
        self.assertNotIn(TIER_SELECTION_EMPTY, _codes(envelope),
                         f"envelope={envelope!r}")
        return body

    def assertRanWithoutFiling(self, result):
        """A run with no `--agent`: exit 0 and nothing filed."""
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        self.assertEqual([p for p, _ in self.board.posts() if p in INGEST_PATHS],
                         [], f"a run without --agent files nothing; "
                             f"{_diagnostics(result)}")
        self.assertNotIn(TIER_SELECTION_EMPTY, result.stdout + result.stderr,
                         _diagnostics(result))

    def assertUndeclared(self, result, *help_names):
        """`tier-run-undeclared`: `ok: false`, exit 1, no `make` run and
        nothing posted; the `help[]` names each of `help_names`."""
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, _diagnostics(result))
        self.assertEqual(result.returncode, 1, _diagnostics(result))
        self.assertTrue(TIER_RUN_UNDECLARED in _codes(envelope)
                        or TIER_RUN_UNDECLARED in result.stderr,
                        f"answers {TIER_RUN_UNDECLARED}; {_diagnostics(result)}")
        help_text = " ".join(str(line) for line in envelope.get("help") or [])
        for name in help_names:
            self.assertIn(name, help_text,
                          f"the help names {name!r}; help={help_text!r}")
        self.assertEqual(self.make_runs(), [], f"no `make` runs; "
                                               f"{_diagnostics(result)}")
        self.assertEqual([p for p, _ in self.board.posts()], [],
                         "nothing reaches the board")

    def assertRunsToday(self, result, *tiers):
        """The refusal's `help[]` names exactly `tiers` as the tier verbs
        this client runs on this project."""
        help_lines = [str(line) for line in self.envelope_of(result).get("help") or []]
        listed = [line[len(RUNS_TODAY):] for line in help_lines
                  if line.startswith(RUNS_TODAY)]
        self.assertEqual(len(listed), 1, f"one line names the tiers run "
                                         f"today; help={help_lines!r}")
        self.assertEqual({tier.strip() for tier in listed[0].split(",")},
                         set(tiers), f"help={help_lines!r}")

    def assertSelectionEmpty(self, result, agent=None):
        """`tier-selection-empty`: `ok: false`, exit 1, no run filed; with an
        agent the one run opened is aborted, without one nothing is posted."""
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, _diagnostics(result))
        self.assertEqual(result.returncode, 1, _diagnostics(result))
        self.assertIn(TIER_SELECTION_EMPTY, _codes(envelope),
                      f"envelope={envelope!r}")
        self.assertEqual([p for p, _ in self.board.posts() if p in INGEST_PATHS],
                         [], f"no run is filed; {_diagnostics(result)}")
        if agent is None:
            self.assertEqual([p for p, _ in self.board.posts()], [],
                             f"nothing is posted; {_diagnostics(result)}")
            return
        opened = self.board.run_ids_opened()
        self.assertEqual(len(opened), 1, f"the run was opened; "
                                         f"{_diagnostics(result)}")
        self.assertEqual([p for p, _ in self.board.aborts()],
                         [f"/api/v2/runs/{opened[0]}/abort"] if opened else [],
                         f"the opened run is aborted; {_diagnostics(result)}")


# ── AC1 — `unit` runs the native host tests, or a declared `junit-unit` ────


class AUnitRunRunsTheNativeHostTestsTest(_TierProject):

    def test_unit_runs_make_junit_in_tests_native_and_files_under_unit(self):
        result = self.drive("unit", agent="ard-tier-unit-junit")
        self.assertRanMake(result, "junit", NATIVE)
        self.assertFiledUnder(result, "unit", "ard-tier-unit-junit", cases=1)

    def test_unit_without_an_agent_runs_make_junit_in_tests_native(self):
        result = self.drive("unit")
        self.assertRanMake(result, "junit", NATIVE)
        self.assertRanWithoutFiling(result)

    def test_unit_runs_a_declared_junit_unit_and_never_make_junit(self):
        self.place(NATIVE, "unit")
        result = self.drive("unit", agent="ard-tier-unit-declared")
        self.assertRanMake(result, "junit-unit", NATIVE)
        self.assertFiledUnder(result, "unit", "ard-tier-unit-declared", cases=1)

    def test_unit_without_an_agent_runs_a_declared_junit_unit_and_never_make_junit(self):
        self.place(NATIVE, "unit")
        result = self.drive("unit")
        self.assertRanMake(result, "junit-unit", NATIVE)
        self.assertRanWithoutFiling(result)

    def assert_narrowing_reaches_a_declared_junit_unit(self, agent):
        self.place(NATIVE, "unit")
        self.script_cases(NARROWABLE)
        result = self.drive("unit", "--tests", "test_a", "--name", "foo",
                            agent=agent)
        record = self.assertRanMake(result, "junit-unit", NATIVE)
        self.assertEqual(
            (record.get("tests"), record.get("test_name")), ("test_a", "foo"),
            f"`make junit-unit` gets TESTS=test_a and TEST_NAME=foo; "
            f"recorded={record!r}")
        return result

    def test_unit_hands_tests_and_name_to_a_declared_junit_unit(self):
        result = self.assert_narrowing_reaches_a_declared_junit_unit(
            "ard-tier-unit-declared-narrowed")
        self.assertFiledUnder(result, "unit", "ard-tier-unit-declared-narrowed",
                              cases=1)

    def test_unit_without_an_agent_hands_tests_and_name_to_a_declared_junit_unit(self):
        result = self.assert_narrowing_reaches_a_declared_junit_unit(None)
        self.assertRanWithoutFiling(result)


# ── AC2 — `e2e` and `integration` run in their own place ───────────────────


class AHardwareOrSimulatorTierRunsInItsPlaceTest(_TierProject):

    def test_e2e_runs_make_junit_in_tests_hil_and_files_under_e2e(self):
        self.place(HIL)
        result = self.drive("e2e", agent="ard-tier-e2e-hil")
        self.assertRanMake(result, "junit", HIL)
        self.assertFiledUnder(result, "e2e", "ard-tier-e2e-hil", cases=1)

    def test_e2e_without_an_agent_runs_make_junit_in_tests_hil(self):
        self.place(HIL)
        result = self.drive("e2e")
        self.assertRanMake(result, "junit", HIL)
        self.assertRanWithoutFiling(result)

    def test_integration_runs_make_junit_in_tests_sim_and_files_under_integration(self):
        self.place(SIM)
        result = self.drive("integration", agent="ard-tier-integration-sim")
        self.assertRanMake(result, "junit", SIM)
        self.assertFiledUnder(result, "integration", "ard-tier-integration-sim",
                              cases=1)

    def test_integration_without_an_agent_runs_make_junit_in_tests_sim(self):
        self.place(SIM)
        result = self.drive("integration")
        self.assertRanMake(result, "junit", SIM)
        self.assertRanWithoutFiling(result)

    def test_a_junit_e2e_declared_in_tests_native_wins_over_tests_hil(self):
        self.place(NATIVE, "e2e")
        self.place(HIL)
        result = self.drive("e2e", agent="ard-tier-e2e-declared")
        self.assertRanMake(result, "junit-e2e", NATIVE)
        self.assertFiledUnder(result, "e2e", "ard-tier-e2e-declared", cases=1)

    def test_without_an_agent_a_junit_e2e_declared_in_tests_native_wins_over_tests_hil(self):
        self.place(NATIVE, "e2e")
        self.place(HIL)
        result = self.drive("e2e")
        self.assertRanMake(result, "junit-e2e", NATIVE)
        self.assertRanWithoutFiling(result)

    def test_e2e_with_dir_runs_make_junit_in_that_directory(self):
        self.place(RIG)
        result = self.drive("e2e", "--dir", RIG, agent="ard-tier-e2e-rig")
        self.assertRanMake(result, "junit", RIG)
        self.assertFiledUnder(result, "e2e", "ard-tier-e2e-rig", cases=1)

    def test_e2e_with_dir_without_an_agent_runs_make_junit_in_that_directory(self):
        self.place(RIG)
        result = self.drive("e2e", "--dir", RIG)
        self.assertRanMake(result, "junit", RIG)
        self.assertRanWithoutFiling(result)


# ── AC3 — no place and no declaration: refused before anything runs ───────


class ATierWithNoPlaceAndNoDeclarationIsRefusedTest(_TierProject):

    def test_e2e_with_no_hil_makefile_is_refused_naming_both_ways_out(self):
        result = self.drive("e2e", agent="ard-tier-e2e-undeclared")
        self.assertUndeclared(result, "tests/hil/Makefile", "junit-e2e",
                              "tests/native/Makefile")

    def test_e2e_without_an_agent_with_no_hil_makefile_is_refused(self):
        self.assertUndeclared(self.drive("e2e"), "tests/hil/Makefile", "junit-e2e",
                              "tests/native/Makefile")

    def test_integration_with_no_sim_makefile_is_refused_naming_both_ways_out(self):
        result = self.drive("integration", agent="ard-tier-integration-undeclared")
        self.assertUndeclared(result, "tests/sim/Makefile", "junit-integration",
                              "tests/native/Makefile")

    def test_integration_without_an_agent_with_no_sim_makefile_is_refused(self):
        self.assertUndeclared(self.drive("integration"), "tests/sim/Makefile",
                              "junit-integration", "tests/native/Makefile")

    def test_module_with_no_declaration_is_refused(self):
        result = self.drive("module", agent="ard-tier-module-undeclared")
        self.assertUndeclared(result, "Makefile", "junit-module")

    def test_module_without_an_agent_with_no_declaration_is_refused(self):
        self.assertUndeclared(self.drive("module"), "Makefile", "junit-module")

    def test_bdd_with_no_declaration_is_refused(self):
        result = self.drive("bdd", agent="ard-tier-bdd-undeclared")
        self.assertUndeclared(result, "Makefile", "junit-bdd")

    def test_bdd_without_an_agent_with_no_declaration_is_refused(self):
        self.assertUndeclared(self.drive("bdd"), "Makefile", "junit-bdd")

    def test_a_module_refusal_names_only_the_tiers_that_run_here(self):
        """No `tests/sim`, no `tests/hil` and no declaration: `integration`
        and `e2e` would refuse too, so the refusal never sends a caller
        there."""
        result = self.drive("module", agent="ard-tier-module-runnable")
        self.assertUndeclared(result, "junit-module")
        self.assertRunsToday(result, "unit", "regression")

    def test_a_bdd_refusal_names_only_the_tiers_that_run_here(self):
        result = self.drive("bdd")
        self.assertUndeclared(result, "junit-bdd")
        self.assertRunsToday(result, "unit", "regression")


# ── AC4 — TESTS and TEST_NAME from the shell never reach `make` ────────────


class AShellNarrowingNeverReachesATierRunTest(_TierProject):
    """With TESTS and TEST_NAME set in the client's environment, the `make`
    a tier verb runs receives neither."""

    SHELL_NARROWING = {"TESTS": "test_c", "TEST_NAME": "speed"}

    def assert_neither_reaches_make(self, verb, target, place, agent):
        result = self.drive(verb, agent=agent, client_env=self.SHELL_NARROWING)
        record = self.assertRanMake(result, target, place)
        self.assertEqual(
            (record.get("tests_present"), record.get("test_name_present")),
            (False, False),
            f"`{verb}` runs `make` with neither TESTS nor TEST_NAME; "
            f"recorded={record!r}")

    def test_unit_runs_make_with_neither_variable(self):
        self.assert_neither_reaches_make("unit", "junit", NATIVE, "ard-shell-unit")

    def test_unit_without_an_agent_runs_make_with_neither_variable(self):
        self.assert_neither_reaches_make("unit", "junit", NATIVE, None)

    def test_integration_runs_make_with_neither_variable(self):
        self.place(SIM)
        self.assert_neither_reaches_make("integration", "junit", SIM,
                                         "ard-shell-integration")

    def test_integration_without_an_agent_runs_make_with_neither_variable(self):
        self.place(SIM)
        self.assert_neither_reaches_make("integration", "junit", SIM, None)

    def test_e2e_runs_make_with_neither_variable(self):
        self.place(HIL)
        self.assert_neither_reaches_make("e2e", "junit", HIL, "ard-shell-e2e")

    def test_e2e_without_an_agent_runs_make_with_neither_variable(self):
        self.place(HIL)
        self.assert_neither_reaches_make("e2e", "junit", HIL, None)

    def test_module_runs_make_with_neither_variable(self):
        self.place(NATIVE, "module")
        self.assert_neither_reaches_make("module", "junit-module", NATIVE,
                                         "ard-shell-module")

    def test_module_without_an_agent_runs_make_with_neither_variable(self):
        self.place(NATIVE, "module")
        self.assert_neither_reaches_make("module", "junit-module", NATIVE, None)

    def test_bdd_runs_make_with_neither_variable(self):
        self.place(NATIVE, "bdd")
        self.assert_neither_reaches_make("bdd", "junit-bdd", NATIVE, "ard-shell-bdd")

    def test_bdd_without_an_agent_runs_make_with_neither_variable(self):
        self.place(NATIVE, "bdd")
        self.assert_neither_reaches_make("bdd", "junit-bdd", NATIVE, None)


# ── AC5 — a run in which no case ran is refused, never filed ───────────────


class _NoCaseRun:
    """`VERB` in its `PLACE`: a run whose reports hold no case, or only
    skipped ones, is refused; one passed case among skipped ones is filed."""

    VERB = ""
    PLACE = ""

    def setUp(self):
        super().setUp()  # type: ignore[misc]
        self.place(self.PLACE)  # type: ignore[attr-defined]

    def agent(self, case):
        return f"ard-no-case-{self.VERB}-{case}"

    def refused_after_one_run(self, cases, agent):
        self.script_cases(cases)  # type: ignore[attr-defined]
        result = self.drive(self.VERB, agent=agent)  # type: ignore[attr-defined]
        self.assertRanMake(result, "junit", self.PLACE)  # type: ignore[attr-defined]
        self.assertSelectionEmpty(result, agent=agent)  # type: ignore[attr-defined]

    def test_only_skipped_cases_are_refused_as_an_empty_selection(self):
        self.refused_after_one_run(SKIPPED_ONLY, self.agent("skipped"))

    def test_only_skipped_cases_without_an_agent_are_refused_as_an_empty_selection(self):
        self.refused_after_one_run(SKIPPED_ONLY, None)

    def test_no_case_is_refused_as_an_empty_selection(self):
        self.refused_after_one_run(NO_CASE, self.agent("zero"))

    def test_no_case_without_an_agent_is_refused_as_an_empty_selection(self):
        self.refused_after_one_run(NO_CASE, None)

    def test_one_passed_case_among_skipped_ones_is_filed(self):
        self.script_cases(ONE_PASS_REST_SKIPPED)  # type: ignore[attr-defined]
        agent = self.agent("one-passed")
        result = self.drive(self.VERB, agent=agent)  # type: ignore[attr-defined]
        self.assertRanMake(result, "junit", self.PLACE)  # type: ignore[attr-defined]
        self.assertFiledUnder(result, self.VERB, agent, cases=3)  # type: ignore[attr-defined]

    def test_one_passed_case_among_skipped_ones_without_an_agent_is_not_refused(self):
        self.script_cases(ONE_PASS_REST_SKIPPED)  # type: ignore[attr-defined]
        result = self.drive(self.VERB)  # type: ignore[attr-defined]
        self.assertRanMake(result, "junit", self.PLACE)  # type: ignore[attr-defined]
        self.assertRanWithoutFiling(result)  # type: ignore[attr-defined]


class AUnitRunWithNoCaseIsRefusedTest(_NoCaseRun, _TierProject):
    VERB = "unit"
    PLACE = NATIVE

    def test_a_narrowed_unit_run_that_ran_nothing_is_refused_as_an_empty_selection(self):
        agent = "ard-no-case-unit-narrowed"
        result = self.drive("unit", "--name", "nomatch", agent=agent)
        record = self.assertRanMake(result, "junit", NATIVE)
        self.assertEqual(record.get("test_name"), "nomatch", f"recorded={record!r}")
        self.assertSelectionEmpty(result, agent=agent)

    def test_a_narrowed_unit_run_without_an_agent_that_ran_nothing_is_refused(self):
        result = self.drive("unit", "--name", "nomatch")
        record = self.assertRanMake(result, "junit", NATIVE)
        self.assertEqual(record.get("test_name"), "nomatch", f"recorded={record!r}")
        self.assertSelectionEmpty(result)


class AnIntegrationRunWithNoCaseIsRefusedTest(_NoCaseRun, _TierProject):
    VERB = "integration"
    PLACE = SIM


class AnE2eRunWithNoCaseIsRefusedTest(_NoCaseRun, _TierProject):
    VERB = "e2e"
    PLACE = HIL


class ARegressionRunWithNoCaseIsStillFiledTest(_TierProject):

    def test_regression_files_a_run_whose_reports_hold_no_case(self):
        self.script_cases(NO_CASE)
        agent = "ard-no-case-regression"
        result = self.drive("regression", agent=agent)
        self.assertRanMake(result, "junit", NATIVE)
        self.assertFiledUnder(result, "regression", agent, cases=0)

    def test_regression_without_an_agent_is_not_refused_when_no_case_ran(self):
        self.script_cases(NO_CASE)
        result = self.drive("regression")
        self.assertRanMake(result, "junit", NATIVE)
        self.assertRanWithoutFiling(result)


# ── AC6 — `regression` and the gate are unchanged ──────────────────────────


class RegressionAndTheGateAreUnchangedTest(_TierProject):

    def test_regression_runs_make_junit_once_in_tests_native(self):
        self.place(HIL)
        self.place(SIM)
        agent = "ard-what-stays-regression"
        result = self.drive("regression", agent=agent)
        self.assertRanMake(result, "junit", NATIVE)
        self.assertFiledUnder(result, "regression", agent, cases=1)

    def test_regression_without_an_agent_runs_make_junit_once_in_tests_native(self):
        self.place(HIL)
        self.place(SIM)
        result = self.drive("regression")
        self.assertRanMake(result, "junit", NATIVE)
        self.assertRanWithoutFiling(result)

    def gate(self, agent):
        """Drive the gate; its composed rows by suite. A gate that composes
        no declared suite and has no agent to file under prints no envelope,
        and so no row. The gate's own verdict is not this file's subject: a
        composing gate with no agent cannot read its suite's counts back."""
        result = self.drive("pre-merge-gate", "--skip-check", agent=agent)
        envelope = _envelope(result.stdout) or {}
        rows = {row.get("suite"): row for row in envelope.get("suites") or []
                if isinstance(row, dict)}
        return result, rows

    def assert_composes_integration_and_excludes_e2e(self, agent):
        self.place(NATIVE, "integration", "e2e")
        result, rows = self.gate(agent)
        integration = rows.get("junit-integration") or {}
        e2e = rows.get("junit-e2e") or {}
        self.assertIs(integration.get("gated"), True,
                      f"junit-integration is a gated suite; rows={rows!r} "
                      f"{_diagnostics(result)}")
        self.assertIs(e2e.get("gated"), False,
                      f"junit-e2e is declared and not gated; rows={rows!r}")
        self.assertIsInstance(e2e.get("excluded"), str,
                              f"junit-e2e says why it is excluded; row={e2e!r}")
        self.assertTrue(e2e.get("excluded"), f"row={e2e!r}")
        runs = self.make_runs()
        self.assertEqual(
            [r.get("argv") for r in runs].count(["junit"]), 1,
            f"the gate runs `make junit` once; runs={runs!r}")
        self.assertNotIn(["junit-e2e"], [r.get("argv") for r in runs],
                         f"the gate never runs `make junit-e2e`; runs={runs!r}")
        self.assertEqual(
            {os.path.realpath(r.get("cwd") or "") for r in runs},
            {self.path_of(NATIVE)},
            f"every gate run is in tests/native; runs={runs!r}")

    def test_the_gate_composes_a_declared_integration_and_excludes_a_declared_e2e(self):
        self.assert_composes_integration_and_excludes_e2e("ard-what-stays-gate-declared")

    def test_the_gate_without_an_agent_composes_a_declared_integration_and_excludes_e2e(self):
        self.assert_composes_integration_and_excludes_e2e(None)

    def test_the_gate_composes_neither_place_found_only_by_convention(self):
        self.assert_composes_neither_place("ard-what-stays-gate-places")

    def test_the_gate_without_an_agent_composes_neither_place_found_only_by_convention(self):
        self.assert_composes_neither_place(None)

    def assert_composes_neither_place(self, agent):
        self.place(HIL)
        self.place(SIM)
        result, rows = self.gate(agent)
        self.assertEqual(sorted(str(s) for s in rows if str(s).startswith("junit-")), [],
                         f"no declared suite is composed; rows={rows!r} "
                         f"{_diagnostics(result)}")
        runs = self.make_runs()
        self.assertEqual(
            [(r.get("argv"), os.path.realpath(r.get("cwd") or "")) for r in runs],
            [(["junit"], self.path_of(NATIVE))],
            f"the gate runs `make junit` once in tests/native and nothing in "
            f"tests/hil or tests/sim; runs={runs!r}")


if __name__ == "__main__":
    unittest.main()
