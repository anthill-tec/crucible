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
`CONSOLE_FILE` as thin delegates, so its own tests are unchanged; no client
defines a tee class of its own, and the maven client reaches the shared one
through `_axi()`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.unit.test_the_console_tee_lives_once_in_the_shared_module
"""

import ast
import contextlib
import io
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from tests.client.live_run_harness import CLIENTS, load_client

RUN_MODULE = CLIENTS / "_crucible_run.py"
CORE_MODULE = CLIENTS / "_crucible_axi.py"
CLIENT_FILES = ("bun-crucible.py", "python-crucible.py", "mvn-crucible.py",
                "rust-crucible.py", "arduino-crucible.py")
SHARED_NAMES = ("ConsoleTee", "console_observer")
BUN_DELEGATES = ("_ConsoleTee", "_console_observer", "_board_reads_console",
                 "_console_relay", "_finish_console_relay", "CONSOLE_FILE")


def _tree(path):
    return ast.parse(Path(path).read_text(encoding="utf-8"))


def _top_level(tree):
    """`{name: node}` for every top-level def, class or assigned name."""
    names = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.setdefault(node.name, []).append(node)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    names.setdefault(target.id, []).append(node)
    return names


def _calls(node, name):
    """The calls inside `node` to a bare or attribute name `name`."""
    found = []
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            func = sub.func
            called = (func.id if isinstance(func, ast.Name)
                      else func.attr if isinstance(func, ast.Attribute) else None)
            if called == name:
                found.append(sub)
    return found


def _reaches_through_axi(tree, name):
    """True when `tree` reads `_axi().<name>` somewhere."""
    for sub in ast.walk(tree):
        if (isinstance(sub, ast.Attribute) and sub.attr == name
                and isinstance(sub.value, ast.Call)
                and isinstance(sub.value.func, ast.Name) and sub.value.func.id == "_axi"):
            return True
    return False


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

    def test_the_run_module_defines_the_tee_and_the_core_does_not(self):
        run_defs = _top_level(_tree(RUN_MODULE))
        core_defs = _top_level(_tree(CORE_MODULE))
        counts = {name: (len(run_defs.get(name, [])), len(core_defs.get(name, [])))
                  for name in SHARED_NAMES}
        self.assertEqual(counts, dict.fromkeys(SHARED_NAMES, (1, 0)),
                         "{name: (run module, core)}: each is defined once in "
                         "clients/_crucible_run.py and never in clients/_crucible_axi.py")
        self.assertIsInstance(run_defs["ConsoleTee"][0], ast.ClassDef)

    def test_the_core_re_exports_the_run_modules_tee_as_the_same_object(self):
        core = load_client("_crucible_axi.py")
        namespace = core.ingest_reports.__globals__
        for name in SHARED_NAMES:
            with self.subTest(name=name):
                self.assertIn(name, namespace, f"the run module defines {name}")
                self.assertIs(getattr(core, name, None), namespace[name],
                              f"the core's {name} is the run module's")

    def test_no_client_defines_a_tee_class_of_its_own(self):
        own = {}
        for client in CLIENT_FILES:
            tree = _tree(CLIENTS / client)
            classes = [node.name for node in tree.body if isinstance(node, ast.ClassDef)
                       and "Tee" in node.name]
            if classes:
                own[client] = classes
        self.assertEqual(own, {}, "the tee is the shared module's, never a client's")

    def test_the_bun_delegates_open_and_write_nothing_themselves(self):
        defs = _top_level(_tree(CLIENTS / "bun-crucible.py"))
        for name in ("_ConsoleTee", "_console_observer"):
            with self.subTest(name=name):
                self.assertEqual(len(defs.get(name, [])), 1, f"bun keeps {name}, once")
                node = defs[name][0]
                self.assertNotIsInstance(node, ast.ClassDef, f"{name} is a delegate, not a class")
                self.assertEqual(_calls(node, "open"), [], f"{name} opens no file itself")
                self.assertEqual(_calls(node, "write"), [], f"{name} writes nothing itself")

    def test_bun_keeps_every_name_its_tests_reach(self):
        bun = load_client("bun-crucible.py")
        missing = [name for name in BUN_DELEGATES if not hasattr(bun, name)]
        self.assertEqual(missing, [])
        self.assertEqual(bun.CONSOLE_FILE, "bun-console.log")

    def test_the_maven_client_reaches_the_shared_tee_through_axi(self):
        tree = _tree(CLIENTS / "mvn-crucible.py")
        self.assertTrue(any(_reaches_through_axi(tree, name) for name in SHARED_NAMES),
                        "clients/mvn-crucible.py tees its console through "
                        "`_axi().console_observer` or `_axi().ConsoleTee`")


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
