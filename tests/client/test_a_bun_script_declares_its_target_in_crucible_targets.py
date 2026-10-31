"""A bun script declares its target in `crucible.targets`: framework, record,
console and coverage, read by the bun client.

Every test drives the REAL `clients/bun-crucible.py` as an OS subprocess against
`TargetsBoard` (the console-relay tests' `ConsoleBoard`, a `RecordingBoard`,
answering health with `codecs.stream`, `codecs.view` and `codecs.coverage`), with
`FAKE_TARGET_BUN` as the runner (both in tests/client/bun_targets_harness.py).

What is pinned:
- every refusal of a table entry happens before anything is posted and before
  the runner is spawned, in ONE `ok: false` envelope naming the script's key
  and `crucible.targets`: an entry that is not an object or has no
  `framework`; a framework outside `bun-test`, `vitest`, `playwright` and
  `playwright-bdd`; both `stream` and `junit`, or neither; a `stream` with no
  `codec`, no `path`, or a `path` other than `env:CRUCIBLE_STREAM`; a `junit`
  that is neither `flag` nor `env:<VAR>`; a `console` on a `stream` entry; a
  `console: bun-console` on a framework other than `bun-test`; a `coverage` the
  target cannot produce (only `lcov`, on a `junit: flag` `bun-test` target);
  a script in the table and in `crucible.reportPath` or `crucible.rawReport`
  (that refusal names both);
- a script with no table entry runs as today, now stamped framework
  `bun-test` on its start and its close (the compile close and the
  `--no-lifecycle` single-shot ingest included), against a health with no
  `codecs.view` too: no relay and no refusal;
- a codec the table declares that the board's health does not list
  (`codecs.stream`, `codecs.view`, `codecs.coverage`) is refused before the run
  opens; under `--no-lifecycle` no health is read and nothing is checked;
- a `junit: env:<VAR>` target is handed its report path in that variable,
  and relays its console only when its entry declares `console: bun-console`;
- `crucible.testScript` naming a table-declared script runs through that
  entry: the runner is handed `CRUCIBLE_STREAM=<reports dir>/crucible-events.
  ndjson` and `CRUCIBLE_REPORTERS=<the client's install>/reporters`, and the run
  is closed by its stream; naming a `junit` entry, the runner is handed its
  report path the entry's way, the run is filed from its JUnit report stamped
  `bun-test`, and its console relays only when the entry declares one;
- the declared `framework` rides the run start and the close, and a declared
  `coverage` names the coverage codec the close carries; `check` sends no
  framework.

Interface choices (the spec leaves these open; GREEN is asked to use them):
- A refusal is said in the verb's envelope (`ok: false`, its `error` or its
  `warnings[]`), which names `crucible.targets`, the script's key and, where
  one field is at fault, that field's key (`framework`, `stream`, `junit`,
  `codec`, `path`, `console`, `coverage`); a `sys.exit` message on stderr
  alone does not satisfy these tests.
- The board check's refusal names the codec the board's health does not list.
- The unfiled answer of a stream target with no open run names its cause in
  the envelope's `error`: the board's URL (as python's does), or
  `--no-lifecycle`.
- The table is read, for one script, by `_declared_target(package_dir,
  script)` in clients/bun-crucible.py, answering `(target, refusal)`: the
  entry as the client runs it (None for a script with no entry), or the
  refusal's detail. No test here calls it: it is driven only through the
  verbs.
- The coverage codec a declared `coverage` names rides the close as the
  close's `coverage.codec`; the run start carries no coverage.
"""

import json
import os
import unittest

from tests.client.bun_targets_harness import (
    AGENT,
    CLOSE,
    COMPILE,
    INGESTING,
    JUNIT_VAR,
    PLANTED_LCOV,
    REPORTERS_DIR,
    REPORTERS_VAR,
    RUN_ID,
    RUN_STREAM,
    STREAM_FILE,
    STREAM_PATH_DECLARATION,
    STREAM_VAR,
    VIEW_CODEC,
    VITEST_STREAM_ENTRY,
    TargetsBoard,
    TargetsCase,
)
from tests.client.live_run_harness import START, STREAM_CODEC

UNIT = "test:unit"
VITEST = "test:vitest"
ENV_JUNIT = f"env:{JUNIT_VAR}"


# ── every refusal of a table entry ──────────────────────────────────────────


class EveryTableRefusalComesBeforeAnythingIsPostedTest(TargetsCase):
    """Each entry `unit` would run through is refused before the board hears
    anything and before the runner is spawned."""

    def refuse(self, entry, *also_named, **crucible):
        self.declare_unit_target(entry, **crucible)
        drive = self.drive("unit")
        self.assert_refused_before_anything_is_posted(drive, UNIT, *also_named)

    def test_an_entry_that_is_not_an_object_is_refused(self):
        self.refuse("bun-test")

    def test_an_entry_with_no_framework_is_refused(self):
        self.refuse({"junit": "flag"}, "framework")

    def test_a_framework_reserved_for_another_stack_is_refused(self):
        self.refuse({"framework": "pytest", "junit": "flag"}, "framework")

    def test_a_framework_no_stack_names_is_refused(self):
        self.refuse({"framework": "jest", "junit": "flag"}, "framework")

    def test_an_entry_with_both_stream_and_junit_is_refused(self):
        self.refuse({**VITEST_STREAM_ENTRY, "junit": "flag"}, "stream", "junit")

    def test_an_entry_with_neither_stream_nor_junit_is_refused(self):
        self.refuse({"framework": "bun-test"}, "stream", "junit")

    def test_a_stream_path_naming_another_variable_is_refused(self):
        self.refuse({"framework": "vitest",
                     "stream": {"codec": STREAM_CODEC, "path": "env:OTHER_STREAM"}},
                    "path")

    def test_a_stream_with_no_codec_is_refused(self):
        self.refuse({"framework": "vitest", "stream": {"path": STREAM_PATH_DECLARATION}},
                    "codec")

    def test_a_stream_with_no_path_is_refused(self):
        self.refuse({"framework": "vitest", "stream": {"codec": STREAM_CODEC}}, "path")

    def test_a_junit_that_is_neither_flag_nor_an_env_variable_is_refused(self):
        self.refuse({"framework": "bun-test", "junit": "file:report.xml"}, "junit")

    def test_a_junit_env_declaration_naming_no_variable_is_refused(self):
        self.refuse({"framework": "bun-test", "junit": "env:"}, "junit")

    def test_a_console_on_a_stream_entry_is_refused(self):
        self.refuse({**VITEST_STREAM_ENTRY, "console": VIEW_CODEC}, "console")

    def test_a_bun_console_on_a_framework_other_than_bun_test_is_refused(self):
        self.refuse({"framework": "vitest", "junit": ENV_JUNIT, "console": VIEW_CODEC},
                    "console")

    def test_lcov_coverage_on_a_stream_entry_is_refused(self):
        self.refuse({**VITEST_STREAM_ENTRY, "coverage": "lcov"}, "coverage")

    def test_lcov_coverage_on_an_env_junit_target_is_refused(self):
        self.refuse({"framework": "bun-test", "junit": ENV_JUNIT, "coverage": "lcov"},
                    "coverage")

    def test_lcov_coverage_on_a_flag_target_of_another_framework_is_refused(self):
        self.refuse({"framework": "vitest", "junit": "flag", "coverage": "lcov"},
                    "coverage")

    def test_a_coverage_codec_other_than_lcov_is_refused(self):
        self.refuse({"framework": "bun-test", "junit": "flag", "coverage": "jacoco"},
                    "coverage")

    def test_a_script_in_the_table_and_in_report_path_is_refused_naming_both(self):
        self.refuse({"framework": "bun-test", "junit": "flag"}, "crucible.reportPath",
                    reportPath={UNIT: "flag"})

    def test_a_script_in_the_table_and_in_raw_report_is_refused_naming_both(self):
        self.refuse({"framework": "bun-test", "junit": "flag"}, "crucible.rawReport",
                    rawReport={UNIT: {"codec": "playwright", "file": "results.json",
                                      "path": "env:FIXTURE_RAW_PATH"}})

    def test_a_test_run_through_a_test_script_with_a_refused_entry_is_refused(self):
        self.declare({VITEST: "vitest run"},
                     {"testScript": VITEST,
                      "targets": {VITEST: {"framework": "jest", "junit": ENV_JUNIT}}})
        drive = self.drive("test")
        self.assert_refused_before_anything_is_posted(drive, VITEST, "framework")


# ── a script with no table entry runs as today, stamped bun-test ────────────


class AScriptWithNoTableEntryRunsAsTodayTest(TargetsCase):
    """No entry: today's run, now carrying framework `bun-test`."""

    def setUp(self):
        super().setUp()
        # A health with no `codecs.view` and no `codecs.stream`: an older board.
        self.use_board(TargetsBoard(stream=None, view=None))

    def assert_todays_junit_run_stamped_bun_test(self, drive):
        self.assertEqual(drive.returncode, 0, drive.diag())
        start = self.only(START, drive)
        close = self.only(CLOSE, drive)
        self.assertEqual(start.get("framework"), "bun-test",
                         f"the run start carries framework bun-test; start={start!r}")
        self.assertEqual((close.get("codec"), close.get("runId"), close.get("framework")),
                         ("junit", RUN_ID, "bun-test"),
                         f"the JUnit close carries framework bun-test; close={close!r}")
        self.assertEqual(self.board.stream_posts(), [],
                         "a board with no `codecs.view` gets no relay")
        self.assertIs(self.envelope(drive).get("ok"), True, drive.diag())

    def test_the_clients_own_bun_test_is_stamped_bun_test_with_no_relay_and_no_refusal(self):
        drive = self.drive("test")
        self.assert_todays_junit_run_stamped_bun_test(drive)
        self.assertEqual(len(self.spawns()), 1, drive.diag())
        self.assertEqual(self.spawns()[0]["argv"][0], "test",
                         "the client's own `bun test` runs, as today")

    def test_a_declared_script_with_no_table_entry_is_stamped_bun_test(self):
        self.declare({UNIT: "bun test"})
        drive = self.drive("unit")
        self.assert_todays_junit_run_stamped_bun_test(drive)
        self.assertEqual(self.spawns()[0]["argv"][:2], ["run", UNIT], drive.diag())

    def test_a_script_missing_from_a_table_that_declares_others_runs_as_today(self):
        self.declare({UNIT: "bun test", VITEST: "vitest run"},
                     {"targets": {VITEST: VITEST_STREAM_ENTRY}})
        drive = self.drive("unit")
        self.assert_todays_junit_run_stamped_bun_test(drive)

    def test_a_run_with_no_report_is_closed_by_a_compile_ingest_stamped_bun_test(self):
        drive = self.drive("test", FAKE_SHAPE="no-report")
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        compile_close = self.only(COMPILE, drive)
        self.assertEqual((compile_close.get("runId"), compile_close.get("framework")),
                         (RUN_ID, "bun-test"),
                         f"the compile close carries framework bun-test; "
                         f"body={compile_close!r}")

    def test_a_no_lifecycle_single_shot_ingest_is_stamped_bun_test(self):
        drive = self.drive("test", "--no-lifecycle")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.posts_to(START), [], "--no-lifecycle opens no run")
        close = self.only(CLOSE, drive)
        self.assertNotIn("runId", close)
        self.assertEqual(close.get("framework"), "bun-test", f"close={close!r}")


# ── the board check ─────────────────────────────────────────────────────────


class ATableCodecTheBoardDoesNotListIsRefusedTest(TargetsCase):
    """A codec the table declares, missing from the board's health list, is
    refused before the run opens and before the runner is spawned."""

    def assert_refused_before_the_run_opens(self, drive, codec):
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.posts_to(START), [],
                         f"refused before the run opens; posts={self.board.posts()!r}")
        self.assertEqual(self.posts_to(CLOSE) + self.posts_to(COMPILE), [],
                         "nothing is filed")
        self.assertEqual(self.spawns(), [], f"the runner is never spawned; {drive.diag()}")
        envelope = self.envelope(drive)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertIn(codec, json.dumps(envelope),
                      f"the refusal names the codec; envelope={envelope!r}")

    def test_a_stream_codec_missing_from_codecs_stream_is_refused(self):
        # `codecs.test` still lists crucible-events: the check reads codecs.stream.
        self.use_board(TargetsBoard(stream=["another-stream-codec"]))
        self.declare_unit_target(VITEST_STREAM_ENTRY)
        drive = self.drive("unit")
        self.assert_refused_before_the_run_opens(drive, STREAM_CODEC)

    def test_a_console_codec_missing_from_codecs_view_is_refused(self):
        self.use_board(TargetsBoard(view=[]))
        self.declare_unit_target({"framework": "bun-test", "junit": "flag",
                                  "console": VIEW_CODEC})
        drive = self.drive("unit")
        self.assert_refused_before_the_run_opens(drive, VIEW_CODEC)

    def test_a_coverage_codec_missing_from_codecs_coverage_is_refused(self):
        self.use_board(TargetsBoard(coverage=["jacoco"]))
        self.declare_unit_target({"framework": "bun-test", "junit": "flag",
                                  "coverage": "lcov"})
        drive = self.drive("unit", "--coverage")
        self.assert_refused_before_the_run_opens(drive, "lcov")

    def test_under_no_lifecycle_a_stream_target_reads_no_health_and_checks_nothing(self):
        self.use_board(TargetsBoard(stream=["another-stream-codec"]))
        self.declare_unit_target(VITEST_STREAM_ENTRY)
        drive = self.drive("unit", "--no-lifecycle")
        self.assertEqual(self.board.health_reads(), [],
                         f"no health is read under --no-lifecycle; {drive.diag()}")
        self.assertEqual(len(self.spawns()), 1,
                         f"nothing is checked: the suite runs; {drive.diag()}")

    def test_under_no_lifecycle_an_unlisted_console_is_not_checked(self):
        self.use_board(TargetsBoard(view=[]))
        self.declare_unit_target({"framework": "bun-test", "junit": "flag",
                                  "console": VIEW_CODEC})
        drive = self.drive("unit", "--no-lifecycle")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(len(self.spawns()), 1, drive.diag())
        close = self.only(CLOSE, drive)
        self.assertEqual((close.get("codec"), close.get("framework")), ("junit", "bun-test"),
                         f"the run files single-shot, unchecked; close={close!r}")


# ── a junit target with env:<VAR> relays by its console ─────────────────────


class AJunitEnvTargetRelaysByItsConsoleTest(TargetsCase):
    """`junit: env:<VAR>` hands the report path in that variable; `console`
    alone decides the relay."""

    def assert_handed_its_report_path_the_declared_way(self, drive):
        spawns = self.spawns()
        self.assertEqual(len(spawns), 1, drive.diag())
        argv, env = spawns[0]["argv"], spawns[0]["env"]
        self.assertEqual(argv, ["run", UNIT],
                         "an env-declared target is handed no report flags")
        self.assertEqual(os.path.realpath(env.get(JUNIT_VAR) or ""),
                         os.path.realpath(self.reports / "junit.xml"),
                         f"the report path rides {JUNIT_VAR}; spawn={spawns[0]!r}")
        close = self.only(CLOSE, drive)
        self.assertEqual((close.get("codec"), close.get("runId"), close.get("framework")),
                         ("junit", RUN_ID, "bun-test"), f"close={close!r}")

    def test_a_junit_env_target_declaring_bun_console_relays_its_console(self):
        self.declare_unit_target({"framework": "bun-test", "junit": ENV_JUNIT,
                                  "console": VIEW_CODEC})
        drive = self.drive("unit")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_handed_its_report_path_the_declared_way(drive)
        self.assertTrue(self.view_batches(), f"the console is relayed; {drive.diag()}")
        self.assertEqual({p for p, _b in self.board.stream_posts()}, {RUN_STREAM})
        held = self.board.held_stream(RUN_ID)
        self.assertIn("(pass) targets > case_1 [0.01ms]\n", held,
                      "the runner's console is what the board holds")

    def test_a_junit_env_target_declaring_no_console_does_not_relay(self):
        self.declare_unit_target({"framework": "bun-test", "junit": ENV_JUNIT})
        drive = self.drive("unit")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assert_handed_its_report_path_the_declared_way(drive)
        self.assertEqual(self.board.stream_posts(), [], "nothing is relayed")


# ── crucible.testScript naming a table-declared script ──────────────────────


class ATestScriptNamingATableScriptRunsThroughItsEntryTest(TargetsCase):

    def test_a_test_run_through_a_stream_entry_is_handed_the_stream_and_closed_by_it(self):
        self.declare({VITEST: "vitest run"},
                     {"testScript": VITEST, "targets": {VITEST: VITEST_STREAM_ENTRY}})
        drive = self.drive("test")
        self.assertEqual(drive.returncode, 0, drive.diag())
        spawns = self.spawns()
        self.assertEqual(len(spawns), 1, drive.diag())
        self.assertEqual(spawns[0]["argv"], ["run", VITEST],
                         "a stream target is handed no report flags")
        env = spawns[0]["env"]
        self.assertEqual(os.path.realpath(env.get(STREAM_VAR) or ""),
                         os.path.realpath(self.reports / STREAM_FILE),
                         f"{STREAM_VAR} names <reports dir>/{STREAM_FILE}; spawn={spawns[0]!r}")
        self.assertEqual(os.path.realpath(env.get(REPORTERS_VAR) or ""),
                         os.path.realpath(REPORTERS_DIR),
                         f"{REPORTERS_VAR} names the client's install's reporters/")
        self.assertIsNone(env.get(JUNIT_VAR))
        start = self.only(START, drive)
        self.assertEqual(start.get("framework"), "vitest", f"start={start!r}")
        close = self.only(CLOSE, drive)
        self.assertEqual(
            (close.get("codec"), close.get("runId"), close.get("framework")),
            (STREAM_CODEC, RUN_ID, "vitest"),
            f"the run is closed by its stream; close={close!r}")
        self.assertNotIn("data", close, "a stream close sends no report")
        self.assertEqual(self.posts_to(COMPILE), [])
        held = self.board.held_stream(RUN_ID)
        self.assertEqual(held.count('"test-end"'), 3,
                         f"the board holds the runner's stream; held={held!r}")
        self.assertEqual({b.get("codec") for _p, b in self.board.stream_posts()},
                         {STREAM_CODEC}, "the stream is relayed under its declared codec")
        messages = self.board.messages()
        self.assertIn("ran 3/3", messages,
                      f"the narration counts the stream's tests; messages={messages!r}")
        envelope = self.envelope(drive)
        self.assertEqual(envelope.get("script"), VITEST, f"envelope={envelope!r}")
        self.assertIn(INGESTING, messages)

    def run_through_a_junit_entry(self, entry):
        """`test` through `crucible.testScript` naming `test:unit`, whose
        table entry is `entry`: the runner is handed its report path the
        entry's way and the run is filed from its JUnit report, stamped
        `bun-test`."""
        self.declare({UNIT: "bun test"},
                     {"testScript": UNIT, "targets": {UNIT: entry}})
        drive = self.drive("test")
        self.assertEqual(drive.returncode, 0, drive.diag())
        spawns = self.spawns()
        self.assertEqual(len(spawns), 1, drive.diag())
        self.assertEqual(spawns[0]["argv"], ["run", UNIT],
                         "the named script runs, handed no report flags")
        env = spawns[0]["env"]
        self.assertEqual(os.path.realpath(env.get(JUNIT_VAR) or ""),
                         os.path.realpath(self.reports / "junit.xml"),
                         f"the report path rides {JUNIT_VAR}; spawn={spawns[0]!r}")
        self.assertIsNone(env.get(STREAM_VAR), "a junit target is handed no stream")
        self.assertEqual(self.only(START, drive).get("framework"), "bun-test")
        close = self.only(CLOSE, drive)
        self.assertEqual((close.get("codec"), close.get("runId"), close.get("framework")),
                         ("junit", RUN_ID, "bun-test"),
                         f"the run is filed from its JUnit report; close={close!r}")
        self.assertEqual(self.posts_to(COMPILE), [])
        envelope = self.envelope(drive)
        self.assertEqual(envelope.get("script"), UNIT, f"envelope={envelope!r}")
        return drive

    def test_a_test_run_through_a_junit_entry_declaring_bun_console_relays_its_console(self):
        drive = self.run_through_a_junit_entry(
            {"framework": "bun-test", "junit": ENV_JUNIT, "console": VIEW_CODEC})
        self.assertTrue(self.view_batches(), f"the console is relayed; {drive.diag()}")
        self.assertEqual({p for p, _b in self.board.stream_posts()}, {RUN_STREAM})
        self.assertEqual({b.get("codec") for _p, b in self.board.stream_posts()},
                         {VIEW_CODEC}, "the console is relayed under its declared view codec")
        held = self.board.held_stream(RUN_ID)
        self.assertIn("(pass) targets > case_1 [0.01ms]\n", held,
                      "the runner's console is what the board holds")

    def test_a_test_run_through_a_junit_entry_declaring_no_console_does_not_relay(self):
        drive = self.run_through_a_junit_entry({"framework": "bun-test", "junit": ENV_JUNIT})
        self.assertEqual(self.board.stream_posts(), [],
                         f"an entry declaring no console relays nothing; {drive.diag()}")


# ── framework and coverage ride the start and the close ─────────────────────


class FrameworkAndCoverageRideTheStartAndTheCloseTest(TargetsCase):

    def test_a_declared_framework_rides_the_start_and_the_junit_close(self):
        self.declare_unit_target({"framework": "playwright", "junit": ENV_JUNIT})
        drive = self.drive("unit")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.only(START, drive).get("framework"), "playwright")
        close = self.only(CLOSE, drive)
        self.assertEqual((close.get("codec"), close.get("framework")),
                         ("junit", "playwright"), f"close={close!r}")

    def test_declared_lcov_coverage_rides_the_close_beside_framework_bun_test(self):
        self.declare_unit_target({"framework": "bun-test", "junit": "flag",
                                  "coverage": "lcov"})
        drive = self.drive("unit", "--coverage")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.only(START, drive).get("framework"), "bun-test")
        close = self.only(CLOSE, drive)
        self.assertEqual(close.get("framework"), "bun-test", f"close={close!r}")
        self.assertEqual(close.get("coverage"), {"codec": "lcov", "data": [PLANTED_LCOV]},
                         f"the declared coverage codec rides the close; close={close!r}")

    def test_check_sends_no_framework(self):
        # A regression pin: it passes on today's client and fails on one that
        # stamps a framework on every compile ingest.
        drive = self.drive("check", reports=False)
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        compile_ingest = self.only(COMPILE, drive)
        self.assertEqual(compile_ingest.get("agentId"), AGENT)
        self.assertNotIn("framework", compile_ingest,
                         f"`check` (tsc) states no framework; body={compile_ingest!r}")


if __name__ == "__main__":
    unittest.main()
