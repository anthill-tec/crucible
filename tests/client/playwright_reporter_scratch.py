"""A scratch copy of the committed playwright-bdd fixture, run on the REAL
Playwright and playwright-bdd this repo installs, with the shipped Crucible
reporter handed in the way the bun client hands a reporter.

Shared by the Playwright reporter's test modules (it is not itself a test
module: no `test_*.py` discovery collects it).

Interface choices these tests drive (the reporter is GREEN's to write; this is
the contract it is driven through):

* **The fixture.** `tests/fixtures/playwright-bdd-project`: a `package.json`
  declaring `test:bdd` (`bunx bddgen && bunx playwright test`), a
  `playwright.config.ts`, `features/*.feature` and `steps/*.ts`. Its steps
  never touch `page`, so no browser is launched. Four projects:
  `alpha` and `beta` both run the `@main` feature; `setup` runs one failing
  scenario; `after-setup` depends on `setup`, so its two scenarios never run.
  `retries: 1` for every test.
* **How the retried scenario fails once.** Its first step throws while
  Playwright's `testInfo.retry` (playwright-bdd's `$testInfo` fixture) is 0,
  so attempt 0 fails and the retry passes -- no marker file, no shared state.
* **How the reporter is reached.** The runner's environment carries
  `CRUCIBLE_REPORTERS`, the DIRECTORY holding `playwright-crucible.ts`. The
  fixture's config adds `<CRUCIBLE_REPORTERS>/playwright-crucible.ts` to
  Playwright's `reporter` list when -- and only when -- that variable is set.
* **Where the reporter writes.** The reporter reads the file path from
  `CRUCIBLE_STREAM` itself; the config passes it no option.
* **Playwright's own reports.** The config writes Playwright's JUnit report to
  `FIXTURE_JUNIT_PATH` and its JSON report to `FIXTURE_JSON_PATH`, each only
  when set: the tests compare the stream against them.
* **How Playwright runs.** `bun x bddgen`, then `bun x playwright test [args]`
  -- the fixture's `test:bdd` script, its two commands run in turn -- from the
  scratch copy, whose `node_modules` is a directory of links to this repo's
  installed packages (no network install), as the Vitest reporter's helper does.
* **A failure's parts.** `failure` is `{message, type?, trace?}`, the keys the
  board's `crucible-events` codec reads; the error's stack rides in `trace`.

Extra files a test needs (a feature that reads the stream mid-run) are written
into the scratch copy only, never into the committed fixture.
"""

import json
import os
import shutil
import subprocess
import xml.etree.ElementTree as ElementTree
from pathlib import Path

from tests.client.live_run_harness import REPO_ROOT, new_scratch, scrubbed_env
from tests.client.vitest_reporter_scratch import link_repo_node_modules

REPORTERS_DIR = REPO_ROOT / "clients" / "reporters"
REPORTER_NAME = "playwright-crucible.ts"
REPORTER = REPORTERS_DIR / REPORTER_NAME
FIXTURE_REL = "tests/fixtures/playwright-bdd-project"
FIXTURE = REPO_ROOT / FIXTURE_REL
REPO_NODE_MODULES = REPO_ROOT / "node_modules"
STREAM_VAR = "CRUCIBLE_STREAM"
REPORTERS_VAR = "CRUCIBLE_REPORTERS"
FIXTURE_JUNIT_VAR = "FIXTURE_JUNIT_PATH"
FIXTURE_JSON_VAR = "FIXTURE_JSON_PATH"
STREAM_FILE_NAME = "crucible-events.ndjson"
TIMEOUT = 300
SUITE_SEPARATOR = " \u203a "

# Variables an ambient shell or an enclosing Playwright run could carry into
# the fixture's run; each is removed before the run.
_SCRUBBED_VARS = (
    REPORTERS_VAR, STREAM_VAR, FIXTURE_JUNIT_VAR, FIXTURE_JSON_VAR,
    "PLAYWRIGHT_JUNIT_OUTPUT_NAME", "PLAYWRIGHT_JSON_OUTPUT_NAME",
    "PLAYWRIGHT_BDD_CONFIGS", "PW_TEST_CONNECT_WS_ENDPOINT",
    "PW_TEST_CONNECT_EXPOSE_NETWORK", "TEST_WORKER_INDEX",
)

# The fixture's vocabulary.
FEATURE = "Scenarios the reporter streams"
RULE = "a rule groups its scenarios"
RULE_SUITE = f"{FEATURE}{SUITE_SEPARATOR}{RULE}"
SETUP_FEATURE = "A setup project that fails"
WAITING_FEATURE = "Scenarios that wait on the failed setup"
MAIN_FEATURE_FILE = "scenarios.feature"
SETUP_FEATURE_FILE = "setup-fails.feature"
WAITING_FEATURE_FILE = "waits-on-setup.feature"

ALPHA = "alpha"
BETA = "beta"
SETUP_PROJECT = "setup"
WAITING_PROJECT = "after-setup"
MAIN_PROJECTS = (ALPHA, BETA)

EVERY_STEP_PASSES = "every step passes"
A_STEP_FAILS = "a step fails"
BEFORE_HOOK_FAILS = "a Before hook fails"
PASSES_ON_RETRY = "passes on its second attempt"
EXPECTED_FAILURE = "an expected failure"
UNDER_RULE = "a scenario under a rule"
SETUP_FAILS = "the setup fails"
FIRST_NEVER_RUNS = "the first scenario that never runs"
SECOND_NEVER_RUNS = "the second scenario that never runs"

BACKGROUND_STEP = "Given the background is laid"
PASSING_STEP = "Given a passing step"
ANOTHER_PASSING_STEP = "When another passing step runs"
SCENARIO_PASSES_STEP = "Then the scenario passes"
FAILING_STEP = "When a step fails on purpose"
NEVER_RUN_STEP = "Then a step that never runs"
FIRST_ATTEMPT_STEP = "Given a step that fails on the first attempt only"
SETUP_STEP = "Given the setup fails"
HOOK_NAME = "a Before hook that fails"

STEP_FAILURE_TEXT = "the step failed on purpose"
HOOK_FAILURE_TEXT = "the Before hook failed on purpose"
SETUP_FAILURE_TEXT = "the setup failed on purpose"
FIRST_ATTEMPT_FAILURE_TEXT = "the first attempt failed on purpose"

# One expected `test-end` per (scenario, project):
#   (status, suite, feature file, steps as [(name, status)], failure text)
# A failure text of None means the test-end carries no `failure`; the
# expected failure's own `failure` is left unasserted (`...`).
_MAIN = {
    EVERY_STEP_PASSES: ("pass", FEATURE, MAIN_FEATURE_FILE, [
        (BACKGROUND_STEP, "pass"), (PASSING_STEP, "pass"),
        (ANOTHER_PASSING_STEP, "pass"), (SCENARIO_PASSES_STEP, "pass")], None),
    A_STEP_FAILS: ("fail", FEATURE, MAIN_FEATURE_FILE, [
        (BACKGROUND_STEP, "pass"), (PASSING_STEP, "pass"), (FAILING_STEP, "fail")],
        STEP_FAILURE_TEXT),
    # The Before hook runs ahead of the Background, which then does not run:
    # no step of the scenario ever runs.
    BEFORE_HOOK_FAILS: ("fail", FEATURE, MAIN_FEATURE_FILE, [], HOOK_FAILURE_TEXT),
    PASSES_ON_RETRY: ("pass", FEATURE, MAIN_FEATURE_FILE, [
        (BACKGROUND_STEP, "pass"), (FIRST_ATTEMPT_STEP, "pass"),
        (SCENARIO_PASSES_STEP, "pass")], None),
    EXPECTED_FAILURE: ("pass", FEATURE, MAIN_FEATURE_FILE, [
        (BACKGROUND_STEP, "pass"), (PASSING_STEP, "pass"), (FAILING_STEP, "fail")], ...),
    UNDER_RULE: ("pass", RULE_SUITE, MAIN_FEATURE_FILE, [
        (BACKGROUND_STEP, "pass"), (PASSING_STEP, "pass")], None),
}
EXPECTED_TEST_ENDS = {
    **{(name, project): expected for project in MAIN_PROJECTS
       for name, expected in _MAIN.items()},
    (SETUP_FAILS, SETUP_PROJECT): ("fail", SETUP_FEATURE, SETUP_FEATURE_FILE,
                                   [(SETUP_STEP, "fail")], SETUP_FAILURE_TEXT),
    (FIRST_NEVER_RUNS, WAITING_PROJECT): ("pending", WAITING_FEATURE,
                                          WAITING_FEATURE_FILE, [], None),
    (SECOND_NEVER_RUNS, WAITING_PROJECT): ("pending", WAITING_FEATURE,
                                           WAITING_FEATURE_FILE, [], None),
}
EXPECTED_TOTALS = {"total": 15, "passed": 8, "failed": 5, "pending": 2}

_STATUSES = ("pass", "fail", "pending")

def require_playwright_toolchain(case):
    """The real `bun` and this repo's installed Playwright and playwright-bdd;
    returns bun's path."""
    bun = shutil.which("bun")
    case.assertIsNotNone(bun, "this proof needs the real `bun` on PATH")
    for package in ("@playwright/test", "playwright-bdd"):
        case.assertTrue(
            (REPO_NODE_MODULES / package / "package.json").is_file(),
            f"this proof needs this repo's dev dependencies installed (`bun install`): "
            f"the fixture runs the real {package}")
    case.assertTrue((FIXTURE / "playwright.config.ts").is_file(),
                    f"the committed playwright-bdd fixture is missing: {FIXTURE}")
    return bun

def scratch_fixture(prefix, extra_files=None):
    """A scratch copy of the committed fixture, its `node_modules` linked, with
    `extra_files` ({relative path: source}) written into it. Returns
    `(scratch_root, project)`; the caller removes `scratch_root`."""
    scratch = new_scratch(prefix)
    project = os.path.join(scratch, "project")
    shutil.copytree(FIXTURE, project)
    link_repo_node_modules(project)
    for name, source in (extra_files or {}).items():
        target = Path(project, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source)
    return scratch, project

def run_fixture_playwright(bun, project, reporters_dir, stream_path, *args,
                           junit_path=None, json_path=None):
    """`bunx bddgen && bunx playwright test [args…]` in the scratch copy.

    `reporters_dir`, `stream_path`, `junit_path` and `json_path` set
    `CRUCIBLE_REPORTERS`, `CRUCIBLE_STREAM`, `FIXTURE_JUNIT_PATH` and
    `FIXTURE_JSON_PATH`; `None` leaves the variable UNSET. Returns the
    `playwright test` run, or the `bddgen` run when that fails."""
    env = scrubbed_env(None, NO_COLOR="1", FORCE_COLOR="0")
    for key in _SCRUBBED_VARS:
        env.pop(key, None)
    for key, value in ((REPORTERS_VAR, reporters_dir), (STREAM_VAR, stream_path),
                       (FIXTURE_JUNIT_VAR, junit_path), (FIXTURE_JSON_VAR, json_path)):
        if value is not None:
            env[key] = str(value)
    generated = subprocess.run([bun, "x", "bddgen"], cwd=project, env=env,
                               capture_output=True, text=True, timeout=TIMEOUT,
                               check=False)
    if generated.returncode != 0:
        return generated
    return subprocess.run([bun, "x", "playwright", "test", *args], cwd=project,
                          env=env, capture_output=True, text=True, timeout=TIMEOUT,
                          check=False)

def diagnostics(result):
    if result is None:
        return "no run (bun is missing)"
    return (f"exit={result.returncode} stdout={result.stdout[-3000:]!r} "
            f"stderr={result.stderr[-3000:]!r}")

def stream_events(case, stream_path, result):
    """The stream file's lines, each parsed: fails the test, naming the run,
    when the file is absent or a line is not one complete JSON object."""
    case.assertTrue(
        os.path.isfile(stream_path),
        f"the reporter wrote no stream at {STREAM_VAR}={stream_path}: with "
        f"{REPORTERS_VAR} set, the fixture's config adds the shipped reporter "
        f"({REPORTER}) and the reporter must write the file {STREAM_VAR} names; "
        f"{diagnostics(result)}")
    text = Path(stream_path).read_text()
    case.assertTrue(text.endswith("\n"),
                    f"every stream line is written whole, newline-terminated; "
                    f"tail={text[-300:]!r}")
    events = []
    for number, line in enumerate(text.split("\n")[:-1], start=1):
        try:
            parsed = json.loads(line)
        except ValueError as error:
            raise case.failureException(
                f"stream line {number} is not one complete JSON value "
                f"({error}): {line!r}") from error
        case.assertIsInstance(parsed, dict, f"stream line {number} is not a JSON object: {line!r}")
        events.append(parsed)
    return events

def streamed_test_ends(events):
    return [event for event in events if event.get("event") == "test-end"]

def by_scenario(events):
    """{(name, browser): [test-end, …]} in stream order."""
    keyed = {}
    for event in streamed_test_ends(events):
        keyed.setdefault((event.get("name"), event.get("browser")), []).append(event)
    return keyed

def step_pairs(event):
    """A test-end's steps as [(name, status)]; an absent `steps` is no step."""
    return [(step.get("name"), step.get("status")) for step in event.get("steps", [])]

def junit_report(case, junit_path, result):
    """Playwright's own JUnit report: the root's counts and every
    (project, test case name) it lists."""
    case.assertTrue(os.path.isfile(junit_path),
                    f"Playwright wrote no JUnit report at {junit_path}; {diagnostics(result)}")
    # Trusted input: Playwright's own report, written by this run into the
    # test's scratch directory.
    root = ElementTree.parse(junit_path).getroot()  # noqa: S314 - own scratch report
    cases = set()
    for suite in root.iter("testsuite"):
        for testcase in suite.iter("testcase"):
            cases.add((suite.get("hostname"), testcase.get("name")))
    counts = {key: int(root.get(key, "-1"))
              for key in ("tests", "skipped", "failures", "errors")}
    return counts, cases

def expected_junit_cases():
    """(project, name) as Playwright's JUnit names each expected test case:
    the title path after the file, joined by ` › `."""
    return {(project, f"{suite}{SUITE_SEPARATOR}{name}")
            for (name, project), (_, suite, _, _, _) in EXPECTED_TEST_ENDS.items()}

def json_report_ids(case, json_path, result):
    """{test id: (scenario, project)} from Playwright's own JSON report. A spec
    run in several projects is merged there under one id, its first test's."""
    case.assertTrue(os.path.isfile(json_path),
                    f"Playwright wrote no JSON report at {json_path}; {diagnostics(result)}")
    report = json.loads(Path(json_path).read_text())
    ids = {}

    def walk(suite):
        for spec in suite.get("specs", []):
            ids[spec["id"]] = (spec["title"], spec["tests"][0]["projectName"])
        for child in suite.get("suites", []) or []:
            walk(child)

    for top in report.get("suites", []):
        walk(top)
    return ids

def codec_rejection(fields):
    """Why the board's `crucible-events` `readEvent`
    (src/codecs/crucible-events.ts) would read this parsed line as undecodable
    or unknown, or None when it reads it as a known event."""
    kind = fields.get("event")
    if kind == "run-start":
        total = fields.get("total")
        if total is not None and not _is_count(total):
            return f"run-start total {total!r} is not a count"
        return None
    if kind == "test-end":
        return _test_end_rejection(fields)
    if kind == "run-end":
        for key in ("total", "passed", "failed", "pending"):
            if not _is_count(fields.get(key)):
                return f"run-end `{key}` {fields.get(key)!r} is not a count"
        if "duration_ms" in fields and not _is_duration(fields["duration_ms"]):
            return f"run-end duration_ms {fields['duration_ms']!r} is not a duration"
        return None
    if isinstance(kind, str):
        return f"event kind {kind!r} is one no codec knows"
    return "line has no string `event`"

def _test_end_rejection(fields):
    leaf = _leaf_rejection(fields, "test-end")
    if leaf is not None:
        return leaf
    for key in ("id", "suite", "file"):
        if key in fields and not isinstance(fields[key], str):
            return f"test-end `{key}` is not a string"
    if "browser" in fields and not (isinstance(fields["browser"], str) and fields["browser"]):
        return "test-end `browser` is not a non-empty string"
    if "steps" in fields:
        steps = fields["steps"]
        if not isinstance(steps, list):
            return "test-end `steps` is not an array"
        for step in steps:
            if not isinstance(step, dict):
                return f"a step is not an object: {step!r}"
            rejected = _leaf_rejection(step, "step")
            if rejected is not None:
                return rejected
    return None

def _leaf_rejection(fields, what):
    if not isinstance(fields.get("name"), str):
        return f"{what} has no string `name`"
    if fields.get("status") not in _STATUSES:
        return f"{what} status {fields.get('status')!r} is not one of {_STATUSES}"
    if "duration_ms" in fields and not _is_duration(fields["duration_ms"]):
        return f"{what} duration_ms {fields['duration_ms']!r} is not a duration"
    if "failure" in fields:
        failure = fields["failure"]
        if not isinstance(failure, dict):
            return f"{what} failure is not an object"
        for key in ("message", "type", "trace"):
            if key in failure and not isinstance(failure[key], str):
                return f"{what} failure.{key} is not a string"
    return None

def _is_count(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0

def _is_duration(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and value >= 0 and value == value and value != float("inf"))
