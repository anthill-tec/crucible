"""Every client envelope names the board events its invocation filed.

A run is known to the board by the event id the board answers its ingest
with, and an orchestrator reading a client's envelope needs that id to find
the run again (a gate needs it to read a dispatched suite's failing tests). So
every envelope states `events`: the board's event id of each run the
invocation filed, in filing order, and `[]` when it filed none.

The verbs are the fleet's run-filing verbs exactly as the unattributed-run
refusal suite enumerates them (`_filing_verbs`, read off each client's own
argparse — no second list is kept here). Each is driven twice as a real OS
subprocess against a REAL scratch board (`tests/client/real_board.py`): once
over a passing fixture and once over a failing one (the gate-outcome suite's
failing toolchains and fixtures, adopted by name). What the drive filed is
read back from the board and compared with the envelope's `events`.

Three readings, and each guards the others against a vacuous pass:

  * the census: for every verb, on both drives, `events` is present and names
    every test run the drive filed — no more, no fewer, in filing order;
  * the non-vacuity pin: each client's `test` verb files exactly one run on a
    passing AND on a failing drive, and its `events` is exactly that run's id —
    so the census cannot pass on drives that filed nothing;
  * the empty case: a tier verb with no declared target files nothing, and
    its envelope still states `events: []`.

A compile or lint result (`check`, `compile`, `clippy`, a gate's first step)
and an aborted run are events the board stores beside a run; the census
accepts `events` either naming or omitting them, and requires every filed
test run.

Invocation:
    python3 -m unittest tests.client.test_every_run_names_the_board_events_it_filed -v
"""

import shutil
import sys
import unittest

from tests.client.real_board import RealBoard
from tests.client.test_an_unattributed_run_is_refused_while_a_cycle_is_active import (
    _call,
)
from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    drive_verb,
)
from tests.client.test_every_verb_that_files_a_run_is_refused_while_a_cycle_is_active import (
    _filing_verbs,
    _seed,
)
from tests.client.test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close import (
    _PY_TEST_FAIL,
    _PY_TEST_PASS,
    _SUREFIRE_FAIL_ONE_OF_TWO,
    _SUREFIRE_PASS_ONE,
    FAILING_TEST_MARKER,
    _fail_bin_dir_for,
    _write_native_fixture,
)

TOON = _load_toon_module()
OUTCOMES = ("pass", "fail")
RUN_KIND = "test"
ABORTED = "aborted"
# The event kinds a client files beside a run: a compile or lint result.
STEP_KINDS = ("compile",)
TIMEOUT = 180

_BOARD = None
_ACTIVE_CYCLE_PROJECT = None


def setUpModule():
    global _BOARD
    bun = shutil.which("bun")
    if bun is None:
        raise unittest.SkipTest(
            "the event ids an envelope must name are a REAL board's answers: "
            "without `bun` there is no board to answer them")
    _BOARD = RealBoard(bun, "every-run-names-its-events")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


def _accepts(subparser, flag):
    return any(flag in action.option_strings for action in subparser._actions)


def _ids(values):
    return [str(v) for v in values]


class _Drive:
    """One verb's invocation and what it left on the board."""

    def __init__(self, result, emits, axi, filed, argv):
        self.result = result
        self.emits = emits
        self.axi = axi
        self.filed = filed  # every non-lifecycle event the agent filed, oldest first
        self.argv = argv

    @property
    def events(self):
        return self.axi.get("events", None)

    def runs(self):
        """The test runs the drive filed (ingested, not aborted), oldest first."""
        return [e for e in self.filed
                if e.get("kind") == RUN_KIND and e.get("status") != ABORTED]

    def optional(self):
        """Events the board stores beside a run: compile/lint results and
        aborted runs."""
        return [e for e in self.filed
                if e.get("kind") in STEP_KINDS
                or (e.get("kind") == RUN_KIND and e.get("status") == ABORTED)]

    def transcript(self):
        return (f"argv={self.argv!r} exit={self.result.returncode} "
                f"stdout={self.result.stdout.strip()[-1500:]!r} "
                f"stderr={self.result.stderr.strip()[-1500:]!r} "
                f"filed={[(e.get('id'), e.get('kind'), e.get('status')) for e in self.filed]!r}")


_DRIVES = {}


class EveryFilingVerbNamesItsEventsTest(unittest.TestCase):
    """`events` on the envelope of every run-filing verb of all five clients,
    on a passing and on a failing drive."""

    def _board(self):
        if _BOARD is None:
            self.fail("the module's real board was never booted")
        return _BOARD

    # ── the drive ─────────────────────────────────────────────────────────

    def _project(self, client_key, verb, outcome, project_key):
        board = self._board()
        project_dir = _make_project_dir(client_key)
        self.addCleanup(shutil.rmtree, project_dir, True)
        env_lines = [f"CRUCIBLE_PROJECT_KEY={project_key}\n"]
        if client_key == "arduino":
            env_lines.append(f"CRUCIBLE_PROJECT_NAME={board.name}\n")
        (project_dir / ".env").write_text("".join(env_lines))
        extra = _seed(client_key, verb, project_dir)
        if client_key == "python":
            # The refusal suite's seed plants a source that does not compile;
            # these drives run a suite, so the source compiles and the suite
            # itself passes or fails.
            (project_dir / "app" / "broken.py").unlink(missing_ok=True)
            (project_dir / "tests" / "test_gate_fixture.py").write_text(
                _PY_TEST_PASS if outcome == "pass" else _PY_TEST_FAIL)
        if client_key == "arduino" and outcome == "fail":
            _write_native_fixture(project_dir, "fail")
        if client_key == "mvn" and verb == "auto-ingest":
            # The refusal suite seeds no maven report; without one maven's
            # auto-ingest falls back to a compile capture.
            reports = project_dir / "target" / "surefire-reports"
            reports.mkdir(parents=True, exist_ok=True)
            (reports / "TEST-GateFixtureTest.xml").write_text(
                _SUREFIRE_PASS_ONE if outcome == "pass" else _SUREFIRE_FAIL_ONE_OF_TWO)
        return project_dir, extra

    def _bin_dir(self, client_key, outcome):
        bin_dir = (_build_fake_bin_dir() if outcome == "pass"
                   else _fail_bin_dir_for(client_key))
        self.addCleanup(shutil.rmtree, bin_dir, True)
        return bin_dir

    def _register(self, agent_id, project_key):
        board = self._board()
        reg = board.http("/api/v2/agents/register",
                         {"projectKey": project_key, "agentId": agent_id,
                          "role": "report"})
        self.assertTrue(reg.get("ok"), f"registration failed: {reg!r}")

    def _project_with_an_active_cycle(self):
        """A second project on the board, carrying one ACTIVE cycle: there a
        run with no `--cycle` from an unbound agent is refused before its
        runner starts, on every client, so the drive files nothing."""
        global _ACTIVE_CYCLE_PROJECT
        if _ACTIVE_CYCLE_PROJECT is not None:
            return _ACTIVE_CYCLE_PROJECT
        board = self._board()
        project = board.http("/api/v2/projects", {"name": "events-active-cycle"})
        self.assertTrue(project.get("ok"), f"project creation failed: {project!r}")
        key = project["project"]["key"]
        orchestrator = "events-active-cycle-orchestrator"
        reg = board.http("/api/v2/agents/register",
                         {"projectKey": key, "agentId": orchestrator,
                          "role": "ORCHESTRATOR"})
        self.assertTrue(reg.get("ok"), f"orchestrator registration failed: {reg!r}")
        filed = board.http(f"/api/v2/projects/{key}/plans",
                           {"cr": "events-active-cycle-plan",
                            "cycles": [{"label": "solo"}],
                            "agentId": orchestrator})
        self.assertTrue(filed.get("ok"), f"plan-file failed: {filed!r}")
        cycle_id = filed["cycles"][0]["id"]
        active = _call(
            board.base,
            f"/api/v2/projects/{key}/plans/{filed['planId']}/cycles/{cycle_id}",
            {"status": "active", "agentId": orchestrator}, method="PATCH")
        self.assertTrue(active.get("ok"), f"cycle activation failed: {active!r}")
        _ACTIVE_CYCLE_PROJECT = key
        return key

    def _filed_by(self, agent_id, project_key):
        board = self._board()
        read = board.http(f"/api/v2/events?project={project_key}&limit=500")
        self.assertTrue(read.get("ok"), f"events read failed: {read!r}")
        mine = [e for e in (read.get("events") or [])
                if e.get("agentId") == agent_id
                and e.get("kind") in (RUN_KIND,) + STEP_KINDS]
        # The list answers newest first; filing order is oldest first.
        mine.reverse()
        return sorted(mine, key=lambda e: e.get("timestamp") or 0)

    def drive(self, client_key, verb, outcome, *, refused=False):
        cache_key = (client_key, verb, outcome, refused)
        if cache_key in _DRIVES:
            return _DRIVES[cache_key]
        agent_id = f"events-{outcome}-{client_key}-{verb}" + ("-refused" if refused else "")
        project_key = (self._project_with_an_active_cycle() if refused
                       else self._board().key)
        project_dir, seeded = self._project(client_key, verb, outcome, project_key)
        bin_dir = self._bin_dir(client_key, outcome)
        subparser = _filing_verbs(client_key)[verb]
        census = build_argv(verb, subparser, project_dir)[1:]
        positionals = sum(1 for a in subparser._actions if not a.option_strings)
        census = census[:len(census) - positionals]
        census[census.index("--agent") + 1] = agent_id
        extra = []
        if _accepts(subparser, "--min-free-g"):
            extra += ["--min-free-g", "1"]
        argv = [verb] + seeded + extra + census
        self._register(agent_id, project_key)
        result = drive_verb(
            CLIENT_FILES[client_key], argv, project_dir, bin_dir,
            timeout=TIMEOUT, board=self._board().base,
            extra_env={"PY_CRUCIBLE_PYTHON": sys.executable})
        emits, axi = classify_envelope(result.stdout, TOON)
        drive = _Drive(result, emits, axi or {},
                       self._filed_by(agent_id, project_key), argv)
        _DRIVES[cache_key] = drive
        return drive

    # ── the readings ──────────────────────────────────────────────────────

    def assertEventsNameTheFiledRuns(self, drive, where):
        self.assertTrue(drive.emits, f"{where}: no envelope; {drive.transcript()}")
        self.assertIn(
            "events", drive.axi,
            f"{where}: the envelope states no `events` — the ids of the runs "
            f"this invocation filed ({_ids(e['id'] for e in drive.runs())}) "
            f"are not named; envelope={drive.axi!r}")
        events = drive.events
        self.assertIsInstance(events, list,
                              f"{where}: `events` is a list; got {events!r}")
        events = _ids(events)
        runs = _ids(e["id"] for e in drive.runs())
        allowed = set(runs) | set(_ids(e["id"] for e in drive.optional()))
        self.assertEqual(
            len(events), len(set(events)),
            f"{where}: each filed event is named once; events={events!r}")
        missing = [i for i in runs if i not in events]
        self.assertEqual(
            missing, [],
            f"{where}: `events` must name every run the invocation filed; "
            f"missing {missing!r} from events={events!r}; {drive.transcript()}")
        foreign = [i for i in events if i not in allowed]
        self.assertEqual(
            foreign, [],
            f"{where}: `events` names ids this invocation never filed: "
            f"{foreign!r}; {drive.transcript()}")
        order = [e["id"] for e in drive.filed if str(e["id"]) in events]
        self.assertEqual(
            events, _ids(order),
            f"{where}: `events` is in filing order; {drive.transcript()}")

    def test_every_filing_verb_names_the_events_it_filed_on_a_passing_and_a_failing_run(self):
        for client_key in sorted(CLIENT_FILES):
            for verb in sorted(_filing_verbs(client_key)):
                for outcome in OUTCOMES:
                    with self.subTest(client=client_key, verb=verb, outcome=outcome):
                        drive = self.drive(client_key, verb, outcome)
                        self.assertEventsNameTheFiledRuns(
                            drive, f"{client_key} {verb} ({outcome})")

    def test_each_clients_test_verb_names_the_one_run_it_filed_passing_and_failing(self):
        for client_key in sorted(CLIENT_FILES):
            for outcome in OUTCOMES:
                with self.subTest(client=client_key, outcome=outcome):
                    drive = self.drive(client_key, "test", outcome)
                    runs = drive.runs()
                    self.assertEqual(
                        len(runs), 1,
                        f"{client_key} test ({outcome}): the fixture files "
                        f"exactly one run, or this pin proves nothing; "
                        f"{drive.transcript()}")
                    if len(runs) != 1:
                        continue
                    run = runs[0]
                    stored = self._board().event(str(run["id"]))
                    expected_failed = 0 if outcome == "pass" else 1
                    self.assertEqual(
                        (stored.get("summary") or {}).get("failed"),
                        expected_failed,
                        f"{client_key} test ({outcome}): the stored run carries "
                        f"{expected_failed} failure(s); run={run!r}")
                    self.assertEqual(
                        _ids(drive.events or []) if isinstance(drive.events, list)
                        else drive.events,
                        [str(run["id"])],
                        f"{client_key} test ({outcome}): `events` names exactly "
                        f"the id the board answered for the one run filed "
                        f"({run['id']!r}); envelope={drive.axi!r}")

    def test_a_failing_drive_names_the_failing_run_and_not_another(self):
        """The failing `test` drive's one named event is the run carrying the
        real failing test, read back by its id."""
        board = self._board()
        for client_key in sorted(CLIENT_FILES):
            with self.subTest(client=client_key):
                drive = self.drive(client_key, "test", "fail")
                events = drive.events
                self.assertIsInstance(
                    events, list,
                    f"{client_key} test (fail): `events` is a list; "
                    f"envelope={drive.axi!r}")
                if not isinstance(events, list):
                    continue
                self.assertEqual(len(events), 1,
                                 f"{client_key}: events={events!r}")
                stored = board.event(str(events[0]))
                self.assertIn(
                    FAILING_TEST_MARKER, repr(stored.get("tree")),
                    f"{client_key}: the named event is the failing run; "
                    f"stored={stored!r}")

    def test_a_verb_that_filed_nothing_states_an_empty_events_list(self):
        """`test` with no `--cycle`, from an unbound agent, while the project
        has an active cycle: refused before its runner starts, so it files
        nothing — and its envelope still states `events: []`."""
        for client_key in sorted(CLIENT_FILES):
            with self.subTest(client=client_key):
                drive = self.drive(client_key, "test", "pass", refused=True)
                self.assertNotEqual(
                    drive.result.returncode, 0,
                    f"{client_key} test: refused while a cycle is active, or "
                    f"this case proves nothing; {drive.transcript()}")
                self.assertEqual(
                    drive.filed, [],
                    f"{client_key} test: a refused run files nothing, "
                    f"or this case proves nothing; {drive.transcript()}")
                self.assertTrue(drive.emits,
                                f"{client_key}: no envelope; {drive.transcript()}")
                self.assertIn(
                    "events", drive.axi,
                    f"{client_key} test (refused): a verb that filed nothing still states "
                    f"`events`; envelope={drive.axi!r}")
                self.assertEqual(
                    drive.events, [],
                    f"{client_key} test (refused): filed nothing, so `events: []`; "
                    f"envelope={drive.axi!r}")


if __name__ == "__main__":
    unittest.main()
