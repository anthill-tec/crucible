"""`test` runs the `crucible.targets` entry its table marks `"test": true`.

A bun project marks ONE entry of `crucible.targets` as the script `test` runs,
with the field `"test": true` (an unmarked entry omits the field). Only `test`
reads the marker: `test <files>` and `test --name <pattern>` run the marked
script, the files and the framework's filter flag riding its passthrough, and
the run carries the entry's framework; `test` with no files runs the whole
marked script under the verb `test`, with no tier.

Every test drives the REAL `clients/bun-crucible.py` as an OS subprocess
against `TargetsBoard`, with `FAKE_TARGET_BUN` as the runner (both in
tests/client/bun_targets_harness.py).

What is pinned:
- a marked `junit: flag` entry runs as `bun run <script>` with the report
  flags, then the files and the filter, with no `--`; a marked
  `junit: env:<VAR>` entry runs with nothing appended but a `--` and the
  files and the filter, its report path handed in the variable; a marked
  `stream` entry is handed `CRUCIBLE_STREAM` and is closed by its stream. Each
  run's start and close carry the entry's framework, and the envelope's
  `script` names the marked script;
- the filter flag follows the entry's framework: `-t` for `bun-test` and
  `vitest`, `--grep` for `playwright` and `playwright-bdd`, the pattern
  passed unchanged as ONE argument;
- `test` with no files runs the whole marked script, under the verb `test`,
  claiming no tier on its start or its close;
- only the marked entry is validated: another entry of the table that a tier
  verb would refuse does not stop `test`;
- each refusal comes before anything is posted and before the runner is
  spawned, exits non-zero and says `ok: false` in ONE envelope naming
  `crucible.targets` and the entry: two marked entries (naming both); a
  marker that is not `true` (`false`, a string, the number 1), on the entry
  `test` would run or on another; a marked script missing from `scripts`; a
  marked script whose body is empty;
- a tier verb on a marked entry runs as it does unmarked, and a bad or
  doubled marker does not stop it: the tier verbs ignore the marker
  (regression pins -- they pass on today's client, which reads no marker,
  and fail on one that validates the marker where every verb reads the
  entry);
- with no entry marked, `test` runs the client's own `bun test`
  (a regression pin, as above).

Interface choices (the spec leaves these open; GREEN is asked to use them):
- A refusal is said in the `test` verb's envelope (`ok: false`, its `error` or
  its `warnings[]`), naming `crucible.targets` and the entry's script key.
"""

import os
import unittest

from tests.client.bun_targets_harness import (
    CLOSE,
    COMPILE,
    JUNIT_VAR,
    REPORTERS_DIR,
    REPORTERS_VAR,
    RUN_ID,
    STREAM_FILE,
    STREAM_VAR,
    VITEST_STREAM_ENTRY,
    TargetsCase,
)
from tests.client.live_run_harness import START, STREAM_CODEC

UNIT = "test:unit"
VITEST = "test:vitest"
E2E = "test:e2e"
BDD = "test:bdd"
ENV_JUNIT = f"env:{JUNIT_VAR}"
TARGET_FILE = "targets.test.ts"
# An anchored pattern with a space and a group: it must reach the runner as
# ONE argument, unchanged.
PATTERN = "^targets (case_1|case_2)$"

FLAG_UNIT_ENTRY = {"framework": "bun-test", "junit": "flag"}
ENV_VITEST_ENTRY = {"framework": "vitest", "junit": ENV_JUNIT}


def marked(entry: dict, marker: object = True) -> dict:
    """`entry` carrying the `test` marker `marker` (any JSON value: the
    refusals declare markers that are not `true`)."""
    return {**entry, "test": marker}


class _MarkedTargetCase(TargetsCase):
    """Reading what one `test` run spawned and filed."""

    def only_spawn(self, drive):
        spawns = self.spawns()
        self.assertEqual(len(spawns), 1,
                         f"`test` spawns its runner exactly once; spawns={spawns!r}; "
                         f"{drive.diag()}")
        return spawns[0] if spawns else {"argv": [], "env": {}}

    def assert_filed_from_junit_with_framework(self, drive, framework):
        start = self.only(START, drive)
        self.assertEqual(start.get("framework"), framework,
                         f"the run start carries the entry's framework; start={start!r}")
        close = self.only(CLOSE, drive)
        self.assertEqual((close.get("codec"), close.get("runId"), close.get("framework")),
                         ("junit", RUN_ID, framework),
                         f"the run is filed from its JUnit report, carrying the "
                         f"entry's framework; close={close!r}")
        self.assertEqual(self.posts_to(COMPILE), [], drive.diag())
        return start, close

    def assert_untiered(self, start, close):
        self.assertNotIn("tier", start,
                         f"a `test` run claims no tier on its start; start={start!r}")
        self.assertNotIn("tier", close,
                         f"a `test` run claims no tier on its close; close={close!r}")


# ── `test` runs the marked entry ────────────────────────────────────────────


class TestRunsTheMarkedJunitEntryTest(_MarkedTargetCase):
    """A marked `junit` entry, under the flag and under an env variable."""

    def test_a_marked_flag_entry_runs_its_script_with_the_report_flags_the_files_and_the_filter(self):
        self.declare({UNIT: "bun test", VITEST: "vitest run"},
                     {"targets": {UNIT: marked(FLAG_UNIT_ENTRY), VITEST: ENV_VITEST_ENTRY}})
        drive = self.drive("test", "--tests", TARGET_FILE, "--name", PATTERN)
        argv = self.only_spawn(drive)["argv"]
        self.assertEqual(argv[:3], ["run", UNIT, "--reporter=junit"],
                         f"the marked script runs by name, not the other entry's; "
                         f"argv={argv!r}")
        self.assertRegex(argv[3] if len(argv) > 3 else "",
                         r"^--reporter-outfile=.+junit\.xml$", f"argv={argv!r}")
        self.assertEqual(argv[4:], [TARGET_FILE, "-t", PATTERN],
                         f"the file and the filter follow the report flags, the "
                         f"pattern as one argument; argv={argv!r}")
        self.assertNotIn("--", argv, f"argv={argv!r}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_filed_from_junit_with_framework(drive, "bun-test")
        envelope = self.envelope(drive)
        self.assertEqual(envelope.get("script"), UNIT, f"envelope={envelope!r}")
        self.assertEqual(envelope.get("name"), PATTERN, f"envelope={envelope!r}")

    def test_a_marked_env_entry_runs_its_script_with_the_files_and_the_filter_after_dashdash(self):
        self.declare({UNIT: "bun test", VITEST: "vitest run"},
                     {"targets": {UNIT: FLAG_UNIT_ENTRY, VITEST: marked(ENV_VITEST_ENTRY)}})
        drive = self.drive("test", "--tests", "a.vitest.ts", "--name", PATTERN)
        spawn = self.only_spawn(drive)
        self.assertEqual(spawn["argv"], ["run", VITEST, "--", "a.vitest.ts", "-t", PATTERN],
                         f"under env:<VAR> nothing is appended but the passthrough; "
                         f"spawn={spawn!r}")
        self.assertEqual(os.path.realpath(spawn["env"].get(JUNIT_VAR) or ""),
                         os.path.realpath(self.reports / "junit.xml"),
                         f"the report path rides {JUNIT_VAR}; spawn={spawn!r}")
        self.assertIsNone(spawn["env"].get(STREAM_VAR), "a junit entry is handed no stream")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_filed_from_junit_with_framework(drive, "vitest")
        envelope = self.envelope(drive)
        self.assertEqual(envelope.get("script"), VITEST, f"envelope={envelope!r}")


class TestRunsTheMarkedStreamEntryTest(_MarkedTargetCase):
    """A marked `stream` entry streams, and is closed by its stream."""

    def test_a_marked_stream_entry_is_handed_the_stream_with_the_files_and_the_filter(self):
        self.declare({UNIT: "bun test", VITEST: "vitest run"},
                     {"targets": {UNIT: FLAG_UNIT_ENTRY, VITEST: marked(VITEST_STREAM_ENTRY)}})
        drive = self.drive("test", "--tests", "a.vitest.ts", "--name", PATTERN)
        spawn = self.only_spawn(drive)
        self.assertEqual(spawn["argv"], ["run", VITEST, "--", "a.vitest.ts", "-t", PATTERN],
                         f"a stream entry is handed no report flags; spawn={spawn!r}")
        env = spawn["env"]
        self.assertEqual(os.path.realpath(env.get(STREAM_VAR) or ""),
                         os.path.realpath(self.reports / STREAM_FILE),
                         f"{STREAM_VAR} names <reports dir>/{STREAM_FILE}; spawn={spawn!r}")
        self.assertEqual(os.path.realpath(env.get(REPORTERS_VAR) or ""),
                         os.path.realpath(REPORTERS_DIR),
                         f"{REPORTERS_VAR} names the client's install's reporters/")
        self.assertIsNone(env.get(JUNIT_VAR), "a stream entry is handed no JUnit path")
        self.assertEqual(drive.returncode, 0, drive.diag())
        start = self.only(START, drive)
        self.assertEqual(start.get("framework"), "vitest", f"start={start!r}")
        close = self.only(CLOSE, drive)
        self.assertEqual((close.get("codec"), close.get("runId"), close.get("framework")),
                         (STREAM_CODEC, RUN_ID, "vitest"),
                         f"the run is closed by its stream; close={close!r}")
        self.assertNotIn("data", close, "a stream close sends no report")
        self.assertEqual(self.posts_to(COMPILE), [], drive.diag())
        held = self.board.held_stream(RUN_ID)
        self.assertEqual(held.count('"test-end"'), 3,
                         f"the board holds the runner's stream; held={held!r}")
        self.assertEqual(self.envelope(drive).get("script"), VITEST, drive.diag())


# ── the filter flag follows the entry's framework ───────────────────────────


class TheNameFilterFollowsTheMarkedEntrysFrameworkTest(_MarkedTargetCase):
    """`--name` reaches the marked script as its framework's own filter flag."""

    def filtered_argv(self, script, framework):
        self.declare({script: "some-runner"},
                     {"targets": {script: marked({"framework": framework,
                                                  "junit": ENV_JUNIT})}})
        drive = self.drive("test", "--tests", "some.spec.ts", "--name", PATTERN)
        argv = self.only_spawn(drive)["argv"]
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_filed_from_junit_with_framework(drive, framework)
        return argv

    def test_a_bun_test_entry_filters_with_dash_t(self):
        self.assertEqual(self.filtered_argv(UNIT, "bun-test"),
                         ["run", UNIT, "--", "some.spec.ts", "-t", PATTERN])

    def test_a_vitest_entry_filters_with_dash_t(self):
        self.assertEqual(self.filtered_argv(VITEST, "vitest"),
                         ["run", VITEST, "--", "some.spec.ts", "-t", PATTERN])

    def test_a_playwright_entry_filters_with_grep(self):
        argv = self.filtered_argv(E2E, "playwright")
        self.assertEqual(argv, ["run", E2E, "--", "some.spec.ts", "--grep", PATTERN])
        self.assertNotIn("-t", argv, f"playwright takes no `-t`; argv={argv!r}")

    def test_a_playwright_bdd_entry_filters_with_grep(self):
        argv = self.filtered_argv(BDD, "playwright-bdd")
        self.assertEqual(argv, ["run", BDD, "--", "some.spec.ts", "--grep", PATTERN])
        self.assertNotIn("-t", argv, f"playwright-bdd takes no `-t`; argv={argv!r}")

    def test_a_playwright_filter_with_no_files_is_the_grep_alone(self):
        self.declare({E2E: "playwright test"},
                     {"targets": {E2E: marked({"framework": "playwright",
                                               "junit": ENV_JUNIT})}})
        drive = self.drive("test", "--name", PATTERN)
        self.assertEqual(self.only_spawn(drive)["argv"],
                         ["run", E2E, "--", "--grep", PATTERN], drive.diag())


# ── `test` with no files runs the whole marked script ───────────────────────


class TestWithNoFilesRunsTheWholeMarkedScriptTest(_MarkedTargetCase):

    def test_a_marked_env_entry_with_no_files_runs_the_script_alone_under_verb_test_untiered(self):
        self.declare({VITEST: "vitest run"}, {"targets": {VITEST: marked(ENV_VITEST_ENTRY)}})
        drive = self.drive("test")
        self.assertEqual(self.only_spawn(drive)["argv"], ["run", VITEST],
                         f"the whole script runs, handed no passthrough; {drive.diag()}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        start, close = self.assert_filed_from_junit_with_framework(drive, "vitest")
        self.assert_untiered(start, close)
        envelope = self.envelope(drive)
        self.assertEqual(envelope.get("verb"), "test", f"envelope={envelope!r}")
        self.assertEqual(envelope.get("script"), VITEST, f"envelope={envelope!r}")
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")

    def test_a_marked_flag_entry_with_no_files_runs_the_script_and_its_report_flags(self):
        self.declare({UNIT: "bun test"}, {"targets": {UNIT: marked(FLAG_UNIT_ENTRY)}})
        drive = self.drive("test")
        argv = self.only_spawn(drive)["argv"]
        self.assertEqual(argv[:3], ["run", UNIT, "--reporter=junit"], f"argv={argv!r}")
        self.assertEqual(len(argv), 4, f"only the report flags follow; argv={argv!r}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        start, close = self.assert_filed_from_junit_with_framework(drive, "bun-test")
        self.assert_untiered(start, close)
        self.assertEqual(self.envelope(drive).get("verb"), "test", drive.diag())


# ── only the marked entry is validated ──────────────────────────────────────


class OnlyTheMarkedEntryIsValidatedTest(_MarkedTargetCase):

    def test_an_unmarked_entry_a_tier_verb_would_refuse_does_not_stop_test(self):
        self.declare({UNIT: "bun test", VITEST: "vitest run"},
                     {"targets": {UNIT: marked(FLAG_UNIT_ENTRY),
                                  VITEST: {"framework": "jest", "junit": ENV_JUNIT}}})
        drive = self.drive("test")
        self.assertEqual(self.only_spawn(drive)["argv"][:2], ["run", UNIT], drive.diag())
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_filed_from_junit_with_framework(drive, "bun-test")


# ── every refusal of the marker comes before anything is posted ─────────────


class AMarkerTestCannotHonourIsRefusedTest(_MarkedTargetCase):
    """Each refusal: non-zero exit, nothing posted, the runner never spawned,
    ONE `ok: false` envelope naming `crucible.targets` and the entry."""

    def test_two_marked_entries_are_refused_naming_both(self):
        self.declare({UNIT: "bun test", VITEST: "vitest run"},
                     {"targets": {UNIT: marked(FLAG_UNIT_ENTRY),
                                  VITEST: marked(ENV_VITEST_ENTRY)}})
        drive = self.drive("test", "--tests", TARGET_FILE)
        self.assert_refused_before_anything_is_posted(drive, UNIT, VITEST)

    def test_a_marker_of_false_is_refused(self):
        self.declare({UNIT: "bun test"},
                     {"targets": {UNIT: marked(FLAG_UNIT_ENTRY, False)}})
        drive = self.drive("test", "--tests", TARGET_FILE)
        self.assert_refused_before_anything_is_posted(drive, UNIT)

    def test_a_marker_of_false_beside_a_true_one_is_refused_naming_the_false_entry(self):
        self.declare({UNIT: "bun test", VITEST: "vitest run"},
                     {"targets": {UNIT: marked(FLAG_UNIT_ENTRY),
                                  VITEST: marked(ENV_VITEST_ENTRY, False)}})
        drive = self.drive("test")
        self.assert_refused_before_anything_is_posted(drive, VITEST)

    def test_a_marker_that_is_a_string_is_refused(self):
        self.declare({UNIT: "bun test"},
                     {"targets": {UNIT: marked(FLAG_UNIT_ENTRY, "true")}})
        drive = self.drive("test", "--tests", TARGET_FILE)
        self.assert_refused_before_anything_is_posted(drive, UNIT)

    def test_a_marker_that_is_the_number_one_is_refused(self):
        self.declare({UNIT: "bun test"},
                     {"targets": {UNIT: marked(FLAG_UNIT_ENTRY, 1)}})
        drive = self.drive("test", "--tests", TARGET_FILE)
        self.assert_refused_before_anything_is_posted(drive, UNIT)

    def test_a_marked_script_missing_from_scripts_is_refused(self):
        self.declare({UNIT: "bun test"},
                     {"targets": {"test:absent": marked(FLAG_UNIT_ENTRY)}})
        drive = self.drive("test", "--tests", TARGET_FILE)
        self.assert_refused_before_anything_is_posted(drive, "test:absent")

    def test_a_marked_script_missing_from_scripts_is_refused_on_a_whole_suite_run_too(self):
        self.declare({UNIT: "bun test"},
                     {"targets": {"test:absent": marked(FLAG_UNIT_ENTRY)}})
        drive = self.drive("test")
        self.assert_refused_before_anything_is_posted(drive, "test:absent")

    def test_a_marked_script_whose_body_is_empty_is_refused(self):
        self.declare({"test:empty": ""},
                     {"targets": {"test:empty": marked(FLAG_UNIT_ENTRY)}})
        drive = self.drive("test", "--tests", TARGET_FILE)
        self.assert_refused_before_anything_is_posted(drive, "test:empty")


# ── the tier verbs ignore the marker ────────────────────────────────────────


class TheTierVerbsIgnoreTheMarkerTest(_MarkedTargetCase):
    """Regression pins: `unit` on a marked entry runs as it does unmarked."""

    def assert_unit_runs_its_entry(self, drive):
        argv = self.only_spawn(drive)["argv"]
        self.assertEqual(argv[:3], ["run", UNIT, "--reporter=junit"], f"argv={argv!r}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        start = self.only(START, drive)
        self.assertEqual((start.get("tier"), start.get("framework")), ("unit", "bun-test"),
                         f"start={start!r}")
        self.assertIs(self.envelope(drive).get("ok"), True, drive.diag())

    def test_a_tier_verb_on_a_marked_entry_runs_as_it_does_unmarked(self):
        self.declare_unit_target(marked(FLAG_UNIT_ENTRY))
        self.assert_unit_runs_its_entry(self.drive("unit"))

    def test_a_tier_verb_on_an_entry_with_a_bad_marker_is_not_refused(self):
        self.declare_unit_target(marked(FLAG_UNIT_ENTRY, "yes"))
        self.assert_unit_runs_its_entry(self.drive("unit"))

    def test_a_tier_verb_on_a_table_with_two_marked_entries_is_not_refused(self):
        self.declare({UNIT: "bun test", VITEST: "vitest run"},
                     {"targets": {UNIT: marked(FLAG_UNIT_ENTRY),
                                  VITEST: marked(ENV_VITEST_ENTRY)}})
        self.assert_unit_runs_its_entry(self.drive("unit"))


# ── no marked entry: the client's own `bun test` ────────────────────────────


class WithNoMarkedEntryTestRunsBunTestTest(_MarkedTargetCase):
    """A regression pin: an unmarked table leaves `test` on `bun test`."""

    def test_a_table_with_no_marked_entry_leaves_test_on_the_clients_own_bun_test(self):
        self.declare({UNIT: "bun test"}, {"targets": {UNIT: FLAG_UNIT_ENTRY}})
        drive = self.drive("test")
        argv = self.only_spawn(drive)["argv"]
        self.assertEqual(argv[0], "test",
                         f"the client's own `bun test` runs, not the entry's "
                         f"script; argv={argv!r}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_filed_from_junit_with_framework(drive, "bun-test")


if __name__ == "__main__":
    unittest.main()
