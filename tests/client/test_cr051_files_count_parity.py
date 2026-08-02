"""CR-CRU-051 C1 RED -- propagate the run-envelope `files` (distinct test-FILE)
count from `bun-crucible.py` (the reference, CR-CRU-047 §S2) to python, mvn and
arduino. rust is C2 (its two parse sites + the server-parsed `_ingest_junit_axi`
distinction have their own complications) and is deliberately OUT of this file.

Contract pinned VERBATIM from
docs/changes/CR-CRU-051-files-count-fleet-parity.md:

  §S1 -- "Follow bun-crucible.py:_parse_junit_file, which is the reference. Its
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

RED phase: `python-crucible.py::_parse_junit_dir`, `mvn-crucible.py::_parse_junit`
and `arduino-crucible.py::_parse_junit` all return a bare `(summary, tree)`
2-tuple today (confirmed by reading the source) -- unpacking a third `files`
element raises `ValueError: not enough values to unpack`, a real behavioral
failure. Their `run:` envelopes (`_emit_ingest_axi` / `_emit_ingest_summary_axi`)
build `run = {"passed", "failed", "pending", "total"}` with no `files` key at
all. Neither parser's docstring/comment mentions "granularity" anywhere
(confirmed by grep). Every test below against these three clients therefore
fails now for the right reason. The bun-client tests are a REGRESSION PIN
(AC "confirmed, not assumed") -- bun already carries this behavior from
CR-CRU-047, so those specific assertions may already pass; they are not new
capability, they guard against this CR's edits touching the reference by
mistake.

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

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"

PYTHON_SCRIPT = CLIENTS_DIR / "python-crucible.py"
MVN_SCRIPT = CLIENTS_DIR / "mvn-crucible.py"
ARDUINO_SCRIPT = CLIENTS_DIR / "arduino-crucible.py"
BUN_SCRIPT = CLIENTS_DIR / "bun-crucible.py"


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
    with mock.patch.object(sys, "argv", full_argv):
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
# Neither `file` NOR `classname` present anywhere -- the deepest fallback rung.
PY_BARE_ONE = (
    '<?xml version="1.0" ?>'
    '<testsuite name="tests.bare_one" tests="1" failures="0">'
    '<testcase name="test_x" time="0.001"/>'
    '</testsuite>'
)
PY_BARE_TWO = (
    '<?xml version="1.0" ?>'
    '<testsuite name="tests.bare_two" tests="1" failures="0">'
    '<testcase name="test_y" time="0.001"/>'
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
MVN_BARE_A = (
    '<?xml version="1.0" ?>'
    '<testsuite name="com.acme.BareOne" tests="1" failures="0">'
    '<testcase name="testX" time="0.01"/>'
    '</testsuite>'
)
MVN_BARE_B = (
    '<?xml version="1.0" ?>'
    '<testsuite name="com.acme.BareTwo" tests="1" failures="0">'
    '<testcase name="testY" time="0.01"/>'
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

# bun (reference/unchanged): testcases stamp `file` (CR-CRU-047 §S2).
BUN_FILE_ATTR = (
    '<?xml version="1.0" ?>'
    '<testsuites>'
    '<testsuite name="toon.test.ts">'
    '<testcase file="tests/a.test.ts" name="passes_a" time="0.001"></testcase>'
    '<testcase file="tests/b.test.ts" name="passes_b" time="0.001"></testcase>'
    '</testsuite>'
    '</testsuites>'
)
BUN_BARE = (
    '<?xml version="1.0" ?>'
    '<testsuites>'
    '<testsuite name="toon.bare.ts">'
    '<testcase name="passes" time="0.001"></testcase>'
    '</testsuite>'
    '</testsuites>'
)


# ── python-crucible.py :: _parse_junit_dir ──────────────────────────────────


class PythonFilesCountParityTest(unittest.TestCase):
    PROJECT_KEY = "cr051-c1-python-key"

    def setUp(self):
        self.module = _load_module_by_path(PYTHON_SCRIPT, "cr051_c1_python_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="cr051-c1-python-")
        _write(os.path.join(self.tmpdir, ".env"),
               f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_parse_junit_dir_computes_distinct_classname_count(self):
        """§S1 AC: the parser returns a THIRD `files` element -- the distinct
        source count -- alongside (summary, tree). xmlrunner never stamps
        `file`, so the count here is `classname`-derived (2 distinct classes
        across 3 testcases). A no-op stub that keeps returning a 2-tuple
        fails this at the unpack, not at a value comparison."""
        reports_dir = os.path.join(self.tmpdir, "reports")
        _write(os.path.join(reports_dir, "TEST-A.xml"), PY_CLASSNAME_A)
        _write(os.path.join(reports_dir, "TEST-B.xml"), PY_CLASSNAME_B)

        summary, tree, files = self.module._parse_junit_dir(reports_dir)

        self.assertEqual(summary["total"], 3)
        self.assertEqual(summary["passed"], 3)
        self.assertEqual(
            files, 2,
            f"expected 2 distinct classnames (tests.suite_a.ClassA, "
            f"tests.suite_b.ClassB) across the two reports; got files={files!r}")

    def test_parse_junit_dir_fallback_to_suite_name_is_never_zero(self):
        """AC (verbatim): "A report whose testcases carry no `file` attribute
        still yields a NON-ZERO `files` count via the `classname` ->
        suite-name fallback." Here neither `file` NOR `classname` is present
        anywhere -- the deepest rung of the chain -- so the count must still
        degrade to the distinct SUITE names (2), never collapse to 0."""
        reports_dir = os.path.join(self.tmpdir, "reports")
        _write(os.path.join(reports_dir, "TEST-Bare1.xml"), PY_BARE_ONE)
        _write(os.path.join(reports_dir, "TEST-Bare2.xml"), PY_BARE_TWO)

        summary, tree, files = self.module._parse_junit_dir(reports_dir)

        self.assertEqual(summary["total"], 2)
        self.assertGreater(
            files, 0,
            "files must NEVER degrade to 0 -- a constant zero would make a "
            "shrinking suite look identical to a healthy one")
        self.assertEqual(
            files, 2,
            f"with no file/classname attribute anywhere, files must fall "
            f"back to the 2 distinct SUITE names; got files={files!r}")

    def test_granularity_is_documented_in_a_comment_beside_the_parser(self):
        """AC: "The resolved granularity per client (file vs class) is
        recorded in a comment beside each implementation." xmlrunner stamps
        `classname`, so python's real granularity is per-CLASS, not
        per-file -- that honesty must be readable in the source."""
        body = _function_source_segment(PYTHON_SCRIPT, "_parse_junit_dir")
        self.assertIsNotNone(body, "_parse_junit_dir must exist as a top-level def")
        self.assertIn(
            "granularity", body.lower(),
            "_parse_junit_dir's docstring/comment must record its resolved "
            "files-count granularity (file vs class) -- not present yet")

    def test_auto_ingest_run_envelope_carries_files_alongside_core_counts(self):
        """§S2 AC: `files` rides the `run:` envelope alongside
        passed/failed/pending/total, driven through the REAL `auto-ingest`
        CLI verb over a REAL reports dir (no hand-built harness bypassing the
        production entry point)."""
        reports_dir = os.path.join(self.tmpdir, "test-reports")
        _write(os.path.join(reports_dir, "TEST-A.xml"), PY_CLASSNAME_A)
        _write(os.path.join(reports_dir, "TEST-B.xml"), PY_CLASSNAME_B)

        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-CRU-051-C1-py-check",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")

        toon = _load_module_by_path(CLIENTS_DIR / "toon.py", "cr051_c1_toon_for_python")
        decoded = toon.decode(out)
        axi = decoded["axi"]
        run = axi.get("run")
        self.assertIsInstance(run, dict)
        self.assertEqual(run.get("passed"), 3)
        self.assertEqual(run.get("total"), 3)
        self.assertEqual(
            run.get("files"), 2,
            f"the printed run: envelope must carry files=2 alongside the "
            f"core counts; got run={run!r}")

    def test_ingest_payload_never_carries_files_key(self):
        """Non-goal / AC (verbatim): "files rides the printed envelope only,
        never the ingest payload." The parser's `summary` dict IS the
        `/api/v2/runs/parsed` payload's `summary` field verbatim -- a naive
        GREEN that stuffs `files` INTO the summary dict (rather than
        threading it as a sibling return value) would leak it onto the wire.
        This drives the real ingest through a mocked `_post` and inspects the
        actual outgoing body."""
        reports_dir = os.path.join(self.tmpdir, "test-reports")
        _write(os.path.join(reports_dir, "TEST-A.xml"), PY_CLASSNAME_A)

        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-CRU-051-C1-py-nofiles",
                "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call)
        payload = ingest_call[0][1]
        self.assertNotIn(
            "files", payload,
            "the ingest payload's top level must never carry a files key")
        self.assertNotIn(
            "files", payload.get("summary", {}),
            "the ingest payload's summary must never carry a files key -- "
            "it rides the printed run: envelope only (CR-CRU-047 §S2)")


# ── mvn-crucible.py :: _parse_junit ─────────────────────────────────────────


class MvnFilesCountParityTest(unittest.TestCase):
    PROJECT_KEY = "cr051-c1-mvn-key"

    def setUp(self):
        self.module = _load_module_by_path(MVN_SCRIPT, "cr051_c1_mvn_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="cr051-c1-mvn-")
        _write(os.path.join(self.tmpdir, ".env"),
               f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_parse_junit_computes_distinct_classname_count_across_dirs(self):
        """surefire never stamps `file`, so mvn's count is `classname`-derived
        (2 distinct classes across 3 testcases, spread over two report
        dirs -- mirroring the real surefire/failsafe split)."""
        dir_a = os.path.join(self.tmpdir, "target", "surefire-reports")
        dir_b = os.path.join(self.tmpdir, "target", "failsafe-reports")
        _write(os.path.join(dir_a, "TEST-FooTest.xml"), MVN_CLASSNAME_A)
        _write(os.path.join(dir_b, "TEST-BarTest.xml"), MVN_CLASSNAME_B)

        summary, tree, files = self.module._parse_junit([dir_a, dir_b])

        self.assertEqual(summary["total"], 3)
        self.assertEqual(
            files, 2,
            f"expected 2 distinct classnames (com.acme.FooTest, "
            f"com.acme.BarTest); got files={files!r}")

    def test_parse_junit_fallback_to_suite_name_is_never_zero(self):
        """AC (verbatim): the classname -> suite-name fallback must never
        collapse to 0. Here no testcase carries `classname` at all."""
        dir_a = os.path.join(self.tmpdir, "target", "surefire-reports")
        dir_b = os.path.join(self.tmpdir, "target", "failsafe-reports")
        _write(os.path.join(dir_a, "TEST-Bare1.xml"), MVN_BARE_A)
        _write(os.path.join(dir_b, "TEST-Bare2.xml"), MVN_BARE_B)

        summary, tree, files = self.module._parse_junit([dir_a, dir_b])

        self.assertGreater(files, 0, "files must never degrade to 0")
        self.assertEqual(
            files, 2,
            f"with no classname anywhere, files must fall back to the 2 "
            f"distinct SUITE names; got files={files!r}")

    def test_granularity_is_documented_in_a_comment_beside_the_parser(self):
        body = _function_source_segment(MVN_SCRIPT, "_parse_junit")
        self.assertIsNotNone(body, "_parse_junit must exist as a top-level def")
        self.assertIn(
            "granularity", body.lower(),
            "_parse_junit's docstring/comment must record its resolved "
            "files-count granularity (file vs class) -- not present yet")

    def test_auto_ingest_run_envelope_carries_files_alongside_core_counts(self):
        """Two report dirs (surefire + failsafe) forces the CLIENT-parsed
        `_parse_junit` + `_emit_ingest_summary_axi` path (a single dir takes
        the server-side codec=junit fast path, which has no client-side
        `files` to emit -- out of scope here, matching the CR's own
        server-parsed-path caveat)."""
        dir_a = os.path.join(self.tmpdir, "target", "surefire-reports")
        dir_b = os.path.join(self.tmpdir, "target", "failsafe-reports")
        _write(os.path.join(dir_a, "TEST-FooTest.xml"), MVN_CLASSNAME_A)
        _write(os.path.join(dir_b, "TEST-BarTest.xml"), MVN_CLASSNAME_B)

        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-CRU-051-C1-mvn-check",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")

        toon = _load_module_by_path(CLIENTS_DIR / "toon.py", "cr051_c1_toon_for_mvn")
        decoded = toon.decode(out)
        axi = decoded["axi"]
        run = axi.get("run")
        self.assertIsInstance(run, dict)
        self.assertEqual(run.get("total"), 3)
        self.assertEqual(
            run.get("files"), 2,
            f"the printed run: envelope must carry files=2 alongside the "
            f"core counts; got run={run!r}")

    def test_ingest_payload_never_carries_files_key(self):
        dir_a = os.path.join(self.tmpdir, "target", "surefire-reports")
        dir_b = os.path.join(self.tmpdir, "target", "failsafe-reports")
        _write(os.path.join(dir_a, "TEST-FooTest.xml"), MVN_CLASSNAME_A)
        _write(os.path.join(dir_b, "TEST-BarTest.xml"), MVN_CLASSNAME_B)

        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-CRU-051-C1-mvn-nofiles",
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


# ── bun-crucible.py :: _parse_junit_file -- REGRESSION PIN, not new capability ──


class BunFilesCountUnchangedTest(unittest.TestCase):
    """AC (verbatim): "bun-crucible.py is unchanged (already correct) --
    confirmed, not assumed." bun already implements this (CR-CRU-047 §S2), so
    these specific assertions may already pass on first run -- that is
    EXPECTED and correct for a regression pin (it is not exercising new
    capability; it is guarding the reference implementation against this
    CR's edits touching the other four clients by mistake). The file's
    overall RED signal comes from the python/mvn/arduino classes above, which
    fail today."""

    PROJECT_KEY = "cr051-c1-bun-key"

    def setUp(self):
        self.module = _load_module_by_path(BUN_SCRIPT, "cr051_c1_bun_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="cr051-c1-bun-")
        _write(os.path.join(self.tmpdir, ".env"),
               f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_parse_junit_file_still_computes_distinct_file_count(self):
        junit_path = os.path.join(self.tmpdir, "junit.xml")
        _write(junit_path, BUN_FILE_ATTR)

        summary, tree, files = self.module._parse_junit_file(junit_path)

        self.assertEqual(summary["total"], 2)
        self.assertEqual(
            files, 2,
            f"bun's reference implementation must still compute 2 distinct "
            f"file= values (tests/a.test.ts, tests/b.test.ts); "
            f"got files={files!r}")

    def test_parse_junit_file_fallback_to_suite_name_still_never_zero(self):
        junit_path = os.path.join(self.tmpdir, "junit.xml")
        _write(junit_path, BUN_BARE)

        summary, tree, files = self.module._parse_junit_file(junit_path)

        self.assertEqual(summary["total"], 1)
        self.assertGreater(
            files, 0,
            "bun's reference fallback must still never degrade to 0")
        self.assertEqual(files, 1)

    def test_ingest_payload_still_never_carries_files_key(self):
        """The `files` count bun already computes must still ride the
        printed envelope only, never the `/api/v2/runs/parsed` payload."""
        junit_path = os.path.join(self.tmpdir, "junit.xml")
        _write(junit_path, BUN_FILE_ATTR)
        summary, tree, files = self.module._parse_junit_file(junit_path)

        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            self.module._ingest_parsed(
                self.tmpdir, "CR-CRU-051-C1-bun-nofiles", summary, tree)

        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call)
        payload = ingest_call[0][1]
        self.assertNotIn("files", payload)
        self.assertNotIn("files", payload.get("summary", {}))


if __name__ == "__main__":
    unittest.main()
