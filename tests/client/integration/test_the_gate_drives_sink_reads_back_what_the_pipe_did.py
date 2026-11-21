"""The gate drive's sink reads back what the pipe did.

`launched_axi_tool` (`clients/_crucible_run.py`) sends the tool's stdout to an
unnamed temporary file instead of a pipe, and `read_output()` reads it back
once the tool has exited. The read-back must be the text the old pipe form
(`Popen(text=True)` + `communicate()`) gave for the same bytes:

- **CRLF.** `a\\r\\nb\\n` reads back as the pipe form reads it, `"a\\nb\\n"`:
  universal newlines, compared against the pipe form in the same test.
- **Undecodable bytes.** Bytes the locale encoding cannot decode raise the
  same exception type the pipe form raises (`UnicodeDecodeError` under a
  UTF-8 locale): strict errors, never a silent replacement.

And the sink is closed on every exit: an exception raised inside the `with`
(standing in for an interrupt) closes it, and the tool is never killed or
waited for there -- it is still running when the `with` has exited.

Integration tier: each case spawns a real python child. Every wait is
bounded (`WAIT_S`), and every child is reaped before its test ends. The run
module is loaded from the suite's test install (`tests.client.load_client`);
the sink is reached by replacing the module's `tempfile` with one whose
`TemporaryFile` records the file it opens, never through private attributes.

Invocation:
    .venv/bin/python clients/python-crucible.py test \\
        --tests tests.client.integration.test_the_gate_drives_sink_reads_back_what_the_pipe_did
"""

import codecs
import locale
import os
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

from tests.client import load_client

RUN = load_client("_crucible_run.py")

#: The bound on every wait for a child this module spawns.
WAIT_S = 10
#: How long the interrupted child sleeps: long enough to be alive when the
#: `with` has exited, short enough never to hold the suite.
SLEEP_S = 1.5

CRLF_BYTES = b"a\r\nb\n"
#: Bytes no UTF-8 decoder accepts: a lone continuation byte and two bytes
#: that never occur in UTF-8.
UNDECODABLE_BYTES = b"ok \x80\xfe\xff\n"


def _writer_argv(payload):
    """A python child that writes `payload` to its stdout as raw bytes."""
    code = (f"import sys; sys.stdout.buffer.write({payload!r}); "
            "sys.stdout.flush()")
    return [sys.executable, "-c", code]


def _piped(argv, env=None):
    """What the old pipe form reads from `argv`: `Popen(text=True)` and
    `communicate()`. The pipe is closed and the child reaped on every exit,
    a decode error included (`Popen`'s own context manager)."""
    with subprocess.Popen(argv, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True,
                          env=env) as proc:
        try:
            out, _ = proc.communicate(timeout=WAIT_S)
        finally:
            if proc.poll() is None:
                proc.kill()
    return out


def _launched(argv):
    """What `launched_axi_tool` reads back from `argv`. The tool's exit is
    awaited under `WAIT_S` first, so `read_output()`'s own wait returns at
    once."""
    with RUN.launched_axi_tool(argv) as (proc, read_output):
        try:
            proc.wait(timeout=WAIT_S)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=WAIT_S)
        return read_output()


def _pinned_child_env():
    """The test's environment with the child's encoding pinned: `LC_ALL`
    `C.UTF-8`, UTF-8 mode off, and no `PYTHONIOENCODING`."""
    env = dict(os.environ)
    env["LC_ALL"] = "C.UTF-8"
    env["PYTHONUTF8"] = "0"
    env.pop("PYTHONIOENCODING", None)
    return env


class _StandInInterrupt(BaseException):
    """Raised inside the `with` in place of an interrupt: a `BaseException`,
    as `KeyboardInterrupt` is, so no `except Exception` absorbs it."""


class TheSinkReadsBackWhatThePipeDid(unittest.TestCase):

    def test_crlf_reads_back_as_the_pipe_reads_it(self):
        argv = _writer_argv(CRLF_BYTES)
        piped = _piped(argv)
        launched = _launched(argv)
        self.assertEqual(piped, "a\nb\n",
                         "the pipe form reads CRLF with universal newlines")
        self.assertEqual(launched, piped,
                         "the sink reads CRLF back as the pipe form does")

    def test_undecodable_bytes_raise_what_the_pipe_raises(self):
        encoding = locale.getpreferredencoding(False)
        if codecs.lookup(encoding).name != "utf-8":
            self.skipTest(
                f"this process decodes with {encoding!r}, not UTF-8: the "
                "undecodable bytes are pinned for a UTF-8 reader only")
        argv = _writer_argv(UNDECODABLE_BYTES)
        env = _pinned_child_env()
        with self.assertRaises(UnicodeDecodeError,
                               msg="the pipe form decodes strictly"):
            _piped(argv, env=env)
        with (mock.patch.dict(os.environ, env, clear=True),
              self.assertRaises(UnicodeDecodeError,
                                msg="the sink decodes strictly, as the "
                                    "pipe form does")):
            _launched(argv)

    def test_an_interrupt_closes_the_sink_and_never_kills_the_tool(self):
        opened = []

        def recording_temporary_file(*args, **kwargs):
            # Handed back open on purpose: the drive's own `with` owns it,
            # and the `finally` below closes whatever it left open.
            sink = tempfile.TemporaryFile(*args, **kwargs)  # noqa: SIM115
            opened.append(sink)
            return sink

        recording_tempfile = types.SimpleNamespace(
            TemporaryFile=recording_temporary_file)
        argv = [sys.executable, "-c", f"import time; time.sleep({SLEEP_S})"]
        launched = []
        try:
            with (mock.patch.object(RUN, "tempfile", recording_tempfile),
                  self.assertRaises(_StandInInterrupt),
                  RUN.launched_axi_tool(argv) as (proc, _read_output)):
                launched.append(proc)
                self.assertEqual(len(opened), 1, "the drive opens one sink")
                self.assertFalse(opened[0].closed,
                                 "the sink is open inside the with")
                raise _StandInInterrupt()
            self.assertEqual(len(launched), 1, "the tool was launched")
            self.assertTrue(opened[0].closed,
                            "an interrupt inside the with closes the sink")
            self.assertIsNone(launched[0].poll(),
                              "the tool is never killed or waited for on "
                              "an interrupt: it is still running")
        finally:
            for proc in launched:
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=WAIT_S)
            for sink in opened:
                sink.close()


if __name__ == "__main__":
    unittest.main()
