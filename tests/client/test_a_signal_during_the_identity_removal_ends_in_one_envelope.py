"""The closing half of the gated-run identity bracket (`gated_run`, shared by
every test-family verb): a SIGTERM landing while the bracket is removing the
run's identity must neither cut that removal short nor print a second
envelope.

Two exits reach the removal:
- an interrupted one: the runner was already signalled, the verb's own trap
  aborted the run and printed its one `ok: false` envelope, and a further
  signal lands while the identity removal is in flight. That exit must stay
  at exactly ONE envelope;
- a normal one: the run was filed and its envelope printed, and the signal
  lands while the identity removal is in flight. The exit then ends with one
  `ok: false` envelope naming the signal, on 128+signum, and the identity is
  still removed.

Driven through a REAL client subprocess (the python client's `test` verb —
the close is the one shared bracket) against the recording board, holding the
identity removal's reply (`RecordingBoard.hold_next_reply`) so the signal
lands while the client is still waiting on it.

Invocation:
    python3 -m unittest tests.client.test_a_signal_during_the_identity_removal_ends_in_one_envelope -v
"""

import os
import shutil
import signal
import subprocess
import sys
import time
import unittest

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    install_project,
    load_toon,
    new_scratch,
    scrubbed_env,
    write_fake_python,
)

AGENT = "removal-held-signal-fixture"
PROJECT_KEY = "test-key-removal-held-signal"
UNREGISTER_PATH = "/api/v2/agents/unregister"
MARKER = "REMOVAL_HELD_RUNNER_MARKER"
TOON = load_toon()


def _wait_until(predicate, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def _read(path):
    try:
        with open(path, errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def _envelopes(stdout):
    """Every TOON envelope on stdout, decoded, in print order (each one starts
    at a top-level `axi:` line)."""
    chunks, current = [], []
    for line in stdout.splitlines():
        if line == "axi:" and current:
            chunks.append(current)
            current = []
        current.append(line)
    if current:
        chunks.append(current)
    return [TOON.decode("\n".join(chunk) + "\n").get("axi")
            for chunk in chunks if chunk and chunk[0] == "axi:"]


class SignalDuringIdentityRemovalTest(unittest.TestCase):

    def setUp(self):
        self.project = new_scratch("removal-held-")
        self.scratch = new_scratch("removal-held-scratch-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY)
        self.fake_python = write_fake_python(self.project)
        self.release = os.path.join(self.scratch, "release-runner")
        self.stderr_path = os.path.join(self.scratch, "client-stderr.txt")

    def tearDown(self):
        with open(self.release, "w") as f:
            f.write("go")
        self.board.close()
        for d in (self.project, self.scratch):
            shutil.rmtree(d, ignore_errors=True)

    def _cmd(self):
        return [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
                "--python", self.fake_python, "--project-dir", self.project,
                "--reports", "reports", "--agent", AGENT]

    def _removals(self):
        return [b for p, b in self.board.posts() if p == UNREGISTER_PATH
                and isinstance(b, dict) and b.get("agentId") == AGENT]

    def _drive(self, interrupt_runner_first):
        """Hold the identity removal's reply. With `interrupt_runner_first`,
        the runner blocks on its marker and is interrupted by a first SIGTERM;
        otherwise it runs to completion. Once the removal has reached the
        board, SIGTERM the client, then release the reply."""
        self.board.hold_next_reply(UNREGISTER_PATH)
        extra = {"FAKE_TOTAL": "3"}
        if interrupt_runner_first:
            extra.update(FAKE_RELEASE_FILE=self.release,
                         FAKE_MARKER_LINE=MARKER, FAKE_BLOCK_AFTER_INDEX="1")
        with open(self.stderr_path, "w") as err:
            proc = subprocess.Popen(self._cmd(), cwd=self.project,
                                    env=scrubbed_env(**extra),
                                    stdout=subprocess.PIPE, stderr=err,
                                    text=True)
            try:
                if interrupt_runner_first:
                    self.assertTrue(
                        _wait_until(lambda: MARKER in _read(self.stderr_path)),
                        "the runner's marker never reached the client's stderr")
                    proc.send_signal(signal.SIGTERM)
                self.assertTrue(
                    _wait_until(lambda: bool(self._removals())),
                    f"the identity removal never reached the board; "
                    f"posts={self.board.posts()!r}; "
                    f"stderr={_read(self.stderr_path)[-2000:]!r}")
                proc.send_signal(signal.SIGTERM)
                self.board.release_held()
                try:
                    stdout, _ = proc.communicate(timeout=20)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    stdout, _ = proc.communicate(timeout=10)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        return proc.returncode, stdout, _read(self.stderr_path)

    def test_a_signal_during_the_removal_after_a_runner_interrupt_prints_one_envelope(self):
        code, stdout, stderr = self._drive(interrupt_runner_first=True)
        envelopes = _envelopes(stdout)
        self.assertEqual(
            len(envelopes), 1,
            f"an interrupted run prints exactly ONE envelope, even when a "
            f"further SIGTERM lands while its identity is being removed; got "
            f"{len(envelopes)}: {envelopes!r}; stderr={stderr[-2000:]!r}")
        axi = envelopes[0]
        self.assertIs(axi.get("ok"), False, repr(axi))
        self.assertEqual(axi.get("signal"), "SIGTERM", repr(axi))
        self.assertEqual(axi.get("runId"), "run-live-1", repr(axi))
        self.assertEqual(code, 143, f"stdout={stdout!r} stderr={stderr[-2000:]!r}")
        self.assertEqual(len(self._removals()), 1, repr(self.board.posts()))

    def test_a_signal_during_the_removal_of_a_normal_run_ends_in_one_signal_envelope(self):
        code, stdout, stderr = self._drive(interrupt_runner_first=False)
        envelopes = _envelopes(stdout)
        failed = [axi for axi in envelopes if axi.get("ok") is False]
        self.assertEqual(
            len(failed), 1,
            f"a SIGTERM during the identity removal ends the exit with ONE "
            f"ok:false envelope; got {envelopes!r}; stderr={stderr[-2000:]!r}")
        self.assertIs(
            envelopes[-1], failed[0],
            f"the signal's envelope is the exit's last word; got {envelopes!r}")
        self.assertEqual(failed[0].get("signal"), "SIGTERM", repr(failed[0]))
        self.assertEqual(
            (failed[0].get("context") or {}).get("agentId"), AGENT,
            f"the signal's envelope names the identity the bracket removed; "
            f"got {failed[0]!r}")
        self.assertEqual(code, 143, f"stdout={stdout!r} stderr={stderr[-2000:]!r}")
        removals = self._removals()
        self.assertEqual(len(removals), 1, repr(self.board.posts()))
        self.assertIs(removals[0].get("silent"), True, repr(removals[0]))
        self.assertIn(
            f"cleanup: ok=True agent={AGENT}", stderr,
            f"the removal must finish and report its outcome, not be cut "
            f"short by the signal; stderr={stderr[-2000:]!r}")
        self.assertEqual(self.board.aborts(), [], repr(self.board.posts()))


if __name__ == "__main__":
    unittest.main()
