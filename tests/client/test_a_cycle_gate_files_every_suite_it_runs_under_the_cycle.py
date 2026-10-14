"""A gate given `--cycle <id>` files EVERY suite it runs under that cycle,
the suites it dispatches to another stack's client included.

While a project has an active cycle, a run whose agent is bound to no cycle
and that carries neither `--cycle` nor `--release` is refused before its
runner starts. A gate that composes several suites must therefore hand its
cycle on: bun's `pre-merge-gate` runs its own whole-suite regression in a
gated bracket (which binds, then removes, the identity it created) and only
THEN dispatches each declared suite another stack owns to that stack's client
as a separate process (`run_gate_suites` -> `_dispatch_gate_suite` -> the
shared `sibling_client_argv`). If the cycle is not forwarded, the dispatched
python suite arrives unbound, with no `--cycle`, while the cycle is active.
It is refused, and the gate that was asked for the cycle reports a suite it
never ran.

Driven against a REAL, ephemeral `bun run src/server.ts` board (never
:3850/:3849): the cycle must genuinely be ACTIVE for the refusal to have
anything to answer, and the stored events must be read back from a real
store. The project, the fake toolchain and the gate drive are the adopted
multi-suite gate fixture (`test_gate_multi_suite_coverage.py`'s
`_GateFixtureCase`, adopted by name the way
`test_a_release_gate_files_every_suite_it_runs_under_the_release.py` adopts
it): a project declaring a bun suite and a python-owned `test:client` suite
whose script invokes the python client. The board server idiom is the one the
unattributed-run refusal suite uses.

Invocation:
    python3 -m unittest tests.client.test_a_cycle_gate_files_every_suite_it_runs_under_the_cycle -v
"""

import importlib.util
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.client.test_an_unattributed_run_is_refused_while_a_cycle_is_active import (
    _await_server,
    _call,
    _declare_listener,
    _free_port,
)
from tests.client.test_client_fleet_envelope_census import declare_board, would_resolve

TESTS_CLIENT_DIR = Path(__file__).resolve().parent
REPO_ROOT = TESTS_CLIENT_DIR.parents[1]
GATE_HARNESS_PATH = TESTS_CLIENT_DIR / "test_gate_multi_suite_coverage.py"

# Resolved at import, before the adopted module fixture puts its fake
# toolchains first on PATH: the board must run on the REAL bun.
_REAL_BUN = shutil.which("bun")

# The names the fixture's two suites carry in their stored trees: the bun
# probe file and the python probe's test class.
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
PYTHON_SUITE = _GATE.PYTHON_SUITE
GATE_AGENT = _GATE.AGENT


def setUpModule():
    _GATE.setUpModule()


def tearDownModule():
    _GATE.tearDownModule()


class CycleGateFilesEverySuiteUnderTheCycleTest(_GATE._GateFixtureCase):
    """`bun-crucible.py pre-merge-gate --cycle <id>`, the cycle active on a
    live board, a python-owned suite declared beside the bun one: every
    suite's run is stored under <id>."""

    ORCHESTRATOR = "cycle-gate-fixture-orchestrator"
    PLANTED_CR = "CR-T-CYCLE-GATE-DISPATCH"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._proc = None
        cls._store_dir = tempfile.mkdtemp(prefix="cycle-gate-dispatch-board-")
        if _REAL_BUN is None:
            shutil.rmtree(cls._store_dir, ignore_errors=True)
            raise unittest.SkipTest(
                "an ACTIVE cycle is a property of a REAL store: without `bun` "
                "there is no server to carry one. A missing toolchain, not a "
                "passing assertion.")
        port = _free_port()
        assert port not in (3850, 3849, 39877), (
            f"fixture sanity: the OS handed back a reserved port {port}")
        cls.base = f"http://127.0.0.1:{port}"
        _declare_listener(cls._store_dir, port)
        cls._proc = subprocess.Popen(
            [_REAL_BUN, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ,
                 "CRUCIBLE_DB": os.path.join(cls._store_dir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            cls._seed()
        except BaseException:
            cls._stop_board()
            raise

    @classmethod
    def _seed(cls):
        """One project carrying exactly ONE active cycle."""
        _await_server(cls.base, cls._proc)
        project = _call(cls.base, "/api/v2/projects", {"name": "cycle-gate-dispatch"})
        assert project.get("ok"), f"project creation failed: {project!r}"
        key = project["project"]["key"]
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
        shutil.rmtree(getattr(cls, "_store_dir", ""), ignore_errors=True)
        super().tearDownClass()

    @classmethod
    def _stop_board(cls):
        proc = getattr(cls, "_proc", None)
        if proc is None:
            return
        cls._proc = None
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)

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
            f"dispatched `{PYTHON_SUITE}` must not be refused for carrying no "
            f"cycle. gate envelope={envelope!r} "
            f"stderr={drive.err[-3000:]!r}")
        self.assertTrue(
            envelope.get("ok"),
            f"the gate's own envelope must be ok:true; got {envelope!r}")

        match = re.search(
            rf"dispatching `{re.escape(PYTHON_SUITE)}` to (?P<argv>[^\n]*)", drive.err)
        if match is None:
            self.fail(f"the gate must dispatch `{PYTHON_SUITE}` to its sibling "
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
            f"the dispatched `{PYTHON_SUITE}`); got {len(events)} event(s): "
            f"{[(e.get('id'), e.get('context')) for e in events]!r}")
        for event in bun_runs + python_runs:
            self.assertEqual(
                (event.get("context") or {}).get("cycleId"), self.cycle_id,
                f"every suite a `--cycle {self.cycle_id}` gate runs is stored "
                f"under that cycle; event {event.get('id')} carries "
                f"context={event.get('context')!r}")


if __name__ == "__main__":
    unittest.main()
