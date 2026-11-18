"""`regression` runs the `crucible.targets` entry marked `"test": true`.

A bun project marks ONE entry of `crucible.targets` as the script its runs go
through, with the field `"test": true`. `regression` reads that marker the way
`test` does:

- an entry is marked: `regression` spawns `bun run <script>` -- the whole
  script, handed no passthrough and no name filter -- and never `bun test`.
  The run is filed under the `regression` tier with the entry's framework,
  and the envelope names the script as `script`. This holds for each record
  kind: a `junit: flag` entry, a `junit: env:<VAR>` entry, and a `stream`
  entry;
- a `stream`-marked `regression --no-lifecycle` runs the script, files
  nothing and answers `ok: false`, naming the opt-out exactly as a stream
  tier run does;
- no entry is marked: `regression` spawns the same `bun test` argv the
  client's own builder produces, and its envelope carries no `script`
  (a regression pin);
- a marker `test` refuses (two marked entries; a marker of `"true"`, `1` or
  `false`; a marked script missing from `scripts`; a marked script whose body
  is empty) refuses `regression` too: a non-zero exit, ONE `target-refused`
  envelope whose detail equals the one `test` gives for the same package,
  nothing spawned and nothing posted;
- the verb's help names the entry marked `"test": true`, the full-suite
  `bun test` it otherwise runs, and that `--coverage` adds coverage.

Every case drives the REAL `clients/bun-crucible.py` as an OS subprocess, with
the stand-in `bun` of `bun_targets_harness` recording every argv it is spawned
with, against a stand-in board recording every POST.
"""

import importlib.util
import os
import unittest

from tests.client.bun_targets_harness import (
    AGENT,
    BUN_CLIENT,
    CLOSE,
    COMPILE,
    JUNIT_VAR,
    PARSED,
    RUN_ID,
    STREAM_FILE,
    STREAM_VAR,
    VITEST_STREAM_ENTRY,
    TargetsCase,
)
from tests.client.live_run_harness import START, STREAM_CODEC
from tests.client.integration.test_every_clients_help_says_regression_coverage_is_opt_in import (
    _plain,
    _root_line,
)

UNIT = "test:unit"
VITEST = "test:vitest"
ENV_JUNIT = f"env:{JUNIT_VAR}"
TARGET_REFUSED = "target-refused"

FLAG_BUN_TEST_ENTRY = {"framework": "bun-test", "junit": "flag"}
ENV_VITEST_ENTRY = {"framework": "vitest", "junit": ENV_JUNIT}


def marked(entry: dict, marker: object = True) -> dict:
    """`entry` carrying the `test` marker `marker` (any JSON value)."""
    return {**entry, "test": marker}


def _load_bun_client():
    """The bun client loaded as a module, for its own `bun test` builder."""
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_regression_marked_target", BUN_CLIENT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _codes(envelope):
    return [w.get("code") for w in (envelope or {}).get("warnings") or []
            if isinstance(w, dict)]


class _RegressionCase(TargetsCase):
    """Reading what one `regression` run spawned, posted and answered."""

    def only_spawn(self, drive):
        spawns = self.spawns()
        self.assertEqual(len(spawns), 1,
                         f"the run spawns its runner exactly once; spawns={spawns!r}; "
                         f"{drive.diag()}")
        return spawns[0] if spawns else {"argv": [], "env": {}}

    def assert_no_bun_test_spawned(self, drive):
        bun_tests = [s for s in self.spawns() if s["argv"][:1] == ["test"]]
        self.assertEqual(bun_tests, [],
                         f"a marked project's regression never spawns `bun test`; "
                         f"{drive.diag()}")

    def assert_filed_under_regression(self, drive, framework, codec):
        start = self.only(START, drive)
        self.assertEqual((start.get("tier"), start.get("framework")),
                         ("regression", framework),
                         f"the run opens under the regression tier with the entry's "
                         f"framework; start={start!r}")
        close = self.only(CLOSE, drive)
        self.assertEqual((close.get("codec"), close.get("runId"), close.get("tier"),
                          close.get("framework")),
                         (codec, RUN_ID, "regression", framework),
                         f"the run is filed under the regression tier with the "
                         f"entry's framework; close={close!r}")
        self.assertEqual(self.posts_to(COMPILE), [], drive.diag())
        return start, close

    def assert_regression_envelope_names(self, drive, script):
        envelope = self.envelope(drive)
        self.assertEqual(envelope.get("verb"), "regression", f"envelope={envelope!r}")
        self.assertEqual(envelope.get("script"), script,
                         f"the envelope names the marked script; envelope={envelope!r}")
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")


# ── a marked entry is the run, for each record kind ─────────────────────────


class RegressionRunsTheMarkedEntryTest(_RegressionCase):
    """`regression` spawns `bun run <marked script>`, whole, and files it
    under `regression` with the entry's framework."""

    def test_a_marked_flag_entry_runs_its_script_with_only_the_report_flags(self):
        self.declare({UNIT: "bun test tests/unit", VITEST: "vitest run"},
                     {"targets": {UNIT: marked(FLAG_BUN_TEST_ENTRY),
                                  VITEST: ENV_VITEST_ENTRY}})
        drive = self.drive("regression")
        argv = self.only_spawn(drive)["argv"]
        self.assert_no_bun_test_spawned(drive)
        self.assertEqual(argv[:3], ["run", UNIT, "--reporter=junit"],
                         f"the marked script runs by name, handed bun's report "
                         f"flags; argv={argv!r}")
        self.assertRegex(argv[3] if len(argv) > 3 else "",
                         r"^--reporter-outfile=.+junit\.xml$", f"argv={argv!r}")
        self.assertEqual(len(argv), 4,
                         f"only the report flags follow: no passthrough, no name "
                         f"filter; argv={argv!r}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_filed_under_regression(drive, "bun-test", "junit")
        self.assert_regression_envelope_names(drive, UNIT)

    def test_a_marked_env_entry_runs_its_script_alone_told_its_report_path(self):
        self.declare({UNIT: "bun test tests/unit", VITEST: "vitest run"},
                     {"targets": {UNIT: FLAG_BUN_TEST_ENTRY,
                                  VITEST: marked(ENV_VITEST_ENTRY)}})
        drive = self.drive("regression")
        spawn = self.only_spawn(drive)
        self.assert_no_bun_test_spawned(drive)
        self.assertEqual(spawn["argv"], ["run", VITEST],
                         f"the whole script runs, handed nothing on its command "
                         f"line; spawn={spawn!r}")
        self.assertEqual(os.path.realpath(spawn["env"].get(JUNIT_VAR) or ""),
                         os.path.realpath(self.reports / "junit.xml"),
                         f"the report path rides {JUNIT_VAR}; spawn={spawn!r}")
        self.assertIsNone(spawn["env"].get(STREAM_VAR), "a junit entry is handed no stream")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_filed_under_regression(drive, "vitest", "junit")
        self.assert_regression_envelope_names(drive, VITEST)

    def test_a_marked_stream_entry_runs_its_script_handed_the_stream(self):
        self.declare({UNIT: "bun test tests/unit", VITEST: "vitest run"},
                     {"targets": {UNIT: FLAG_BUN_TEST_ENTRY,
                                  VITEST: marked(VITEST_STREAM_ENTRY)}})
        drive = self.drive("regression")
        spawn = self.only_spawn(drive)
        self.assert_no_bun_test_spawned(drive)
        self.assertEqual(spawn["argv"], ["run", VITEST],
                         f"a stream entry is handed no report flags and no "
                         f"passthrough; spawn={spawn!r}")
        self.assertEqual(os.path.realpath(spawn["env"].get(STREAM_VAR) or ""),
                         os.path.realpath(self.reports / STREAM_FILE),
                         f"{STREAM_VAR} names <reports dir>/{STREAM_FILE}; spawn={spawn!r}")
        self.assertIsNone(spawn["env"].get(JUNIT_VAR), "a stream entry is handed no JUnit path")
        self.assertEqual(drive.returncode, 0, drive.diag())
        _start, close = self.assert_filed_under_regression(drive, "vitest", STREAM_CODEC)
        self.assertNotIn("data", close, f"a stream close sends no report; close={close!r}")
        held = self.board.held_stream(RUN_ID)
        self.assertEqual(held.count('"test-end"'), 3,
                         f"the board holds the runner's stream; held={held!r}")
        self.assert_regression_envelope_names(drive, VITEST)


class AStreamMarkedRegressionUnderNoLifecycleFilesNothingTest(_RegressionCase):
    """`regression --no-lifecycle` through a marked `stream` entry runs the
    script, files nothing and answers `ok: false`, as a stream tier run does."""

    def test_no_lifecycle_runs_the_marked_stream_script_files_nothing_and_answers_as_a_tier_run(self):
        # Keyed `test:unit` so the `unit` tier verb runs the same entry, giving
        # the stream tier run's own answer to compare against.
        self.declare({UNIT: "vitest run"}, {"targets": {UNIT: marked(VITEST_STREAM_ENTRY)}})
        tier_run = self.drive("unit", "--no-lifecycle")
        tier_envelope = self.envelope(tier_run)
        self.spawn_log.unlink(missing_ok=True)
        self.board.events.clear()

        drive = self.drive("regression", "--no-lifecycle")
        spawn = self.only_spawn(drive)
        self.assert_no_bun_test_spawned(drive)
        self.assertEqual(spawn["argv"], ["run", UNIT],
                         f"the marked stream script runs; spawn={spawn!r}")
        self.assertIsNone(spawn["env"].get(STREAM_VAR),
                          f"no run is opened, so no stream is handed; spawn={spawn!r}")
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.posts_to(START) + self.posts_to(CLOSE) + self.posts_to(COMPILE)
                         + self.posts_to(PARSED), [],
                         f"nothing is opened or filed; posts={self.board.posts()!r}")
        self.assertEqual(self.board.stream_posts(), [], "nothing is streamed")
        envelope = self.envelope(drive)
        self.assertEqual(envelope.get("verb"), "regression", f"envelope={envelope!r}")
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertIn("no-lifecycle", str(envelope.get("error")),
                      f"the cause named is the opt-out; envelope={envelope!r}")
        self.assertEqual(envelope.get("error"), tier_envelope.get("error"),
                         f"the unfiled cause is the stream tier run's; "
                         f"regression={envelope!r} tier={tier_envelope!r}")
        self.assertEqual(_codes(envelope), _codes(tier_envelope),
                         f"the warnings are the stream tier run's; "
                         f"regression={envelope!r} tier={tier_envelope!r}")
        self.assertEqual(envelope.get("script"), UNIT,
                         f"the envelope names the marked script; envelope={envelope!r}")


# ── no entry marked: the client's own `bun test`, unchanged ─────────────────


class WithNoMarkedEntryRegressionRunsBunTestTest(_RegressionCase):
    """Regression pins: an unmarked project's `regression` is unchanged."""

    def test_an_unmarked_table_spawns_exactly_the_clients_own_bun_test_argv(self):
        self.declare({UNIT: "bun test tests/unit", VITEST: "vitest run"},
                     {"targets": {UNIT: FLAG_BUN_TEST_ENTRY, VITEST: ENV_VITEST_ENTRY}})
        drive = self.drive("regression")
        argv = self.only_spawn(drive)["argv"]
        client = _load_bun_client()
        junit_path = client._junit_path(
            client._reports_dir(str(self.project), str(self.reports), AGENT))
        expected = client._bun_test_cmd(str(self.fake), None, junit_path, False, None)
        self.assertEqual(argv, expected[1:],
                         f"the same `bun test` argv the client's builder produces; "
                         f"{drive.diag()}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        envelope = self.envelope(drive)
        self.assertNotIn("script", envelope,
                         f"an unmarked run names no script; envelope={envelope!r}")

    def test_a_package_with_no_targets_table_spawns_bun_test_and_names_no_script(self):
        self.declare({UNIT: "bun test tests/unit"})
        drive = self.drive("regression")
        argv = self.only_spawn(drive)["argv"]
        self.assertEqual(argv[:1], ["test"], f"argv={argv!r}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertNotIn("script", self.envelope(drive), drive.diag())


# ── a marker `test` refuses refuses `regression` too ───────────────────────


class AMarkerTestRefusesRefusesRegressionTest(_RegressionCase):
    """Each refused marker: `regression` exits non-zero with ONE
    `target-refused` envelope whose detail is `test`'s, having spawned and
    posted nothing."""

    def refusal_detail(self, drive, verb):
        envelope = self.envelope(drive)
        self.assertEqual(envelope.get("verb"), verb, f"envelope={envelope!r}")
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        refused = [w for w in envelope.get("warnings") or []
                   if isinstance(w, dict) and w.get("code") == TARGET_REFUSED]
        self.assertEqual(len(refused), 1,
                         f"one {TARGET_REFUSED} warning; envelope={envelope!r}")
        return refused[0].get("detail") if refused else None

    def assert_regression_refused_as_test_is(self, scripts, targets):
        self.declare(scripts, {"targets": targets})
        drive = self.drive("regression")
        self.assertNotEqual(drive.returncode, 0, f"a refusal exits non-zero; {drive.diag()}")
        self.assertEqual(self.spawns(), [],
                         f"a refused regression spawns nothing; {drive.diag()}")
        self.assertEqual(self.board.posts(), [],
                         f"a refused regression posts nothing; {drive.diag()}")
        regression_detail = self.refusal_detail(drive, "regression")

        test_drive = self.drive("test")
        self.assertNotEqual(test_drive.returncode, 0, test_drive.diag())
        test_detail = self.refusal_detail(test_drive, "test")
        self.assertIsInstance(test_detail, str, test_drive.diag())
        self.assertEqual(regression_detail, test_detail,
                         f"regression refuses with test's detail for the same package; "
                         f"regression={drive.diag()} test={test_drive.diag()}")

    def test_two_marked_entries_refuse_regression(self):
        self.assert_regression_refused_as_test_is(
            {UNIT: "bun test tests/unit", VITEST: "vitest run"},
            {UNIT: marked(FLAG_BUN_TEST_ENTRY), VITEST: marked(ENV_VITEST_ENTRY)})

    def test_a_marker_that_is_the_string_true_refuses_regression(self):
        self.assert_regression_refused_as_test_is(
            {UNIT: "bun test tests/unit"}, {UNIT: marked(FLAG_BUN_TEST_ENTRY, "true")})

    def test_a_marker_that_is_the_number_one_refuses_regression(self):
        self.assert_regression_refused_as_test_is(
            {UNIT: "bun test tests/unit"}, {UNIT: marked(FLAG_BUN_TEST_ENTRY, 1)})

    def test_a_marker_of_false_refuses_regression(self):
        self.assert_regression_refused_as_test_is(
            {UNIT: "bun test tests/unit"}, {UNIT: marked(FLAG_BUN_TEST_ENTRY, False)})

    def test_a_marked_script_missing_from_scripts_refuses_regression(self):
        self.assert_regression_refused_as_test_is(
            {UNIT: "bun test tests/unit"}, {"test:absent": marked(FLAG_BUN_TEST_ENTRY)})

    def test_a_marked_script_with_an_empty_body_refuses_regression(self):
        self.assert_regression_refused_as_test_is(
            {"test:empty": ""}, {"test:empty": marked(FLAG_BUN_TEST_ENTRY)})


# ── the help ────────────────────────────────────────────────────────────────


class RegressionHelpNamesTheMarkedEntryTest(unittest.TestCase):
    """`regression`'s help line says what it runs: the entry marked
    `"test": true`, else the full-suite `bun test`; and that `--coverage`
    adds coverage."""

    def setUp(self):
        self.line = _plain(_root_line("bun", "regression"))

    def test_the_regression_help_names_the_entry_marked_test_true(self):
        self.assertIn('"test": true', self.line,
                      f"the help names the marked entry; line={self.line!r}")

    def test_the_regression_help_still_names_the_full_suite_bun_test(self):
        self.assertIn("bun test", self.line, f"line={self.line!r}")

    def test_the_regression_help_still_says_coverage_adds_coverage(self):
        self.assertIn("--coverage adds", self.line, f"line={self.line!r}")


if __name__ == "__main__":
    unittest.main()
