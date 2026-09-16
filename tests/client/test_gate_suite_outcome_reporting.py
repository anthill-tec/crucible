"""CR-CRU-112 AC2/AC3/AC4 — what a gate SAYS about the suites it declared.

Cycle 388 shipped the composition (`clients/_crucible_axi.py`:
`declared_gate_suites` / `run_gate_suites` / `gate_regression`) and cycle 388's
own instrument (`tests/client/test_gate_multi_suite_coverage.py`) owns AC1,
AC5, AC6 and AC8. This file is cycle 389's and owns the three ACs about the
OUTCOME a gate reports: a declared suite that FAILED (AC2), one that could not
be RUN (AC3), and a single-suite project whose output must not have changed at
all (AC4). AC7's reverted-fix reproduction is cycle 390's.

A SIBLING FILE rather than four more classes in cycle 388's, for two reasons
and no third. That file is a measured RED instrument whose docstring records a
colour per test AS OF cycle 388; appending cycle 389's tests would make that
record false for half its contents, and this CR's own rule is that a RED
instrument is not edited to accommodate what came after it. Its HARNESS is
adopted here whole and by name — the same mechanism it used to adopt cycle
378/379's — so nothing is duplicated: the fixture project, the stub board, the
faithful fake bun, the envelope readers and the drive are all its own.

MEASURED ON `feature/CR-CRU-112` @ `aa2d475`, 2026-09-09, colour per test,
because a suite that does not say which of its members were born green is a
suite whose colour means nothing:

  PIN  `DeclaredSuiteFailureFailsTheGateTest` (AC2, both methods). Both halves
         pass on the shipped composition: `run_gate_suites` raises
         `gate-suite-failed` for a suite whose own envelope reports failures OR
         whose exit code is non-zero, from EITHER side. They are kept as the
         standing proof against the defect this CR closes — the gate that
         noticed only the first runner's failure — and they are what fails if a
         later change pools the two suites' counts into one total or drops the
         loser's attribution.
  RED  `UnrunnableInterpreterFailsTheGateTest`. MEASURED: `subprocess.run(argv,
         ...)` at `_crucible_axi.py:4267` is unguarded, so a declared command
         whose first token does not exist raises `FileNotFoundError: [Errno 2]
         No such file or directory: '<...>/python3-cr112-missing'` out of
         `cmd_pre_merge_gate`. The gate emits NO envelope at all: no
         `ok:false`, no `suites[]` row, no warning naming the suite or the
         reason — and the suite that DID run is unreported too, because the
         document that would have carried it never reached stdout. AC3 requires
         the suite and the reason NAMED, which a traceback is not.
  RED  `UnrunnableLocalRunnerFailsTheGateTest`. The same crash class as the
         first shape at a DIFFERENT unguarded call site — `run_gate_suites` →
         `_captured_suite_run` → the client's own `_run_logged`
         (`bun-crucible.py:316`) — so a declared suite the gate runs in its own
         process, whose runner is missing, kills the gate too, and kills it
         BEFORE any suite has run at all. Included because AC3's shapes are
         otherwise both on the dispatched side, and a GREEN that guards only
         the dispatch would leave half the composition unguarded
         (ESCALATION 6).
  PIN  `UnrunnableStartDirFailsTheGateTest`. The second unrunnable shape passes
         today: the dispatched client writes no XML, `_suite_counts` answers
         None, and the suite is named by `gate-suite-unreported` beside the
         runner's own `no-test-reports` warning, which quotes `ImportError:
         Start directory is not importable: 'tests/nowhere-cr112'`. Kept
         because AC3's two negatives — not silently skipped, never reported as
         a pass — are exactly what a suite that cannot run is otherwise
         recorded as.
  RED  `SingleSuiteProjectGateIsUnchangedTest` (AC4, all three methods). A
         project declaring ONE bun suite no longer takes the fallback: it runs
         through the composition, and three things changed against the snapshot
         below — the envelope's `tier` (`regression` → `unit`), `run.files`
         (present → GONE), and the step itself (`bun test <flags>` over the
         whole suite → `bun run test:unit`, which re-enters `bun test
         tests/unit`). See ESCALATION 2, 3 and 4.

WHY THE AC4 COMPARISON IS A FROZEN SNAPSHOT AND NOT A BASE REF. The obvious
instrument is `git show develop:clients/bun-crucible.py`, driven on the same
fixture. It is also self-invalidating: the moment this branch merges, the base
and the tree become the same thing and the comparison goes degenerate while
still passing. That is not hypothetical — it is what CR-CRU-111's AC16 proof
did in `tests/client/test_client_tier_verb_contract.py`, and repairing those
two tests is a line item in THIS CR's own non-goals. So the base ref was driven
ONCE, at writing time, and what it produced is pinned below as a NAMED, DATED
snapshot that cannot rot when a branch merges.

ESCALATIONS (full text in the report):

  1. AC3 SAYS "missing interpreter, missing start-dir" AND NAMES NO REASON
     FORMAT. The reason is therefore asserted in its most falsifiable form —
     the missing thing must be NAMED in the gate's own warnings, since a
     warning that says only "the suite failed" tells the caller nothing about
     which of the two shapes it hit. Any wording satisfies these tests; a
     wording that omits the interpreter path or the start-dir does not.
  2. AC4 SAYS "SAME ENVELOPE SHAPE" AND §S1 SAYS THE ENVELOPE CARRIES
     `suites[]`. Both cannot hold literally for a one-suite project, so these
     assertions are one-directional on purpose: every field the pre-composition
     envelope carried must STILL be there with the same value, and the ADDED
     `suites[]` key is not asserted against. A field LOST is an information
     regression; a field gained is the shape §S1 ruled. If AC4 is meant to
     permit the `tier` change too, AC4 must say so — that value is what a run
     is attributed by.
  3. AC4's "SAME STEPS" IS ASSERTED LITERALLY, AND IT MAY BE THE AC THAT IS
     WRONG. A one-suite project's gate now runs the DECLARED SCRIPT (`bun run
     test:unit`) instead of the whole-suite `bun test` develop ran, which is
     arguably what "the gate runs the project's declared suites" MEANS. It is
     still a change to what the gate collects — `bun test tests/unit` is not
     `bun test` — and §S2 says a one-suite project's behaviour is unchanged.
     One of those two sentences has to give; this file asserts the AC as
     written and the CR must rule.
  4. `run.files` IS DROPPED BY THE COMPOSITION FOR EVERY PROJECT, not just a
     one-suite one: `_suite_counts` keeps `passed/failed/pending/total` and
     nothing else. CR-CRU-051 §S2 carries that count "so a suite that silently
     shrinks is visible in the gate output itself", which is this CR's own
     thesis, so its loss is reported here rather than left to AC7.
  5. THE `help[]` OF AN UNRUNNABLE SUITE POINTS AT THE WRONG THING. Measured on
     both unrunnable shapes: the gate's next step reads "check the Crucible
     server is running / reachable at http://127.0.0.1:<port>" for a run whose
     board was reachable throughout and whose suite had a missing start-dir.
     AC3 does not name `help[]`, so nothing here asserts it; recorded because a
     gate that names the wrong next action is a defect a later AC will want.
  6. THE LOCAL-RUNNER SHAPE IS PRE-EXISTING, AND IN SCOPE ANYWAY. A missing
     `--bun` killed `develop`'s gate the same way, so this is not a regression
     this CR introduced. It is asserted here because AC3 makes "a declared
     suite that cannot be run" a REPORTED outcome, and once the gate's scope is
     the declared suites, the locally-run one is one of them: a gate that dies
     on it reports nothing about the suites it could have run. If the CR means
     AC3 to cover only DISPATCHED suites, AC3 must say so and this test comes
     out.

TIER: `integration` by the DN's definition — the drives here open a TCP
listener and spawn real client processes. Reported under the python
`tests/client` suite. The one exception is the last class, whose two methods
are `unit` — they ask the shared module what a raised error MEANS and take no
process, socket, service or clock; the class says so itself.

Invocation:
    python3 clients/python-crucible.py test --tests tests.client.test_gate_suite_outcome_reporting --agent <id>
Fallback:
    python3 -m unittest tests.client.test_gate_suite_outcome_reporting
"""

import importlib.util
import json
import os
import unittest
import urllib.error
from pathlib import Path

TESTS_CLIENT_DIR = Path(__file__).resolve().parent
GATE_HARNESS_PATH = TESTS_CLIENT_DIR / "test_gate_multi_suite_coverage.py"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Cycle 388's harness, adopted whole and by name — that file's own idiom for
# adopting cycles 378/379. Only NON-test names are taken: importing one of its
# TestCases would run that cycle's suite a second time under this module.
_GATE = _load_module(GATE_HARNESS_PATH, "cr112_c2_gate_harness")

BUN_SUITE = _GATE.BUN_SUITE
PYTHON_SUITE = _GATE.PYTHON_SUITE
FAKE_BUN = _GATE.FAKE_BUN
CHILD_PYTHON = _GATE.CHILD_PYTHON
_attributed_counts = _GATE._attributed_counts
_text = _GATE._text

# The shared module itself, for the one class below that asks it what an error
# MEANS rather than driving a gate end to end. Loaded by the harness's own
# `AXI_PATH` so this file names the path in no second place.
_AXI = _load_module(_GATE.AXI_PATH, "cr112_c5_axi_under_test")


def setUpModule():
    _GATE.setUpModule()


def tearDownModule():
    _GATE.tearDownModule()


# ── what each fixture plants ──────────────────────────────────────────────

# The bun suite's report with ONE planted failure beside one pass, so the
# failing suite's own counts (1 passed, 1 failed) are distinguishable from the
# gate's union AND from the other suite's row.
PLANTED_BUN_JUNIT = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" failures="1">
  <testsuite name="tests/unit/probe.test.ts" tests="2" failures="1">
    <testcase name="the declared bun suite runs" classname="probe"
              file="tests/unit/probe.test.ts" time="0.001"/>
    <testcase name="the planted bun failure" classname="probe"
              file="tests/unit/probe.test.ts" time="0.001">
      <failure message="planted">expected 1 to be 2</failure>
    </testcase>
  </testsuite>
</testsuites>
"""

# The python suite's planted failure, written BESIDE the fixture's passing
# probe so that suite also reports 1 passed / 1 failed. Single-quoted
# throughout, so the fixture source carries no quoting hazard.
PLANTED_PYTHON_TEST = '''import unittest


class PlantedFailureTest(unittest.TestCase):
    # The failure AC2 plants in the DECLARED python suite.

    def test_the_planted_python_failure_is_reported_by_the_gate(self):
        self.assertEqual(1, 2, 'planted python failure')
'''

# What the planted suite produces, either side: the numbers the gate must
# attribute to the suite that produced them and to no other.
PLANTED_PASSED = 1
PLANTED_FAILED = 1

# AC3's two unrunnable shapes, NAMED so the gate's warnings can be asked for
# the reason and not merely for a refusal (ESCALATION 1).
MISSING_INTERPRETER = "python3-cr112-missing"
MISSING_START_DIR = "tests/nowhere-cr112"
# ... and the third shape, on the side of the gate that runs a suite ITSELF:
# the runner of a LOCAL declared suite is missing.
MISSING_LOCAL_RUNNER = "bun-cr112-missing"


# ── the AC4 comparison: a NAMED, DATED snapshot, never a base ref ─────────
#
# `develop` @ `0c78928`, 2026-09-08 — the last commit before this CR's
# composition (`git archive develop clients` carries no `gate_regression` and
# no `run_gate_suites`). MEASURED by driving THAT client through the very
# fixture and drive below, and recorded verbatim:
#
#     axi:
#       verb: pre-merge-gate
#       ok: true
#       tier: regression
#       run: {passed: 2, failed: 0, pending: 0, total: 2, files: 1}
#       help[2]: cycle-done <id>,status
#       context: {projectKey, agentId}
#       warnings: []
#     exit=0
#     bun steps: ["test", "--reporter=junit",
#                 "--reporter-outfile=<project>/reports/junit.xml",
#                 "--coverage", "--coverage-reporter=lcov",
#                 "--coverage-dir=<project>/coverage"]
#
# Pinned rather than re-derived, because a base-ref comparison self-invalidates
# the moment the branch merges (module docstring).
PRE_COMPOSITION_REF = "develop@0c78928 (2026-09-08)"
PRE_COMPOSITION_EXIT = 0
PRE_COMPOSITION_OK = True
PRE_COMPOSITION_TIER = "regression"
PRE_COMPOSITION_ENVELOPE_KEYS = ("context", "help", "ok", "run", "tier", "verb",
                                 "warnings")
PRE_COMPOSITION_RUN = {"passed": 2, "failed": 0, "pending": 0, "total": 2,
                       "files": 1}
PRE_COMPOSITION_HELP = ["cycle-done <id>", "status"]
PRE_COMPOSITION_STEPS = [
    ["test", "--reporter=junit",
     "--reporter-outfile=<project>/reports/junit.xml",
     "--coverage", "--coverage-reporter=lcov",
     "--coverage-dir=<project>/coverage"],
]


# ── reading the outcome ───────────────────────────────────────────────────


def _ok(envelope):
    """The envelope's `ok`, however the codec spelled it."""
    value = envelope.get("ok")
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "1", "yes")


def _warnings_text(envelope):
    """Every warning the gate reported, as text — the channel AC2 and AC3 both
    name (`warnings[]`), read without freezing any one warning's key names."""
    return _text(envelope.get("warnings") or [])


def _run_counts(envelope):
    run = envelope.get("run")
    return run if isinstance(run, dict) else {}


class _OutcomeCase(_GATE._GateFixtureCase):
    """Cycle 388's fixture and drive, with ONE addition: a gate that DIES is an
    outcome this file has to be able to report, and the adopted drive lets
    anything but `SystemExit` propagate — which would surface as a test ERROR
    carrying no assertion message of its own."""

    def gate_outcome(self):
        """`(drive, exception)` — exactly one of the two is None."""
        try:
            return self.drive_gate(), None
        except Exception as exc:  # noqa: BLE001 — the crash IS the measurement
            return None, exc

    def assertGateReported(self, drive, exc, criterion):
        self.assertIsNone(
            exc,
            "%s — the gate reported NOTHING: it died with %r, so stdout "
            "carries no envelope, `ok:false` was never emitted, the suite is "
            "named nowhere and the reason is named nowhere. A caller gets a "
            "traceback instead of a gate verdict, and the suite that DID run "
            "goes unreported with it." % (criterion, exc))
        return drive


# ── AC2 — a declared suite that FAILS fails the gate, from EITHER side ────


class DeclaredSuiteFailureFailsTheGateTest(_OutcomeCase):
    """AC2 — PIN (both methods, measured green on `aa2d475`). 'A declared suite
    that fails fails the gate: exit non-zero, `ok:false`, and the failing suite
    named in `warnings[]`. Asserted by planting one failing python test and one
    failing bun test in a fixture project, separately — two assertions, because
    a gate that only notices the first runner's failure is the defect this CR
    closes.'

    Each method also asserts the OTHER suite's row still carries its OWN honest
    counts: a failure in one suite may not erase the attribution of the one
    that passed, and a gate answering with a single pooled total would satisfy
    `ok:false` while telling the caller nothing about where to look."""

    def assertFailingSuiteFailedTheGate(self, drive, failing, passing,
                                        passing_passed):
        envelope = self.gate_envelope(drive)
        self.assertNotEqual(
            drive.code, 0,
            "AC2 — the declared suite `%s` FAILED and the gate exited 0. A "
            "gate that reports a pass over a failing declared suite is the "
            "whole defect this CR closes. envelope=%s"
            % (failing, _text(envelope)))
        self.assertFalse(
            _ok(envelope),
            "AC2 — the declared suite `%s` FAILED and the gate's envelope says "
            "ok=%r. envelope=%s"
            % (failing, envelope.get("ok"), _text(envelope)))
        warnings = _warnings_text(envelope)
        self.assertIn(
            failing, warnings,
            "AC2 — the gate failed but never NAMES the suite that failed in "
            "`warnings[]`, so the caller is not told which declared suite to "
            "look at. warnings=%s envelope=%s" % (warnings, _text(envelope)))
        failed_counts = _attributed_counts(envelope, failing) or {}
        self.assertEqual(
            (failed_counts.get("passed"), failed_counts.get("failed")),
            (PLANTED_PASSED, PLANTED_FAILED),
            "AC2 — the failing suite `%s` produced exactly %d passed and %d "
            "failed, and its own row attributes %r. One planted failure stays "
            "one failure attributed to the suite that produced it, never a "
            "union total. envelope=%s"
            % (failing, PLANTED_PASSED, PLANTED_FAILED, failed_counts,
               _text(envelope)))
        passing_counts = _attributed_counts(envelope, passing) or {}
        self.assertEqual(
            (passing_counts.get("passed"), passing_counts.get("failed")),
            (passing_passed, 0),
            "AC2 — the OTHER declared suite `%s` passed %d of its own tests "
            "and its row attributes %r. A failure in one suite must not erase "
            "the attribution of the one that passed. envelope=%s"
            % (passing, passing_passed, passing_counts, _text(envelope)))

    def test_a_failing_python_suite_fails_the_gate_and_is_named(self):
        """AC2, the DISPATCHED side: the failure is in a suite owned by ANOTHER
        stack, so the gate can only learn of it by reading the envelope that
        client's own process put on its stdout."""
        Path(self.tmpdir, "tests", "client",
             "test_planted_failure.py").write_text(PLANTED_PYTHON_TEST)
        drive, exc = self.gate_outcome()
        self.assertGateReported(drive, exc, "AC2")
        self.assertFailingSuiteFailedTheGate(
            drive, PYTHON_SUITE, BUN_SUITE, _GATE.BUN_SUITE_PASSED)

    def test_a_failing_bun_suite_fails_the_gate_and_is_named(self):
        """AC2, the LOCAL side — the half a gate watching only its own runner
        would already have had. Asserted separately because the two are
        independently breakable: this suite runs inside the gate's own process
        and its envelope is CAPTURED rather than read off a pipe."""
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PLANTED_BUN_JUNIT
        os.environ["FAKE_BUN_EXIT_CODE"] = "1"
        drive, exc = self.gate_outcome()
        self.assertGateReported(drive, exc, "AC2")
        self.assertFailingSuiteFailedTheGate(
            drive, BUN_SUITE, PYTHON_SUITE, _GATE.PYTHON_SUITE_PASSED)


# ── AC3 — a declared suite that cannot be RUN fails the gate ─────────────


class _UnrunnableSuiteProbe(_OutcomeCase):
    """AC3's shared instrument — 'a declared suite that cannot be run (missing
    interpreter, missing start-dir) fails the gate with the suite and the
    reason named. It may NOT be silently skipped, and it may NOT report a
    pass.'

    Both of AC3's negatives are asserted explicitly and not implied: the suite
    must still be NAMED in the envelope (a skip drops it) and it must carry no
    passing count (a suite that never ran has no pass to claim). 'Skipped
    quietly' is the failure mode a green suite would hide, so it is the one
    thing that gets its own assertion."""

    # The suite this fixture makes unrunnable, and the thing that is missing —
    # which is the REASON the gate has to name.
    UNRUNNABLE = PYTHON_SUITE
    REASON = ""

    def assertUnrunnableSuiteFailedTheGate(self, drive):
        envelope = self.gate_envelope(drive)
        self.assertNotEqual(
            drive.code, 0,
            "AC3 — the declared suite `%s` could NOT be run (%s) and the gate "
            "exited 0. A suite that could not run may not report a pass. "
            "envelope=%s" % (self.UNRUNNABLE, self.REASON, _text(envelope)))
        self.assertFalse(
            _ok(envelope),
            "AC3 — the declared suite `%s` could NOT be run (%s) and the "
            "gate's envelope says ok=%r. envelope=%s"
            % (self.UNRUNNABLE, self.REASON, envelope.get("ok"),
               _text(envelope)))
        warnings = _warnings_text(envelope)
        self.assertIn(
            self.UNRUNNABLE, warnings,
            "AC3 — the suite that could not be run is not NAMED in "
            "`warnings[]`. warnings=%s envelope=%s"
            % (warnings, _text(envelope)))
        self.assertIn(
            self.REASON, warnings,
            "AC3 — the gate names the suite but not the REASON: %r appears "
            "nowhere in `warnings[]`, so the caller is told a declared suite "
            "failed and never told this is what it could not find "
            "(ESCALATION 1). warnings=%s" % (self.REASON, warnings))
        # NOT silently skipped — a gate that dropped the suite names it nowhere
        # in the envelope at all, and a reader cannot tell it was ever declared.
        self.assertIn(
            self.UNRUNNABLE, _text(envelope),
            "AC3 — the declared suite `%s` that could not be run is absent "
            "from the gate's envelope entirely: it was SKIPPED, and this gate "
            "ran a subset without reporting as one. envelope=%s"
            % (self.UNRUNNABLE, _text(envelope)))
        # NOT reported as a pass: a suite that never ran has no pass to claim.
        counts = _attributed_counts(envelope, self.UNRUNNABLE) or {}
        self.assertEqual(
            counts.get("passed", 0), 0,
            "AC3 — the suite that could not be run is credited with %r passing "
            "test(s). It ran none. envelope=%s"
            % (counts.get("passed"), _text(envelope)))

    def assertSurvivingSuiteKeptItsOwnCounts(self, drive, suite, passed):
        """The suite that DID run keeps its own attribution beside the one that
        could not — the same requirement AC2 makes of a failing suite, and the
        reason `suites[]` is per-suite at all."""
        envelope = self.gate_envelope(drive)
        counts = _attributed_counts(envelope, suite) or {}
        self.assertEqual(
            (counts.get("passed"), counts.get("failed")), (passed, 0),
            "AC3 — the declared suite `%s` ran and passed %d of its own tests, "
            "and the envelope attributes %r to it: a suite that could not run "
            "must not cost the one that did its attribution. envelope=%s"
            % (suite, passed, counts, _text(envelope)))
        self.assertEqual(
            _run_counts(envelope).get("passed"), passed,
            "AC3 — the gate's union carries %r pass(es) where the only suite "
            "that ran produced %d. An unrunnable suite may not add passes of "
            "its own. envelope=%s"
            % (_run_counts(envelope).get("passed"), passed, _text(envelope)))


class UnrunnableInterpreterFailsTheGateTest(_UnrunnableSuiteProbe):
    """AC3's first shape — RED. The DISPATCHED suite's declared command names a
    first token that does not exist, so the gate has nothing to spawn."""

    REASON = MISSING_INTERPRETER

    def python_suite_command(self):
        return ("%s/no-such-bin/%s -m unittest discover -s tests/client -t ."
                % (self.tmpdir, MISSING_INTERPRETER))

    def test_a_declared_suite_whose_interpreter_is_missing_fails_the_gate(self):
        drive, exc = self.gate_outcome()
        self.assertGateReported(drive, exc, "AC3")
        self.assertUnrunnableSuiteFailedTheGate(drive)
        self.assertSurvivingSuiteKeptItsOwnCounts(
            drive, BUN_SUITE, _GATE.BUN_SUITE_PASSED)


class UnrunnableStartDirFailsTheGateTest(_UnrunnableSuiteProbe):
    """AC3's second shape — PIN (measured green). The declaration points at a
    start-dir that is not there, so the suite's own client runs and finds
    nothing it can collect."""

    REASON = MISSING_START_DIR

    def python_suite_command(self):
        return ("%s -m unittest discover -s %s -t ."
                % (CHILD_PYTHON, MISSING_START_DIR))

    def test_a_declared_suite_whose_start_dir_is_missing_fails_the_gate(self):
        drive, exc = self.gate_outcome()
        self.assertGateReported(drive, exc, "AC3")
        self.assertUnrunnableSuiteFailedTheGate(drive)
        self.assertSurvivingSuiteKeptItsOwnCounts(
            drive, BUN_SUITE, _GATE.BUN_SUITE_PASSED)


class UnrunnableLocalRunnerFailsTheGateTest(_UnrunnableSuiteProbe):
    """AC3's third shape — RED, and the one that makes the AC symmetrical: the
    missing runner belongs to the suite the gate runs in its OWN process, not
    to a dispatched one.

    A different unguarded call site from the first shape's — `run_gate_suites`
    → `_captured_suite_run` → the client's own `_run_logged` at
    `bun-crucible.py:316`, versus the dispatch's `subprocess.run` at
    `_crucible_axi.py:4267` — so a GREEN that guards only the dispatch still
    dies here, and dies BEFORE any suite has run at all (ESCALATION 6)."""

    UNRUNNABLE = BUN_SUITE
    REASON = MISSING_LOCAL_RUNNER

    def test_a_declared_local_suite_whose_runner_is_missing_fails_the_gate(self):
        drive, exc = self.gate_outcome()
        self.assertGateReported(drive, exc, "AC3")
        self.assertUnrunnableSuiteFailedTheGate(drive)

    def drive_gate(self, extra=()):
        """The adopted drive, pointed at a bun that is not there. The flag rides
        LAST so argparse takes it over the fixture's fake."""
        return super().drive_gate(
            list(extra) + ["--bun", "%s/no-such-bin/%s"
                           % (self.tmpdir, MISSING_LOCAL_RUNNER)])


# ── AC4 — a single-suite project's gate output is UNCHANGED ──────────────


class SingleSuiteProjectGateIsUnchangedTest(_OutcomeCase):
    """AC4 — RED (all three methods). 'A single-suite project's gate output is
    unchanged: same steps, same envelope shape, same exit codes, asserted
    against a one-suite fixture.'

    The fixture declares exactly ONE target and the comparison is against the
    NAMED, DATED snapshot of what `develop`@`0c78928` produced on this very
    fixture — never a live base ref, which self-invalidates on merge (module
    docstring; it is what CR-CRU-111's AC16 proof did, and repairing it is a
    line item in this CR's own non-goals)."""

    def write_fixture_project(self):
        """ONE declared target, owned by this client's own stack — the shape AC4
        names. No python target and no e2e target: a project with one suite is
        the case §S2 says must not change."""
        bun_tests = Path(self.tmpdir, "tests", "unit")
        bun_tests.mkdir(parents=True, exist_ok=True)
        (bun_tests / "probe.test.ts").write_text(_GATE._BUN_PROBE_TEST_TS)
        (Path(self.tmpdir) / "package.json").write_text(json.dumps({
            "name": "gate-one-suite-probe",
            "private": True,
            "scripts": {BUN_SUITE: "bun test tests/unit"},
        }, indent=2) + "\n")

    def bun_steps(self):
        """Every bun invocation the gate made, with this run's throwaway project
        dir folded back to `<project>` so the sequence is comparable to the
        snapshot's."""
        return [[arg.replace(self.tmpdir, "<project>") for arg in record["argv"]]
                for record in self.invocations(FAKE_BUN)]

    def test_a_single_suite_gate_keeps_every_field_of_the_pre_composition_envelope(self):
        """'Same envelope shape, same exit codes.' One-directional by design
        (ESCALATION 2): a field the snapshot carried and this envelope does not
        is an information regression, while the `suites[]` key §S1 adds is not
        asserted against.

        The `files` member of `run` is asserted for a reason of its own:
        CR-CRU-051 §S2 carries that count 'so a suite that silently shrinks is
        visible in the gate output itself', which is this CR's own thesis, so a
        composition that dropped it would hide precisely what the gate exists
        to show (ESCALATION 4). The lineage lives HERE and not in the assertion
        message below, which a client-tree test may not EMIT a project CR
        literal into."""
        drive, exc = self.gate_outcome()
        self.assertGateReported(drive, exc, "AC4")
        envelope = self.gate_envelope(drive)
        self.assertEqual(
            drive.code, PRE_COMPOSITION_EXIT,
            "AC4 — a one-suite project's gate exited %r where %s exited %r on "
            "the same fixture. envelope=%s"
            % (drive.code, PRE_COMPOSITION_REF, PRE_COMPOSITION_EXIT,
               _text(envelope)))
        self.assertEqual(
            _ok(envelope), PRE_COMPOSITION_OK,
            "AC4 — a one-suite project's gate reports ok=%r where %s reported "
            "ok=%r. envelope=%s"
            % (envelope.get("ok"), PRE_COMPOSITION_REF, PRE_COMPOSITION_OK,
               _text(envelope)))
        missing = [key for key in PRE_COMPOSITION_ENVELOPE_KEYS
                   if key not in envelope]
        self.assertEqual(
            missing, [],
            "AC4 — the envelope LOST the field(s) %r that %s carried for a "
            "one-suite project. envelope=%s"
            % (missing, PRE_COMPOSITION_REF, _text(envelope)))
        run = _run_counts(envelope)
        lost = sorted(key for key, value in PRE_COMPOSITION_RUN.items()
                      if run.get(key) != value)
        self.assertEqual(
            lost, [],
            "AC4 — the `run` of a one-suite project's gate no longer reports "
            "%r as %s did: it reported %r and this gate reports %r. `files` is "
            "the count the gate carries 'so a suite that silently shrinks is "
            "visible in the gate output itself' (see this test's docstring for "
            "the lineage, ESCALATION 4). envelope=%s"
            % (lost, PRE_COMPOSITION_REF, PRE_COMPOSITION_RUN, run,
               _text(envelope)))
        self.assertEqual(
            list(envelope.get("help") or []), PRE_COMPOSITION_HELP,
            "AC4 — a one-suite project's gate now offers %r as the next step "
            "where %s offered %r."
            % (envelope.get("help"), PRE_COMPOSITION_REF, PRE_COMPOSITION_HELP))

    def test_a_single_suite_gate_still_attributes_its_run_to_the_regression_tier(self):
        """The tier a gate's own run claims is what the board attributes that
        run BY, so it is part of 'unchanged' in the only sense a consumer of
        the run can observe."""
        drive, exc = self.gate_outcome()
        self.assertGateReported(drive, exc, "AC4")
        envelope = self.gate_envelope(drive)
        self.assertEqual(
            envelope.get("tier"), PRE_COMPOSITION_TIER,
            "AC4 — a one-suite project's gate now stamps its run tier=%r where "
            "%s stamped %r: the declared suite's own tier has replaced the "
            "gate's, so the same project's gate run changes what it is "
            "attributed by. envelope=%s"
            % (envelope.get("tier"), PRE_COMPOSITION_REF, PRE_COMPOSITION_TIER,
               _text(envelope)))

    def test_a_single_suite_gate_runs_the_same_step_it_ran_before_the_composition(self):
        """'Same steps' (ESCALATION 3). The tsc step is bypassed identically in
        both drives, so what is compared is the step the gate takes after it —
        and a project's declared script is not the same collection as the
        whole-suite run it replaced."""
        drive, exc = self.gate_outcome()
        self.assertGateReported(drive, exc, "AC4")
        steps = self.bun_steps()
        self.assertEqual(
            steps, PRE_COMPOSITION_STEPS,
            "AC4 — a one-suite project's gate no longer runs the step %s ran: "
            "expected %r, got %r. `bun run <script>` re-enters `bun test "
            "tests/unit`, a NARROWER collection than the whole-suite `bun "
            "test` it replaced, so the same project gates fewer files than it "
            "did before the composition."
            % (PRE_COMPOSITION_REF, PRE_COMPOSITION_STEPS, steps))


# ── AC3, the OTHER half of "could NOT be run": what an error MEANS ──────


class RunOutcomeTellsASpawnFailureFromAFailedIngestTest(unittest.TestCase):
    """GREEN — both methods, and the defect they defend against was REAL: the
    gate read every `OSError` out of a locally-run suite as "the runner is not
    there". `urllib.error.URLError` is an `OSError` subclass and so is
    `TimeoutError`, so a board that went unreachable during the whole-suite
    run's INGEST — after the suite had run to completion — was reported as
    `gate-suite-unrunnable`, "could NOT be run". A reader cannot tell that from
    a real one, which makes it the one misreport a gate must not make.

    Falsifiable, and MEASURED against the build that had the defect —
    `git show 5ecb200:clients/_crucible_axi.py`, this branch's commit before
    the fix (`develop` has no `_captured_suite_run` at all; the composition is
    this CR's own). Driven through the same seam, that build answers
    `gate-suite-unrunnable`/"could NOT be run" for ALL FOUR errors below,
    including the missing runner; this one answers it for the missing runner
    alone. The second method fails there and passes here.

    The pair is the point. Asserting only that a failed ingest is not
    `unrunnable` would pass on a build that answered `unrunnable` for nothing
    at all, so the spawn shape AC3 is actually about is asserted beside it.

    TIER: `unit` by the DN's definition, unlike the rest of this file — these
    two drive two pure functions of the shared module with no process, no
    socket, no live service and no wait on the clock. They are reported under
    the same declared python `tests/client` suite, which is that suite's union,
    not a tier claim."""

    def outcome_of_a_run_that_raises(self, error):
        """What the gate SAYS about a locally-run suite whose run body raised
        `error` — composed exactly as `run_gate_suites` composes it, so the
        classification is exercised through the seam that uses it and never
        by calling the classifier with a hand-made argument tuple."""
        def raising_run():
            raise error

        code, out, caught = _AXI._captured_suite_run(raising_run)
        self.assertIs(
            caught, error,
            "the gate's local-run guard must hand the raised error back "
            "rather than let it kill the composition; it returned %r"
            % (caught,))
        counts = _AXI._suite_counts(_AXI._suite_envelope(out))
        return _AXI._run_outcome(code, counts, caught)

    def test_a_local_suite_whose_runner_is_not_there_is_reported_as_unrunnable(self):
        ok, warning, detail = self.outcome_of_a_run_that_raises(
            FileNotFoundError(2, "No such file or directory",
                              MISSING_LOCAL_RUNNER))
        self.assertFalse(
            ok, "a suite whose runner is missing may not report a pass")
        self.assertEqual(
            warning, _AXI.GATE_SUITE_UNRUNNABLE_CODE,
            "a run that never started must be reported as %r, not %r"
            % (_AXI.GATE_SUITE_UNRUNNABLE_CODE, warning))
        self.assertIn(
            MISSING_LOCAL_RUNNER, detail,
            "the warning has to NAME what was missing, not merely refuse: "
            "detail=%r" % (detail,))

    def test_a_board_lost_at_the_ingest_is_not_reported_as_a_suite_that_never_ran(self):
        for error in (urllib.error.URLError("connection refused"),
                      TimeoutError("the read timed out"),
                      ConnectionResetError(104, "Connection reset by peer")):
            with self.subTest(error=type(error).__name__):
                ok, warning, detail = self.outcome_of_a_run_that_raises(error)
                self.assertFalse(
                    ok, "a run the gate has no counts from may not report a "
                        "pass either")
                self.assertNotEqual(
                    warning, _AXI.GATE_SUITE_UNRUNNABLE_CODE,
                    "%s is raised AFTER the suite has run — reporting it as %r "
                    "tells a reader a suite that ran to completion never ran. "
                    "detail=%r"
                    % (type(error).__name__, warning, detail))
                self.assertEqual(
                    warning, _AXI.GATE_SUITE_UNREPORTED_CODE,
                    "a run that happened and then reported nothing is %r; the "
                    "gate answered %r"
                    % (_AXI.GATE_SUITE_UNREPORTED_CODE, warning))


if __name__ == "__main__":
    unittest.main()
