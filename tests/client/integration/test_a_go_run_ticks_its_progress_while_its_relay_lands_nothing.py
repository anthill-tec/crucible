"""A go run ticks `running N[/M]` while its relay lands no batch.

Every streamed run's in-run ticks come from its stream, through the shared
stream reading (`_counted_event`), and are posted through the tick sender its
client hands `start_stream_relay`. The go client hands the shared
`narration_poster(_post, key, agent, identity)`, with the run's listed total
(`go test -list`) as `listed_total`. So:

  - a `test` run whose relay is answered 503 throughout posts `running N/M`
    while `go test -json` is still running: N the top-level results so far
    (a subtest never counts), M the listed total;
  - a run whose listing failed posts `running N`, with no M;
  - a run whose relay lands every batch posts no in-run tick;
  - `regression` over two modules, a declared tier verb (`integration`), and
    the gate's per-tier suite each tick through the same sender;
  - under a gated run, the tick poster carries the bracket's identity, which
    observes each tick's response: a tick whose answer says it created the
    agent row makes the row this run's to remove at its close.

Each test drives the REAL go client as an OS subprocess, with the real `go`
behind the recording shim of `go_client_harness`, against a stand-in board.
The fixture modules (`tests/fixtures/go-client/ticking*`) hold 19 top-level
tests with two gates: before each gate test the go test binary writes the file
`TICK_PARKED_<n>` names and waits for the file `TICK_RELEASE_<n>` names, so a
test reads the board while `go test` is still running, never by timing luck.
Parked at the second gate, 16 top-level tests have a result; the run's
subtests (3) would push a count that read them past 16.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_go_run_ticks_its_progress_while_its_relay_lands_nothing
"""

import subprocess
import time
import unittest
from pathlib import Path
from typing import Any

from tests.client.client_cadence_settings import SHORT_RELAY, launcher_command
from tests.client.go_client_harness import (
    AGENT,
    GO_CLIENT,
    PROJECT_KEY,
    START,
    TIMEOUT,
    GoProject,
    go_events,
    go_toolchain_gap,
)
from tests.client.go_gate_harness import GATE_VERB, GoGateBoard
from tests.client.live_run_harness import RecordingBoard, install_project

HEARTBEAT = "/api/v2/agents/heartbeat"
UNREGISTER = "/api/v2/agents/unregister"
STREAM_SUFFIX = "/stream"

REFUSAL = "GO_STREAM_UNAVAILABLE_FROM_THE_FIXTURE_BOARD"
# The status every stream batch is answered with on a board that never lands
# one (typed loosely: the base board's own answers are narrower literals).
UNAVAILABLE: Any = 503
# The status a scripted heartbeat answer is sent with (typed loosely for the
# same reason).
ANSWERED: Any = 200

#: The fixtures' design: 19 top-level tests; 3 before the first gate (so 4
#: have a result once it is released); 16 with a result while parked at the
#: second gate.
LISTED = 19
BEFORE_FIRST_GATE = 3
AT_SECOND_GATE = 16

#: How long a go build plus the tests before a gate may take to park.
PARK_WAIT = 120
#: Every drive runs the client through the test-only launcher with the relay
#: and stream tick and the narrator throttle at 0.2 s (`SHORT_RELAY`), a
#: tenth of production's 2 s; the waits below are scaled with them.
#: The relay sends every 0.2 s: its first answer lands well inside this.
RELAY_WAIT = 3.0
#: How long a parked run waits for an in-run tick to reach the board.
TICK_WAIT = 4.0
#: Five of the narrator's 0.2 s wakes: a tick that is going to be posted
#: while the run is parked is posted inside it.
QUIET_WAIT = 1.0


def _wait_until(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return bool(predicate())


def in_run_ticks(board):
    """`[(wire index, N, M)]` of every heartbeat whose message is an in-run
    tick, `running N` or `running N/M` (M None without one; N None when the
    message carries no count)."""
    found = []
    for i, (path, body) in enumerate(board.posts()):
        message = str(body.get("message") or "") if isinstance(body, dict) else ""
        if path != HEARTBEAT or not message.startswith("running "):
            continue
        count = message[len("running "):].split(" ", 1)[0]
        done, _slash, total = count.partition("/")
        found.append((i, int(done) if done.isdigit() else None,
                      int(total) if total.isdigit() else None))
    return found


def top_level_results(text):
    return [e for e in go_events(text)
            if e.get("Action") in ("pass", "fail", "skip")
            and e.get("Test") and "/" not in e["Test"]]


class StreamUnavailableBoard(RecordingBoard):
    """A `RecordingBoard` whose stream route answers every batch 503: a board
    that is up but never lands a batch."""

    def _append_stream(self, run_id, body):
        return UNAVAILABLE, {"ok": False, "error": REFUSAL, "held": 0}


class StreamUnavailableGateBoard(GoGateBoard):
    """`GoGateBoard` (a gate's milestone and suites) whose stream route answers
    every batch 503."""

    def _append_stream(self, run_id, body):
        return UNAVAILABLE, {"ok": False, "error": REFUSAL, "held": 0}


class TicksCreateTheAgentRowBoard(StreamUnavailableBoard):
    """A stream-unavailable board that answers the gated run's opening
    heartbeat `changed: false` (the row pre-existed: the caller's) and every
    in-run tick `changed: true` (the tick re-created a pruned row)."""

    def _caller_refusal(self, path, body):
        if path == HEARTBEAT and isinstance(body, dict):
            message = str(body.get("message") or "")
            answer: Any = (ANSWERED, {"ok": True,
                                      "changed": message.startswith("running ")})
            return answer
        return super()._caller_refusal(path, body)


class Drive:
    def __init__(self, returncode, stdout, stderr, cues, seen):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.cues = cues
        self.seen = seen

    def diag(self):
        return (f"cues={self.cues!r} exit={self.returncode} "
                f"stdout={self.stdout[-1500:]!r} stderr={self.stderr[-3000:]!r}")


class _GoTickCase(unittest.TestCase):
    maxDiff = 8000

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")

    def project(self, fixture, board):
        p = GoProject(self, fixture=fixture)
        p.board.close()
        p.board = board
        self.addCleanup(board.close)
        install_project(p.dir, board.url, PROJECT_KEY)
        return p

    def drive_gated(self, p, verb, gates, *argv, **extra):
        """Run the client's `verb` with the go tests parking at each gate of
        `gates`, a list of `step(said)`: parked at gate n, the test calls the
        nth step (`said()` reads the client's stderr so far), which answers
        whether what it waits for was reached, and then releases the gate.
        Each gate also records the in-run ticks on the board when its step
        returned."""
        scratch = Path(p.calls_path).parent
        stderr_path = scratch / "client-stderr.txt"
        plan = [(scratch / f"parked-{n}", scratch / f"release-{n}", step)
                for n, step in enumerate(gates, start=1)]
        env = dict(extra)
        for n, (parked, release, _step) in enumerate(plan, start=1):
            env[f"TICK_PARKED_{n}"] = str(parked)
            env[f"TICK_RELEASE_{n}"] = str(release)
        cmd = launcher_command(GO_CLIENT, verb, *argv, "--agent", AGENT,
                               "--project-dir", p.dir, **SHORT_RELAY)

        def said():
            try:
                return stderr_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                return ""

        cues, seen = [], []
        with open(stderr_path, "w", encoding="utf-8") as err:
            proc = subprocess.Popen(cmd, cwd=p.dir, env=p.env(**env),
                                    stdout=subprocess.PIPE, stderr=err, text=True)
            try:
                for parked, release, step in plan:
                    reached = _wait_until(
                        lambda pk=parked: pk.exists() or proc.poll() is not None,
                        PARK_WAIT) and parked.exists()
                    cues.append(bool(reached and step(said)))
                    seen.append(in_run_ticks(p.board))
                    release.write_text("go", encoding="utf-8")
                stdout, _ = proc.communicate(timeout=TIMEOUT)
            finally:
                for _parked, release, _step in plan:
                    release.write_text("go", encoding="utf-8")
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        return Drive(proc.returncode, stdout, said(), cues, seen)

    # ── the steps a gate waits on ──────────────────────────────────────────
    def heard_a_503_for_each_open_run(self, p):
        """The relay of every run opened so far has had a 503 and taken it in
        (it says the failure, naming the board's error, once per relay)."""
        def step(said):
            return _wait_until(
                lambda: said().count(REFUSAL) >= max(1, len(self.starts(p))), RELAY_WAIT)
        return step

    def a_tick_reached_the_board(self, p):
        def step(_said):
            return _wait_until(lambda: bool(in_run_ticks(p.board)), TICK_WAIT)
        return step

    def starts(self, p):
        return [b for path, b in p.board.posts() if path == START]

    # ── what the ticks say ─────────────────────────────────────────────────
    def assert_parked_ticks(self, drive, listed, board):
        """At the second gate, at least one in-run tick reached the board,
        and each counts the top-level results so far (none before the first
        gate was released, at most the 16 written by the second) over
        `listed` (None: no M)."""
        self.assertEqual(len(drive.cues), 2, drive.diag())
        self.assertTrue(drive.cues[0],
                        f"parked at the first gate, the relay heard a 503; {drive.diag()}")
        self.assertTrue(
            drive.cues[1],
            f"parked at the second gate, with every batch answered 503, an in-run "
            f"`running N{'' if listed is None else f'/{listed}'}` tick reached the "
            f"board; heartbeats={board.messages()!r}; {drive.diag()}")
        ticks = drive.seen[1]
        self.assertEqual(
            [t for t in ticks if t[1] is None
             or not BEFORE_FIRST_GATE < t[1] <= AT_SECOND_GATE or t[2] != listed],
            [], f"each tick counts the top-level results so far "
                f"({BEFORE_FIRST_GATE + 1}..{AT_SECOND_GATE}, never a subtest) over "
                f"{listed!r}; ticks={ticks!r}")


class AGoTestRunTicksWhileItsRelayLandsNothingTest(_GoTickCase):

    def test_a_test_run_answered_503_throughout_ticks_running_n_over_its_listed_total(self):
        p = self.project("ticking", StreamUnavailableBoard())
        drive = self.drive_gated(p, "test", [self.heard_a_503_for_each_open_run(p),
                                             self.a_tick_reached_the_board(p)])
        starts = self.starts(p)
        self.assertEqual([s.get("total") for s in starts], [LISTED],
                         f"one run, opened on the listed total; {drive.diag()}")
        self.assert_parked_ticks(drive, LISTED, p.board)
        self.assertEqual(p.board.held_stream("run-live-1"), "",
                         "the board never held a batch: the relay was never landing")
        ticks = in_run_ticks(p.board)
        self.assertEqual([t for t in ticks if t[2] != LISTED or not 1 <= (t[1] or 0) <= LISTED],
                         [], f"every tick of the run is over {LISTED}; ticks={ticks!r}")
        tick_bodies = [b for path, b in p.board.posts() if path == HEARTBEAT
                       and str((b or {}).get("message") or "").startswith("running ")]
        self.assertEqual(
            [(b.get("agentId"), b.get("projectKey"), "cycleId" in b) for b in tick_bodies],
            [(AGENT, PROJECT_KEY, False)] * len(tick_bodies),
            "each tick is the run agent's role-optional heartbeat, re-declaring no cycle")
        self.assertEqual(drive.returncode, 0, drive.diag())

    def test_a_run_whose_listing_failed_ticks_running_n_with_no_total(self):
        p = self.project("ticking", StreamUnavailableBoard())
        drive = self.drive_gated(p, "test", [self.heard_a_503_for_each_open_run(p),
                                             self.a_tick_reached_the_board(p)],
                                 GO_SHIM_UNREADABLE_LIST="1")
        starts = self.starts(p)
        self.assertEqual([s.get("total") for s in starts], [None],
                         f"the listing failed: the run states no total; {drive.diag()}")
        self.assert_parked_ticks(drive, None, p.board)

    def test_a_run_whose_relay_lands_every_batch_posts_no_in_run_tick(self):
        p = self.project("ticking", RecordingBoard())

        def held_at_least(count):
            def step(_said):
                return _wait_until(
                    lambda: len(top_level_results(p.board.held_stream("run-live-1"))) >= count,
                    RELAY_WAIT)
            return step

        def held_and_quiet(said):
            held = held_at_least(AT_SECOND_GATE)(said)
            ticked = _wait_until(lambda: bool(in_run_ticks(p.board)), QUIET_WAIT)
            return held and not ticked

        drive = self.drive_gated(p, "test", [held_at_least(BEFORE_FIRST_GATE), held_and_quiet])
        self.assertEqual(drive.cues, [True, True],
                         f"the board held each stretch of the stream, and no tick was "
                         f"posted while the run was parked; "
                         f"heartbeats={p.board.messages()!r}; {drive.diag()}")
        self.assertEqual(len(top_level_results(p.board.held_stream("run-live-1"))), LISTED,
                         "the whole stream landed")
        self.assertEqual(in_run_ticks(p.board), [],
                         f"no in-run tick while the relay lands every batch; "
                         f"heartbeats={p.board.messages()!r}")
        self.assertEqual(drive.returncode, 0, drive.diag())


class EveryStreamingGoVerbTicksTest(_GoTickCase):
    """`regression` over two modules, a declared tier verb and the gate's
    per-tier suite: each a `_go_test_run`, each ticking."""

    def test_regression_over_two_modules_ticks_one_count_over_both_listed_totals(self):
        p = self.project("ticking-two-modules", StreamUnavailableBoard())
        drive = self.drive_gated(p, "regression", [self.heard_a_503_for_each_open_run(p),
                                                   self.a_tick_reached_the_board(p)])
        starts = self.starts(p)
        self.assertEqual([(s.get("tier"), s.get("total")) for s in starts],
                         [("regression", LISTED)],
                         f"one regression run over both modules' 4 + 15 tests; {drive.diag()}")
        self.assert_parked_ticks(drive, LISTED, p.board)

    def test_a_declared_tier_verb_ticks_over_the_tiers_total(self):
        p = self.project("ticking-tier", StreamUnavailableBoard())
        drive = self.drive_gated(p, "integration", [self.heard_a_503_for_each_open_run(p),
                                                    self.a_tick_reached_the_board(p)])
        starts = self.starts(p)
        self.assertEqual([(s.get("tier"), s.get("total")) for s in starts],
                         [("integration", LISTED)],
                         f"one integration run of the tier's 19 tests; {drive.diag()}")
        self.assert_parked_ticks(drive, LISTED, p.board)

    def test_the_gates_per_tier_suite_ticks_over_the_tiers_total(self):
        p = self.project("ticking-tier", StreamUnavailableGateBoard())
        drive = self.drive_gated(p, GATE_VERB, [self.heard_a_503_for_each_open_run(p),
                                                self.a_tick_reached_the_board(p)])
        starts = self.starts(p)
        self.assertEqual([(s.get("tier"), s.get("total")) for s in starts],
                         [("regression", 1), ("integration", LISTED)],
                         f"the gate's whole run, then its integration suite; {drive.diag()}")
        self.assert_parked_ticks(drive, LISTED, p.board)
        integration_opened = next(i for i, (path, b) in enumerate(p.board.posts())
                                  if path == START and b.get("tier") == "integration")
        self.assertEqual([t for t in drive.seen[1] if t[0] < integration_opened], [],
                         f"the ticks seen while parked are the integration suite's; "
                         f"ticks={drive.seen[1]!r}")


class AGatedGoRunsTicksAreObservedByItsIdentityTest(_GoTickCase):

    def test_a_tick_that_created_the_agent_row_makes_the_row_the_runs_to_remove(self):
        p = self.project("ticking", TicksCreateTheAgentRowBoard())
        drive = self.drive_gated(p, "test", [self.heard_a_503_for_each_open_run(p),
                                             self.a_tick_reached_the_board(p)])
        self.assertTrue(drive.cues[1:] == [True],
                        f"a tick reached the board while the run was parked; "
                        f"heartbeats={p.board.messages()!r}; {drive.diag()}")
        heartbeats = [str((b or {}).get("message")) for path, b in p.board.posts()
                      if path == HEARTBEAT]
        self.assertEqual(heartbeats[:1], ["gated test run starting"],
                         "the gated bracket's opening heartbeat comes first, answered "
                         "`changed: false`: the row is the caller's")
        removals = [b for path, b in p.board.posts() if path == UNREGISTER]
        self.assertEqual(
            [(b.get("agentId"), b.get("projectKey"), b.get("silent")) for b in removals],
            [(AGENT, PROJECT_KEY, True)],
            f"the bracket's identity observed a tick's `changed: true`, so the run "
            f"removes the row it created, silently, once; {drive.diag()}")
        last_tick = max(i for i, (path, b) in enumerate(p.board.posts()) if path == HEARTBEAT
                        and str((b or {}).get("message") or "").startswith("running "))
        removal_at = next(i for i, (path, _b) in enumerate(p.board.posts())
                          if path == UNREGISTER)
        self.assertLess(last_tick, removal_at, "the removal follows the run's ticks")
        self.assertIn(f"cleanup: ok=True agent={AGENT}", drive.stderr,
                      "the close says the removal it made")
        self.assertNotIn(f"cleanup: skipped agent={AGENT}", drive.stderr,
                         "the close does not read the row as the caller's")


if __name__ == "__main__":
    unittest.main()
