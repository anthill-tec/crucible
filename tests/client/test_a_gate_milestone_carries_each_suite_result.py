"""A gate's milestone carries each suite's result, and its envelope names the
events of every run it composed.

bun's `pre-merge-gate` is the fleet's composed gate: its own whole-suite
regression (covering every bun-owned declared target) plus one dispatched run
per declared suite another stack owns. The `pre-merge-gate` milestone it posts
records the verdict and totals; a later gate run over only some suites can be
judged against it only if the milestone also says what EACH suite did. So the
milestone carries `scope` (`full` for a gate that ran every declared suite)
and `suites`: one entry per gated suite —

  * `target` (the declared target; the stack's whole-suite label when the
    whole-suite run covered no declared target),
  * `outcome` (`pass`/`fail`),
  * `passed` and `failed` (both absent only on a `fail` the gate cannot
    count: a suite that could not run, be dispatched or report),
  * `failingTests` (the real failing tests, a dispatched suite's included —
    read through the event its own envelope names).

An excluded suite is not listed, and a gate that composed no suites (the
project declares none, or the gate stopped at its first step) records no
`suites`.

Driven against a REAL scratch board (`tests/client/real_board.py`): the real
`clients/bun-crucible.py pre-merge-gate` runs as a subprocess, its python
suite dispatched to the real `clients/python-crucible.py`, each runner a small
fake whose pass or fail this suite decides. Each scenario has its own plan and
cycle, so its milestone is found by the plan's CR label and nothing else.

Invocation:
    python3 -m unittest tests.client.test_a_gate_milestone_carries_each_suite_result -v
"""

import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    load_client,
    load_toon,
    new_scratch,
    scrubbed_env,
)
from tests.client.real_board import RealBoard
from tests.client.test_an_unattributed_run_is_refused_while_a_cycle_is_active import (
    _call,
)
from tests.client.test_client_fleet_envelope_census import (
    _FAKE_TOOLS,
    _make_project_dir,
    drive_verb,
)
from tests.client.test_every_verb_that_files_a_run_is_refused_while_a_cycle_is_active import (
    _LOG_SNIPPET,
    INVOCATION_LOG,
)

TOON = load_toon()
AXI = load_client("_crucible_axi.py")
BUN_CLIENT = CLIENTS / "bun-crucible.py"
PYTHON_CLIENT = CLIENTS / "python-crucible.py"
TIMEOUT = 180

GATE_MILESTONE = "pre-merge-gate"
BUN_SUITE = "test:unit"
PYTHON_SUITE = "test:client"
EXCLUDED_SUITE = "test:e2e"
#: The entry the whole-suite run is recorded under when it covers no declared
#: target — the stack's own label, never retyped here.
WHOLE_BUN_SUITE = AXI.whole_suite_label("bun")

BUN_FILE = "math.test.ts"
BUN_CASE = "adds two numbers"
BUN_FAILING_CASE = "subtracts two numbers on purpose wrongly"
PYTHON_CLASS = "gate_probe.GateProbeCase"
PYTHON_CASE = "test_the_python_suite_passes"
PYTHON_FAILING_CASE = "test_the_python_suite_fails_on_purpose"

ENTRY_KEYS = {"target", "outcome", "passed", "failed", "failingTests"}

_SCRUBBED = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
             "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
             "PY_CRUCIBLE_PYTHON", "PYTHON_CRUCIBLE_PROJECT_DIR",
             "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "FAKE_BUN_FAIL", "FAKE_PYTHON_FAIL", "FAKE_TSC_FAIL")

# A fake `bun`. `bun x tsc …` (the gate's step 0) fails with a tsc error when
# FAKE_TSC_FAIL=1; `bun test …` writes one passing JUnit case — plus one
# failing case, and exits 1, when FAKE_BUN_FAIL=1.
_FAKE_BUN = r'''
import os
import sys

FILE, CASE, FAILING = ''' + repr((BUN_FILE, BUN_CASE, BUN_FAILING_CASE)) + r'''

argv = sys.argv[1:]
if argv[:2] == ["x", "tsc"]:
    if os.environ.get("FAKE_TSC_FAIL") == "1":
        sys.stdout.write("src/probe.ts(1,1): error TS2304: Cannot find name 'undeclared'.\n")
        sys.exit(2)
    sys.exit(0)
fail = os.environ.get("FAKE_BUN_FAIL") == "1"
junit = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
cases = '<testcase name="%s" classname="" time="0.00002" file="%s"/>' % (CASE, FILE)
if fail:
    cases += ('<testcase name="%s" classname="" time="0.00002" file="%s">'
              '<failure message="expected 1 received 2" type="AssertionError"/>'
              '</testcase>' % (FAILING, FILE))
total, failures = (2, 1) if fail else (1, 0)
if junit:
    directory = os.path.dirname(junit)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(junit, "w") as handle:
        handle.write(
            '<?xml version="1.0" encoding="UTF-8"?><testsuites tests="%d" failures="%d">'
            '<testsuite name="%s" file="%s" tests="%d" failures="%d">%s'
            '</testsuite></testsuites>' % (total, failures, FILE, FILE, total, failures, cases))
sys.exit(1 if fail else 0)
'''

# A fake interpreter for the python client: run as the suite (`... -o <dir>`)
# it writes one passing JUnit case — plus one failing case, and exits 1, when
# FAKE_PYTHON_FAIL=1. A coverage.py probe (`-c <script>`) answers true.
_FAKE_PYTHON = r'''
import os
import sys

CLASS, CASE, FAILING = ''' + repr((PYTHON_CLASS, PYTHON_CASE, PYTHON_FAILING_CASE)) + r'''

argv = sys.argv[1:]
if argv[:1] == ["-c"]:
    sys.stdout.write("true\n")
    sys.exit(0)
fail = os.environ.get("FAKE_PYTHON_FAIL") == "1"
outdir = None
for i, arg in enumerate(argv):
    if arg == "-o" and i + 1 < len(argv):
        outdir = argv[i + 1]
cases = '<testcase classname="%s" name="%s" time="0.001"></testcase>' % (CLASS, CASE)
if fail:
    cases += ('<testcase classname="%s" name="%s" time="0.001">'
              '<failure type="AssertionError" message="2 != 3">AssertionError: 2 != 3'
              '</failure></testcase>' % (CLASS, FAILING))
total, failures = (2, 1) if fail else (1, 0)
sys.stderr.write("Ran %d test(s)\n\n%s\n" % (total, "FAILED (failures=1)" if fail else "OK"))
sys.stderr.flush()
if outdir:
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "TEST-%s.xml" % CLASS), "w") as handle:
        handle.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                     '<testsuite name="%s" tests="%d" errors="0" failures="%d" '
                     'skipped="0">%s</testsuite>\n' % (CLASS, total, failures, cases))
sys.exit(1 if fail else 0)
'''


def _executable(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)
    return path


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout[-3000:]!r} "
            f"stderr={result.stderr[-3000:]!r}")


_BOARD = None


def setUpModule():
    global _BOARD
    bun = shutil.which("bun")
    if bun is None:
        raise unittest.SkipTest(
            "a gate milestone is read back from a REAL board, and without "
            "`bun` there is none to boot — a missing toolchain, not a passing "
            "assertion")
    _BOARD = RealBoard(bun, "gate-milestone-suites-e2e")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


class _GateScenario(unittest.TestCase):
    """One gate drive per scenario class, made once in `setUpClass` over its
    own project, plan and cycle; each test method reads one property of it."""

    #: Overridden per scenario.
    NAME = "scenario"
    BUN_FAILS = False
    PYTHON_FAILS = False
    TSC_FAILS = False
    SKIP_CHECK = True

    @classmethod
    def scripts(cls, python_suite) -> "dict[str, str] | None":
        """The project's `package.json` scripts; `python_suite` is the command
        that runs the python-owned suite through the python client."""
        return {BUN_SUITE: "bun test tests", PYTHON_SUITE: python_suite,
                EXCLUDED_SUITE: "bunx bddgen && bunx playwright test"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if _BOARD is None:
            raise AssertionError("the module's real board was never booted")
        cls.board = _BOARD
        cls.agent = f"gate-suites-{cls.NAME}"
        cls.cr = f"gate-suites-{cls.NAME}-plan"
        cls.project = new_scratch(f"gate-suites-{cls.NAME}-")
        Path(cls.project, "tests").mkdir()
        cls.fake_bun = _executable(os.path.join(cls.project, "fake_bun.py"), _FAKE_BUN)
        cls.fake_python = _executable(os.path.join(cls.project, "fake_python.py"),
                                      _FAKE_PYTHON)
        python_suite = " ".join(shlex.quote(part) for part in (
            sys.executable, str(PYTHON_CLIENT), "regression",
            "--project-dir", cls.project, "--python", cls.fake_python,
            "--reports", "py-reports"))
        scripts = cls.scripts(python_suite)
        manifest = {"name": f"gate-suites-{cls.NAME}", "private": True}
        if scripts is not None:
            manifest["scripts"] = scripts
        Path(cls.project, "package.json").write_text(json.dumps(manifest, indent=2))
        cls.board.install(cls.project)
        cls.orchestrator = f"gate-suites-{cls.NAME}-orchestrator"
        cls.plan_id, cls.cycle_id = cls._plan()
        cls.result = cls._drive_gate()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.project, ignore_errors=True)
        super().tearDownClass()

    @classmethod
    def _plan(cls):
        """One plan whose one cycle is done: the gate runs `--cycle <it>`, so
        its milestone is labelled with this plan's CR, and `cr-close` meets no
        unfinished cycle before the gate verdict."""
        board = cls.board
        reg = board.http("/api/v2/agents/register",
                         {"projectKey": board.key, "agentId": cls.orchestrator,
                          "role": "ORCHESTRATOR"})
        assert reg.get("ok"), f"orchestrator registration failed: {reg!r}"
        filed = board.http(f"/api/v2/projects/{board.key}/plans",
                           {"cr": cls.cr, "cycles": [{"label": "solo"}],
                            "agentId": cls.orchestrator})
        assert filed.get("ok"), f"plan-file failed: {filed!r}"
        plan_id, cycle_id = filed["planId"], filed["cycles"][0]["id"]
        path = f"/api/v2/projects/{board.key}/plans/{plan_id}/cycles/{cycle_id}"
        for status in ("active", "done"):
            moved = _call(board.base, path,
                          {"status": status, "agentId": cls.orchestrator},
                          method="PATCH")
            assert moved.get("ok"), f"cycle {status} failed: {moved!r}"
        return plan_id, cycle_id

    @classmethod
    def _env(cls):
        env = scrubbed_env(None)
        for key in _SCRUBBED:
            env.pop(key, None)
        env["FAKE_BUN_FAIL"] = "1" if cls.BUN_FAILS else "0"
        env["FAKE_PYTHON_FAIL"] = "1" if cls.PYTHON_FAILS else "0"
        env["FAKE_TSC_FAIL"] = "1" if cls.TSC_FAILS else "0"
        return env

    @classmethod
    def _drive_gate(cls):
        cmd = [sys.executable, str(BUN_CLIENT), "pre-merge-gate",
               "--agent", cls.agent, "--project-dir", cls.project,
               "--package-dir", cls.project, "--bun", cls.fake_bun,
               "--reports", "reports", "--cycle", str(cls.cycle_id)]
        if cls.SKIP_CHECK:
            cmd.append("--skip-check")
        return subprocess.run(cmd, cwd=cls.project, env=cls._env(),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    # ── reading the drive back ─────────────────────────────────────────────

    def gate_envelope(self):
        out = self.result.stdout or ""
        starts = [i for i in range(len(out))
                  if out.startswith("axi:", i) and (i == 0 or out[i - 1] == "\n")]
        for start in reversed(starts):
            try:
                decoded = TOON.decode(out[start:])
            except ValueError:
                continue
            axi = decoded.get("axi") if isinstance(decoded, dict) else None
            if isinstance(axi, dict) and axi.get("verb") == GATE_MILESTONE:
                return axi
        self.fail(f"the gate put no `{GATE_MILESTONE}` envelope on stdout; "
                  f"{_diagnostics(self.result)}")

    def milestone(self):
        """The ONE `pre-merge-gate` milestone this scenario's gate posted."""
        read = self.board.http(
            f"/api/v2/projects/{self.board.key}/milestones?type={GATE_MILESTONE}")
        self.assertTrue(read.get("ok"), f"milestones read failed: {read!r}")
        mine = [m for m in read.get("milestones") or [] if m.get("label") == self.cr]
        self.assertEqual(
            len(mine), 1,
            f"the gate posts exactly one `{GATE_MILESTONE}` milestone for "
            f"{self.cr!r}; got {mine!r}; {_diagnostics(self.result)}")
        return mine[0]

    def entries(self, record):
        suites = record.get("suites")
        self.assertIsInstance(
            suites, list,
            f"the milestone carries `suites`, one entry per gated suite; "
            f"record={record!r}")
        return suites if isinstance(suites, list) else []

    def entry(self, record, target):
        found = [e for e in self.entries(record)
                 if isinstance(e, dict) and e.get("target") == target]
        self.assertEqual(
            len(found), 1,
            f"exactly one `suites` entry for {target!r}; "
            f"suites={record.get('suites')!r}")
        return found[0] if found else {}

    def assertPassingEntry(self, entry, *, passed):
        self.assertEqual(
            (entry.get("outcome"), entry.get("passed"), entry.get("failed")),
            ("pass", passed, 0),
            f"a passing suite's entry: outcome pass, its own counts; entry={entry!r}")
        self.assertEqual(entry.get("failingTests", []), [],
                         f"a passing suite names no failing test; entry={entry!r}")

    def assertFailingEntry(self, entry, *, passed, failed, failing_case):
        self.assertEqual(
            (entry.get("outcome"), entry.get("passed"), entry.get("failed")),
            ("fail", passed, failed),
            f"a failing suite's entry: outcome fail, its own counts; entry={entry!r}")
        failing = entry.get("failingTests")
        self.assertIsInstance(failing, list,
                              f"a failing suite names its failing tests; entry={entry!r}")
        failing = failing if isinstance(failing, list) else []
        self.assertEqual(
            len(failing), failed,
            f"one name per failing test; failingTests={failing!r}")
        self.assertTrue(
            any(failing_case in str(name) for name in failing),
            f"the entry names the REAL failing test ({failing_case!r}); "
            f"failingTests={failing!r}")

    def stored_runs(self):
        """The test runs the gate's agent filed, oldest first, read in full."""
        events = self.board.test_events(self.agent)
        events.reverse()
        events.sort(key=lambda e: e.get("timestamp") or 0)
        return [self.board.event(e["id"]) for e in events]

    def run_id_marked(self, runs, mark):
        marked = [r for r in runs if mark in repr(r.get("tree"))]
        self.assertEqual(len(marked), 1,
                         f"exactly one stored run carries {mark!r}; "
                         f"runs={[(r.get('id'), r.get('summary')) for r in runs]!r}")
        return str(marked[0].get("id")) if marked else None


class AFullGateRecordsADispatchedSuitesFailureTest(_GateScenario):
    """A bun suite that passes beside a dispatched python suite that fails."""

    NAME = "dispatched-python-fails"
    PYTHON_FAILS = True

    def test_the_milestone_states_a_full_scope(self):
        record = self.milestone()
        self.assertEqual(record.get("outcome"), "fail", f"record={record!r}")
        self.assertEqual(
            record.get("scope"), "full",
            f"a gate that ran every declared suite is a full gate; record={record!r}")

    def test_the_milestone_lists_both_gated_suites_and_not_the_excluded_one(self):
        record = self.milestone()
        targets = sorted(str(e.get("target")) for e in self.entries(record)
                         if isinstance(e, dict))
        self.assertEqual(
            targets, sorted([BUN_SUITE, PYTHON_SUITE]),
            f"one entry per gated suite — `{EXCLUDED_SUITE}` is excluded and "
            f"not listed, and the whole-suite run covered `{BUN_SUITE}` so it "
            f"is recorded under that target; suites={record.get('suites')!r}")
        for entry in self.entries(record):
            self.assertLessEqual(
                set(entry), ENTRY_KEYS,
                f"an entry carries only target, outcome, counts and failing "
                f"tests; entry={entry!r}")

    def test_each_entry_carries_its_own_outcome_and_counts(self):
        record = self.milestone()
        self.assertPassingEntry(self.entry(record, BUN_SUITE), passed=1)
        self.assertFailingEntry(self.entry(record, PYTHON_SUITE), passed=1,
                                failed=1, failing_case=PYTHON_FAILING_CASE)

    def test_the_milestones_failing_tests_name_the_dispatched_suites_real_failure(self):
        record = self.milestone()
        self.assertEqual((record.get("passed"), record.get("failed")), (2, 1),
                         f"the gate's totals; record={record!r}")
        failing = record.get("failingTests")
        self.assertIsInstance(failing, list, f"record={record!r}")
        failing = failing if isinstance(failing, list) else []
        self.assertEqual(
            len(failing), 1,
            f"the milestone names the one failing test, which a sibling "
            f"client's process filed; failingTests={failing!r}")
        self.assertTrue(
            any(PYTHON_FAILING_CASE in str(name) for name in failing),
            f"failingTests names the REAL failing test "
            f"({PYTHON_FAILING_CASE!r}); failingTests={failing!r}")

    def test_the_gate_envelope_lists_the_events_of_its_own_run_and_the_dispatched_one(self):
        envelope = self.gate_envelope()
        runs = self.stored_runs()
        self.assertEqual(len(runs), 2,
                         f"the gate files one bun run and one python run; "
                         f"{_diagnostics(self.result)}")
        bun_run = self.run_id_marked(runs, BUN_CASE)
        python_run = self.run_id_marked(runs, PYTHON_FAILING_CASE)
        self.assertIn("events", envelope,
                      f"the gate's envelope names the events of the runs it "
                      f"composed; envelope={envelope!r}")
        events = envelope.get("events")
        self.assertEqual(
            [str(e) for e in events] if isinstance(events, list) else events,
            [bun_run, python_run],
            f"the gate's `events`: its own whole-suite run, then the "
            f"dispatched suite's, in filing order; envelope={envelope!r}")


class AWholeSuiteFailureOverOnlyDispatchedSuitesTest(_GateScenario):
    """A project declaring ONLY a dispatched suite, which passes, while the
    bun whole suite fails: the whole-suite run covers no declared target and
    is still an entry, under the stack's whole-suite label."""

    NAME = "whole-suite-fails"
    BUN_FAILS = True

    @classmethod
    def scripts(cls, python_suite):
        return {PYTHON_SUITE: python_suite}

    def test_the_whole_suite_failure_is_a_fail_entry_under_the_whole_suite_label(self):
        record = self.milestone()
        self.assertEqual(record.get("outcome"), "fail", f"record={record!r}")
        self.assertEqual(record.get("scope"), "full", f"record={record!r}")
        targets = sorted(str(e.get("target")) for e in self.entries(record)
                         if isinstance(e, dict))
        self.assertEqual(
            targets, sorted([WHOLE_BUN_SUITE, PYTHON_SUITE]),
            f"the whole-suite run ran, so it is represented; suites="
            f"{record.get('suites')!r}")
        self.assertFailingEntry(self.entry(record, WHOLE_BUN_SUITE), passed=1,
                                failed=1, failing_case=BUN_FAILING_CASE)
        self.assertPassingEntry(self.entry(record, PYTHON_SUITE), passed=1)

    def test_cr_close_refuses_the_red_gate_with_no_scoped_run_after_it(self):
        """GREEN-GUARD: `cr-close` refuses a CR whose latest gate is red, and
        no scoped gate has run since — it holds today, and must still hold
        once the verdict reads suite by suite."""
        closer = f"{self.agent}-closer"
        reg = self.board.http("/api/v2/agents/register",
                              {"projectKey": self.board.key, "agentId": closer,
                               "role": "ORCHESTRATOR"})
        self.assertTrue(reg.get("ok"), f"closer registration failed: {reg!r}")
        result = subprocess.run(
            [sys.executable, str(BUN_CLIENT), "cr-close", "--agent", closer,
             "--commit", "deadbeef0210", "--cr", self.cr,
             "--project-dir", self.project],
            cwd=self.project, env=self._env(), capture_output=True, text=True,
            timeout=TIMEOUT, check=False)
        self.assertNotEqual(result.returncode, 0,
                            f"a red gate refuses the close; {_diagnostics(result)}")
        plans = self.board.http(f"/api/v2/projects/{self.board.key}/plans")
        plan = [p for p in plans.get("plans") or [] if p.get("planId") == self.plan_id]
        self.assertEqual(len(plan), 1, f"plans={plans!r}")
        self.assertEqual(plan[0].get("status") if plan else None, "open",
                         f"the refused plan stays open; plan={plan!r}")


class AnUndispatchableSuiteTest(_GateScenario):
    """A declared python suite the gate cannot dispatch (its command names no
    discovery the python client can run) is a `fail` entry with no counts."""

    NAME = "undispatchable"

    @classmethod
    def scripts(cls, python_suite):
        return {BUN_SUITE: "bun test tests",
                PYTHON_SUITE: f"{shlex.quote(sys.executable)} -m pytest tests"}

    def test_an_undispatchable_suite_is_a_fail_entry_with_no_counts(self):
        record = self.milestone()
        self.assertEqual(record.get("outcome"), "fail", f"record={record!r}")
        entry = self.entry(record, PYTHON_SUITE)
        self.assertEqual(entry.get("outcome"), "fail",
                         f"a suite that could not be dispatched did not pass; "
                         f"entry={entry!r}")
        self.assertNotIn("passed", entry,
                         f"it ran nothing, so it has no counts; entry={entry!r}")
        self.assertNotIn("failed", entry,
                         f"it ran nothing, so it has no counts; entry={entry!r}")
        self.assertPassingEntry(self.entry(record, BUN_SUITE), passed=1)


class AGateThatDeclaresNoSuitesTest(_GateScenario):
    """GREEN-GUARD: a project declaring no suites composes none, so its gate's
    milestone records no `suites` — it holds today."""

    NAME = "no-declared-suites"

    @classmethod
    def scripts(cls, python_suite):
        return None

    def test_a_gate_over_a_project_declaring_no_suites_records_no_suites(self):
        record = self.milestone()
        self.assertEqual(record.get("outcome"), "pass", f"record={record!r}")
        self.assertNotIn("suites", record,
                         f"a gate that composed no suites records none; "
                         f"record={record!r}")


class AGateStoppedAtItsFirstStepTest(_GateScenario):
    """GREEN-GUARD: a gate whose step 0 (bun's tsc check) fails never composes
    its suites, so its milestone records no `suites` — it holds today."""

    NAME = "stopped-at-step-0"
    TSC_FAILS = True
    SKIP_CHECK = False

    def test_a_gate_stopped_at_its_first_step_records_no_suites(self):
        envelope = self.gate_envelope()
        self.assertEqual(envelope.get("stage"), "check",
                         f"the gate stopped at its tsc step; envelope={envelope!r}")
        record = self.milestone()
        self.assertEqual(record.get("outcome"), "fail", f"record={record!r}")
        self.assertNotIn("suites", record,
                         f"a gate stopped at its first step composed no suites; "
                         f"record={record!r}")


# A fake `docker` that brings the stack "up" and then is gone: the gate's
# teardown (`docker compose down`, run after the composition returned) can no
# longer start it, so the teardown raises an OSError out of the gate.
_VANISHING_DOCKER = r'''
import os
import sys

if sys.argv[1:2] == ["compose"] and "up" in sys.argv[2:]:
    os.remove(os.path.abspath(__file__))
sys.exit(0)
'''


class AGateThatFailsAfterItsCompositionTest(_GateScenario):
    """A maven gate whose composition FINISHED — its whole-suite run filed, so
    every declared target had a result — and that then failed in the step
    after it: its `docker compose down` teardown could not start `docker`.
    That OSError escapes the gate, and a failure that escapes the gate, even
    after the composition, posts a `fail` milestone with no `suites`.

    The drive's PATH holds only its own fakes, so the vanished `docker` can
    never resolve to a real one further along the PATH."""

    NAME = "fails-after-composition"

    @classmethod
    def setUpClass(cls):
        super(_GateScenario, cls).setUpClass()
        if _BOARD is None:
            raise AssertionError("the module's real board was never booted")
        cls.board = _BOARD
        cls.agent = f"gate-suites-{cls.NAME}"
        cls.cr = f"gate-suites-{cls.NAME}-plan"
        cls.orchestrator = f"gate-suites-{cls.NAME}-orchestrator"
        cls.project = str(_make_project_dir("mvn"))
        cls.bin_dir = new_scratch("gate-suites-mvn-bin-")
        for name, body in (("mvn", _FAKE_TOOLS["mvn"].split("\n", 1)[1]),
                           ("docker", _VANISHING_DOCKER)):
            _executable(os.path.join(cls.bin_dir, name), _LOG_SNIPPET + body)
        Path(cls.project, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={cls.board.key}\n")
        profiles = "".join(f"<profile><id>{t}</id></profile>"
                           for t in ("unit", "integration", "e2e"))
        Path(cls.project, "pom.xml").write_text(
            f"<project><profiles>{profiles}</profiles></project>")
        cls.plan_id, cls.cycle_id = cls._plan()
        cls.result = drive_verb(
            CLIENTS / "mvn-crucible.py",
            [GATE_MILESTONE, "--agent", cls.agent, "--project-dir", cls.project,
             "--cycle", str(cls.cycle_id)],
            Path(cls.project), Path(cls.bin_dir), timeout=TIMEOUT,
            extra_env={"PATH": cls.bin_dir}, board=cls.board.base)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.bin_dir, ignore_errors=True)
        super().tearDownClass()

    def test_the_composition_ran_before_the_teardown_failed(self):
        """The control: the whole-suite run ran and was filed, and the
        teardown never started, so the failure came after the composition."""
        log = Path(self.bin_dir, INVOCATION_LOG)
        ran = log.read_text().splitlines() if log.exists() else []
        self.assertEqual(
            [line.split(" ", 1)[0] for line in ran], ["docker", "mvn"],
            f"the stack came up and the suite ran, and nothing ran after it; "
            f"invocations={ran!r}; {_diagnostics(self.result)}")
        self.assertEqual(len(self.stored_runs()), 1,
                         f"the whole-suite run was filed; "
                         f"{_diagnostics(self.result)}")
        self.assertNotEqual(self.result.returncode, 0,
                            f"the escaped teardown failure fails the gate; "
                            f"{_diagnostics(self.result)}")

    def test_a_failure_escaping_after_the_composition_records_no_suites(self):
        record = self.milestone()
        self.assertEqual(record.get("outcome"), "fail",
                         f"a gate a failure escaped did not pass; "
                         f"record={record!r}")
        self.assertNotIn("suites", record,
                         f"a failure that escapes the gate, even after the "
                         f"composition, posts no `suites`; record={record!r}")


if __name__ == "__main__":
    unittest.main()
