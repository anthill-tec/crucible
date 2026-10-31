"""The shipped Vitest reporter stands alone, is typechecked, and is installed.

* **No client.** The Vitest fixture's config runs unchanged with
  `CRUCIBLE_REPORTERS` unset and writes no stream -- even with
  `CRUCIBLE_STREAM` set -- while the same copy, with `CRUCIBLE_REPORTERS` set,
  does stream: the config adds the reporter from that variable and from
  nothing else.
* **No `node_modules` above it.** The reporter, copied alone into a directory
  with no `node_modules` ancestor and handed to Vitest from there, loads and
  streams. A source check states why: it imports only `vitest` types and
  `node:` built-ins.
* **`check` typechecks it.** `tsconfig.json`'s `include` names
  `clients/reporters`.
* **The installer lays it down.** `crucible_axi.install.run_fleet_stage`
  writes `<target>/clients/reporters/vitest-crucible.ts`, byte-identical to its
  source, creating the subdirectory; a second run converges; and a symlinked
  `reporters/` directory is never followed -- the stage either refuses it
  (raises, naming it) or replaces the link with a real directory, and writes
  nothing through it either way.

The interface these tests drive -- `CRUCIBLE_REPORTERS` naming the reporter's
directory, the config adding `<dir>/vitest-crucible.ts` only when it is set,
the reporter reading `CRUCIBLE_STREAM` itself -- is stated in
`tests/client/vitest_reporter_scratch.py`.

Invocation:
    python3 -m unittest tests.client.test_vitest_crucible_reporter_stands_alone_and_installs -v
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
from tests.client.vitest_reporter_scratch import (
    FIXTURE_FAILING_CASE,
    REPORTER,
    REPORTER_NAME,
    REPORTERS_DIR,
    STREAM_FILE_NAME,
    diagnostics,
    require_vitest_toolchain,
    run_fixture_vitest,
    scratch_fixture,
    stream_events,
)

TSCONFIG = REPO_ROOT / "tsconfig.json"
REPORTERS_INCLUDE = "clients/reporters"
REPORTERS_SUBDIR = "reporters"

# The committed fixture's own five tests: four pass, one fails.
FIXTURE_TOTALS = {"total": 5, "passed": 4, "failed": 1, "pending": 0}


def _assert_reporter_exists(case):
    case.assertTrue(REPORTER.is_file(),
                    f"the shipped Vitest reporter is missing: {REPORTER}")


def _run_end(case, events):
    ends = [event for event in events if event.get("event") == "run-end"]
    case.assertEqual(len(ends), 1, f"exactly one run-end; events={events!r}")
    return {key: ends[0].get(key) for key in FIXTURE_TOTALS}


class FixtureConfigAddsTheReporterOnlyFromCrucibleReportersTest(unittest.TestCase):
    """The fixture's config, unchanged, with and without the client's variable."""

    def setUp(self):
        self.bun = require_vitest_toolchain(self)
        self.scratch, self.project = scratch_fixture("vitest-reporter-gate-")
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)

    def stream_path(self, name):
        directory = os.path.join(self.scratch, name)
        os.makedirs(directory)
        return directory, os.path.join(directory, STREAM_FILE_NAME)

    def test_unset_crucible_reporters_runs_unchanged_and_writes_no_stream(self):
        quiet_dir, quiet_stream = self.stream_path("without-client")
        quiet = run_fixture_vitest(self.bun, self.project, None, quiet_stream)
        self.assertEqual(quiet.returncode, 1,
                         f"with no client the fixture runs as before: its one "
                         f"failing test fails the run; {diagnostics(quiet)}")
        self.assertIn(FIXTURE_FAILING_CASE, quiet.stdout + quiet.stderr,
                      f"Vitest's own reporter still reports the run; {diagnostics(quiet)}")
        self.assertEqual(os.listdir(quiet_dir), [],
                         f"no reporter is added while CRUCIBLE_REPORTERS is unset, "
                         f"so no stream is written; {diagnostics(quiet)}")

        _, live_stream = self.stream_path("with-client")
        live = run_fixture_vitest(self.bun, self.project, REPORTERS_DIR, live_stream)
        self.assertEqual(_run_end(self, stream_events(self, live_stream, live)),
                         FIXTURE_TOTALS,
                         f"the same copy streams once CRUCIBLE_REPORTERS is set; "
                         f"{diagnostics(live)}")
        self.assertEqual(live.returncode, quiet.returncode,
                         f"adding the reporter changes no outcome; {diagnostics(live)}")


class ReporterLoadsWithNoNodeModulesAboveItTest(unittest.TestCase):
    """The reporter alone, in a directory no `node_modules` sits above."""

    def setUp(self):
        self.bun = require_vitest_toolchain(self)
        self.scratch, self.project = scratch_fixture("vitest-reporter-alone-")
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.isolated = tempfile.mkdtemp(prefix="vitest-reporter-isolated-")
        self.addCleanup(shutil.rmtree, self.isolated, ignore_errors=True)

    def test_the_reporter_copied_alone_loads_and_streams(self):
        _assert_reporter_exists(self)
        reporters = Path(self.isolated, "reporters")
        reporters.mkdir()
        shutil.copyfile(REPORTER, reporters / REPORTER_NAME)
        ancestors = [p for p in [reporters, *reporters.parents]
                     if (p / "node_modules").exists()]
        self.assertEqual(ancestors, [],
                         "precondition: no `node_modules` above the copied reporter")
        stream_dir = os.path.join(self.scratch, "reports")
        os.makedirs(stream_dir)
        stream = os.path.join(stream_dir, STREAM_FILE_NAME)
        result = run_fixture_vitest(self.bun, self.project, reporters, stream)
        self.assertEqual(_run_end(self, stream_events(self, stream, result)),
                         FIXTURE_TOTALS, diagnostics(result))


_SPECIFIER = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']""")
_IMPORT_STATEMENT = re.compile(r"^\s*(?:import|export)\b[^;]*?from\s*[\"']([^\"']+)[\"']",
                               re.MULTILINE | re.DOTALL)


class ReporterImportsOnlyVitestTypesAndNodeBuiltinsTest(unittest.TestCase):

    def test_every_import_is_a_vitest_type_or_a_node_builtin(self):
        _assert_reporter_exists(self)
        source = REPORTER.read_text()
        specifiers = _SPECIFIER.findall(source)
        self.assertGreater(len(specifiers), 0, "the reporter imports at least its Vitest types")
        foreign = [s for s in specifiers
                   if not s.startswith("node:") and s != "vitest" and not s.startswith("vitest/")]
        self.assertEqual(foreign, [],
                         "only `vitest` types and `node:` built-ins may be imported")
        value_imports = []
        for statement in _IMPORT_STATEMENT.finditer(source):
            specifier = statement.group(1)
            text = statement.group(0).strip()
            if (specifier == "vitest" or specifier.startswith("vitest/")) and not \
                    re.match(r"(?:import|export)\s+type\b", text):
                value_imports.append(text)
        self.assertEqual(value_imports, [],
                         "a `vitest` import is a type-only import, erased at load")
        dynamic = [s for s in re.findall(r"""\b(?:import\s*\(|require\s*\()\s*["']([^"']+)""",
                                         source) if not s.startswith("node:")]
        self.assertEqual(dynamic, [], "no runtime load of anything but a built-in")


class TsconfigTypechecksTheReportersTest(unittest.TestCase):

    def test_tsconfig_include_names_clients_reporters_beside_its_existing_entries(self):
        include = json.loads(TSCONFIG.read_text()).get("include")
        self.assertIsInstance(include, list, f"include={include!r}")
        self.assertIn(REPORTERS_INCLUDE, include,
                      "`check` typechecks the reporters through tsconfig's include")
        for kept in ("src", "tests", "playwright.config.ts"):
            self.assertIn(kept, include, f"the existing entries stay; include={include!r}")


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


class FleetStageLaysTheReporterDownTest(unittest.TestCase):

    def setUp(self):
        self.install = _fresh_install_module()
        self.target = new_scratch("vitest-reporter-fleet-")
        self.addCleanup(shutil.rmtree, self.target, ignore_errors=True)
        self.landed_dir = Path(self.target, self.install.FLEET_DIRNAME, REPORTERS_SUBDIR)
        self.landed = self.landed_dir / REPORTER_NAME

    def test_the_reporter_lands_byte_identical_in_a_created_reporters_subdirectory(self):
        result = self.install.run_fleet_stage(self.target)
        self.assertTrue(self.landed_dir.is_dir() and not self.landed_dir.is_symlink(),
                        f"the stage creates <target>/clients/reporters/; result={result!r}")
        self.assertTrue(self.landed.is_file(), f"{self.landed} not laid down; result={result!r}")
        _assert_reporter_exists(self)
        self.assertEqual(self.landed.read_bytes(), REPORTER.read_bytes(),
                         "the landed reporter is byte-identical to its source")
        self.assertEqual(os.listdir(self.landed_dir), [REPORTER_NAME],
                         "the reporters directory holds the shipped reporter only")

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


class FleetStageNeverFollowsASymlinkedReportersDirectoryTest(unittest.TestCase):

    SENTINEL = b"// an operator file outside the install target\n"

    def setUp(self):
        self.install = _fresh_install_module()
        self.target = new_scratch("vitest-reporter-fleet-link-")
        self.addCleanup(shutil.rmtree, self.target, ignore_errors=True)
        self.outside = tempfile.mkdtemp(prefix="vitest-reporter-outside-")
        self.addCleanup(shutil.rmtree, self.outside, ignore_errors=True)
        Path(self.outside, REPORTER_NAME).write_bytes(self.SENTINEL)
        clients = Path(self.target, self.install.FLEET_DIRNAME)
        clients.mkdir(parents=True)
        self.link = clients / REPORTERS_SUBDIR
        os.symlink(self.outside, self.link)

    def test_a_symlinked_reporters_directory_is_refused_or_replaced_never_written_through(self):
        refusal = None
        try:
            self.install.run_fleet_stage(self.target)
        except (OSError, ValueError, RuntimeError) as error:
            refusal = error
        self.assertEqual(sorted(os.listdir(self.outside)), [REPORTER_NAME],
                         "nothing is written into the directory the link points at")
        self.assertEqual(Path(self.outside, REPORTER_NAME).read_bytes(), self.SENTINEL,
                         "the file outside the target is never overwritten through the link")
        if refusal is not None:
            self.assertIn(REPORTERS_SUBDIR, str(refusal),
                          f"a refusal names the symlinked directory; {refusal!r}")
            return
        self.assertFalse(
            self.link.is_symlink(),
            "the stage neither refused the symlinked reporters/ directory nor "
            "replaced it: it is still a link out of the install target")
        _assert_reporter_exists(self)
        self.assertEqual((self.link / REPORTER_NAME).read_bytes(), REPORTER.read_bytes(),
                         "a replaced reporters/ directory holds the shipped reporter")


if __name__ == "__main__":
    unittest.main()
