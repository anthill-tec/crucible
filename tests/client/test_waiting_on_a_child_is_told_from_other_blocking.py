"""The shared live-run helper `wait_until_waiting_on_a_child`
(`tests/client/live_run_harness.py`) must tell a process blocked WAITING ON A
CHILD apart from a process blocked in any other way — by the system call it
is blocked in (`/proc/<pid>/syscall`, first field: the `wait4` or `waitid`
number for `platform.machine()`), never by a kernel function name read from
`/proc/<pid>/wchan`, which is not stable across kernels (on this machine a
process blocked in `Popen.wait()` reads `__x64_sys_wait4.cold`, not
`do_wait`).

Every behavioural test below drives the helper against a REAL child process
the test starts itself, in its own session, killed as a group in cleanup:

* a child blocked in `Popen.wait()` (the `wait4` call) — the helper says True;
* a child blocked in `os.waitid` — True;
* a child sleeping in `time.sleep` — False, within a short timeout;
* a child whose `/proc/<pid>/syscall` cannot be read — the child makes itself
  non-dumpable (`prctl(PR_SET_DUMPABLE, 0)`), so the kernel hands its
  `/proc` entries to root and opening `syscall` raises `PermissionError` for
  this unprivileged test: a real unreadable file, not pid 1 and no seam — the
  helper falls back to its short fixed pause, then True, raising nothing;
* an architecture outside the table — the fallback, never a poll.

The architecture case patches `platform.machine` (the `platform` module's
attribute, consulted when the helper is CALLED): the smallest seam, adding
nothing to the helper's signature.

A sleeping child is used for the two fallback cases on purpose: a helper that
really polled the system call would say False for it, so True can only come
from the fallback.

Invocation:
    python3 -m unittest tests.client.test_waiting_on_a_child_is_told_from_other_blocking -v
"""

import ast
import contextlib
import inspect
import os
import signal
import subprocess
import sys
import time
import unittest
from unittest import mock

from tests.client import live_run_harness
from tests.client.live_run_harness import wait_until_waiting_on_a_child

HARNESS_SOURCE_PATH = live_run_harness.__file__

# The child programs. Each prints one line once it has reached the point
# just before it blocks, so the test never polls a child still starting up.
_BLOCKED_IN_POPEN_WAIT = (
    "import subprocess, sys\n"
    "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
    "print(p.pid, flush=True)\n"
    "p.wait()\n"
)
_BLOCKED_IN_WAITID = (
    "import os, subprocess, sys\n"
    "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
    "print(p.pid, flush=True)\n"
    "os.waitid(os.P_PID, p.pid, os.WEXITED)\n"
)
_SLEEPING = (
    "import time\n"
    "print('sleeping', flush=True)\n"
    "time.sleep(60)\n"
)
_SLEEPING_NON_DUMPABLE = (
    "import ctypes, time\n"
    "PR_SET_DUMPABLE = 4\n"
    "result = ctypes.CDLL(None, use_errno=True).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)\n"
    "print(result, flush=True)\n"
    "time.sleep(60)\n"
)

# The fallback is today's: a short fixed pause (one second), then True.
FALLBACK_PAUSE_FLOOR = 0.9
FALLBACK_PAUSE_CEILING = 4.0


class WaitingOnAChildHelperTest(unittest.TestCase):
    """`wait_until_waiting_on_a_child` against children this test starts."""

    def _start_child(self, program):
        """Start `program` in its own session and return `(proc, ready_line)`
        once it has printed its ready line. The whole session (the child and
        any grandchild it started) is SIGKILLed in cleanup, whatever the
        assertions did."""
        proc = subprocess.Popen(
            [sys.executable, "-c", program],
            stdout=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
        )
        self.addCleanup(self._kill_session, proc)
        assert proc.stdout is not None
        ready = proc.stdout.readline().strip()
        self.assertTrue(
            ready,
            "fixture failure: the child exited before printing its ready line")
        return proc, ready

    @staticmethod
    def _kill_session(proc):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=10)
        if proc.stdout is not None:
            proc.stdout.close()

    def _timed(self, pid, timeout):
        started = time.monotonic()
        result = wait_until_waiting_on_a_child(pid, timeout=timeout)
        return result, time.monotonic() - started

    # ── a wait is recognised ────────────────────────────────────────────────

    def test_a_child_blocked_in_popen_wait_is_seen_waiting_on_a_child(self):
        proc, grandchild = self._start_child(_BLOCKED_IN_POPEN_WAIT)
        self.assertTrue(grandchild.isdigit(),
                        "fixture failure: the child never started its own child")

        result, elapsed = self._timed(proc.pid, timeout=5)

        self.assertIs(result, True,
                      "a process blocked in Popen.wait() (the wait4 system call) "
                      "must be recognised as waiting on a child")
        self.assertLess(elapsed, 5.0,
                        "the wait must be seen before the timeout, not at it")
        self.assertIsNone(proc.poll(), "the child must still be blocked waiting")

    def test_a_child_blocked_in_os_waitid_is_seen_waiting_on_a_child(self):
        proc, grandchild = self._start_child(_BLOCKED_IN_WAITID)
        self.assertTrue(grandchild.isdigit(),
                        "fixture failure: the child never started its own child")

        result, elapsed = self._timed(proc.pid, timeout=5)

        self.assertIs(result, True,
                      "a process blocked in os.waitid (the waitid system call) "
                      "must be recognised as waiting on a child")
        self.assertLess(elapsed, 5.0,
                        "the wait must be seen before the timeout, not at it")
        self.assertIsNone(proc.poll(), "the child must still be blocked waiting")

    # ── other blocking is not a wait ────────────────────────────────────────

    def test_a_child_sleeping_in_time_sleep_is_not_seen_waiting_within_the_timeout(self):
        proc, _ready = self._start_child(_SLEEPING)

        result, elapsed = self._timed(proc.pid, timeout=1.5)

        self.assertIs(result, False,
                      "a process sleeping in time.sleep is blocked, but not "
                      "waiting on a child")
        self.assertGreaterEqual(elapsed, 1.5,
                                "False must come only once the timeout has passed")
        self.assertLess(elapsed, 3.5,
                        "the helper must give up at its timeout, not run on")

    # ── the state cannot be observed: the fallback ──────────────────────────

    def test_an_unreadable_syscall_file_falls_back_to_a_pause_then_true(self):
        proc, prctl_result = self._start_child(_SLEEPING_NON_DUMPABLE)
        self.assertEqual(prctl_result, "0",
                         "fixture failure: the child could not make itself "
                         "non-dumpable")
        syscall_path = f"/proc/{proc.pid}/syscall"
        with self.assertRaises(PermissionError,
                               msg="fixture failure: the child's syscall file is "
                                   "still readable (is this test running as root?)"), \
                open(syscall_path) as f:
            f.read()

        try:
            result, elapsed = self._timed(proc.pid, timeout=8)
        except OSError as exc:
            self.fail("an unreadable syscall file must fall back, never raise: "
                      f"{type(exc).__name__}")

        self.assertIs(result, True,
                      "an unreadable /proc/<pid>/syscall means the state cannot be "
                      "observed: the fallback answers True")
        self.assertGreaterEqual(elapsed, FALLBACK_PAUSE_FLOOR,
                                "the fallback's True comes after its short pause")
        self.assertLess(elapsed, FALLBACK_PAUSE_CEILING,
                        "the fallback is a short fixed pause, not a poll to the "
                        "timeout")

    def test_an_architecture_outside_the_table_falls_back_to_a_pause_then_true(self):
        proc, _ready = self._start_child(_SLEEPING)

        with mock.patch("platform.machine", return_value="riscv64") as machine:
            result, elapsed = self._timed(proc.pid, timeout=8)

        self.assertIs(result, True,
                      "an architecture outside the table means the state cannot "
                      "be observed: the fallback answers True")
        self.assertGreaterEqual(machine.call_count, 1,
                                "the helper must look up the machine's "
                                "architecture when it is called")
        self.assertGreaterEqual(elapsed, FALLBACK_PAUSE_FLOOR,
                                "the fallback's True comes after its short pause")
        self.assertLess(elapsed, FALLBACK_PAUSE_CEILING,
                        "the fallback is a short fixed pause, not a poll to the "
                        "timeout")


class WaitingOnAChildHelperSourceTest(unittest.TestCase):
    """The helper never relies on a kernel function name, and its docstring
    states the system-call test and its table."""

    KERNEL_FUNCTION_NAMES = ("wchan", "do_wait", "sys_wait4", "sys_waitid")

    @staticmethod
    def _docstring_nodes(tree):
        nodes = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef,
                                 ast.AsyncFunctionDef, ast.ClassDef)):
                body = node.body
                if (body and isinstance(body[0], ast.Expr)
                        and isinstance(body[0].value, ast.Constant)
                        and isinstance(body[0].value.value, str)):
                    nodes.add(id(body[0].value))
        return nodes

    def test_no_code_in_the_harness_reads_wchan_or_names_a_kernel_function(self):
        with open(HARNESS_SOURCE_PATH) as f:
            tree = ast.parse(f.read())
        docstrings = self._docstring_nodes(tree)
        offending = sorted({
            name
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
            and id(node) not in docstrings
            for name in self.KERNEL_FUNCTION_NAMES
            if name in node.value
        })
        self.assertEqual(offending, [],
                         "the harness must recognise a wait by its system call, "
                         "never by /proc/<pid>/wchan or a kernel function name")

    def test_the_helpers_docstring_states_the_system_call_test_and_its_table(self):
        doc = inspect.getdoc(wait_until_waiting_on_a_child) or ""
        self.assertIn("/proc/<pid>/syscall", doc)
        for term in ("wait4", "waitid", "x86_64", "aarch64"):
            self.assertIn(term, doc)
        for number in ("61", "247", "260", "95"):
            self.assertRegex(doc, rf"\b{number}\b",
                             f"the docstring's table must give the number {number}")
        self.assertNotIn("do_wait", doc,
                         "the docstring must not describe a kernel function name test")


if __name__ == "__main__":
    unittest.main()
