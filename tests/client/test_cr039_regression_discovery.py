"""CR-CRU-039 C1 RED -- python-crucible.py `regression` silently discovers 0
tests from its documented default `--start-dir tests` because `tests/` (and
`tests/client/`) lack `__init__.py`, so `unittest discover -s tests` treats
`tests/client/` as a non-package subdirectory and does NOT recurse into it --
0 tests are collected. With 0 tests, xmlrunner writes no `TEST-*.xml`, so
`_produced_xml` is False and the client falls into a masked "no JUnit XML
produced -- ingesting as compile" branch instead of reporting the real
zero-discovery condition.

Contract pinned from docs/changes/CR-CRU-039-python-regression-discovery.md:

  Sec S1 -- Make the Python suite discoverable from the default `start_dir`:
  adding `tests/__init__.py` + `tests/client/__init__.py` must make
  `discover -s tests -p 'test_*.py'` recurse into `tests/client/` and collect
  the full suite (374 tests as of authoring; asserted here as a robust >=300
  lower bound, not the brittle exact count, per the dispatch).

  Sec S2 -- A zero-test discovery is a DEFINITIVE AXI error, never a masked
  "compile": a `regression` run whose discovery collects ZERO tests (as
  opposed to a genuine import/collection failure) must emit a structured
  `no-tests-discovered` warning (naming the start_dir + pattern) inside the
  Sec S1 TOON-AXI envelope on stdout, with a `help[]` next-step, exit
  non-zero, and must NOT route through `_ingest_compile(..., tier="regression")`
  -- that path is reserved for a genuine compile/import failure (stderr
  carrying a traceback), never an honest empty collection.

RED phase (both confirmed by direct manual invocation before writing this
file):
  - Sec S1: `python -m xmlrunner discover -s tests -p 'test_*.py'` today
    collects 0 tests and produces no TEST-*.xml at all (confirmed), while
    `discover -s tests/client` collects 374 (confirmed) -- so the default
    `_xmlrunner_cmd(..., "tests", ...)` invocation fails this test's
    >=300-test lower bound today.
  - Sec S2: the current `_regression_run` zero-discovery branch
    (python-crucible.py ~700-705) prints ONLY a stderr line and calls
    `_ingest_compile(project_dir, args.agent, ..., tier="regression")` --
    there is no TOON-AXI envelope on stdout at all (no `axi` key to decode)
    and the compile-tier ingest IS invoked, so both proven via a patched spy.

Module-loading + HTTP-mocking convention mirrored from the sibling
`tests/client/test_python_crucible_axi.py` harness: load the hyphen-named
client by file path via `importlib`, mock its `_post`/`_ingest_compile` seams
so the live Crucible server is never touched and the masked-compile call
path can be asserted against directly.
"""

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
SCRIPT_PATH = REPO_ROOT / "clients" / "python-crucible.py"
TOON_PATH = REPO_ROOT / "clients" / "toon.py"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module():
    return _load_module(SCRIPT_PATH, "python_crucible_under_test_cr039")


def _load_toon_module():
    return _load_module(TOON_PATH, "toon_under_test_for_cr039")


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched. Returns (code, stdout, stderr).
    Only SystemExit is caught -- any OTHER exception propagates so unittest
    reports it as an ERROR (still a valid RED signal)."""
    full_argv = ["python-crucible.py"] + argv
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


class RegressionDiscoversFullSuiteFromDefaultStartDirTest(unittest.TestCase):
    """Sec S1 -- `regression`'s default `--start-dir tests` must recurse into
    `tests/client/` (20+ files) and collect the whole suite, not 0 tests."""

    def test_default_start_dir_discovers_and_collects_the_full_suite(self):
        # Pure in-process COLLECTION check: `discover` IMPORTS the test modules
        # (so this still fails RED on a tree where `tests/` / `tests/client/`
        # lack `__init__.py` -- discover then won't recurse into the non-package
        # subdir and collects 0) but `.countTestCases()` EXECUTES nothing. No
        # subprocess, no recursion, no XML -- ~0.08s instead of a full second
        # discovery run.
        start_dir = str(REPO_ROOT / "tests")
        pattern = "test_*.py"
        count = unittest.TestLoader().discover(
            start_dir, pattern=pattern, top_level_dir=str(REPO_ROOT),
        ).countTestCases()
        self.assertGreaterEqual(
            count, 300,
            f"expected `discover(start_dir={start_dir!r}, pattern={pattern!r})` "
            f"to collect the full Python suite (>=300 tests, ~374 as of "
            f"authoring); got only {count} -- tests/client/ is not being "
            f"recursed into from the 'tests' start_dir (ensure tests/ AND "
            f"tests/client/ are packages with __init__.py)",
        )


class RegressionZeroDiscoveryEmitsDefinitiveNoTestsDiscoveredErrorTest(unittest.TestCase):
    """Sec S2 -- a `regression` discovery that collects ZERO tests (a
    start_dir/pattern matching nothing) must be a DEFINITIVE
    `no-tests-discovered` AXI error -- not the masked "no JUnit XML produced
    -- ingesting as compile" fallback, which hides the real zero-discovery
    cause behind a compile ingest."""

    PROJECT_KEY = "test-key-cr039-regression"

    def setUp(self):
        self.module = _load_client_module()
        self.toon = _load_toon_module()
        self.project_dir = tempfile.mkdtemp(prefix="cr039-s2-project-")
        with open(os.path.join(self.project_dir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        # A REAL, existing, but completely empty directory -- discover finds
        # nothing here, exactly the "start_dir/pattern matching nothing" case
        # the CR specifies, as opposed to a genuine import/syntax failure.
        self.empty_start_dir = os.path.join(self.project_dir, "empty_suite")
        os.makedirs(self.empty_start_dir, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.project_dir, ignore_errors=True)

    def _decode_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn(
            "axi", decoded,
            f"a zero-test discovery must still emit a Sec S1 TOON-AXI "
            f"envelope on stdout (a definitive no-tests-discovered error), "
            f"not silence; got stdout={stdout_text!r}",
        )
        return decoded["axi"]

    def test_zero_discovery_emits_definitive_no_tests_discovered_error_and_skips_compile_ingest(self):
        pattern = "test_*.py"
        with mock.patch.object(self.module, "_post", return_value={"ok": True}), \
             mock.patch.object(self.module, "_ingest_compile") as compile_mock:
            code, out, _err = _run_main(self.module, [
                "regression", "--agent", "CR-CRU-039-C1-RED-probe",
                "--project-dir", self.project_dir,
                "--start-dir", self.empty_start_dir,
                "--pattern", pattern,
            ])

        self.assertNotEqual(
            code, 0,
            "a zero-test discovery must exit non-zero (it is a definitive "
            "error condition, not a silent no-op success)",
        )

        axi = self._decode_axi(out)
        self.assertIs(
            axi.get("ok"), False,
            f"the zero-discovery envelope must report ok:false; got {axi!r}",
        )
        warnings_list = axi.get("warnings", [])
        no_tests_warning = next(
            (w for w in warnings_list if w.get("code") == "no-tests-discovered"), None,
        )
        self.assertIsNotNone(
            no_tests_warning,
            f"expected a structured 'no-tests-discovered' warning entry "
            f"naming the start_dir + pattern that matched nothing; got "
            f"warnings={warnings_list!r}",
        )
        detail_text = str(no_tests_warning.get("detail", ""))
        self.assertIn(
            self.empty_start_dir, detail_text,
            f"the no-tests-discovered warning must NAME the start_dir that "
            f"matched nothing; detail={detail_text!r}",
        )
        self.assertIn(
            pattern, detail_text,
            f"the no-tests-discovered warning must NAME the pattern that "
            f"matched nothing; detail={detail_text!r}",
        )
        help_steps = axi.get("help") or no_tests_warning.get("help") or []
        self.assertTrue(
            len(help_steps) > 0,
            f"expected a help[] next-step (e.g. 'check --start-dir/--pattern; "
            f"ensure the test dir is a package') on the definitive error "
            f"envelope; axi={axi!r}",
        )

        regression_tier_compile_calls = [
            call for call in compile_mock.call_args_list
            if call.kwargs.get("tier") == "regression"
            or (len(call.args) >= 4 and call.args[3] == "regression")
        ]
        self.assertEqual(
            regression_tier_compile_calls, [],
            f"a zero-test discovery must NOT be masked as a compile ingest "
            f"(_ingest_compile(..., tier='regression') is reserved for a "
            f"GENUINE import/collection failure); calls="
            f"{compile_mock.call_args_list!r}",
        )


if __name__ == "__main__":
    unittest.main()
