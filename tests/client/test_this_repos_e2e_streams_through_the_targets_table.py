"""This repo's e2e target streams through the `crucible.targets` table, and its
kept Playwright reports land in the run's own reports dir.

Two things are pinned here.

1. **The kept reports' destination.** A `stream` target is handed
   `PLAYWRIGHT_JUNIT_OUTPUT_NAME` and `PLAYWRIGHT_JSON_OUTPUT_NAME`, both naming
   files in the run's reports dir, so the run writes nothing into the
   package's own `test-reports/`. The REAL `clients/bun-crucible.py` is driven
   as an OS subprocess against `TargetsBoard`
   (tests/client/bun_targets_harness.py). The runner is a fake `bun` written
   below. It records the environment it was handed, writes a
   `crucible-events` stream to `CRUCIBLE_STREAM`, and writes Playwright's two
   kept reports the way this repo's `playwright.config.ts` does: to the path
   each variable names, else to `test-reports/junit.xml` and
   `test-reports/playwright.json` under the package.
2. **This repo's declaration.** `package.json` declares `test:e2e` in
   `crucible.targets` as a `playwright-bdd` target streamed in `crucible-events`
   through `env:CRUCIBLE_STREAM`, and nowhere else: neither
   `crucible.reportPath` nor `crucible.rawReport` names it.

Interface choices (the spec leaves these open):
- The reports' file names inside the reports dir are GREEN's to choose. These
  tests read them from the environment the runner was handed, and pin only
  their directory, that they are two different files, and that neither is the
  stream file.
- A run that opens no board run (`--no-lifecycle`, an unreachable board) is
  not asserted here.
"""

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

from tests.client.bun_targets_harness import (
    CLOSE,
    COMPILE,
    RUN_ID,
    STREAM_FILE,
    STREAM_PATH_DECLARATION,
    STREAM_VAR,
    TargetsCase,
)
from tests.client.live_run_harness import REPO_ROOT, START, STREAM_CODEC

E2E = "test:e2e"
E2E_BODY = "bunx bddgen && bunx playwright test"
FRAMEWORK = "playwright-bdd"
E2E_STREAM_ENTRY = {"framework": FRAMEWORK,
                    "stream": {"codec": STREAM_CODEC, "path": STREAM_PATH_DECLARATION}}
JUNIT_VAR = "PLAYWRIGHT_JUNIT_OUTPUT_NAME"
JSON_VAR = "PLAYWRIGHT_JSON_OUTPUT_NAME"
PACKAGE_REPORTS = "test-reports"
MANIFEST_PATH = REPO_ROOT / "package.json"

# A stand-in `bun` for a playwright-bdd target. It records its argv and the
# variables a stream run hands it, then writes the stream to `CRUCIBLE_STREAM`
# and Playwright's two kept reports where this repo's config writes them: the
# path each variable names, else the config's own default under the package.
FAKE_PLAYWRIGHT_BUN = r'''
import json
import os
import sys

WATCHED = ("CRUCIBLE_STREAM", "CRUCIBLE_REPORTERS",
           "PLAYWRIGHT_JUNIT_OUTPUT_NAME", "PLAYWRIGHT_JSON_OUTPUT_NAME")
argv = sys.argv[1:]
with open(os.environ["FAKE_SPAWN_LOG"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"argv": argv,
                             "env": {k: os.environ.get(k) for k in WATCHED}}) + "\n")

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)

names = ["the first scenario", "the second scenario"]
print("Running %d tests using 1 worker" % len(names))
sys.stdout.flush()

stream = os.environ.get("CRUCIBLE_STREAM")
if stream:
    events = [{"event": "run-start", "total": len(names)}]
    events += [{"event": "test-end", "id": "e2e-%d" % i, "name": name,
                "suite": "A feature", "browser": "chromium",
                "file": "features/a.feature", "status": "pass", "duration_ms": 1,
                "steps": [{"name": "Given a step", "status": "pass"}]}
               for i, name in enumerate(names)]
    events.append({"event": "run-end", "total": len(names), "passed": len(names),
                   "failed": 0, "pending": 0, "duration_ms": 2})
    write(stream, "".join(json.dumps(event) + "\n" for event in events))

cases = "".join('<testcase name="%s" classname="features/a.feature" time="0.001"/>'
                % name for name in names)
write(os.environ.get("PLAYWRIGHT_JUNIT_OUTPUT_NAME") or "test-reports/junit.xml",
      '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="%d">'
      '<testsuite name="features/a.feature" tests="%d" failures="0">%s'
      '</testsuite></testsuites>\n' % (len(names), len(names), cases))
write(os.environ.get("PLAYWRIGHT_JSON_OUTPUT_NAME") or "test-reports/playwright.json",
      json.dumps({"suites": [], "stats": {"expected": len(names)}}) + "\n")
sys.exit(0)
'''


class AStreamTargetKeepsPlaywrightsReportsInItsReportsDirTest(TargetsCase):
    """A `playwright-bdd` stream target, run by the `e2e` verb, is handed both
    kept report paths inside the run's reports dir."""

    def setUp(self):
        super().setUp()
        self.fake.write_text(f"#!{sys.executable}\n" + FAKE_PLAYWRIGHT_BUN, encoding="utf-8")
        self.fake.chmod(0o755)
        self.declare({E2E: E2E_BODY}, {"targets": {E2E: E2E_STREAM_ENTRY}})

    def only_spawn(self, drive):
        spawns = self.spawns()
        self.assertEqual(len(spawns), 1,
                         f"the declared target runs exactly once; {drive.diag()}")
        return spawns[0] if spawns else {"argv": [], "env": {}}

    def assert_inside_the_reports_dir(self, value, variable, spawn):
        self.assertIsNotNone(value, f"the runner is handed {variable}; spawn={spawn!r}")
        self.assertEqual(os.path.realpath(os.path.dirname(value or "")),
                         os.path.realpath(self.reports),
                         f"{variable} names a file in the run's reports dir "
                         f"{self.reports}, not {value!r}")

    def assert_closed_by_its_stream(self, drive):
        self.assertEqual(self.only(START, drive).get("framework"), FRAMEWORK)
        close = self.only(CLOSE, drive)
        self.assertEqual((close.get("codec"), close.get("runId"), close.get("framework")),
                         (STREAM_CODEC, RUN_ID, FRAMEWORK),
                         f"the run is closed by its stream; close={close!r}")
        self.assertNotIn("data", close, f"a stream close sends no report; close={close!r}")
        self.assertEqual(self.posts_to(COMPILE), [], drive.diag())

    def test_a_playwright_bdd_stream_target_is_handed_both_report_paths_inside_its_reports_dir(self):
        drive = self.drive("e2e")
        self.assertEqual(drive.returncode, 0, drive.diag())
        spawn = self.only_spawn(drive)
        self.assertEqual(spawn["argv"], ["run", E2E],
                         "a stream target is run by name and handed no report flags")
        env = spawn["env"]
        junit, raw = env.get(JUNIT_VAR), env.get(JSON_VAR)
        self.assert_inside_the_reports_dir(junit, JUNIT_VAR, spawn)
        self.assert_inside_the_reports_dir(raw, JSON_VAR, spawn)
        stream = os.path.realpath(self.reports / STREAM_FILE)
        self.assertEqual(os.path.realpath(env.get(STREAM_VAR) or ""), stream,
                         f"{STREAM_VAR} still names <reports dir>/{STREAM_FILE}")
        self.assertNotEqual(os.path.realpath(junit or ""), os.path.realpath(raw or ""),
                            f"the JUnit and JSON reports are two files; spawn={spawn!r}")
        self.assertNotIn(stream, {os.path.realpath(junit or ""), os.path.realpath(raw or "")},
                         f"neither report overwrites the stream file; spawn={spawn!r}")
        self.assert_closed_by_its_stream(drive)

    def test_a_playwright_bdd_stream_target_run_writes_nothing_into_the_packages_test_reports(self):
        drive = self.drive("e2e")
        self.assertEqual(drive.returncode, 0, drive.diag())
        package_reports = self.project / PACKAGE_REPORTS
        written = (sorted(str(p.relative_to(self.project)) for p in package_reports.rglob("*"))
                   if package_reports.exists() else [])
        self.assertEqual(written, [],
                         f"the run writes nothing into <package>/{PACKAGE_REPORTS}")
        self.assertFalse(package_reports.exists(),
                         f"<package>/{PACKAGE_REPORTS} is never even created")
        env = self.only_spawn(drive)["env"]
        for variable in (JUNIT_VAR, JSON_VAR):
            with self.subTest(report=variable):
                named = env.get(variable)
                self.assertIsNotNone(named, f"the runner is handed {variable}")
                path = Path(named or self.reports / "unnamed")
                self.assertTrue(path.is_file(),
                                f"the report {variable} named was written there: {path}")
                self.assertEqual(path.resolve().parent, self.reports.resolve())
        self.assert_closed_by_its_stream(drive)

    def test_the_reports_dir_paths_replace_report_paths_the_callers_environment_carries(self):
        stale_junit = self.project / PACKAGE_REPORTS / "junit.xml"
        stale_json = self.project / PACKAGE_REPORTS / "playwright.json"
        callers = {JUNIT_VAR: str(stale_junit), JSON_VAR: str(stale_json)}
        with mock.patch.dict(os.environ, callers):
            drive = self.drive("e2e")
        self.assertEqual(drive.returncode, 0, drive.diag())
        spawn = self.only_spawn(drive)
        self.assert_inside_the_reports_dir(spawn["env"].get(JUNIT_VAR), JUNIT_VAR, spawn)
        self.assert_inside_the_reports_dir(spawn["env"].get(JSON_VAR), JSON_VAR, spawn)
        self.assertFalse(stale_junit.exists(), "the caller's JUnit path is not written")
        self.assertFalse(stale_json.exists(), "the caller's JSON path is not written")


class ThisRepoDeclaresItsE2eTargetInTheTableTest(unittest.TestCase):
    """This repo's `package.json` declares `test:e2e` in `crucible.targets`."""

    def setUp(self):
        self.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        self.crucible = self.manifest.get("crucible") or {}

    def test_this_repos_e2e_target_is_a_playwright_bdd_stream_in_the_targets_table(self):
        self.assertEqual((self.manifest.get("scripts") or {}).get(E2E), E2E_BODY,
                         "the e2e script itself is unchanged")
        targets = self.crucible.get("targets") or {}
        self.assertEqual(targets.get(E2E), E2E_STREAM_ENTRY,
                         f"crucible.targets[{E2E!r}] declares a {FRAMEWORK} target "
                         f"streamed in {STREAM_CODEC} through {STREAM_PATH_DECLARATION}; "
                         f"crucible={self.crucible!r}")

    def test_this_repos_e2e_target_is_declared_nowhere_but_the_targets_table(self):
        for older in ("reportPath", "rawReport"):
            with self.subTest(declaration=f"crucible.{older}"):
                self.assertNotIn(E2E, self.crucible.get(older) or {},
                                 f"crucible.{older} no longer names {E2E}: a script is "
                                 f"declared in one place; crucible={self.crucible!r}")


if __name__ == "__main__":
    unittest.main()
