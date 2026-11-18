"""A gate's milestone carries each suite's result, and its envelope names the
events of every run it composed; a cycle gate files every suite it runs under
the cycle; and no composed gate is green on a failed runner.

The feature this module keeps a live board for is gate composition across
dispatched clients: bun's gate and the python client it dispatches, each a
separate process, file their runs and the gate's milestone on one board. No
fake can prove it, because the hand-off between those processes is the
server's own storage: the dispatched child's stored event, the run the board
adds for a runner's exit, and the cycle binding a real active cycle enforces.

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

`CycleGateFilesEverySuiteUnderTheCycleTest`: a gate given `--cycle <id>`
files EVERY suite it runs under that cycle, the suites it dispatches to
another stack's client included. While a project has an active cycle, a run
whose agent is bound to no cycle and that carries neither `--cycle` nor
`--release` is refused before its runner starts. A gate that composes several
suites must therefore hand its cycle on: bun's `pre-merge-gate` runs its own
whole-suite regression in a gated bracket (which binds, then removes, the
identity it created) and only THEN dispatches each declared suite another
stack owns to that stack's client as a separate process (`run_gate_suites` ->
`_dispatch_gate_suite` -> the shared `sibling_client_argv`). If the cycle is
not forwarded, the dispatched python suite arrives unbound, with no
`--cycle`, while the cycle is active. It is refused, and the gate that was
asked for the cycle reports a suite it never ran. Its board is its own
`RealBoard`: the cycle must genuinely be ACTIVE for the refusal to have
anything to answer. The project, the fake toolchain and the gate drive are
the adopted multi-suite gate fixture (`test_gate_multi_suite_coverage.py`'s
`_GateFixtureCase`, adopted by name the way
`test_a_release_gate_files_every_suite_it_runs_under_the_release.py` adopts
it): a project declaring a bun suite and a python-owned `test:client` suite
whose script invokes the python client.

`ComposedGateOverAFailedRunnerTest`, on the module's board, drives the real
`clients/bun-crucible.py pre-merge-gate` over a project whose `package.json`
declares a bun-owned suite (`test:unit`) and a python-owned one
(`test:client`, whose script invokes the real `clients/python-crucible.py
regression`). A runner that exits non-zero over a report that records only
passes is a failed run: the board adds its `runner / exit <n>` case, and the
gate that composed the run is not green:

  * the bun whole-suite runner exits 1 over a passing-only report — the gate
    exits non-zero, its envelope is `ok: false`, its totals and the covered
    suite's row carry the board's added case, and the stored run holds it;
  * the dispatched python suite's runner exits 1 over a passing-only report
    while bun's run is clean — the same, attributed to `test:client`;
  * both runners exit 0 over clean reports — the gate is green, exits 0, and
    no run carries a `runner` suite (nothing else changes).

Each fake runner reads its OWN exit variable (`FAKE_BUN_EXIT`,
`FAKE_PYTHON_EXIT`), so one drive can fail one stack's runner and not the
other's.

Invocation:
    python3 -m unittest tests.client.integration.test_a_gate_milestone_carries_each_suite_result -v
"""

import importlib.util
import json
import os
import re
import shlex
import shutil
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
from tests.client.an_unattributed_run_is_refused_while_a_cycle_is_active_helpers import _call
from tests.client.client_fleet_envelope_census_helpers import (
    _FAKE_TOOLS,
    _make_project_dir,
    declare_board,
    drive_verb,
    would_resolve,
)
from tests.client.every_verb_that_files_a_run_is_refused_while_a_cycle_is_active_helpers import (
    _LOG_SNIPPET,
    INVOCATION_LOG,
)
from tests.client.a_gate_milestone_carries_each_suite_result_helpers import (
    BUN_CASE,
    BUN_FAILING_CASE,
    BUN_SUITE,
    EXCLUDED_SUITE,
    _executable,
    _FAKE_BUN,
    _FAKE_PYTHON,
    _RUNNER_EXIT_FAKE_BUN,
    _RUNNER_EXIT_FAKE_PYTHON,
    PYTHON_CASE,
    PYTHON_FAILING_CASE,
    PYTHON_SUITE,
)

TOON = load_toon()
AXI = load_client("_crucible_axi.py")
BUN_CLIENT = CLIENTS / "bun-crucible.py"
PYTHON_CLIENT = CLIENTS / "python-crucible.py"
TIMEOUT = 180

GATE_MILESTONE = "pre-merge-gate"
#: The entry the whole-suite run is recorded under when it covers no declared
#: target — the stack's own label, never retyped here.
WHOLE_BUN_SUITE = AXI.whole_suite_label("bun")


ENTRY_KEYS = {"target", "outcome", "passed", "failed", "failingTests"}

_SCRUBBED = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
             "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
             "PY_CRUCIBLE_PYTHON", "PYTHON_CRUCIBLE_PROJECT_DIR",
             "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "FAKE_BUN_FAIL", "FAKE_PYTHON_FAIL", "FAKE_TSC_FAIL",
             "FAKE_PYTHON_STREAM_CAPTURE")

GATE_SUITE_FAILED = "gate-suite-failed"

# Keys that would let the shell running this suite decide what either client
# resolves or how it files: scrubbed from every runner-exit drive.
_RUNNER_EXIT_SCRUBBED = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
                         "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
                         "PY_CRUCIBLE_PYTHON", "PYTHON_CRUCIBLE_PROJECT_DIR",
                         "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
                         "FAKE_BUN_EXIT", "FAKE_PYTHON_EXIT")

TESTS_CLIENT_DIR = Path(__file__).resolve().parents[1]
GATE_HARNESS_PATH = TESTS_CLIENT_DIR / "integration" / "test_gate_multi_suite_coverage.py"

# Resolved at import, before the adopted gate fixture puts its fake
# toolchains first on PATH: the cycle gate's board must run on the REAL bun.
_REAL_BUN = shutil.which("bun")

# The names the adopted fixture's two suites carry in their stored trees: the
# bun probe file and the python probe's test class.
BUN_SUITE_MARK = "probe.test.ts"
PYTHON_SUITE_MARK = "DeclaredPythonSuiteTest"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The multi-suite gate harness, adopted whole. Only NON-test names are taken:
# importing one of its TestCases would run that suite a second time.
_GATE = _load_module(GATE_HARNESS_PATH, "cycle_gate_dispatch_harness")
CYCLE_GATE_PYTHON_SUITE = _GATE.PYTHON_SUITE
GATE_AGENT = _GATE.AGENT


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
        cls._register_the_gates_agent()
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
    def _register_the_gates_agent(cls):
        """The gate's agent, registered unbound before the drive. The plan's
        cycle is done, so the clients' own registration bound to it is
        refused, and a streamed python unittest run whose run cannot be
        opened files nothing (CR-CRU-224 section S3): the dispatched suite's
        run opens under this registration."""
        reg = cls.board.http("/api/v2/agents/register",
                             {"projectKey": cls.board.key, "agentId": cls.agent,
                              "role": "ORCHESTRATOR"})
        assert reg.get("ok"), f"gate agent registration failed: {reg!r}"

    @classmethod
    def _env(cls):
        env = scrubbed_env(None)
        for key in _SCRUBBED:
            env.pop(key, None)
        env["FAKE_BUN_FAIL"] = "1" if cls.BUN_FAILS else "0"
        env["FAKE_PYTHON_FAIL"] = "1" if cls.PYTHON_FAILS else "0"
        env["FAKE_TSC_FAIL"] = "1" if cls.TSC_FAILS else "0"
        env["FAKE_PYTHON_STREAM_CAPTURE"] = os.path.join(cls.project,
                                                         "stream-capture.txt")
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

    def test_the_dispatched_python_suite_hands_its_runner_a_stream(self):
        """CR-CRU-224 section S3: the dispatched python suite is a unittest
        run with `--agent`, so its runner is handed `CRUCIBLE_STREAM`, naming
        `<reports dir>/crucible-events.ndjson`, and the run is filed from it."""
        capture = Path(self.project, "stream-capture.txt")
        handed = capture.read_text() if capture.exists() else None
        self.assertEqual(
            os.path.realpath(handed) if handed else handed,
            os.path.realpath(os.path.join(self.project, "py-reports",
                                          "crucible-events.ndjson")),
            f"the python runner was handed CRUCIBLE_STREAM={handed!r}; "
            f"{_diagnostics(self.result)}")

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


class CycleGateFilesEverySuiteUnderTheCycleTest(_GATE._GateFixtureCase):
    """`bun-crucible.py pre-merge-gate --cycle <id>`, the cycle active on a
    live board, a python-owned suite declared beside the bun one: every
    suite's run is stored under <id>."""

    ORCHESTRATOR = "cycle-gate-fixture-orchestrator"
    PLANTED_CR = "CR-T-CYCLE-GATE-DISPATCH"

    @classmethod
    def setUpClass(cls):
        # The adopted fixture's fake toolchains go first on PATH for this
        # class alone, and come off again once it is done.
        _GATE.setUpModule()
        cls.addClassCleanup(_GATE.tearDownModule)
        super().setUpClass()
        cls._live_board = None
        if _REAL_BUN is None:
            raise unittest.SkipTest(
                "an ACTIVE cycle is a property of a REAL store: without `bun` "
                "there is no server to carry one. A missing toolchain, not a "
                "passing assertion.")
        cls._live_board = RealBoard(_REAL_BUN, "cycle-gate-dispatch")
        cls.base = cls._live_board.base
        try:
            cls._seed()
        except BaseException:
            cls._stop_board()
            raise

    @classmethod
    def _seed(cls):
        """One project carrying exactly ONE active cycle."""
        board = cls._live_board
        assert board is not None, "the class's real board was never booted"
        key = board.key
        reg = _call(cls.base, "/api/v2/agents/register",
                    {"projectKey": key, "agentId": cls.ORCHESTRATOR,
                     "role": "ORCHESTRATOR"})
        assert reg.get("ok"), f"orchestrator registration failed: {reg!r}"
        filed = _call(cls.base, f"/api/v2/projects/{key}/plans",
                      {"cr": cls.PLANTED_CR, "cycles": [{"label": "solo"}],
                       "agentId": cls.ORCHESTRATOR})
        assert filed.get("ok"), f"plan-file failed: {filed!r}"
        cycle_id = filed["cycles"][0]["id"]
        activated = _call(
            cls.base, f"/api/v2/projects/{key}/plans/{filed['planId']}/cycles/{cycle_id}",
            {"status": "active", "agentId": cls.ORCHESTRATOR}, method="PATCH")
        assert activated.get("ok"), f"cycle activation failed: {activated!r}"
        # The adopted fixture writes this key into the project's `.env`, so
        # the gate AND the sibling client it dispatches both resolve it.
        cls.PROJECT_KEY = key
        cls.cycle_id = cycle_id

    @classmethod
    def tearDownClass(cls):
        cls._stop_board()
        super().tearDownClass()

    @classmethod
    def _stop_board(cls):
        board = getattr(cls, "_live_board", None)
        if board is None:
            return
        cls._live_board = None
        board.close()

    def setUp(self):
        super().setUp()
        # The adopted fixture declared its own stub board; this drive reports
        # to the live one instead, for the gate and its sibling alike.
        declare_board(Path(self.tmpdir) / "crucible.toml", self.base)

    def require_the_declared_board_resolves(self):
        """The adopted interlock, asked of the LIVE board this drive uses."""
        ok, reason = would_resolve(_GATE.AXI_PATH, self.tmpdir, self.base)
        self.assertTrue(
            ok,
            f"the gate's drive must resolve the board declared in "
            f"{self.tmpdir}/crucible.toml, and nothing was spawned because it "
            f"would not: {reason}")

    def _stored_test_events(self):
        """Every stored run-result event of the gate's agent, read in full."""
        listed = _call(self.base, f"/api/v2/events?project={self.PROJECT_KEY}")
        self.assertTrue(listed.get("ok"), f"events read failed: {listed!r}")
        full = []
        for event in listed.get("events") or []:
            if event.get("agentId") != GATE_AGENT or event.get("kind") != "test":
                continue
            read = _call(self.base, f"/api/v2/events/{event['id']}")
            self.assertTrue(read.get("ok", True) and read.get("event"),
                            f"event read failed: {read!r}")
            full.append(read["event"])
        return full

    def test_every_suite_a_cycle_gate_runs_is_stored_under_the_cycle(self):
        drive = self.drive_gate(extra=["--cycle", str(self.cycle_id)])
        envelope = self.gate_envelope(drive)

        self.assertEqual(
            drive.code, 0,
            f"`pre-merge-gate --cycle {self.cycle_id}` with cycle "
            f"{self.cycle_id} ACTIVE must run every declared suite; the "
            f"dispatched `{CYCLE_GATE_PYTHON_SUITE}` must not be refused for carrying no "
            f"cycle. gate envelope={envelope!r} "
            f"stderr={drive.err[-3000:]!r}")
        self.assertTrue(
            envelope.get("ok"),
            f"the gate's own envelope must be ok:true; got {envelope!r}")

        match = re.search(
            rf"dispatching `{re.escape(CYCLE_GATE_PYTHON_SUITE)}` to (?P<argv>[^\n]*)",
            drive.err)
        if match is None:
            self.fail(f"the gate must dispatch `{CYCLE_GATE_PYTHON_SUITE}` to its sibling "
                      f"client; stderr={drive.err[-3000:]!r}")
        dispatched = match.group("argv") if match is not None else ""
        self.assertRegex(
            dispatched, rf"(^|\s)--cycle {self.cycle_id}(\s|$)",
            f"the dispatched sibling command must carry `--cycle "
            f"{self.cycle_id}`, as it carries the gate's --release; got "
            f"{dispatched!r}")

        events = self._stored_test_events()
        bun_runs = [e for e in events if BUN_SUITE_MARK in repr(e.get("tree"))]
        python_runs = [e for e in events if PYTHON_SUITE_MARK in repr(e.get("tree"))]
        self.assertEqual(
            (len(bun_runs), len(python_runs)), (1, 1),
            f"one stored run per suite the gate ran (the bun whole suite AND "
            f"the dispatched `{CYCLE_GATE_PYTHON_SUITE}`); got {len(events)} event(s): "
            f"{[(e.get('id'), e.get('context')) for e in events]!r}")
        for event in bun_runs + python_runs:
            self.assertEqual(
                (event.get("context") or {}).get("cycleId"), self.cycle_id,
                f"every suite a `--cycle {self.cycle_id}` gate runs is stored "
                f"under that cycle; event {event.get('id')} carries "
                f"context={event.get('context')!r}")


class ComposedGateOverAFailedRunnerTest(unittest.TestCase):
    """The gate's exit, its envelope and the runs it filed, for a composed
    gate one of whose runners exited non-zero over a passing-only report."""

    def setUp(self):
        board = _BOARD
        if board is None:
            self.fail("the module's real board was never booted")
        self.board = board
        self.project = new_scratch("composed-gate-runner-exit-")
        self.addCleanup(shutil.rmtree, self.project, ignore_errors=True)
        Path(self.project, "tests").mkdir()
        self.fake_bun = _executable(os.path.join(self.project, "fake_bun.py"),
                                    _RUNNER_EXIT_FAKE_BUN)
        self.fake_python = _executable(
            os.path.join(self.project, "fake_python.py"), _RUNNER_EXIT_FAKE_PYTHON)
        python_suite = " ".join(shlex.quote(part) for part in (
            sys.executable, str(PYTHON_CLIENT), "regression",
            "--project-dir", self.project, "--python", self.fake_python,
            "--reports", "py-reports"))
        Path(self.project, "package.json").write_text(json.dumps({
            "name": "composed-gate-runner-exit", "private": True,
            "scripts": {BUN_SUITE: "bun test tests", PYTHON_SUITE: python_suite},
        }, indent=2))
        self.board.install(self.project)

    # -- the drive -----------------------------------------------------------

    def drive_gate(self, agent, *, bun_exit, python_exit):
        env = scrubbed_env(None)
        for key in _RUNNER_EXIT_SCRUBBED:
            env.pop(key, None)
        env["FAKE_BUN_EXIT"] = str(bun_exit)
        env["FAKE_PYTHON_EXIT"] = str(python_exit)
        cmd = [sys.executable, str(BUN_CLIENT), "pre-merge-gate",
               "--agent", agent, "--project-dir", self.project,
               "--package-dir", self.project, "--bun", self.fake_bun,
               "--reports", "reports", "--skip-check"]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def gate_envelope(self, result):
        """The gate's own envelope: the LAST `axi:` document on stdout naming
        `pre-merge-gate`."""
        out = result.stdout or ""
        starts = [i for i in range(len(out))
                  if out.startswith("axi:", i) and (i == 0 or out[i - 1] == "\n")]
        for start in reversed(starts):
            try:
                decoded = TOON.decode(out[start:])
            except ValueError:
                continue
            axi = decoded.get("axi") if isinstance(decoded, dict) else None
            if isinstance(axi, dict) and axi.get("verb") == "pre-merge-gate":
                return axi
        self.fail(f"the gate put no `pre-merge-gate` envelope on stdout; "
                  f"{_diagnostics(result)}")

    def stored_runs(self, agent, result, expected):
        events = self.board.test_events(agent)
        self.assertEqual(
            len(events), expected,
            f"the gate files exactly {expected} test run(s) for its agent; "
            f"events={events!r} {_diagnostics(result)}")
        return [self.board.event(e["id"]) for e in events]

    @staticmethod
    def run_marked(runs, mark):
        return [run for run in runs if mark in repr(run.get("tree"))]

    @staticmethod
    def runner_suites(run):
        return [s for s in (run.get("tree") or []) if s.get("name") == "runner"]

    def assert_runner_case(self, run, code):
        runner = self.runner_suites(run)
        self.assertEqual(len(runner), 1,
                         f"exactly one `runner` suite; tree={run.get('tree')!r}")
        children = runner[0].get("children") or []
        self.assertEqual(len(children), 1, f"runner suite={runner[0]!r}")
        case = children[0]
        self.assertEqual(case.get("name"), f"exit {code}", f"case={case!r}")
        self.assertEqual(case.get("status"), "fail", f"case={case!r}")
        self.assertEqual(
            (case.get("failure") or {}).get("message"),
            f"the runner exited {code} but its report records no failure",
            f"case={case!r}")

    def assert_counts(self, counts, *, total, passed, failed, where):
        self.assertEqual(
            (counts.get("total"), counts.get("passed"), counts.get("failed")),
            (total, passed, failed),
            f"{where} counts (total, passed, failed); got {counts!r}")

    @staticmethod
    def suite_row(envelope, suite):
        rows = [r for r in (envelope.get("suites") or [])
                if isinstance(r, dict) and r.get("suite") == suite]
        return rows[0] if len(rows) == 1 else {"rows": envelope.get("suites")}

    @staticmethod
    def failed_warnings(envelope):
        return [w for w in (envelope.get("warnings") or [])
                if isinstance(w, dict) and w.get("code") == GATE_SUITE_FAILED]

    # -- the bun-owned suite: the whole-suite runner fails ------------------

    def test_a_gate_whose_bun_runner_exits_1_over_a_passing_report_is_not_green(self):
        agent = "composed-gate-bun-runner-exit"
        result = self.drive_gate(agent, bun_exit=1, python_exit=0)
        self.assertNotEqual(result.returncode, 0,
                            f"a gate one of whose runners exited 1 never exits "
                            f"green; {_diagnostics(result)}")
        envelope = self.gate_envelope(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        # bun: 1 pass + the board's runner case; python: 1 pass.
        self.assert_counts(envelope.get("run") or {}, total=3, passed=2,
                           failed=1, where="the gate's run")
        row = self.suite_row(envelope, BUN_SUITE)
        self.assertIn("coveredBy", row,
                      f"the bun-owned suite is covered by the whole-suite run; "
                      f"row={row!r}")
        self.assert_counts(row, total=2, passed=1, failed=1,
                           where=f"the `{BUN_SUITE}` row's")
        failed = self.failed_warnings(envelope)
        self.assertEqual(len(failed), 1,
                         f"exactly one failed-suite warning; "
                         f"warnings={envelope.get('warnings')!r}")
        self.assertIn(f"`{BUN_SUITE}`", failed[0].get("detail") or "",
                      f"the warning names the suite the failed run covered; "
                      f"warning={failed[0]!r}")
        runs = self.stored_runs(agent, result, 2)
        bun_runs = self.run_marked(runs, BUN_CASE)
        self.assertEqual(len(bun_runs), 1, f"runs={runs!r}")
        self.assert_runner_case(bun_runs[0], 1)
        self.assert_counts(bun_runs[0].get("summary") or {}, total=2, passed=1,
                           failed=1, where="the stored bun run's")
        python_runs = self.run_marked(runs, PYTHON_CASE)
        self.assertEqual(len(python_runs), 1, f"runs={runs!r}")
        self.assertEqual(self.runner_suites(python_runs[0]), [],
                         "the clean python run gets no `runner` suite")

    # -- the dispatched python-owned suite: its runner fails ----------------

    def test_a_gate_whose_dispatched_python_runner_exits_1_over_a_passing_report_is_not_green(self):
        agent = "composed-gate-python-runner-exit"
        result = self.drive_gate(agent, bun_exit=0, python_exit=1)
        self.assertNotEqual(result.returncode, 0,
                            f"a gate whose dispatched suite's runner exited 1 "
                            f"never exits green; {_diagnostics(result)}")
        envelope = self.gate_envelope(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        # bun: 1 pass; python: 1 pass + the board's runner case.
        self.assert_counts(envelope.get("run") or {}, total=3, passed=2,
                           failed=1, where="the gate's run")
        row = self.suite_row(envelope, PYTHON_SUITE)
        self.assertEqual(row.get("stack"), "python", f"row={row!r}")
        self.assert_counts(row, total=2, passed=1, failed=1,
                           where=f"the `{PYTHON_SUITE}` row's")
        failed = self.failed_warnings(envelope)
        self.assertEqual(len(failed), 1,
                         f"exactly one failed-suite warning; "
                         f"warnings={envelope.get('warnings')!r}")
        self.assertIn(f"`{PYTHON_SUITE}`", failed[0].get("detail") or "",
                      f"the warning names the dispatched suite; "
                      f"warning={failed[0]!r}")
        runs = self.stored_runs(agent, result, 2)
        python_runs = self.run_marked(runs, PYTHON_CASE)
        self.assertEqual(len(python_runs), 1, f"runs={runs!r}")
        self.assert_runner_case(python_runs[0], 1)
        self.assert_counts(python_runs[0].get("summary") or {}, total=2,
                           passed=1, failed=1, where="the stored python run's")
        bun_runs = self.run_marked(runs, BUN_CASE)
        self.assertEqual(len(bun_runs), 1, f"runs={runs!r}")
        self.assertEqual(self.runner_suites(bun_runs[0]), [],
                         "the clean bun run gets no `runner` suite")

    # -- nothing else changes ----------------------------------------------

    def test_a_gate_whose_runners_both_exit_0_over_clean_reports_is_green(self):
        agent = "composed-gate-clean"
        result = self.drive_gate(agent, bun_exit=0, python_exit=0)
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        envelope = self.gate_envelope(result)
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
        self.assert_counts(envelope.get("run") or {}, total=2, passed=2,
                           failed=0, where="the gate's run")
        self.assertEqual(self.failed_warnings(envelope), [],
                         f"warnings={envelope.get('warnings')!r}")
        runs = self.stored_runs(agent, result, 2)
        for run in runs:
            self.assertEqual(self.runner_suites(run), [],
                             f"a clean runner adds no `runner` suite; "
                             f"tree={run.get('tree')!r}")
            self.assert_counts(run.get("summary") or {}, total=1, passed=1,
                               failed=0, where="a stored run's")


if __name__ == "__main__":
    unittest.main()
