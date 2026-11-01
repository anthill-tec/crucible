"""The shipped Playwright reporter streams each scenario with its steps.

`clients/reporters/playwright-crucible.ts` is handed to a REAL Playwright run
(playwright-bdd generating the tests) of a scratch copy of
`tests/fixtures/playwright-bdd-project`, through `CRUCIBLE_REPORTERS`, and
writes the file `CRUCIBLE_STREAM` names. Its stream must hold:

* one `run-start`, first, with the total `onBegin` sees: every test in every
  project;
* one `test-end` per test per project, from its last attempt, carrying `id`
  (`test.id`), `name` (the scenario), `suite` (the describe titles after the
  file, without the scenario, joined by ` › `), `browser` (the project),
  `file`, `status` by `test.outcome()`, `duration_ms`, `steps` and `failure`;
* `steps`: the Background's steps first, then the scenario's own `test.step`
  steps in order -- no hook, no fixture -- the failing step carrying its
  failure, and no step that never ran after it;
* a scenario whose Before hook fails as a failing scenario with no failing
  step; a retried scenario once, from its passing last attempt; a `@fail`
  scenario as `pass`;
* the tests of the project that depends on a failed project as `pending`,
  swept at `onEnd`;
* one `run-end`, last, whose totals are the `test-end`s', and whose scenario
  count is Playwright's own JUnit `tests` for the same run.

Every line is one complete JSON object the board's `crucible-events` rules read
as a known event, the whole stream decodes through the board's own codec with
nothing incomplete, and a line is on disk while the run is still going.

The interface these tests drive is stated in
`tests/client/playwright_reporter_scratch.py`.

Invocation:
    python3 -m unittest tests.client.test_playwright_crucible_reporter_streams_scenarios_with_steps -v
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path
from typing import ClassVar

from tests.client.live_run_harness import REPO_ROOT, scrubbed_env
from tests.client.playwright_reporter_scratch import (
    A_STEP_FAILS,
    ALPHA,
    BEFORE_HOOK_FAILS,
    EXPECTED_FAILURE,
    EXPECTED_TEST_ENDS,
    EXPECTED_TOTALS,
    FAILING_STEP,
    FEATURE,
    FIRST_ATTEMPT_FAILURE_TEXT,
    HOOK_FAILURE_TEXT,
    HOOK_NAME,
    MAIN_PROJECTS,
    PASSES_ON_RETRY,
    PASSING_STEP,
    REPORTERS_DIR,
    RULE_SUITE,
    SETUP_FAILS,
    SETUP_FEATURE,
    SETUP_PROJECT,
    STEP_FAILURE_TEXT,
    STREAM_FILE_NAME,
    TIMEOUT,
    WAITING_FEATURE,
    WAITING_PROJECT,
    by_scenario,
    codec_rejection,
    diagnostics,
    json_report_ids,
    junit_report,
    require_playwright_toolchain,
    run_fixture_playwright,
    scratch_fixture,
    step_pairs,
    stream_events,
    streamed_test_ends,
)

# The board's own decoding of the stream, through the real codec.
_DECODE_SCRIPT = (
    'import { parseCrucibleEvents } from '
    + json.dumps(str(REPO_ROOT / "src" / "codecs" / "crucible-events.ts")) + ";\n"
    'const text = await Bun.file(process.env["STREAM_TO_DECODE"] ?? "").text();\n'
    "const run = parseCrucibleEvents(text);\n"
    "console.log(JSON.stringify({ summary: run.summary, incomplete: run.incomplete ?? null,\n"
    "  suites: run.tree.map((suite) => ({ name: suite.name, browser: suite.browser ?? null,\n"
    "    tests: suite.children.length,\n"
    "    steps: suite.children.reduce((sum, leaf) => sum + (leaf.steps ?? []).length, 0) })) }));\n"
)

def _failing_steps(event):
    return [step for step in event.get("steps", []) if step.get("status") == "fail"]

class PlaywrightReporterStreamsEveryScenarioTest(unittest.TestCase):
    """One real Playwright run of the fixture, its stream read back beside
    Playwright's own JUnit and JSON reports of the same run."""

    bun: ClassVar[str]
    scratch: ClassVar[str]
    stream: ClassVar[str]
    junit: ClassVar[str]
    json_report: ClassVar[str]
    result: ClassVar[subprocess.CompletedProcess | None]

    @classmethod
    def setUpClass(cls):
        cls.scratch, project = scratch_fixture("playwright-reporter-stream-")
        reports = os.path.join(cls.scratch, "reports")
        os.makedirs(reports)
        cls.stream = os.path.join(reports, STREAM_FILE_NAME)
        cls.junit = os.path.join(reports, "junit.xml")
        cls.json_report = os.path.join(reports, "playwright.json")
        cls.bun = shutil.which("bun") or ""
        # Without bun nothing runs; `setUp` then fails every test naming why.
        cls.result = (run_fixture_playwright(cls.bun, project, REPORTERS_DIR, cls.stream,
                                             junit_path=cls.junit, json_path=cls.json_report)
                      if cls.bun else None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.scratch, ignore_errors=True)

    def setUp(self):
        require_playwright_toolchain(self)

    def events(self):
        return stream_events(self, self.stream, self.result)

    def scenario(self, name, project):
        keyed = by_scenario(self.events())
        self.assertIn((name, project), keyed,
                      f"no test-end for {name!r} in project {project!r}; "
                      f"streamed={sorted(keyed, key=repr)!r}")
        return keyed[(name, project)][-1]

    def test_every_line_is_a_complete_json_event_the_board_codec_reads(self):
        events = self.events()
        self.assertGreater(len(events), 0, diagnostics(self.result))
        rejected = [(event, codec_rejection(event)) for event in events
                    if codec_rejection(event) is not None]
        self.assertEqual(rejected, [],
                         "every line, `browser` and `steps` included, must be an event "
                         "the board's `crucible-events` rules read as known")

    def test_the_stream_opens_with_one_run_start_stating_the_onbegin_total(self):
        events = self.events()
        starts = [event for event in events if event.get("event") == "run-start"]
        self.assertEqual(len(starts), 1, f"exactly one run-start; events={events!r}")
        self.assertEqual(events[0].get("event"), "run-start",
                         f"the run-start is the first line; first={events[0]!r}")
        self.assertEqual(starts[0].get("total"), EXPECTED_TOTALS["total"],
                         f"onBegin's total: every test in every project, the two "
                         f"that never run included; run-start={starts[0]!r}")

    def test_one_test_end_per_scenario_per_project_with_its_outcome_status(self):
        keyed = by_scenario(self.events())
        statuses = {key: [event.get("status") for event in group]
                    for key, group in keyed.items()}
        expected = {key: [status] for key, (status, _, _, _, _) in EXPECTED_TEST_ENDS.items()}
        self.assertEqual(
            statuses, expected,
            "one test-end per (scenario, project), its status by test.outcome(): "
            "expected or flaky -> pass, unexpected -> fail, skipped -> pending")

    def test_every_test_end_names_its_suite_browser_file_and_duration(self):
        keyed = by_scenario(self.events())
        wrong = {}
        for key, (status, suite, feature_file, _, _) in EXPECTED_TEST_ENDS.items():
            if key not in keyed:
                wrong[key] = "not streamed"
                continue
            event = keyed[key][-1]
            if event.get("suite") != suite:
                wrong[key] = f"suite {event.get('suite')!r} != {suite!r}"
            elif event.get("browser") != key[1]:
                wrong[key] = f"browser {event.get('browser')!r} != {key[1]!r}"
            elif not (isinstance(event.get("file"), str)
                      and Path(event["file"]).name.startswith(feature_file)):
                wrong[key] = f"file {event.get('file')!r} does not name {feature_file!r}"
            elif status != "pending" and not (
                    isinstance(event.get("duration_ms"), (int, float))
                    and event["duration_ms"] >= 0):
                wrong[key] = f"duration_ms {event.get('duration_ms')!r}"
        self.assertEqual(
            wrong, {},
            "suite: the describe titles after the file, without the scenario, joined "
            "by ' › '; browser: the project; file: the scenario's own; duration_ms on "
            "every test that ran")

    def test_every_test_end_id_is_playwrights_test_id_unique_per_project(self):
        events = streamed_test_ends(self.events())
        ids = [event.get("id") for event in events]
        self.assertTrue(all(isinstance(i, str) and i for i in ids), f"ids={ids!r}")
        self.assertEqual(len(ids), len(set(ids)),
                         f"the same scenario in two projects has two ids: {ids!r}")
        by_id = {event.get("id"): (event.get("name"), event.get("browser")) for event in events}
        playwright_ids = json_report_ids(self, self.json_report, self.result)
        self.assertGreaterEqual(len(playwright_ids), 9,
                                f"Playwright's JSON report lists the fixture's specs: "
                                f"{playwright_ids!r}")
        mismatched = {test_id: (expected, by_id.get(test_id))
                      for test_id, expected in playwright_ids.items()
                      if by_id.get(test_id) != expected}
        self.assertEqual(mismatched, {},
                         "every id Playwright's own JSON report gives a test is the "
                         "id of that test's test-end (expected, streamed)")

    def test_each_scenarios_steps_are_its_background_then_its_own_steps_in_order(self):
        keyed = by_scenario(self.events())
        wrong = {}
        for key, (_, _, _, steps, _) in EXPECTED_TEST_ENDS.items():
            if key not in keyed:
                wrong[key] = "not streamed"
                continue
            got = step_pairs(keyed[key][-1])
            if got != steps:
                wrong[key] = (got, steps)
        self.assertEqual(
            wrong, {},
            "(got, expected): the Background's steps first, then the scenario's own "
            "test.step steps in order; no hook, no fixture, and no step that never "
            "ran after a failing one")

    def test_every_step_carries_a_duration_and_only_a_failing_step_a_failure(self):
        wrong = []
        for event in streamed_test_ends(self.events()):
            for step in event.get("steps", []):
                duration = step.get("duration_ms")
                if not (isinstance(duration, (int, float)) and duration >= 0):
                    wrong.append((event.get("name"), step, "duration_ms"))
                if (step.get("status") == "fail") != ("failure" in step):
                    wrong.append((event.get("name"), step, "failure"))
        self.assertEqual(wrong, [], "each step has a name, status and duration; a "
                                    "failing step, and only it, has a failure")

    def test_a_failing_step_carries_its_failure_and_so_does_its_scenario(self):
        for project in MAIN_PROJECTS:
            event = self.scenario(A_STEP_FAILS, project)
            failing = _failing_steps(event)
            self.assertEqual([step.get("name") for step in failing], [FAILING_STEP],
                             f"the one failing step; {event!r}")
            self.assertIn(STEP_FAILURE_TEXT, failing[0]["failure"].get("message", ""),
                          f"the step's own error; {event!r}")
            failure = event.get("failure")
            self.assertIsInstance(failure, dict, f"the failing scenario's failure: {event!r}")
            self.assertIn(STEP_FAILURE_TEXT, failure.get("message", ""),
                          f"from result.error; {event!r}")
            self.assertIsInstance(failure.get("trace"), str,
                                  f"the error's stack rides in `trace`; {event!r}")
            self.assertIn(STEP_FAILURE_TEXT, failure["trace"], f"{event!r}")

    def test_a_before_hook_failure_is_a_failing_scenario_with_no_failing_step(self):
        for project in MAIN_PROJECTS:
            event = self.scenario(BEFORE_HOOK_FAILS, project)
            self.assertEqual(event.get("status"), "fail", f"{event!r}")
            self.assertEqual(_failing_steps(event), [],
                             f"a Before hook is not a step: no step fails; {event!r}")
            self.assertNotIn(HOOK_NAME, [step.get("name") for step in event.get("steps", [])],
                             f"the hook's own test.step is not a step; {event!r}")
            self.assertNotIn(PASSING_STEP, [name for name, _ in step_pairs(event)],
                             f"the scenario's steps never ran; {event!r}")
            failure = event.get("failure")
            self.assertIsInstance(failure, dict, f"the scenario carries the failure: {event!r}")
            self.assertIn(HOOK_FAILURE_TEXT, failure.get("message", ""), f"{event!r}")

    def test_a_retried_scenario_is_streamed_once_from_its_passing_last_attempt(self):
        keyed = by_scenario(self.events())
        for project in MAIN_PROJECTS:
            group = keyed.get((PASSES_ON_RETRY, project), [])
            self.assertEqual(len(group), 1,
                             f"one test-end for the retried scenario in {project}, never "
                             f"one per attempt; {group!r}")
            event = group[0]
            self.assertEqual(event.get("status"), "pass", f"flaky -> pass; {event!r}")
            self.assertNotIn("failure", event,
                             f"the last attempt passed: no failure; {event!r}")
            self.assertEqual(_failing_steps(event), [],
                             f"the steps are the last attempt's; {event!r}")
            self.assertNotIn(FIRST_ATTEMPT_FAILURE_TEXT, json.dumps(event),
                             f"nothing of the first attempt is streamed; {event!r}")

    def test_an_expected_failure_streams_as_pass_with_its_failing_step(self):
        for project in MAIN_PROJECTS:
            event = self.scenario(EXPECTED_FAILURE, project)
            self.assertEqual(event.get("status"), "pass",
                             f"a @fail scenario that fails is expected: pass, as JUnit "
                             f"counts it; {event!r}")
            self.assertEqual([step.get("name") for step in _failing_steps(event)],
                             [FAILING_STEP], f"{event!r}")

    def test_the_failed_dependency_projects_dependents_stream_as_pending(self):
        events = self.events()
        waiting = [event for event in streamed_test_ends(events)
                   if event.get("browser") == WAITING_PROJECT]
        self.assertEqual(sorted(event.get("name") for event in waiting),
                         sorted(name for name, project in EXPECTED_TEST_ENDS
                                if project == WAITING_PROJECT),
                         f"every test of the dependent project is swept; events={events!r}")
        for event in waiting:
            self.assertEqual(event.get("status"), "pending", f"{event!r}")
            self.assertEqual(event.get("suite"), WAITING_FEATURE, f"{event!r}")
            self.assertEqual(step_pairs(event), [], f"a test that never ran has no step; {event!r}")
            self.assertNotIn("failure", event, f"{event!r}")
        setup = self.scenario(SETUP_FAILS, SETUP_PROJECT)
        self.assertEqual((setup.get("status"), setup.get("suite")), ("fail", SETUP_FEATURE),
                         f"the dependency project's own scenario failed; {setup!r}")
        last_test = max(index for index, event in enumerate(events)
                        if event.get("event") == "test-end")
        swept = [index for index, event in enumerate(events) if event in waiting]
        self.assertEqual(swept[-1], last_test,
                         "the never-run tests are swept at onEnd, after every test that ran")

    def test_the_stream_closes_with_one_run_end_whose_totals_are_its_test_ends(self):
        events = self.events()
        ends = [event for event in events if event.get("event") == "run-end"]
        self.assertEqual(len(ends), 1, f"exactly one run-end; events={events!r}")
        self.assertEqual(events[-1].get("event"), "run-end",
                         f"the run-end is the last line; last={events[-1]!r}")
        stated = {key: ends[0].get(key) for key in EXPECTED_TOTALS}
        statuses = [event.get("status") for event in streamed_test_ends(events)]
        counted = {"total": len(statuses), "passed": statuses.count("pass"),
                   "failed": statuses.count("fail"), "pending": statuses.count("pending")}
        self.assertEqual(stated, counted, "the run-end states what the test-ends count")
        self.assertEqual(stated, EXPECTED_TOTALS, f"run-end={ends[0]!r}")

    def test_the_scenario_count_equals_playwrights_own_junit_for_the_same_run(self):
        events = self.events()
        statuses = [event.get("status") for event in streamed_test_ends(events)]
        counts, _ = junit_report(self, self.junit, self.result)
        self.assertEqual(
            {"total": len(statuses), "pending": statuses.count("pending"),
             "failed": statuses.count("fail")},
            {"total": counts["tests"], "pending": counts["skipped"],
             "failed": counts["failures"] + counts["errors"]},
            f"the stream counts scenarios as Playwright's JUnit does; junit={counts!r}")

    def test_the_board_codec_decodes_each_feature_per_browser_with_nothing_incomplete(self):
        self.events()
        decoded = subprocess.run(
            [self.bun, "-e", _DECODE_SCRIPT], cwd=REPO_ROOT,
            env=scrubbed_env(None, STREAM_TO_DECODE=self.stream),
            capture_output=True, text=True, timeout=TIMEOUT, check=False)
        self.assertEqual(decoded.returncode, 0, f"stderr={decoded.stderr[-2000:]!r}")
        run = json.loads(decoded.stdout.strip().splitlines()[-1])
        self.assertIsNone(run["incomplete"],
                          f"the board would mark this stream incomplete: {run!r}")
        summary = {key: run["summary"].get(key) for key in EXPECTED_TOTALS}
        self.assertEqual(summary, EXPECTED_TOTALS, f"the summary counts tests: {run!r}")
        suites = {(suite["name"], suite["browser"]): suite["tests"] for suite in run["suites"]}
        self.assertEqual(suites, {
            (FEATURE, ALPHA): 5, (FEATURE, "beta"): 5,
            (RULE_SUITE, ALPHA): 1, (RULE_SUITE, "beta"): 1,
            (SETUP_FEATURE, SETUP_PROJECT): 1, (WAITING_FEATURE, WAITING_PROJECT): 2,
        }, f"each scenario sits under its feature and browser: {run!r}")
        steps = sum(len(expected[3]) for expected in EXPECTED_TEST_ENDS.values())
        self.assertEqual(sum(suite["steps"] for suite in run["suites"]), steps,
                         f"the steps ride under their tests: {run!r}")

LIVE_FEATURE_FILE = "features/streams-as-it-runs.feature"
LIVE_STEPS_FILE = "steps/streams-as-it-runs.ts"
LIVE_FIRST = "the first scenario finishes"
LIVE_SECOND = "the second scenario sees the first already streamed"
LIVE_STEP = "the first scenario is already in the stream"

_LIVE_FEATURE = f"""@main @live
Feature: A stream read while the run goes on

  Scenario: {LIVE_FIRST}
    Given a passing step

  Scenario: {LIVE_SECOND}
    Then {LIVE_STEP}
"""

_LIVE_STEPS = f'''import {{ existsSync, readFileSync }} from "node:fs";
import {{ createBdd }} from "playwright-bdd";

const {{ Then }} = createBdd();

// Polls the stream while the run is still going: a reporter that writes only
// at the end never shows the first scenario's line here.
Then({json.dumps(LIVE_STEP)}, async () => {{
  const path = process.env["CRUCIBLE_STREAM"] ?? "";
  const deadline = Date.now() + 10000;
  let seen = false;
  while (!seen && Date.now() < deadline) {{
    if (path !== "" && existsSync(path)) {{
      seen = readFileSync(path, "utf8").split("\\n").some((line) =>
        line.endsWith("}}") && line.includes({json.dumps(json.dumps(LIVE_FIRST))}));
    }}
    if (!seen) await new Promise((resolve) => setTimeout(resolve, 50));
  }}
  if (!seen) throw new Error("the first scenario's line was not in the stream during the run");
}});
'''

class PlaywrightReporterWritesEachLineAsItsScenarioEndsTest(unittest.TestCase):
    """A line is on disk while the run is still going, not only at its end."""

    def setUp(self):
        self.bun = require_playwright_toolchain(self)
        self.scratch, self.project = scratch_fixture(
            "playwright-reporter-live-",
            {LIVE_FEATURE_FILE: _LIVE_FEATURE, LIVE_STEPS_FILE: _LIVE_STEPS})
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        os.makedirs(os.path.join(self.scratch, "reports"))
        self.stream = os.path.join(self.scratch, "reports", STREAM_FILE_NAME)

    def test_a_later_scenario_reads_an_earlier_scenarios_line_during_the_run(self):
        result = run_fixture_playwright(self.bun, self.project, REPORTERS_DIR, self.stream,
                                        "--project", ALPHA, "--grep", "@live")
        keyed = by_scenario(stream_events(self, self.stream, result))
        self.assertEqual(sorted(keyed), sorted([(LIVE_FIRST, ALPHA), (LIVE_SECOND, ALPHA)]),
                         f"the filtered run streams its two scenarios; {diagnostics(result)}")
        second = keyed[(LIVE_SECOND, ALPHA)][0]
        self.assertEqual(
            second.get("status"), "pass",
            f"the first scenario's complete line must be in the stream while the second "
            f"runs; second={second!r} {diagnostics(result)}")

if __name__ == "__main__":
    unittest.main()
