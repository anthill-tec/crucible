"""The pytest fixture project stays out of this repo's own suites.

`tests/fixtures/pytest-project` is a real pytest project the python client's
tests run from a scratch copy. It carries its own pytest configuration, whose
`python_files` names its test files `check_*.py` -- a name none of this repo's
own runs matches -- and it holds no `__init__.py`, so none of its files is
collected by:

* this repo's python runs: `python-crucible.py`'s unittest discovery (start dir
  `tests` or `tests/client`, pattern `test_*.py`) and CI's python job
  (`python3 -m unittest discover -s tests/client -t .`, pattern `test*.py`).
  unittest descends only into packages and collects only files matching its
  pattern;
* this repo's bun runs: a bare `bun test` (CI, `test:regression`) and the
  `test:unit` / `test:integration` targets `scripts/test-targets.ts` enumerates.

Proved from the discovery itself, cheaply: each discovery is pointed at the
fixture (or a scratch copy of it), with a control proving the probe would
have seen a file named the way that discovery collects. No nested full-suite
run. The fixture is also proved to be what later tests rely on: a real pytest
run of a scratch copy gives 1 passed, 1 failed and 1 skipped, and leaves the
checkout's copy untouched.

A test here that needs pytest FAILS, never skips, when the interpreter running
this suite cannot import it -- pytest is in this repo's `[dev]` extras.

Invocation:
    python3 -m unittest tests.client.test_pytest_fixture_stays_out_of_this_repos_suite -v
"""

import configparser
import fnmatch
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tomllib
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from tests.client.live_run_harness import REPO_ROOT, new_scratch, scrubbed_env

FIXTURE_REL = "tests/fixtures/pytest-project"
FIXTURE = REPO_ROOT / FIXTURE_REL
TIMEOUT = 120
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "release.yml"
PYPROJECT = REPO_ROOT / "pyproject.toml"

# The patterns this repo's python runs discover with: the python client's
# default, and unittest's own default (CI's `unittest discover` passes none).
REPO_PYTHON_PATTERNS = ("test_*.py", "test*.py")

_TARGET_LISTING = (
    'import { enumerateTestFiles, partitionTestFiles } from "./scripts/test-targets";\n'
    "const all = await enumerateTestFiles();\n"
    "const partition = await partitionTestFiles(all);\n"
    "console.log(JSON.stringify({ all, unit: partition.unit, "
    "integration: partition.integration }));\n"
)

_UNITTEST_CONTROL = (
    "import unittest\n\n\n"
    "class ControlTest(unittest.TestCase):\n"
    "    def test_control(self):\n"
    "        self.assertEqual(1, 1)\n"
)


def _fixture_python_files():
    return sorted(p.relative_to(FIXTURE).as_posix() for p in FIXTURE.rglob("*.py")
                  if "__pycache__" not in p.parts)


def _fixture_tree():
    """Every path under the fixture, `__pycache__` included: what a run left
    behind in the checkout is exactly what this must see."""
    return sorted(p.relative_to(FIXTURE).as_posix() for p in FIXTURE.rglob("*"))


def _declared_python_files():
    parser = configparser.ConfigParser()
    parser.read(FIXTURE / "pytest.ini")
    return parser.get("pytest", "python_files", fallback=None)


class _FixtureCase(unittest.TestCase):

    def setUp(self):
        self.assertTrue(FIXTURE.is_dir(), f"the committed pytest fixture must exist: {FIXTURE}")
        self.assertGreaterEqual(
            len(_fixture_python_files()), 1,
            f"the committed pytest fixture must hold its test files: {FIXTURE}")

    @staticmethod
    def run_python(args, cwd):
        return subprocess.run([sys.executable, *args], cwd=cwd, env=scrubbed_env(None),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)


class ThePytestFixtureIsItsOwnProjectTest(_FixtureCase):
    """Its own pytest configuration decides what it collects, and a real
    pytest run of a scratch copy files the three outcomes later tests rely on."""

    def test_the_fixture_declares_a_python_files_pattern_this_repos_runs_never_match(self):
        declared = _declared_python_files()
        self.assertEqual(declared, "check_*.py",
                         "the fixture's own pytest.ini must declare its python_files")
        assert declared is not None
        for pattern in REPO_PYTHON_PATTERNS:
            self.assertFalse(fnmatch.fnmatch(declared, pattern),
                             f"the declared python_files {declared!r} overlaps {pattern!r}")

    def test_the_fixture_holds_no_init_py_so_unittest_never_descends_into_it(self):
        self.assertFalse((REPO_ROOT / "tests" / "fixtures" / "__init__.py").exists(),
                         "tests/fixtures must not be a package")
        inits = [f for f in _fixture_python_files() if f.endswith("__init__.py")]
        self.assertEqual(inits, [], f"the fixture must hold no __init__.py: {inits!r}")

    def test_no_fixture_file_matches_a_pattern_this_repos_python_runs_discover(self):
        for name in _fixture_python_files():
            base = os.path.basename(name)
            for pattern in REPO_PYTHON_PATTERNS:
                self.assertFalse(fnmatch.fnmatch(base, pattern),
                                 f"fixture file {name} matches {pattern!r}")

    def test_a_scratch_copy_runs_one_passed_one_failed_one_skipped_and_the_checkout_is_untouched(self):
        if importlib.util.find_spec("pytest") is None:
            self.fail("pytest must be importable by this suite's interpreter "
                      "(it is in the [dev] extras); this proof runs a real pytest")
        before = _fixture_tree()
        scratch = new_scratch("pytest-fixture-run-")
        try:
            copy = Path(scratch, "project")
            shutil.copytree(FIXTURE, copy)
            report = Path(scratch, "report.xml")
            result = self.run_python(["-m", "pytest", "-v", f"--junitxml={report}"], copy)
            output = result.stdout + result.stderr
            # Exit 1: tests ran and one failed -- never 2/3/4/5.
            self.assertEqual(result.returncode, 1, f"output={output[-2000:]!r}")
            self.assertTrue(report.is_file(), f"no JUnit report; output={output[-2000:]!r}")
            cases = list(ET.parse(report).getroot().iter("testcase"))
            outcomes = {}
            for case in cases:
                if case.find("failure") is not None or case.find("error") is not None:
                    outcome = "failed"
                elif case.find("skipped") is not None:
                    outcome = "skipped"
                else:
                    outcome = "passed"
                outcomes[case.get("name")] = outcome
            self.assertEqual(outcomes, {"test_it_passes": "passed",
                                        "test_it_fails": "failed",
                                        "test_it_is_skipped": "skipped"},
                             f"output={output[-2000:]!r}")
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        self.assertEqual(_fixture_tree(), before,
                         "running the scratch copy must leave the checkout's fixture untouched")


class ThePytestFixtureStaysOutOfThisReposPythonRunsTest(_FixtureCase):

    def test_unittest_discovery_pointed_at_a_copy_of_the_fixture_finds_no_test_but_would_find_a_test_file(self):
        scratch = new_scratch("pytest-fixture-unittest-discovery-")
        try:
            copy = Path(scratch, "project")
            shutil.copytree(FIXTURE, copy)
            for pattern in REPO_PYTHON_PATTERNS:
                with self.subTest(pattern=pattern):
                    result = self.run_python(
                        ["-m", "unittest", "discover", "-s", ".", "-t", ".",
                         "-p", pattern, "-v"], copy)
                    output = result.stdout + result.stderr
                    self.assertIn("Ran 0 tests", output,
                                  f"exit={result.returncode} output={output[-2000:]!r}")
                    self.assertNotEqual(result.returncode, 0, f"output={output[-2000:]!r}")

            # The control: the same discovery DOES see a file named the way it
            # collects, so the empty result above is the naming, not the probe.
            Path(copy, "test_control.py").write_text(_UNITTEST_CONTROL)
            for pattern in REPO_PYTHON_PATTERNS:
                with self.subTest(control=pattern):
                    control = self.run_python(
                        ["-m", "unittest", "discover", "-s", ".", "-t", ".",
                         "-p", pattern, "-v"], copy)
                    control_output = control.stdout + control.stderr
                    self.assertIn("Ran 1 test", control_output,
                                  f"output={control_output[-2000:]!r}")
                    self.assertEqual(control.returncode, 0,
                                     f"output={control_output[-2000:]!r}")
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    def test_the_fixture_lies_outside_ci_and_the_clients_tests_client_start_dir(self):
        client_dir = (REPO_ROOT / "tests" / "client").resolve()
        self.assertNotIn(client_dir, [FIXTURE.resolve(), *FIXTURE.resolve().parents],
                         "the fixture must not live under tests/client")

    def test_ci_runs_the_tests_client_unittest_discovery(self):
        # CI's python step is the discovery the probes above prove; another
        # start dir or a pattern argument there would be a different collection.
        steps = [line.strip() for line in CI_WORKFLOW.read_text().splitlines()
                 if line.strip().startswith("run: python3 -m unittest")]
        self.assertEqual(steps, ["run: python3 -m unittest discover -s tests/client -t ."],
                         f"CI's python test steps: {steps!r}")


class ThePytestFixtureStaysOutOfThisReposBunSuiteTest(_FixtureCase):

    def setUp(self):
        super().setUp()
        bun = shutil.which("bun")
        if bun is None:
            self.fail("this proof asks the real `bun` what it collects")
        self.bun: str = bun

    def run_bun(self, args, cwd):
        return subprocess.run([self.bun, *args], cwd=cwd, env=scrubbed_env(None),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def test_bun_test_from_the_repo_root_collects_no_fixture_file(self):
        result = self.run_bun(["test", "--timeout", "30000", f"./{FIXTURE_REL}"], REPO_ROOT)
        output = result.stdout + result.stderr
        self.assertIn("did not match any test files", output,
                      f"bun test must collect none of the fixture's files; "
                      f"exit={result.returncode} output={output[-2000:]!r}")
        self.assertNotIn("Ran ", output, f"output={output[-2000:]!r}")
        self.assertNotEqual(result.returncode, 0, f"output={output[-2000:]!r}")

    def test_the_unit_and_integration_targets_enumerate_no_fixture_file(self):
        result = self.run_bun(["-e", _TARGET_LISTING], REPO_ROOT)
        self.assertEqual(result.returncode, 0, f"stderr={result.stderr[-2000:]!r}")
        listing = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertGreater(len(listing["all"]), 0, "the enumeration lists the suite")
        for target in ("all", "unit", "integration"):
            stray = [f for f in listing[target] if f.startswith(FIXTURE_REL)]
            self.assertEqual(stray, [],
                             f"the `{target}` listing collects a fixture file: {stray!r}")


class PytestIsInTheDevExtrasTest(unittest.TestCase):

    def test_the_dev_extras_name_pytest(self):
        with open(PYPROJECT, "rb") as handle:
            dev = tomllib.load(handle)["project"]["optional-dependencies"]["dev"]
        named = [d for d in dev if d.split(">")[0].split("=")[0].split("<")[0].strip() == "pytest"]
        self.assertEqual(len(named), 1, f"exactly one pytest entry in [dev]: {dev!r}")

    def test_this_suites_interpreter_imports_pytest(self):
        self.assertIsNotNone(importlib.util.find_spec("pytest"),
                             "pytest must be importable by this suite's interpreter")


if __name__ == "__main__":
    unittest.main()
