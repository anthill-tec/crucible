"""The shipped Playwright reporter stands alone, is typechecked, and is installed.

* **No client.** The playwright-bdd fixture's config runs unchanged with
  `CRUCIBLE_REPORTERS` unset -- Playwright's own JUnit report shows every
  scenario of every project run as the fixture designs -- and writes no
  stream, even with `CRUCIBLE_STREAM` set; the same copy, with
  `CRUCIBLE_REPORTERS` set, does stream.
* **No `node_modules` above it.** The reporter, copied alone into a directory
  with no `node_modules` ancestor and handed to Playwright from there, loads
  and streams. A source check states why: it imports only Playwright types and
  `node:` built-ins.
* **`check` typechecks it.** It sits under an entry of `tsconfig.json`'s
  `include`, the files `check` typechecks.
* **The installer lays it down.** `crucible_axi.install.FLEET_FILES` names
  `reporters/playwright-crucible.ts`, and `run_fleet_stage` writes it,
  byte-identical to its source, beside the Vitest reporter; a second run
  converges, and a stale copy is rewritten.

The interface these tests drive is stated in
`tests/client/playwright_reporter_scratch.py`.

Invocation:
    python3 -m unittest tests.client.test_playwright_crucible_reporter_stands_alone_and_installs -v
"""

import importlib
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client.live_run_harness import REPO_ROOT, new_scratch
from tests.client.playwright_reporter_scratch import (
    EXPECTED_TOTALS,
    REPORTER,
    REPORTER_NAME,
    REPORTERS_DIR,
    STREAM_FILE_NAME,
    diagnostics,
    expected_junit_cases,
    junit_report,
    require_playwright_toolchain,
    run_fixture_playwright,
    scratch_fixture,
    stream_events,
)

TSCONFIG = REPO_ROOT / "tsconfig.json"
REPORTERS_SUBDIR = "reporters"
FLEET_NAME = f"{REPORTERS_SUBDIR}/{REPORTER_NAME}"
VITEST_REPORTER_NAME = "vitest-crucible.ts"

def _assert_reporter_exists(case):
    case.assertTrue(REPORTER.is_file(),
                    f"the shipped Playwright reporter is missing: {REPORTER}")

def _run_end(case, events):
    ends = [event for event in events if event.get("event") == "run-end"]
    case.assertEqual(len(ends), 1, f"exactly one run-end; events={events!r}")
    return {key: ends[0].get(key) for key in EXPECTED_TOTALS}

class FixtureConfigAddsTheReporterOnlyFromCrucibleReportersTest(unittest.TestCase):
    """The fixture's config, unchanged, with and without the client's variable."""

    def setUp(self):
        self.bun = require_playwright_toolchain(self)
        self.scratch, self.project = scratch_fixture("playwright-reporter-gate-")
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)

    def reports_dir(self, name):
        directory = os.path.join(self.scratch, name)
        os.makedirs(directory)
        return directory

    def test_unset_crucible_reporters_runs_the_fixture_and_writes_no_stream(self):
        quiet_dir = self.reports_dir("without-client")
        junit_dir = self.reports_dir("without-client-junit")
        junit = os.path.join(junit_dir, "junit.xml")
        quiet = run_fixture_playwright(self.bun, self.project, None,
                                       os.path.join(quiet_dir, STREAM_FILE_NAME),
                                       junit_path=junit)
        # Playwright itself ran the fixture as it is designed.
        self.assertEqual(quiet.returncode, 1,
                         f"with no client the fixture runs as designed: its failing "
                         f"scenarios fail the run; {diagnostics(quiet)}")
        counts, cases = junit_report(self, junit, quiet)
        # JUnit files a thrown `Error` (not an assertion) under `errors`, so the
        # not-ok scenarios are its failures and errors together.
        self.assertEqual(
            {"tests": counts["tests"], "skipped": counts["skipped"],
             "not ok": counts["failures"] + counts["errors"]},
            {"tests": EXPECTED_TOTALS["total"], "skipped": EXPECTED_TOTALS["pending"],
             "not ok": EXPECTED_TOTALS["failed"]},
            f"Playwright's own JUnit: every scenario of every project, the failed "
            f"dependency's dependents skipped; junit={counts!r} {diagnostics(quiet)}")
        self.assertEqual(cases, expected_junit_cases(),
                         "Playwright's own JUnit lists each scenario in its projects")
        # No stream while CRUCIBLE_REPORTERS is unset.
        self.assertEqual(os.listdir(quiet_dir), [],
                         f"no reporter is added while CRUCIBLE_REPORTERS is unset, "
                         f"so no stream is written; {diagnostics(quiet)}")

        live_dir = self.reports_dir("with-client")
        live_stream = os.path.join(live_dir, STREAM_FILE_NAME)
        live = run_fixture_playwright(self.bun, self.project, REPORTERS_DIR, live_stream)
        self.assertEqual(_run_end(self, stream_events(self, live_stream, live)),
                         EXPECTED_TOTALS,
                         f"the same copy streams once CRUCIBLE_REPORTERS is set; "
                         f"{diagnostics(live)}")
        self.assertEqual(live.returncode, quiet.returncode,
                         f"adding the reporter changes no outcome; {diagnostics(live)}")

class ReporterLoadsWithNoNodeModulesAboveItTest(unittest.TestCase):
    """The reporter alone, in a directory no `node_modules` sits above."""

    def setUp(self):
        self.bun = require_playwright_toolchain(self)
        self.scratch, self.project = scratch_fixture("playwright-reporter-alone-")
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.isolated = tempfile.mkdtemp(prefix="playwright-reporter-isolated-")
        self.addCleanup(shutil.rmtree, self.isolated, ignore_errors=True)

    def test_the_reporter_copied_alone_loads_and_streams(self):
        _assert_reporter_exists(self)
        reporters = Path(self.isolated, REPORTERS_SUBDIR)
        reporters.mkdir()
        shutil.copyfile(REPORTER, reporters / REPORTER_NAME)
        ancestors = [p for p in [reporters, *reporters.parents]
                     if (p / "node_modules").exists()]
        self.assertEqual(ancestors, [],
                         "precondition: no `node_modules` above the copied reporter")
        stream_dir = os.path.join(self.scratch, "reports")
        os.makedirs(stream_dir)
        stream = os.path.join(stream_dir, STREAM_FILE_NAME)
        result = run_fixture_playwright(self.bun, self.project, reporters, stream)
        self.assertEqual(_run_end(self, stream_events(self, stream, result)),
                         EXPECTED_TOTALS, diagnostics(result))

_SPECIFIER = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']""")
_IMPORT_STATEMENT = re.compile(r"^\s*(?:import|export)\b[^;]*?from\s*[\"']([^\"']+)[\"']",
                               re.MULTILINE | re.DOTALL)

def _is_playwright(specifier):
    return any(specifier == root or specifier.startswith(f"{root}/")
               for root in ("@playwright/test", "playwright"))

class ReporterImportsOnlyPlaywrightTypesAndNodeBuiltinsTest(unittest.TestCase):

    def test_every_import_is_a_playwright_type_or_a_node_builtin(self):
        _assert_reporter_exists(self)
        source = REPORTER.read_text()
        specifiers = _SPECIFIER.findall(source)
        self.assertGreater(len(specifiers), 0,
                           "the reporter imports at least its Playwright types")
        foreign = [s for s in specifiers if not s.startswith("node:") and not _is_playwright(s)]
        self.assertEqual(foreign, [],
                         "only Playwright types and `node:` built-ins may be imported")
        value_imports = []
        for statement in _IMPORT_STATEMENT.finditer(source):
            text = statement.group(0).strip()
            if _is_playwright(statement.group(1)) and not \
                    re.match(r"(?:import|export)\s+type\b", text):
                value_imports.append(text)
        self.assertEqual(value_imports, [],
                         "a Playwright import is a type-only import, erased at load")
        dynamic = [s for s in re.findall(r"""\b(?:import\s*\(|require\s*\()\s*["']([^"']+)""",
                                         source) if not s.startswith("node:")]
        self.assertEqual(dynamic, [], "no runtime load of anything but a built-in")

class CheckTypechecksTheReporterTest(unittest.TestCase):

    def test_the_reporter_sits_under_an_entry_check_typechecks(self):
        _assert_reporter_exists(self)
        include = json.loads(TSCONFIG.read_text()).get("include")
        self.assertIsInstance(include, list, f"include={include!r}")
        relative = REPORTER.relative_to(REPO_ROOT).as_posix()
        covering = [entry for entry in include
                    if relative == entry or relative.startswith(f"{entry.rstrip('/')}/")]
        self.assertNotEqual(covering, [],
                            f"`check` typechecks tsconfig's include ({include!r}); "
                            f"{relative} must sit under one of its entries")

def _fresh_install_module():
    """`crucible_axi.install` from this checkout, the whole package re-imported
    so no other suite's module objects are reused."""
    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    for name in list(sys.modules):
        if name == "crucible_axi" or name.startswith("crucible_axi."):
            del sys.modules[name]
    return importlib.import_module("crucible_axi.install")

class FleetStageLaysThePlaywrightReporterDownTest(unittest.TestCase):

    def setUp(self):
        self.install = _fresh_install_module()
        self.target = new_scratch("playwright-reporter-fleet-")
        self.addCleanup(shutil.rmtree, self.target, ignore_errors=True)
        self.landed_dir = Path(self.target, self.install.FLEET_DIRNAME, REPORTERS_SUBDIR)
        self.landed = self.landed_dir / REPORTER_NAME

    def test_the_fleet_files_name_the_playwright_reporter(self):
        self.assertIn(FLEET_NAME, self.install.FLEET_FILES,
                      f"FLEET_FILES={self.install.FLEET_FILES!r}")
        self.assertEqual(list(self.install.FLEET_FILES).count(FLEET_NAME), 1,
                         "named once")

    def test_the_reporter_lands_byte_identical_beside_the_vitest_reporter(self):
        result = self.install.run_fleet_stage(self.target)
        self.assertTrue(self.landed.is_file(), f"{self.landed} not laid down; result={result!r}")
        _assert_reporter_exists(self)
        self.assertEqual(self.landed.read_bytes(), REPORTER.read_bytes(),
                         "the landed reporter is byte-identical to its source")
        self.assertEqual(sorted(os.listdir(self.landed_dir)),
                         [REPORTER_NAME, VITEST_REPORTER_NAME],
                         "the reporters directory holds the two shipped reporters only")

    def test_a_second_run_converges_and_a_stale_reporter_is_rewritten(self):
        self.install.run_fleet_stage(self.target)
        self.assertTrue(self.landed.is_file(), f"{self.landed} not laid down")
        second = self.install.run_fleet_stage(self.target)
        self.assertIs(second.get("converged"), True,
                      f"an unchanged second run converges with the reporter in place; {second!r}")
        self.landed.write_bytes(b"// stale\n")
        third = self.install.run_fleet_stage(self.target)
        self.assertIs(third.get("converged"), False, f"{third!r}")
        _assert_reporter_exists(self)
        self.assertEqual(self.landed.read_bytes(), REPORTER.read_bytes(),
                         "a stale reporter is rewritten from its source")

if __name__ == "__main__":
    unittest.main()
