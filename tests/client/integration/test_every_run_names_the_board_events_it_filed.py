"""Every client envelope names the board events its invocation filed.

A run is known to the board by the event id the board answers its ingest
with, and an orchestrator reading a client's envelope needs that id to find
the run again (a gate needs it to read a dispatched suite's failing tests). So
every envelope states `events`: the board's event id of each run the
invocation filed, in filing order, and `[]` when it filed none.

The verbs are the fleet's run-filing verbs exactly as the unattributed-run
refusal suite enumerates them (`_filing_verbs`, read off each client's own
argparse — no second list is kept here). Each is driven twice as a real OS
subprocess against a fake board (`RecordingBoard`, one per drive): once over
a passing fixture and once over a failing one (the gate-outcome suite's
failing toolchains and fixtures, adopted by name). The fake answers every
ingest the way the board does — `ok` with a store-shaped event id
(`mint_event_id`), a fresh one for each ingest — and what the drive filed is
read off its request log (each ingest and the id it was answered with) and
compared with the envelope's `events`.

That the board stores each ingest as an event, under its id, holding the
counts and tree the client sent, is the server's half, held in bun by
`v2-runs-events.test.ts` ("junit data w/ 1 failing case → 200 {…event:'evt-…'
…}" and the newest-first events list). What this suite keeps is the client's
half: the ids it names are the ids it was answered, and the run it names on a
failing drive is the one it sent the failing test in.

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
    python3 -m unittest tests.client.integration.test_every_run_names_the_board_events_it_filed -v
"""

import shutil
import sys
import unittest
import uuid

from tests.client.client_fleet_envelope_census_helpers import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    drive_verb,
)
from tests.client.every_cycle_help_line_describes_its_own_verb_helpers import (
    TIERS,
    _answer_go_tier_lists,
)
from tests.client.every_verb_that_files_a_run_is_refused_while_a_cycle_is_active_helpers import (
    _filing_verbs,
    _seed,
)
from tests.client.live_run_harness import START, RecordingBoard
from tests.client.the_gate_records_its_outcome_and_a_red_gate_stops_the_close_helpers import (
    _PY_TEST_FAIL,
    _PY_TEST_PASS,
    _SUREFIRE_FAIL_ONE_OF_TWO,
    _SUREFIRE_PASS_ONE,
    FAILING_TEST_MARKER,
    _fail_bin_dir_for,
    _failing_tests_sent,
    _write_native_fixture,
)

TOON = _load_toon_module()
OUTCOMES = ("pass", "fail")
RUN_KIND = "test"
ABORTED = "aborted"
# The event kinds a client files beside a run: a compile or lint result.
STEP_KINDS = ("compile",)
TIMEOUT = 180
PROJECT_NAME = "every-run-names-its-events"

#: The ingest routes, and the kind of event the board files for each
#: (`RUN_INGEST_PATHS`/`COMPILE_INGEST_PATH`, clients/_crucible_axi.py).
INGEST_KINDS = {"/api/v2/runs": RUN_KIND, "/api/v2/runs/parsed": RUN_KIND,
                "/api/v2/runs/compile": "compile"}
#: How many ingests of one route a drive's board answers with an id of its
#: own; past that it answers the board's default (no id), which the census
#: would report as an ingest the envelope cannot name.
IDS_PER_ROUTE = 24


def _script_event_ids(board):
    """Answer each ingest route's next `IDS_PER_ROUTE` posts, in order, each
    with a fresh store-shaped event id; returns `{path: [id, ...]}` in the
    order they are given out."""
    ids = {}
    for path, kind in INGEST_KINDS.items():
        ids[path] = [board.mint_event_id() for _ in range(IDS_PER_ROUTE)]
        # The newest answer set is given first: set them last-to-first.
        for event_id in reversed(ids[path]):
            body = {"ok": True, "changed": True, "event": event_id}
            if kind == RUN_KIND:
                body["run"] = {"total": 0, "passed": 0, "failed": 0}
            board.answer("POST", path, body, times=1)
    return ids


def _filed_from_the_log(board, ids):
    """Every ingest the drive posted, in filing order, as the event the
    board answered it with: `{id, kind, status, tier, sent}`, `sent` being
    everything the client sent for it (the ingest's body and, for a run it
    opened, its start and every post of that run: its stream and its test
    list), and `tier` the tier it was filed under (the ingest's, else its
    start's)."""
    posts = board.posts()
    # The fake opens `run-live-<n>` for the n-th start it answers.
    starts = {f"run-live-{n}": body for n, body in enumerate(
        (b for p, b in posts if p == START), start=1)}
    aborted = {p.split("/")[4] for p, _ in posts
               if p.startswith("/api/v2/runs/") and p.endswith("/abort")}
    given = {path: iter(values) for path, values in ids.items()}
    filed = []
    for path, body in posts:
        if path not in INGEST_KINDS:
            continue
        body = body if isinstance(body, dict) else {}
        run_id = body.get("runId")
        start = starts.get(str(run_id)) or {}
        sent = [start, body] + ([b for p, b in posts
                                 if p.startswith(f"/api/v2/runs/{run_id}/")]
                                if run_id else [])
        filed.append({"id": next(given[path], None), "kind": INGEST_KINDS[path],
                      "status": ABORTED if run_id in aborted else None,
                      "tier": body.get("tier") or start.get("tier"),
                      "sent": repr(sent),
                      "failing": _failing_tests_sent(sent)})
    return filed


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

    # ── the drive ─────────────────────────────────────────────────────────

    def _project(self, client_key, verb, outcome, project_key):
        project_dir = _make_project_dir(client_key)
        self.addCleanup(shutil.rmtree, project_dir, True)
        env_lines = [f"CRUCIBLE_PROJECT_KEY={project_key}\n"]
        if client_key == "arduino":
            env_lines.append(f"CRUCIBLE_PROJECT_NAME={PROJECT_NAME}\n")
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

    @staticmethod
    def _script_the_project(board, project_key, agent_id, refused):
        """The board's answers about the project the drive files under: the
        agent registered (role `report`, bound to no cycle), and — for a
        refused drive — one open plan whose cycle is ACTIVE, the state in
        which a run with no `--cycle` from an unbound agent is refused before
        its runner starts, on every client, so the drive files nothing."""
        board.answer("GET", "/api/v2/agents?project=",
                     {"ok": True, "agents": [
                         {"agentId": agent_id, "projectKey": project_key,
                          "role": "report", "status": "online"}]},
                     prefix=True)
        if refused:
            board.answer(
                "GET", f"/api/v2/projects/{project_key}/plans?status=open",
                {"ok": True, "plans": [
                    {"planId": 1, "projectKey": project_key,
                     "cr": "events-active-cycle-plan", "status": "open",
                     "cycles": [{"id": 1, "label": "solo", "kind": "red-green",
                                 "status": "active"}]}],
                 "lastClosedCr": None, "filed": 1})

    def drive(self, client_key, verb, outcome, *, refused=False):
        cache_key = (client_key, verb, outcome, refused)
        if cache_key in _DRIVES:
            return _DRIVES[cache_key]
        agent_id = f"events-{outcome}-{client_key}-{verb}" + ("-refused" if refused else "")
        project_key = str(uuid.uuid4())
        project_dir, seeded = self._project(client_key, verb, outcome, project_key)
        bin_dir = self._bin_dir(client_key, outcome)
        if client_key == "go" and verb in TIERS:
            # go reads a tier off `go list` and runs it with a tagged
            # `go test -run`, which the fake `go` does not run as asked: a
            # go tier drive gets the front end the cycle-help census uses,
            # its tagged run passing or failing with this drive's outcome.
            _answer_go_tier_lists(bin_dir, outcome)
        subparser = _filing_verbs(client_key)[verb]
        census = build_argv(verb, subparser, project_dir)[1:]
        positionals = sum(1 for a in subparser._actions if not a.option_strings)
        census = census[:len(census) - positionals]
        census[census.index("--agent") + 1] = agent_id
        extra = []
        if _accepts(subparser, "--min-free-g"):
            extra += ["--min-free-g", "1"]
        argv = [verb] + seeded + extra + census
        board = RecordingBoard()
        try:
            self._script_the_project(board, project_key, agent_id, refused)
            ids = _script_event_ids(board)
            result = drive_verb(
                CLIENT_FILES[client_key], argv, project_dir, bin_dir,
                timeout=TIMEOUT, board=board.url,
                extra_env={"PY_CRUCIBLE_PYTHON": sys.executable})
            filed = _filed_from_the_log(board, ids)
        finally:
            board.close()
        emits, axi = classify_envelope(result.stdout, TOON)
        drive = _Drive(result, emits, axi or {}, filed, argv)
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
                    expected_failed = 0 if outcome == "pass" else 1
                    self.assertEqual(
                        len(run["failing"]), expected_failed,
                        f"{client_key} test ({outcome}): the run the client "
                        f"sent reports {expected_failed} failing test(s); "
                        f"failing={run['failing']!r} "
                        f"sent={run['sent'][-1500:]!r}")
                    self.assertEqual(
                        _ids(drive.events or []) if isinstance(drive.events, list)
                        else drive.events,
                        [str(run["id"])],
                        f"{client_key} test ({outcome}): `events` names exactly "
                        f"the id the board answered for the one run filed "
                        f"({run['id']!r}); envelope={drive.axi!r}")

    def test_each_go_tier_verb_names_the_one_run_it_filed_under_its_tier(self):
        """go's tier verbs read their declaration off `go list`: a drive
        whose `go list` failed would file nothing and pass the census above
        on an empty `events`. Each go tier verb in the census files exactly
        one run, under its own tier, and names exactly that run."""
        tiers = sorted(set(_filing_verbs("go")) & set(TIERS))
        self.assertTrue(tiers, "go files a run from at least one tier verb")
        for verb in tiers:
            for outcome in OUTCOMES:
                with self.subTest(verb=verb, outcome=outcome):
                    drive = self.drive("go", verb, outcome)
                    runs = drive.runs()
                    self.assertEqual(
                        len(runs), 1,
                        f"go {verb} ({outcome}): the declared tier files "
                        f"exactly one run; {drive.transcript()}")
                    if len(runs) != 1:
                        continue
                    self.assertEqual(
                        runs[0]["tier"], verb,
                        f"go {verb} ({outcome}): the run is filed under its "
                        f"verb's tier; sent={runs[0]['sent'][-1500:]!r}")
                    self.assertEqual(
                        len(runs[0]["failing"]), 0 if outcome == "pass" else 1,
                        f"go {verb} ({outcome}): failing={runs[0]['failing']!r} "
                        f"sent={runs[0]['sent'][-1500:]!r}")
                    self.assertEqual(
                        _ids(drive.events or []), [str(runs[0]["id"])],
                        f"go {verb} ({outcome}): `events` names exactly the "
                        f"one run filed; envelope={drive.axi!r}")

    def test_a_failing_drive_names_the_failing_run_and_not_another(self):
        """The failing `test` drive's one named event is the run carrying the
        real failing test: the ingest the board answered with that id is the
        one the client sent the failing test in."""
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
                named = [e for e in drive.filed if str(e["id"]) == str(events[0])]
                self.assertEqual(len(named), 1,
                                 f"{client_key}: the named event is one the "
                                 f"board answered; {drive.transcript()}")
                if len(named) != 1:
                    continue
                self.assertIn(
                    FAILING_TEST_MARKER, repr(named[0]["failing"]),
                    f"{client_key}: the named event is the failing run; "
                    f"failing={named[0]['failing']!r} "
                    f"sent={named[0]['sent'][-1500:]!r}")

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
