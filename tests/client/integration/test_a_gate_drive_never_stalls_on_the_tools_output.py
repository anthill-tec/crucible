"""A gate drive never stalls on the tool's own output.

`gate-run` and `gate-respond` launch `no-mistakes axi run` / `axi respond`
and poll `axi status` while the run is in flight (`drive_axi_run` and
`stream_axi_ladder`, shared by every client). Whatever the tool prints --
a final snapshot of any size on stdout, any amount of noise on stderr -- must
never block it: the drive returns on its own, seals what the snapshot states,
relays the snapshot to the caller's stdout once and verbatim, and drops the
tool's stderr as it always has.

Integration tier: each test spawns the installed python client
(`drive_verb`, under `scrubbed_env`) against a fake `no-mistakes` in a
scratch bin directory and a `RecordingBoard` that records every request. One
client is enough, because the drive is shared. Every spawn runs under a
`SPAWN_TIMEOUT_S` subprocess timeout: a drive that stalls fails its test on
that bound and never hangs the suite, and the fake it leaves behind is
reaped in `tearDown` through the pid it wrote.

Invocation:
    python3 -m unittest tests.client.integration.test_a_gate_drive_never_stalls_on_the_tools_output -v
"""

import os
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from tests.client.a_gate_is_running_only_while_its_run_is_driven_or_held_helpers import (
    GATE_DECISIONS_PATH,
    GATES_PATH,
    _fixture,
)
from tests.client.a_gate_posted_by_the_fleet_carries_its_run_and_release_helpers import (
    _FAKE_NO_MISTAKES_BODY,
    ENV_KEYS,
    STDERR_FILLER,
)
from tests.client.client_fleet_envelope_census_helpers import drive_verb
from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    fresh_grandchild_pidfile,
    install_project,
    kill_pid_if_alive,
    load_toon,
    new_scratch,
    pid_alive,
    scrubbed_env,
    wait_for_pid_gone,
)

CLIENT = "python-crucible.py"
SPAWN_TIMEOUT_S = 60
# Four times what a pipe holds: a drive that leaves either pipe unread while
# the tool runs cannot get past this.
LARGE_BYTES = 256 * 1024
CALLER = "gate-drive-output-caller"
PROJECT_KEY = "gate-drive-output-key"
PROJECT_NAME = "gate-drive-output"
HEAD = "cafe2580"
# The decision id the board answers a recorded decision with, in the store's
# own shape (`dec-<ms>-<seq>`).
DECISION_ID = "dec-1763700000000-1"
# Long enough that the drive's first `axi status` poll lands while the tool
# is still running, so the ladder it saw reaches the board as an interim.
FAKE_RUN_SECONDS = "1.0"

HELD_REPORT = ("gate-run: NOT SEALED: the run is still in flight \u2014 "
               "`axi run` resolved no outcome")
ALREADY_ON_BOARD = ("gate-run: an interim gate is already on the board \u2014 "
                    "this exit posted no seal over it")

_TOON = load_toon()


def _with_findings(snapshot, run_id):
    """`snapshot` with a top-level findings table appended, grown until the
    whole text is at least `LARGE_BYTES`: the shape of a review whose rebase
    finding lists hundreds of commits. Read back through the fleet's own TOON
    decoder before any drive uses it, so a fixture that is not well formed
    stops here and is never mistaken for the drive's failure."""
    rows = []
    size = len(snapshot.encode("utf-8"))
    index = 0
    while size < LARGE_BYTES + 4096:
        row = (f'  F{index:05d},info,"replayed commit {index:08x}: one subject '
               f'line of a long-lived branch carried by the rebase finding"\n')
        rows.append(row)
        size += len(row.encode("utf-8"))
        index += 1
    text = (snapshot + f"findings[{len(rows)}]{{id,severity,title}}:\n"
            + "".join(rows))
    decoded = _TOON.decode(text.strip())
    if (len(text.encode("utf-8")) < LARGE_BYTES
            or not isinstance(decoded, dict)
            or (decoded.get("run") or {}).get("id") != run_id
            or len(decoded.get("findings") or []) != len(rows)):
        raise RuntimeError("fixture broken: the large snapshot does not decode "
                           "to its own run and findings")
    return text


def _pid_in(path):
    try:
        with open(path) as handle:
            text = handle.read().strip()
    except FileNotFoundError:
        return None
    return int(text) if text.isdigit() else None


def _gates(posts):
    return [body for path, body in posts if path == GATES_PATH]


def _seals(posts):
    return [b for b in _gates(posts) if "inFlight" not in (b.get("gate") or {})]


def _interims(posts):
    return [b for b in _gates(posts) if (b.get("gate") or {}).get("inFlight") is True]


class AGateDriveNeverStallsOnTheToolsOutputTest(unittest.TestCase):

    def setUp(self):
        self.project = new_scratch("gate-drive-output-")
        self.bin_dir = new_scratch("gate-drive-output-bin-")
        self.state_dir = new_scratch("gate-drive-output-state-")
        fake = os.path.join(self.bin_dir, "no-mistakes")
        with open(fake, "w") as handle:
            handle.write(f"#!{sys.executable}\n")
            handle.write(_FAKE_NO_MISTAKES_BODY)
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IXUSR)
        self.pidfiles = []
        self.boards = []
        self.drives = 0

    def tearDown(self):
        try:
            # A drive that stalled was killed by its timeout; the fake it
            # launched must not outlive this test. Each one wrote its pid.
            for pidfile in self.pidfiles:
                pid = _pid_in(pidfile)
                if pid is not None and not wait_for_pid_gone(pid, timeout=10):
                    kill_pid_if_alive(pid)
                    wait_for_pid_gone(pid, timeout=5)
        finally:
            for board in self.boards:
                board.close()
            for scratch in (self.project, self.bin_dir, self.state_dir):
                shutil.rmtree(scratch, ignore_errors=True)

    # ── the drive ──────────────────────────────────────────────────────────

    def _drive(self, argv, live, final, *, stderr_bytes=0, decision=None):
        """Spawn the installed client once against a fresh board and the fake
        tool, answering `axi status` with `live` and `axi run`/`axi respond`
        with `final`. Answers `(completed process, board posts)`; a drive that
        does not return within `SPAWN_TIMEOUT_S` fails the test."""
        self.drives += 1
        board = RecordingBoard()
        self.boards.append(board)
        if decision is not None:
            board.answer("POST", GATE_DECISIONS_PATH,
                         {"ok": True, "changed": True, "decision": decision},
                         status=201)
        install_project(self.project, board.url, PROJECT_KEY, PROJECT_NAME)
        live_file = os.path.join(self.state_dir, f"live-{self.drives}.toon")
        final_file = os.path.join(self.state_dir, f"final-{self.drives}.toon")
        with open(live_file, "w") as handle:
            handle.write(live)
        with open(final_file, "w") as handle:
            handle.write(final)
        pidfile = fresh_grandchild_pidfile(self.state_dir)
        self.pidfiles.append(pidfile)

        env = scrubbed_env()
        for key in ENV_KEYS:
            env.pop(key, None)
        fake_env = {
            "GATE_FLEET_FAKE_LIVE_FILE": live_file,
            "GATE_FLEET_FAKE_FINAL_FILE": final_file,
            "GATE_FLEET_FAKE_RUN_SECONDS": FAKE_RUN_SECONDS,
            "GATE_FLEET_FAKE_PIDFILE": pidfile,
            "GATE_FLEET_FAKE_STDERR_BYTES": str(stderr_bytes),
        }
        with mock.patch.dict(os.environ, env, clear=True):
            try:
                result = drive_verb(CLIENTS / CLIENT,
                                    argv + ["--project-dir", self.project],
                                    Path(self.project), Path(self.bin_dir),
                                    timeout=SPAWN_TIMEOUT_S, extra_env=fake_env,
                                    board=board.url)
            except subprocess.TimeoutExpired:
                pid = _pid_in(pidfile)
                self.fail(
                    f"`{argv[0]}` did not return within {SPAWN_TIMEOUT_S} s: the "
                    f"drive stalled on the tool's own output (the fake tool "
                    f"pid={pid}, alive={pid is not None and pid_alive(pid)}); "
                    f"board posts so far: {len(board.posts())}")
        return result, board.posts()

    # ── what a caller observes ─────────────────────────────────────────────

    def _envelope_after_one_verbatim_relay(self, out, snapshot):
        """The client's stdout begins with the tool's snapshot, verbatim, and
        carries it exactly once; the envelope follows it."""
        self.assertTrue(
            out.startswith(snapshot),
            f"stdout must begin with the tool's snapshot verbatim "
            f"({len(snapshot)} chars); it begins {out[:200]!r} "
            f"({len(out)} chars in all)")
        self.assertEqual(out.count(snapshot), 1,
                         "the snapshot must be relayed exactly once")
        decoded = _TOON.decode(out[len(snapshot):].strip())
        self.assertIsInstance(decoded, dict)
        self.assertIn("axi", decoded)
        return decoded["axi"]

    def _assert_one_seal(self, posts, run_id):
        seals = _seals(posts)
        self.assertEqual(len(seals), 1,
                         f"exactly one seal; got {len(seals)} of "
                         f"{len(_gates(posts))} gate posts")
        gate = seals[0]["gate"]
        self.assertEqual(gate.get("outcome"), "passed")
        self.assertEqual(gate.get("run", {}).get("id"), run_id)
        self.assertEqual(gate.get("push"), {"commit": HEAD})

    def _assert_one_decision(self, posts, run_id):
        decisions = [b for p, b in posts if p == GATE_DECISIONS_PATH]
        self.assertEqual(len(decisions), 1,
                         f"exactly one decision recorded; got {decisions!r}")
        self.assertEqual(decisions[0]["decision"].get("runId"), run_id)
        self.assertEqual(decisions[0]["decision"].get("action"), "approve")

    # ── the tests ──────────────────────────────────────────────────────────

    def test_gate_run_seals_and_relays_a_final_snapshot_four_times_a_pipe(self):
        run_id = "large-final-run-0001"
        live, final = _fixture(run_id, "feature/large-final", HEAD, "review")
        final = _with_findings(final, run_id)

        result, posts = self._drive(
            ["gate-run", "--intent", "seal a large final snapshot",
             "--agent", CALLER], live, final)

        self.assertEqual(result.returncode, 0,
                         f"gate-run must exit 0; stderr={result.stderr[-2000:]!r}")
        axi = self._envelope_after_one_verbatim_relay(result.stdout, final)
        self.assertEqual(axi.get("verb"), "gate-run")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("outcome"), "passed")
        self.assertEqual(axi.get("postedGate"), "final")
        self._assert_one_seal(posts, run_id)

    def test_gate_run_reports_a_held_run_whose_snapshot_is_four_times_a_pipe(self):
        run_id = "large-held-run-0001"
        live, final = _fixture(run_id, "feature/large-held", HEAD, "review",
                               held=True)
        final = _with_findings(final, run_id)

        result, posts = self._drive(
            ["gate-run", "--intent", "hold a large snapshot",
             "--agent", CALLER], live, final)

        self.assertEqual(result.returncode, 1,
                         f"a held gate-run exits 1; stderr={result.stderr[-2000:]!r}")
        axi = self._envelope_after_one_verbatim_relay(result.stdout, final)
        self.assertEqual(axi.get("verb"), "gate-run")
        self.assertIs(axi.get("ok"), False)
        self.assertIs(axi.get("inFlight"), True)
        self.assertEqual(axi.get("postedGate"), "interim")
        # Nothing sealed, and the held report names the hold and the interim.
        self.assertEqual(_seals(posts), [], "a held run seals nothing")
        self.assertIn(HELD_REPORT, result.stderr)
        self.assertIn(ALREADY_ON_BOARD, result.stderr)
        # The one interim the poll saw (the ladder did not change).
        interims = _interims(posts)
        self.assertEqual(len(interims), 1,
                         f"exactly one interim; got {len(interims)}")
        gate = interims[0]["gate"]
        self.assertEqual(gate.get("run", {}).get("id"), run_id)
        self.assertEqual(gate.get("steps"),
                         [{"name": "intent", "status": "passed", "findings": 0},
                          {"name": "review", "status": "running", "findings": 0}])

    def test_gate_respond_records_and_seals_a_final_snapshot_four_times_a_pipe(self):
        run_id = "large-respond-run-0001"
        live, final = _fixture(run_id, "feature/large-respond", HEAD, "review")
        final = _with_findings(final, run_id)

        result, posts = self._drive(
            ["gate-respond", "--action", "approve", "--agent", CALLER],
            live, final, decision=DECISION_ID)

        self.assertEqual(result.returncode, 0,
                         f"gate-respond must exit 0; stderr={result.stderr[-2000:]!r}")
        axi = self._envelope_after_one_verbatim_relay(result.stdout, final)
        self.assertEqual(axi.get("verb"), "gate-respond")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("decision"), DECISION_ID)
        self._assert_one_decision(posts, run_id)
        self._assert_one_seal(posts, run_id)

    def test_a_tool_stderr_four_times_a_pipe_stalls_neither_drive_and_is_never_relayed(self):
        for verb, argv, decision in (
                ("gate-run", ["gate-run", "--intent", "drop a large stderr",
                              "--agent", CALLER], None),
                ("gate-respond", ["gate-respond", "--action", "approve",
                                  "--agent", CALLER], DECISION_ID)):
            with self.subTest(verb=verb):
                run_id = f"large-stderr-{verb}-0001"
                live, final = _fixture(run_id, f"feature/large-stderr-{verb}",
                                       HEAD, "review")

                result, posts = self._drive(argv, live, final,
                                            stderr_bytes=LARGE_BYTES,
                                            decision=decision)

                self.assertEqual(result.returncode, 0,
                                 f"{verb} must exit 0; stderr="
                                 f"{result.stderr[-2000:]!r}")
                axi = self._envelope_after_one_verbatim_relay(result.stdout, final)
                self.assertEqual(axi.get("verb"), verb)
                self.assertIs(axi.get("ok"), True)
                self._assert_one_seal(posts, run_id)
                if decision is not None:
                    self.assertEqual(axi.get("decision"), decision)
                    self._assert_one_decision(posts, run_id)
                self.assertNotIn(STDERR_FILLER, result.stderr,
                                 "the tool's stderr is dropped, never relayed")
                self.assertNotIn(STDERR_FILLER, result.stdout)


if __name__ == "__main__":
    unittest.main()
