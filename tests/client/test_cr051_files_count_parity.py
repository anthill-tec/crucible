"""CR-CRU-051 C1 RED -- propagate the run-envelope `files` (distinct test-FILE)
count from `bun-crucible.py` (the reference, CR-CRU-047 §S2) to python, mvn and
arduino. rust is C2 (its two parse sites + the server-parsed `_ingest_junit_axi`
distinction have their own complications) and is deliberately OUT of this file.

Contract pinned VERBATIM from
docs/changes/CR-CRU-051-files-count-fleet-parity.md:

  §S1 -- "Follow [bun-crucible.py's own JUnit parser, deleted since by
  CR-CRU-204, which sends bun's reports to the board unparsed], which is the reference. Its
  fallback chain exists precisely so the count degrades instead of collapsing
  to zero": `source = tc.get("file") or tc.get("classname") or suite.get("name")`.
  "State the resolved granularity per client" -- surefire/xmlrunner stamp
  `classname` (per-CLASS, not per-file); the arduino native harness and nextest
  "should be checked for a `file` attribute first".

  §S2 -- add `files` to each client's `run:` envelope alongside
  `passed`/`failed`/`pending`/`total`.

  AC (verbatim): "A report whose testcases carry no `file` attribute still
  yields a NON-ZERO `files` count via the `classname` -> suite-name fallback
  -- asserted. Degrading to zero would make a shrinking suite look identical
  to a healthy one, inverting the CR's purpose." / "No change to `src/` or
  `public/`: `files` rides the printed envelope only, never the ingest payload
  (CR-CRU-047 §S2's explicit contract)." / "bun-crucible.py is unchanged
  (already correct) -- confirmed, not assumed."

RED phase: python's JUnit parser (deleted since by CR-CRU-204, which sends
python's reports to the board unparsed), maven's JUnit parser (deleted since,
as the maven client sends its reports to the board unparsed)
and `arduino-crucible.py::_parse_junit` all returned a bare `(summary, tree)`
2-tuple then (confirmed by reading the source) -- unpacking a third `files`
element raises `ValueError: not enough values to unpack`, a real behavioral
failure. Their `run:` envelopes (`_emit_ingest_axi` / `_emit_ingest_summary_axi`)
build `run = {"passed", "failed", "pending", "total"}` with no `files` key at
all. Neither parser's docstring/comment mentions "granularity" anywhere
(confirmed by grep). Every test below against these three clients therefore
fails now for the right reason. The bun, python and maven clients' parser pins
are retired: they parse no report any more, and the board answers their run's
`files` count, which python's and maven's envelopes state as the board answered
it.

Module-loading + HTTP-mocking convention copied verbatim from the sibling
`test_python_crucible_axi.py` / `test_mvn_crucible_axi.py` /
`test_arduino_crucible_axi.py` harnesses: load each client by file path via
`importlib`, mock the module's `_post` HTTP transport seam so the live
Crucible server on :3849 is NEVER touched. The AST source-segment helper for
the granularity-comment pin is copied verbatim from
`test_cr054_verb_surface_lift.py::_function_source_segment`.

Invocation:
    python3 -m pytest tests/client/test_cr051_files_count_parity.py -q
Fallback:
    python3 tests/client/test_cr051_files_count_parity.py
"""

import ast
import contextlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.live_run_harness import get_answering_health

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"

PYTHON_SCRIPT = CLIENTS_DIR / "python-crucible.py"
MVN_SCRIPT = CLIENTS_DIR / "mvn-crucible.py"
ARDUINO_SCRIPT = CLIENTS_DIR / "arduino-crucible.py"


def _load_module_by_path(path, cache_key):
    """Load a client module by file path -- the exact convention every
    existing client test in this directory uses (importlib, not a package
    import), so each test gets a FRESH module object per test class."""
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Real argparse dispatch via `module.main()` -- copied verbatim from the
    sibling `_run_main` helpers in test_python_crucible_axi.py /
    test_mvn_crucible_axi.py / test_arduino_crucible_axi.py."""
    full_argv = ["crucible.py"] + argv
    stdout, stderr = io.StringIO(), io.StringIO()
    # os.environ is restored on exit: arduino's main() exports $AGENT_ID from --agent for its
    # children, which would otherwise leak into every later test in this process.
    with mock.patch.object(sys, "argv", full_argv), mock.patch.dict(os.environ):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                if e.code is None:
                    code = 0
                elif isinstance(e.code, int):
                    code = e.code
                else:
                    code = 1
    return code, stdout.getvalue(), stderr.getvalue()


def _post_call_for_path(post_mock, path):
    for call in post_mock.call_args_list:
        args, kwargs = call
        call_path = args[0] if args else kwargs.get("path")
        if call_path == path:
            return call
    return None


def _function_source_segment(path, name):
    """AST-extract the exact source text of a top-level `def <name>` in
    `path` -- copied verbatim from
    test_cr054_verb_surface_lift.py::_function_source_segment."""
    text = path.read_text()
    tree = ast.parse(text, filename=str(path))
    for node in tree.body:
        if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == name):
            return ast.get_source_segment(text, node)
    return None


def _write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


# ── fixture XML bodies (per client's real JUnit shape) ──────────────────────

# xmlrunner (python): testcases stamp `classname`, never `file`.
PY_CLASSNAME_A = (
    '<?xml version="1.0" ?>'
    '<testsuite name="tests.suite_a" tests="2" failures="0">'
    '<testcase classname="tests.suite_a.ClassA" name="test_one" time="0.001"/>'
    '<testcase classname="tests.suite_a.ClassA" name="test_two" time="0.001"/>'
    '</testsuite>'
)
PY_CLASSNAME_B = (
    '<?xml version="1.0" ?>'
    '<testsuite name="tests.suite_b" tests="1" failures="0">'
    '<testcase classname="tests.suite_b.ClassB" name="test_three" time="0.001"/>'
    '</testsuite>'
)
# surefire (mvn): testcases stamp `classname`, never `file`.
MVN_CLASSNAME_A = (
    '<?xml version="1.0" ?>'
    '<testsuite name="com.acme.FooTest" tests="2" failures="0">'
    '<testcase classname="com.acme.FooTest" name="testOne" time="0.01"/>'
    '<testcase classname="com.acme.FooTest" name="testTwo" time="0.01"/>'
    '</testsuite>'
)
MVN_CLASSNAME_B = (
    '<?xml version="1.0" ?>'
    '<testsuite name="com.acme.BarTest" tests="1" failures="0">'
    '<testcase classname="com.acme.BarTest" name="testThree" time="0.01"/>'
    '</testsuite>'
)

# arduino native harness: per §S1's own instruction, checked for `file` FIRST.
ARDUINO_FILE_ATTR = (
    '<?xml version="1.0" ?>'
    '<testsuites>'
    '<testsuite name="NativeSuiteA">'
    '<testcase file="test_foo.cpp" name="test_one" time="0.001"/>'
    '<testcase file="test_bar.cpp" name="test_two" time="0.001"/>'
    '</testsuite>'
    '</testsuites>'
)
ARDUINO_BARE = (
    '<?xml version="1.0" ?>'
    '<testsuites>'
    '<testsuite name="NativeBareOne">'
    '<testcase name="test_x" time="0.001"/>'
    '</testsuite>'
    '<testsuite name="NativeBareTwo">'
    '<testcase name="test_y" time="0.001"/>'
    '</testsuite>'
    '</testsuites>'
)



# ── python-crucible.py :: the envelope's files, as the board answers it ─────


class PythonFilesCountParityTest(unittest.TestCase):
    PROJECT_KEY = "cr051-c1-python-key"

    def setUp(self):
        self.module = _load_module_by_path(PYTHON_SCRIPT, "cr051_c1_python_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="cr051-c1-python-")
        _write(os.path.join(self.tmpdir, ".env"),
               f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_auto_ingest_run_envelope_carries_files_alongside_core_counts(self):
        """§S2 AC: `files` rides the `run:` envelope alongside
        passed/failed/pending/total, driven through the REAL `auto-ingest`
        CLI verb over a REAL reports dir (no hand-built harness bypassing the
        production entry point). The client counts nothing: every figure is
        the board's answer, which here differs from any count of the two
        reports, so an envelope stating the client's own parse is caught."""
        reports_dir = os.path.join(self.tmpdir, "test-reports")
        _write(os.path.join(reports_dir, "TEST-A.xml"), PY_CLASSNAME_A)
        _write(os.path.join(reports_dir, "TEST-B.xml"), PY_CLASSNAME_B)
        board_run = {"passed": 9, "failed": 0, "pending": 0, "total": 9, "files": 5}

        def post(path, payload):
            if path == "/api/v2/runs":
                return {"ok": True, "changed": True, "run": dict(board_run)}
            return {"ok": True}

        with mock.patch.object(self.module, "_post", side_effect=post,
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", side_effect=get_answering_health(),
                               create=True):
            code, out, err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-CRU-051-C1-py-check",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")
        self.assertEqual(ingest_call[0][1].get("data") if ingest_call else None,
                         [PY_CLASSNAME_A, PY_CLASSNAME_B],
                         "the two reports are sent as they stand, in path order")

        toon = _load_module_by_path(CLIENTS_DIR / "toon.py", "cr051_c1_toon_for_python")
        decoded = toon.decode(out)
        axi = decoded["axi"]
        run = axi.get("run")
        self.assertIsInstance(run, dict)
        self.assertEqual(
            run, board_run,
            f"the printed run: envelope must carry the board's files=5 "
            f"alongside its core counts; got run={run!r}")

    def test_ingest_payload_never_carries_files_key(self):
        """Non-goal / AC (verbatim): "files rides the printed envelope only,
        never the ingest payload." The client sends its reports and no
        parse of them: the `/api/v2/runs` body carries no `files` key and no
        `summary` at all. This drives the real ingest through a mocked
        `_post` and inspects the actual outgoing body."""
        reports_dir = os.path.join(self.tmpdir, "test-reports")
        _write(os.path.join(reports_dir, "TEST-A.xml"), PY_CLASSNAME_A)

        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", side_effect=get_answering_health(),
                               create=True):
            code, out, _err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-CRU-051-C1-py-nofiles",
                "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call)
        payload = ingest_call[0][1] if ingest_call else {}
        self.assertNotIn(
            "files", payload,
            "the ingest payload's top level must never carry a files key")
        self.assertNotIn(
            "summary", payload,
            "the ingest payload carries no client parse, so no summary -- "
            "files rides the printed run: envelope only (CR-CRU-047 §S2)")


# ── mvn-crucible.py :: the envelope's files, as the board answers it ────────


class MvnFilesCountParityTest(unittest.TestCase):
    PROJECT_KEY = "cr051-c1-mvn-key"

    def setUp(self):
        self.module = _load_module_by_path(MVN_SCRIPT, "cr051_c1_mvn_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="cr051-c1-mvn-")
        _write(os.path.join(self.tmpdir, ".env"),
               f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def write_surefire_and_failsafe(self):
        _write(os.path.join(self.tmpdir, "target", "surefire-reports",
                            "TEST-FooTest.xml"), MVN_CLASSNAME_A)
        _write(os.path.join(self.tmpdir, "target", "failsafe-reports",
                            "TEST-BarTest.xml"), MVN_CLASSNAME_B)

    def test_auto_ingest_run_envelope_carries_files_alongside_core_counts(self):
        """`files` rides the `run:` envelope alongside passed/failed/pending/
        total, driven through the REAL `auto-ingest` verb over a surefire and
        a failsafe reports dir. The client counts nothing: every figure is
        the board's answer, which here differs from any count of the two
        reports, so an envelope stating the client's own parse is caught."""
        self.write_surefire_and_failsafe()
        board_run = {"passed": 9, "failed": 0, "pending": 0, "total": 9, "files": 5}

        def post(path, payload):
            if path == "/api/v2/runs":
                return {"ok": True, "changed": True, "run": dict(board_run)}
            return {"ok": True}

        with mock.patch.object(self.module, "_post", side_effect=post,
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", side_effect=get_answering_health(),
                               create=True):
            code, out, err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-CRU-051-C1-mvn-check",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertIsNone(_post_call_for_path(post_mock, "/api/v2/runs/parsed"),
                          "nothing goes to the parsed route")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")
        self.assertEqual(ingest_call[0][1].get("data") if ingest_call else None,
                         [MVN_CLASSNAME_A, MVN_CLASSNAME_B],
                         "the surefire then the failsafe report are sent as "
                         "they stand")

        toon = _load_module_by_path(CLIENTS_DIR / "toon.py", "cr051_c1_toon_for_mvn")
        run = toon.decode(out)["axi"].get("run")
        self.assertEqual(
            run, board_run,
            f"the printed run: envelope must carry the board's files=5 "
            f"alongside its core counts; got run={run!r}")

    def test_ingest_payload_never_carries_files_key(self):
        """The client sends its reports and no parse of them: the
        `/api/v2/runs` body carries no `files` key and no `summary` at all."""
        self.write_surefire_and_failsafe()

        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", side_effect=get_answering_health(),
                               create=True):
            code, out, _err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-CRU-051-C1-mvn-nofiles",
                "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call)
        payload = ingest_call[0][1] if ingest_call else {}
        self.assertNotIn("files", payload,
                         "the ingest payload's top level must never carry a files key")
        self.assertNotIn(
            "summary", payload,
            "the ingest payload carries no client parse, so no summary -- "
            "files rides the printed run: envelope only")


# ── arduino-crucible.py :: _parse_junit ─────────────────────────────────────


class ArduinoFilesCountParityTest(unittest.TestCase):
    PROJECT_KEY = "cr051-c1-arduino-key"
    PROJECT_NAME = "cr051-c1-fixture-firmware"

    def setUp(self):
        self.module = _load_module_by_path(ARDUINO_SCRIPT, "cr051_c1_arduino_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="cr051-c1-arduino-")
        _write(os.path.join(self.tmpdir, ".env"),
               f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n"
               f"CRUCIBLE_PROJECT_NAME={self.PROJECT_NAME}\n")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_parse_junit_computes_distinct_file_count_when_file_attribute_present(self):
        """§S1: "the arduino native harness should be checked for a `file`
        attribute FIRST." When the native g++ JUnit emitter stamps `file`,
        the count must be genuinely per-FILE (2 distinct .cpp files across 2
        testcases in one native report)."""
        junit_path = os.path.join(self.tmpdir, "TEST-native.xml")
        _write(junit_path, ARDUINO_FILE_ATTR)

        summary, tree, files = self.module._parse_junit(junit_path)

        self.assertEqual(summary["total"], 2)
        self.assertEqual(
            files, 2,
            f"expected 2 distinct file= values (test_foo.cpp, test_bar.cpp); "
            f"got files={files!r}")

    def test_parse_junit_fallback_to_suite_name_is_never_zero(self):
        """AC (verbatim): the fallback must never collapse to 0. Here no
        testcase carries `file` OR `classname` -- only the native harness's
        own suite name is available, across two suites in one report."""
        junit_path = os.path.join(self.tmpdir, "TEST-native.xml")
        _write(junit_path, ARDUINO_BARE)

        summary, tree, files = self.module._parse_junit(junit_path)

        self.assertEqual(summary["total"], 2)
        self.assertGreater(files, 0, "files must never degrade to 0")
        self.assertEqual(
            files, 2,
            f"with no file/classname anywhere, files must fall back to the "
            f"2 distinct SUITE names; got files={files!r}")

    def test_granularity_is_documented_in_a_comment_beside_the_parser(self):
        body = _function_source_segment(ARDUINO_SCRIPT, "_parse_junit")
        self.assertIsNotNone(body, "_parse_junit must exist as a top-level def")
        self.assertIn(
            "granularity", body.lower(),
            "_parse_junit's docstring/comment must record its resolved "
            "files-count granularity -- not present yet")

    def test_auto_ingest_run_envelope_carries_files_alongside_core_counts(self):
        reports_dir = os.path.join(self.tmpdir, "tests", "native", "reports")
        _write(os.path.join(reports_dir, "TEST-native.xml"), ARDUINO_FILE_ATTR)

        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-CRU-051-C1-arduino-check",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")

        toon = _load_module_by_path(CLIENTS_DIR / "toon.py", "cr051_c1_toon_for_arduino")
        decoded = toon.decode(out)
        axi = decoded["axi"]
        run = axi.get("run")
        self.assertIsInstance(run, dict)
        self.assertEqual(run.get("total"), 2)
        self.assertEqual(
            run.get("files"), 2,
            f"the printed run: envelope must carry files=2 alongside the "
            f"core counts; got run={run!r}")

    def test_ingest_payload_never_carries_files_key(self):
        reports_dir = os.path.join(self.tmpdir, "tests", "native", "reports")
        _write(os.path.join(reports_dir, "TEST-native.xml"), ARDUINO_FILE_ATTR)

        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-CRU-051-C1-arduino-nofiles",
                "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call)
        payload = ingest_call[0][1]
        self.assertNotIn("files", payload,
                         "the ingest payload's top level must never carry a files key")
        self.assertNotIn(
            "files", payload.get("summary", {}),
            "the ingest payload's summary must never carry a files key -- "
            "it rides the printed run: envelope only (CR-CRU-047 §S2)")


if __name__ == "__main__":
    unittest.main()
