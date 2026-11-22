"""The console tee lives once, in the shared run module.

A run whose console a board reads as a view (bun's `bun-console`, maven's
`surefire-console`) has the runner's combined output written, line by line as
`run_streamed` reads it, to a console file the shared `StreamRelay` follows.
That tee is written once, in `clients/_crucible_run.py`, and re-exported by
the core (`clients/_crucible_axi.py`), because both the bun and the maven
client use it:

  * `ConsoleTee(handle, path, narrator)` — the line observer: `observe(line)`
    writes the line to `handle` and flushes, then hands it to `narrator`
    (when there is one); a write that fails is said once on stderr and ends
    the writing, never the run, and the narrator still sees every line;
  * `console_observer(relay, path, narrator)` — a context manager yielding
    the observer a run is handed: `narrator` itself when nothing relays
    (`relay` None, and no file is written), else a `ConsoleTee` writing
    `path`; a file that cannot be opened is said once on stderr and the run
    goes on with the narrator alone.

Interface choices (the spec leaves these names open; GREEN is asked to use
them): `ConsoleTee` and `console_observer` in `clients/_crucible_run.py`.

The bun client keeps `_ConsoleTee`, `_console_observer`,
`_board_reads_console`, `_console_relay`, `_finish_console_relay` and
`CONSOLE_FILE` as thin delegates, so its own tests are unchanged.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.unit.test_the_console_tee_lives_once_in_the_shared_module
"""

import contextlib
import io
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from tests.client.live_run_harness import load_client

SHARED_NAMES = ("ConsoleTee", "console_observer")
BUN_DELEGATES = ("_ConsoleTee", "_console_observer", "_board_reads_console",
                 "_console_relay", "_finish_console_relay", "CONSOLE_FILE")


class _Narrator:
    def __init__(self):
        self.lines = []

    def observe(self, line):
        self.lines.append(line)


class _BrokenHandle:
    def __init__(self):
        self.writes = 0

    def write(self, _text):
        self.writes += 1
        raise OSError("disk full (planted)")

    def flush(self):
        pass


# ── where the tee is defined ────────────────────────────────────────────────

class TheTeeIsDefinedOnceInTheRunModuleTest(unittest.TestCase):

    def test_the_core_re_exports_the_run_modules_tee_as_the_same_object(self):
        core = load_client("_crucible_axi.py")
        namespace = core.ingest_reports.__globals__
        for name in SHARED_NAMES:
            with self.subTest(name=name):
                self.assertIn(name, namespace, f"the run module defines {name}")
                self.assertIs(getattr(core, name, None), namespace[name],
                              f"the core's {name} is the run module's")

    def test_bun_keeps_every_name_its_tests_reach(self):
        bun = load_client("bun-crucible.py")
        missing = [name for name in BUN_DELEGATES if not hasattr(bun, name)]
        self.assertEqual(missing, [])
        self.assertEqual(bun.CONSOLE_FILE, "bun-console.log")


# ── what the shared tee does ────────────────────────────────────────────────

class _Scratch(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="console-tee-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.core = load_client("_crucible_axi.py")
        self.path = os.path.join(self.dir, "console.log")


class TheSharedTeeWritesEachLineThenHandsItOnTest(_Scratch):

    def test_each_line_is_written_and_flushed_then_handed_to_the_narrator(self):
        narrator = _Narrator()
        with open(self.path, "w", encoding="utf-8", newline="") as handle:
            tee = self.core.ConsoleTee(handle, self.path, narrator)
            tee.observe("[INFO] Running a.OneTest\n")
            self.assertEqual(Path(self.path).read_text(encoding="utf-8"),
                             "[INFO] Running a.OneTest\n", "flushed as it is observed")
            tee.observe("line two\r\n")
        self.assertEqual(Path(self.path).read_bytes(),
                         b"[INFO] Running a.OneTest\nline two\r\n", "written byte for byte")
        self.assertEqual(narrator.lines, ["[INFO] Running a.OneTest\n", "line two\r\n"])

    def test_a_tee_with_no_narrator_only_writes(self):
        with open(self.path, "w", encoding="utf-8", newline="") as handle:
            self.core.ConsoleTee(handle, self.path, None).observe("only\n")
        self.assertEqual(Path(self.path).read_text(encoding="utf-8"), "only\n")

    def test_a_failing_write_is_said_once_and_the_narrator_still_sees_every_line(self):
        narrator = _Narrator()
        handle = _BrokenHandle()
        said = io.StringIO()
        with contextlib.redirect_stderr(said):
            tee = self.core.ConsoleTee(handle, self.path, narrator)
            for line in ("a\n", "b\n", "c\n"):
                tee.observe(line)
        self.assertEqual(narrator.lines, ["a\n", "b\n", "c\n"])
        self.assertEqual(handle.writes, 1, "the first failure ends the writing")
        naming = [line for line in said.getvalue().splitlines() if self.path in line]
        self.assertEqual(len(naming), 1,
                         f"said once, naming the file; stderr={said.getvalue()[:300]!r}")


class TheSharedObserverTeesOnlyARelayedRunTest(_Scratch):

    def test_with_no_relay_the_narrator_itself_is_handed_and_no_file_is_written(self):
        narrator = _Narrator()
        with self.core.console_observer(None, self.path, narrator) as observer:
            self.assertIs(observer, narrator)
        self.assertFalse(os.path.exists(self.path))

    def test_with_a_relay_a_tee_writes_the_console_file(self):
        narrator = _Narrator()
        with self.core.console_observer(object(), self.path, narrator) as observer:
            self.assertIsInstance(observer, self.core.ConsoleTee)
            observer.observe("[INFO] Running a.OneTest\n")
        self.assertEqual(Path(self.path).read_text(encoding="utf-8"),
                         "[INFO] Running a.OneTest\n")
        self.assertEqual(narrator.lines, ["[INFO] Running a.OneTest\n"])

    def test_a_console_file_that_cannot_be_opened_falls_back_to_the_narrator(self):
        narrator = _Narrator()
        unopenable = os.path.join(self.dir, "missing-dir", "console.log")
        said = io.StringIO()
        with contextlib.redirect_stderr(said), \
                self.core.console_observer(object(), unopenable, narrator) as observer:
            self.assertIs(observer, narrator)
        naming = [line for line in said.getvalue().splitlines() if unopenable in line]
        self.assertEqual(len(naming), 1, f"said once; stderr={said.getvalue()[:300]!r}")


class BunsDelegatesUseTheSharedTeeTest(_Scratch):

    def setUp(self):
        super().setUp()
        self.bun = load_client("bun-crucible.py")

    def test_buns_console_observer_hands_a_shared_tee_writing_bun_console_log(self):
        narrator = _Narrator()
        with self.bun._console_observer(object(), self.dir, narrator) as observer:
            self.assertIsInstance(observer, self.bun._axi().ConsoleTee)
            observer.observe("bun test v1.3\n")
        self.assertEqual(Path(self.dir, "bun-console.log").read_text(encoding="utf-8"),
                         "bun test v1.3\n")
        self.assertEqual(narrator.lines, ["bun test v1.3\n"])

    def test_buns_console_observer_with_no_relay_hands_the_narrator(self):
        narrator = _Narrator()
        with self.bun._console_observer(None, self.dir, narrator) as observer:
            self.assertIs(observer, narrator)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "bun-console.log")))

    def test_buns_console_tee_builds_the_shared_tee(self):
        with open(self.path, "w", encoding="utf-8", newline="") as handle:
            tee = self.bun._ConsoleTee(handle, self.path, None)
            self.assertIsInstance(tee, self.bun._axi().ConsoleTee)
            tee.observe("x\n")
        self.assertEqual(Path(self.path).read_text(encoding="utf-8"), "x\n")


if __name__ == "__main__":
    unittest.main()
