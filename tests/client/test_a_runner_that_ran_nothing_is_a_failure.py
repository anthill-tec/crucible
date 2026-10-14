"""CR-CRU-186 \u00a7S4 (cycle 673) \u2014 a runner that ran nothing is a failure.

\u00a7S4's gap: a runner's report can EXIST and still hold ZERO results while the
runner itself exited non-zero \u2014 what Playwright writes when it cannot start
(its port taken, say). Today every client's `test`-family verb treats "a
report file exists" as "something ran": it parses/ingests it, the runner's
own exit code is never consulted, and the run is filed `ok: true, total: 0`.
\u00a7S4 ends that: this exact shape now takes the SAME exit the runner producing
NO report at all already takes \u2014 `ok: false`, non-zero, a `no_report_warning`
naming the runner's exit code, and the open run ABORTED (CR-CRU-170's existing
`abort_run` route) rather than filed.

Measured against this branch today (confirmed per test, by driving the REAL
client through a real subprocess against a real-HTTP `RecordingBoard`):
every "aborts the run" test below currently exits 0, `ok: true`, `total: 0`,
posts the ingest, and posts NO abort \u2014 the bug \u00a7S4 exists to end. The pin
class proves the one case that must NOT change: a runner that exits 0 with a
report holding zero results keeps filing exactly as it does today.

Fixtures (`tests/client/live_run_harness.py`) reused verbatim from the sibling
`test_a_client_aborts_a_run_it_cannot_file.py` \u2014 `RecordingBoard`, the fake
runners, `install_project`/`scrubbed_env`/`new_scratch` \u2014 plus TWO additions
this file is written against: a `FAKE_ZERO_REPORT`/`FAKE_EXIT_CODE` mode added
to every existing per-stack fake runner (writes a report holding zero
testcases, then exits with a caller-chosen code \u2014 inert unless
`FAKE_ZERO_REPORT=1`, so every pre-existing drive of these fixtures is
unchanged), and a fake-Playwright pair (`write_fake_bun_e2e`,
`write_fake_playwright`) for the `bun-crucible.py e2e` declared-raw-report
route, adapted from `test_bun_crucible_agent_report_isolation.py`'s own fake
`bun run <script>` dispatcher.

Invocation:
    python3 -m unittest tests.client.test_a_runner_that_ran_nothing_is_a_failure -v
"""

import json
import shutil
import subprocess
import sys
import unittest

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    install_project,
    load_toon,
    new_scratch,
    scrubbed_env,
    write_fake_bun,
    write_fake_bun_e2e,
    write_fake_cargo,
    write_fake_mvnw,
    write_fake_native,
    write_fake_playwright,
    write_fake_python,
)

AGENT = "zero-result-fixture"
PROJECT_KEY = "test-key-zero-result"
PROJECT_NAME = "zero-result-fixture-firmware"
TOON = load_toon()
RUN_ID = "run-live-1"

# A minimal, well-formed Playwright JSON report declaring no run at all \u2014
# the shape \u00a7S4's Problem section cites ("what Playwright writes when it
# cannot start"). Its CONTENT is never decoded by the fake board (the real
# server's codec registry is what decodes it in production; `RecordingBoard`
# always answers a raw ingest with `{total: 0, passed: 0, failed: 0}`, which is
# itself the zero-results shape this file drives), but it keeps the fixture
# honest: a real Playwright failure writes exactly this \u2014 an empty suite list.
ZERO_RESULT_PLAYWRIGHT_JSON = json.dumps(
    {"suites": [], "stats": {"expected": 0, "unexpected": 0, "skipped": 0}})


class _ZeroResultCase(unittest.TestCase):

    def setUp(self):
        self.project = new_scratch("zero-result-")
        self.bin_dir = new_scratch("zero-result-bin-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)

    def tearDown(self):
        self.board.close()
        for d in (self.project, self.bin_dir):
            shutil.rmtree(d, ignore_errors=True)

    def env(self, **extra):
        return scrubbed_env(self.bin_dir, FAKE_TOTAL=3, **extra)

    def run_client(self, cmd, env):
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=60)

    def axi(self, stdout):
        decoded = TOON.decode(stdout)
        self.assertIn("axi", decoded, f"stdout is not one TOON envelope: {stdout!r}")
        return decoded["axi"]

    def no_report_warning(self, axi):
        """Exactly one `no-test-reports` warning \u2014 `_crucible_axi.no_report_warning`'s
        own code, UNCHANGED (\u00a7S4 reuses the existing helper rather than growing a
        second one)."""
        warnings = axi.get("warnings") or []
        matches = [w for w in warnings if w.get("code") == "no-test-reports"]
        self.assertEqual(
            len(matches), 1,
            f"exactly one no-test-reports warning naming the starved run; "
            f"got warnings={warnings!r}")
        return matches[0]

    def assert_names_exit_code(self, warning, exit_code):
        """\u00a7S4 AC \u2014 \"the no_report_warning naming the runner's exit code\":
        `no_report_warning`'s own composed prefix is `f\"{verb} produced no
        {artifact} \u2014 the runner exited {exit_code} before writing a report\"`
        (`clients/_crucible_axi.py`), so the exit code's digits must appear in
        that exact phrase."""
        detail = warning.get("detail") or ""
        self.assertIn(
            f"exited {exit_code}", detail,
            f"the no_report_warning must name the runner's own exit code "
            f"({exit_code}); got detail={detail!r}")

    def assert_run_aborted_or_left_open(self, axi, run_id):
        """\u00a7S4 \u2014 \"the run aborted\": the SAME abort-posting mechanism the
        existing no-report path already drives (CR-CRU-170's `abort_run`), so
        either the board settled it (`run-aborted`) or refused the abort and
        fell back to the EXISTING `run-left-open` warning \u2014 never silence on
        both, and never a run left with neither warning."""
        aborts = self.board.aborts()
        self.assertEqual(
            len(aborts), 1,
            f"exactly one abort POST for the run this client itself opened; "
            f"got {aborts!r}; all posts={self.board.posts()!r}")
        path, body = aborts[0]
        self.assertEqual(
            path, f"/api/v2/runs/{run_id}/abort",
            f"the abort must target the run this client opened; got path={path!r}")
        self.assertIsInstance(body, dict, f"got body={body!r}")
        self.assertEqual(body.get("projectKey"), PROJECT_KEY)
        self.assertEqual(body.get("agentId"), AGENT)
        warnings = axi.get("warnings") or []
        aborted = [w for w in warnings if w.get("code") == "run-aborted"]
        left_open = [w for w in warnings if w.get("code") == "run-left-open"]
        self.assertEqual(
            len(aborted) + len(left_open), 1,
            f"exactly one of run-aborted/run-left-open must be disclosed; "
            f"got warnings={warnings!r}")
        detail = (aborted or left_open)[0].get("detail") or ""
        self.assertIn(
            run_id, detail,
            f"the disclosure must name the aborted/left-open run; got {detail!r}")

    def assert_never_filed(self):
        """\u00a7S4 \u2014 \"never filed as total: 0\": a client that can already see
        (from its own parse) that the report holds zero results AND the runner
        exited non-zero must never even POST the ingest \u2014 the positive mirror
        of \"the run aborted\": nothing was ever offered to the board as a real
        result."""
        ingest_paths = [p for p, _ in self.board.posts()
                        if p in ("/api/v2/runs", "/api/v2/runs/parsed")]
        self.assertEqual(
            ingest_paths, [],
            f"a starved run (zero results, non-zero exit) must never be "
            f"ingested; posts={self.board.posts()!r}")

    def assert_filed_normally(self, axi, exit_code=0):
        """The \u00a7S4 PIN \u2014 a runner that exits 0 with zero results keeps TODAY's
        behaviour: filed (one ingest POST reached the board), `ok: true`, no
        no_report_warning, and no abort."""
        self.assertEqual(axi.get("ok"), True, f"got axi={axi!r}")
        warnings = axi.get("warnings") or []
        no_report = [w for w in warnings if w.get("code") == "no-test-reports"]
        self.assertEqual(
            no_report, [],
            f"an exit-0 zero-results run must carry no no-test-reports "
            f"warning; got warnings={warnings!r}")
        ingest_paths = [p for p, _ in self.board.posts()
                        if p in ("/api/v2/runs", "/api/v2/runs/parsed")]
        self.assertEqual(
            len(ingest_paths), 1,
            f"an exit-0 zero-results run must still be filed (one ingest "
            f"POST); posts={self.board.posts()!r}")
        self.assertEqual(
            self.board.aborts(), [],
            f"an exit-0 zero-results run must post no abort; "
            f"aborts={self.board.aborts()!r}")


# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
# `test` in EACH of the five clients \u2014 a fake runner that writes a report
# holding ZERO results and exits non-zero behaves exactly as "no report at
# all": the run is aborted, never filed.
# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

class EmptyReportWithNonzeroExitAbortsTheRunTest(_ZeroResultCase):

    def _bun(self, exit_code, refuse=False):
        fake = write_fake_bun(self.project, 3)
        if refuse:
            self.board.refuse_next_abort()
        return self.run_client(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
             "--bun", fake, "--project-dir", self.project,
             "--package-dir", self.project, "--reports", "reports",
             "--agent", AGENT],
            self.env(FAKE_ZERO_REPORT="1", FAKE_EXIT_CODE=str(exit_code)))

    def _python(self, exit_code, refuse=False):
        fake = write_fake_python(self.project)
        if refuse:
            self.board.refuse_next_abort()
        return self.run_client(
            [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
             "--python", fake, "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_ZERO_REPORT="1", FAKE_EXIT_CODE=str(exit_code)))

    def _rust(self, exit_code, refuse=False):
        write_fake_cargo(self.bin_dir)
        if refuse:
            self.board.refuse_next_abort()
        return self.run_client(
            [sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
             "--crate", "fake-crate", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_ZERO_REPORT="1", FAKE_EXIT_CODE=str(exit_code)))

    def _mvn(self, exit_code, refuse=False):
        write_fake_mvnw(self.project)
        if refuse:
            self.board.refuse_next_abort()
        return self.run_client(
            [sys.executable, str(CLIENTS / "mvn-crucible.py"), "test",
             "--project-dir", self.project, "--reports", "reports",
             "--agent", AGENT],
            self.env(FAKE_ZERO_REPORT="1", FAKE_EXIT_CODE=str(exit_code)))

    def _arduino(self, exit_code, refuse=False):
        write_fake_native(self.project)
        if refuse:
            self.board.refuse_next_abort()
        return self.run_client(
            [sys.executable, str(CLIENTS / "arduino-crucible.py"), "test",
             "--dir", "tests/native", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_ZERO_REPORT="1", FAKE_EXIT_CODE=str(exit_code)))

    def test_bun_test_with_zero_results_and_nonzero_exit_aborts_the_run(self):
        result = self._bun(1)
        self.assertNotEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        axi = self.axi(result.stdout)
        self.assertEqual(axi.get("ok"), False, f"got axi={axi!r}")
        self.assert_names_exit_code(self.no_report_warning(axi), 1)
        self.assert_run_aborted_or_left_open(axi, RUN_ID)
        self.assert_never_filed()

    def test_bun_test_with_zero_results_and_nonzero_exit_and_a_refused_abort_leaves_the_run_open(self):
        result = self._bun(1, refuse=True)
        self.assertNotEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        axi = self.axi(result.stdout)
        self.assertEqual(axi.get("ok"), False, f"got axi={axi!r}")
        self.assert_names_exit_code(self.no_report_warning(axi), 1)
        self.assert_run_aborted_or_left_open(axi, RUN_ID)
        self.assert_never_filed()

    def test_python_test_with_zero_results_and_nonzero_exit_aborts_the_run(self):
        result = self._python(1)
        self.assertNotEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        axi = self.axi(result.stdout)
        self.assertEqual(axi.get("ok"), False, f"got axi={axi!r}")
        self.assert_names_exit_code(self.no_report_warning(axi), 1)
        self.assert_run_aborted_or_left_open(axi, RUN_ID)
        self.assert_never_filed()

    def test_python_test_with_zero_results_and_nonzero_exit_and_a_refused_abort_leaves_the_run_open(self):
        result = self._python(1, refuse=True)
        self.assertNotEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        axi = self.axi(result.stdout)
        self.assertEqual(axi.get("ok"), False, f"got axi={axi!r}")
        self.assert_names_exit_code(self.no_report_warning(axi), 1)
        self.assert_run_aborted_or_left_open(axi, RUN_ID)
        self.assert_never_filed()

    def test_rust_test_with_zero_results_and_nonzero_exit_aborts_the_run(self):
        result = self._rust(101)
        self.assertNotEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        axi = self.axi(result.stdout)
        self.assertEqual(axi.get("ok"), False, f"got axi={axi!r}")
        self.assert_names_exit_code(self.no_report_warning(axi), 101)
        self.assert_run_aborted_or_left_open(axi, RUN_ID)
        self.assert_never_filed()

    def test_mvn_test_with_zero_results_and_nonzero_exit_aborts_the_run(self):
        result = self._mvn(1)
        self.assertNotEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        axi = self.axi(result.stdout)
        self.assertEqual(axi.get("ok"), False, f"got axi={axi!r}")
        self.assert_names_exit_code(self.no_report_warning(axi), 1)
        self.assert_run_aborted_or_left_open(axi, RUN_ID)
        self.assert_never_filed()

    def test_arduino_test_with_zero_results_and_nonzero_exit_aborts_the_run(self):
        result = self._arduino(1)
        self.assertNotEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        axi = self.axi(result.stdout)
        self.assertEqual(axi.get("ok"), False, f"got axi={axi!r}")
        self.assert_names_exit_code(self.no_report_warning(axi), 1)
        self.assert_run_aborted_or_left_open(axi, RUN_ID)
        self.assert_never_filed()


# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
# "An e2e that never ran fails" \u2014 `bun-crucible.py e2e` via the DECLARED
# raw-report route (`test:e2e`), against a fake Playwright that exits 1 before
# running anything and writes a zero-results `playwright.json`.
# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

class EmptyPlaywrightReportFailsTheE2eRunTest(_ZeroResultCase):

    def _declare_e2e(self, fake_playwright):
        manifest = {
            "name": "zero-result-e2e-fixture",
            "scripts": {"test:e2e": f"{sys.executable} {fake_playwright}"},
            "crucible": {
                "reportPath": {"test:e2e": "env:PLAYWRIGHT_JUNIT_OUTPUT_NAME"},
                "rawReport": {"test:e2e": {
                    "codec": "playwright", "file": "playwright.json",
                    "path": "env:PLAYWRIGHT_JSON_OUTPUT_NAME"}},
            },
        }
        with open(f"{self.project}/package.json", "w") as f:
            json.dump(manifest, f)

    def _e2e(self, exit_code, raw_content, refuse=False):
        bun_e2e = write_fake_bun_e2e(self.project)
        fake_playwright = write_fake_playwright(self.project)
        self._declare_e2e(fake_playwright)
        if refuse:
            self.board.refuse_next_abort()
        return self.run_client(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "e2e",
             "--bun", bun_e2e, "--project-dir", self.project,
             "--package-dir", self.project, "--reports", "reports",
             "--agent", AGENT],
            self.env(FAKE_E2E_EXIT_CODE=str(exit_code),
                     FAKE_E2E_RAW_CONTENT=raw_content))

    def test_bun_e2e_with_playwright_exit_before_running_anything_fails(self):
        """The Problem section's own incident, reproduced: Playwright's port is
        taken, it exits 1 before running a single test, and STILL writes
        `playwright.json` holding zero results (`suites: []`)."""
        result = self._e2e(1, ZERO_RESULT_PLAYWRIGHT_JSON)
        self.assertNotEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        axi = self.axi(result.stdout)
        self.assertEqual(axi.get("ok"), False, f"got axi={axi!r}")
        self.assert_names_exit_code(self.no_report_warning(axi), 1)
        self.assert_run_aborted_or_left_open(axi, RUN_ID)
        self.assert_never_filed()

    def test_bun_e2e_with_playwright_exit_before_running_anything_and_a_refused_abort_leaves_the_run_open(self):
        result = self._e2e(1, ZERO_RESULT_PLAYWRIGHT_JSON, refuse=True)
        self.assertNotEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        axi = self.axi(result.stdout)
        self.assertEqual(axi.get("ok"), False, f"got axi={axi!r}")
        self.assert_names_exit_code(self.no_report_warning(axi), 1)
        self.assert_run_aborted_or_left_open(axi, RUN_ID)
        self.assert_never_filed()


# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
# "Existing exits unchanged" \u2014 a runner that exits 0 with zero results keeps
# TODAY's behaviour: filed normally, `ok: true`, no abort. Pinned explicitly
# per the AC's own instruction, for every client this CR touches plus the e2e
# raw-report route.
# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

class RunnerExitsZeroWithZeroResultsFilesNormallyTest(_ZeroResultCase):

    def test_bun_test_with_zero_results_and_exit_zero_files_normally(self):
        fake = write_fake_bun(self.project, 3)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
             "--bun", fake, "--project-dir", self.project,
             "--package-dir", self.project, "--reports", "reports",
             "--agent", AGENT],
            self.env(FAKE_ZERO_REPORT="1", FAKE_EXIT_CODE="0"))
        self.assertEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        self.assert_filed_normally(self.axi(result.stdout))

    def test_python_test_with_zero_results_and_exit_zero_files_normally(self):
        fake = write_fake_python(self.project)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
             "--python", fake, "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_ZERO_REPORT="1", FAKE_EXIT_CODE="0"))
        self.assertEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        self.assert_filed_normally(self.axi(result.stdout))

    def test_rust_test_with_zero_results_and_exit_zero_files_normally(self):
        write_fake_cargo(self.bin_dir)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
             "--crate", "fake-crate", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_ZERO_REPORT="1", FAKE_EXIT_CODE="0"))
        self.assertEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        self.assert_filed_normally(self.axi(result.stdout))

    def test_mvn_test_with_zero_results_and_exit_zero_files_normally(self):
        write_fake_mvnw(self.project)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "mvn-crucible.py"), "test",
             "--project-dir", self.project, "--reports", "reports",
             "--agent", AGENT],
            self.env(FAKE_ZERO_REPORT="1", FAKE_EXIT_CODE="0"))
        self.assertEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        self.assert_filed_normally(self.axi(result.stdout))

    def test_arduino_test_with_zero_results_and_exit_zero_files_normally(self):
        write_fake_native(self.project)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "arduino-crucible.py"), "test",
             "--dir", "tests/native", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_ZERO_REPORT="1", FAKE_EXIT_CODE="0"))
        self.assertEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        self.assert_filed_normally(self.axi(result.stdout))

    def test_bun_e2e_with_zero_results_and_exit_zero_files_normally(self):
        bun_e2e = write_fake_bun_e2e(self.project)
        fake_playwright = write_fake_playwright(self.project)
        self._declare_e2e_for_pin(fake_playwright)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "e2e",
             "--bun", bun_e2e, "--project-dir", self.project,
             "--package-dir", self.project, "--reports", "reports",
             "--agent", AGENT],
            self.env(FAKE_E2E_EXIT_CODE="0",
                     FAKE_E2E_RAW_CONTENT=ZERO_RESULT_PLAYWRIGHT_JSON))
        self.assertEqual(result.returncode, 0, f"stdout={result.stdout!r}")
        self.assert_filed_normally(self.axi(result.stdout))

    def _declare_e2e_for_pin(self, fake_playwright):
        manifest = {
            "name": "zero-result-e2e-pin-fixture",
            "scripts": {"test:e2e": f"{sys.executable} {fake_playwright}"},
            "crucible": {
                "reportPath": {"test:e2e": "env:PLAYWRIGHT_JUNIT_OUTPUT_NAME"},
                "rawReport": {"test:e2e": {
                    "codec": "playwright", "file": "playwright.json",
                    "path": "env:PLAYWRIGHT_JSON_OUTPUT_NAME"}},
            },
        }
        with open(f"{self.project}/package.json", "w") as f:
            json.dump(manifest, f)


if __name__ == "__main__":
    unittest.main()
