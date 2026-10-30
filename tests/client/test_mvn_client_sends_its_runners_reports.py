"""The maven client sends its runner's reports and parses nothing.

Every maven verb that files a report (`test`, `unit`, `module`, `bdd`,
`integration`, `e2e`, `regression`, the regression step `pre-merge-gate`
runs, and `auto-ingest`) files it through the shared ingest
(`ingest_reports`, clients/_crucible_axi.py): the board's health is read
first, then ONE `POST /api/v2/runs` goes out carrying `codec: "junit"`,
`data` (the text of every `TEST-*.xml` in the directories the verb reads, in
the order of those directories, each directory's reports sorted),
`coverage: {codec: "jacoco", data}` on a coverage run that found a CSV
(passing or failing), `raw` (the captured runner output, on every verb but
`auto-ingest`) and `runnerExit`. Nothing goes to `/api/v2/runs/parsed`, and
no body carries a `dataPath`.

Every figure the envelope reports is the board's: its `run:` block is the
answer's `run` block, the one stderr `ingest:` line reads the answer's
coverage, and the answer's `warnings[]` join the envelope's. With no board
there are no figures. A board that cannot decode the run (no `codecs`, or no
`jacoco` for a coverage run), or whose advertised `ingest_body_bytes` the body
exceeds, is refused before anything is sent, and the run the verb opened is
aborted.

The client still decides locally whether a run "ran nothing" (a non-zero
runner over reports with no `<testcase>`, `junit_testcase_count`), and its
exit by `verb_exit` over the runner's exit and the board's answer;
`auto-ingest`, which runs no runner, exits 0 on an `ok` answer and 1
otherwise. The no-report exits are unchanged: a run that wrote no report files
its compile ingest and no run. The shared `ingest:` line is the run's one
ingest line (no `ingest junit:` or `ingest parsed:` literal is left in the
client), and the shared module does not grow past its line budget.

Every drive runs the real `clients/mvn-crucible.py` over a scratch two-module
reactor (`alpha`, `beta`) with a fake `mvnw` in the maven directory that
writes the exact report and JaCoCo CSV texts below where the client tells it
to, and a fake `docker` on PATH. Most drive it as a subprocess against a
`RecordingBoard` whose `/api/v2/runs` answer the test scripts; the ones that
need a board that cannot be reached at one route drive `main()` in-process
with that one route answered as the transport answers an unreachable board.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_mvn_client_sends_its_runners_reports
"""

import ast
import contextlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    load_client,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
MVN_CLIENT = CLIENTS / "mvn-crucible.py"
TIMEOUT = 120
PROJECT_KEY = "mvn-sends-its-reports-key"

RUNS = "/api/v2/runs"
PARSED = "/api/v2/runs/parsed"
COMPILE = "/api/v2/runs/compile"
HEALTH = "/api/health"
FIRST_RUN = "run-live-1"

MODULES = ("alpha", "beta")
PLUGINS = ("surefire", "failsafe")
# The line the fake prints on stdout: the captured output `raw` carries.
OUTPUT_MARKER = "fake-mvnw-output-line-5d2b"


def _class_name(module, plugin):
    suffix = "IT" if plugin == "failsafe" else "Test"
    return f"com.acme.{module}.{module.capitalize()}{suffix}"


def _report_name(module, plugin):
    return f"TEST-{_class_name(module, plugin)}.xml"


def _report_text(module, plugin, variant):
    """One surefire/failsafe report, byte for byte: a passing case, a
    failing one, or (`zero`) a suite that ran no case."""
    name = _class_name(module, plugin)
    head = '<?xml version="1.0" encoding="UTF-8"?>\n'
    if variant == "zero":
        return (head + f'<testsuite name="{name}" tests="0" failures="0" '
                f'errors="0" skipped="0">\n</testsuite>\n')
    failing = variant == "fail"
    body = ('<failure message="planted">planted failure</failure>'
            if failing else "")
    return (head + f'<testsuite name="{name}" tests="1" '
            f'failures="{1 if failing else 0}" errors="0" skipped="0">\n'
            f'  <testcase name="adds" classname="{name}" time="0.001">'
            f'{body}</testcase>\n</testsuite>\n')


REPORTS = {f"{m}/{p}/{v}": _report_text(m, p, v)
           for m in MODULES for p in PLUGINS for v in ("pass", "fail", "zero")}

_CSV_HEADER = ("GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED,"
               "BRANCH_MISSED,BRANCH_COVERED,LINE_MISSED,LINE_COVERED,"
               "COMPLEXITY_MISSED,COMPLEXITY_COVERED,METHOD_MISSED,"
               "METHOD_COVERED\n")
# Each module's JaCoCo CSV, byte for byte (alpha lines 8/10, methods 4/5;
# beta lines 2/10, methods 1/5): summed by a client, 50% and 50%.
JACOCO = {
    "alpha": _CSV_HEADER + "alpha,com.acme.alpha,Adder,3,17,4,6,2,8,1,5,1,4\n",
    "beta": _CSV_HEADER + "beta,com.acme.beta,Suber,9,4,7,1,8,2,4,1,4,1\n",
}
JACOCO_REL = os.path.join("target", "jacoco-report", "jacoco.csv")

# The coverage the scripted board says it kept: not what the CSVs above sum
# to, so a stderr line that reads the client's own sum is caught.
BOARD_COVERAGE = {"lines": {"total": 200, "covered": 123, "percent": 61.5},
                  "functions": {"total": 40, "covered": 17, "percent": 42.5}}

_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "CRUCIBLE_COVERAGE_PROFILE", "MVN_CRUCIBLE_PROJECT_DIR",
             "MVN_CRUCIBLE_MAVEN_DIR", "MVN_CRUCIBLE_COMPOSE_FILE")
_FAKE_KEYS = ("FAKE_EXIT", "FAKE_FAIL", "FAKE_ZERO", "FAKE_REPORT",
              "FAKE_NO_JACOCO")

# A fake `mvnw`. It prints OUTPUT_MARKER. `test-compile` (the client's compile
# fallback) is a build whose compile failed. Any other invocation is a test
# run over the reactor (`-pl <module>` narrows it): for each module it writes
# its surefire report, and its failsafe report when the goals reach failsafe
# (`integration-test`, `verify`), into the directory the client named for the
# plugin (`-D<plugin>.reportsDirectory=`), else `<module>/target/<plugin>-
# reports`. alpha's surefire case fails under FAKE_FAIL=1; every report holds
# no case under FAKE_ZERO=1; none is written under FAKE_REPORT=none. Each
# module's JaCoCo CSV goes to `<module>/target/jacoco-report/jacoco.csv`
# unless FAKE_NO_JACOCO=1. It exits FAKE_EXIT (default 1 under FAKE_FAIL=1,
# else 0).
_FAKE_MVNW = r'''
import os
import sys

MODULES, REPORTS, JACOCO, JACOCO_REL, MARKER = ''' + repr((
    MODULES, REPORTS, JACOCO, JACOCO_REL, OUTPUT_MARKER)) + r'''

def class_name(module, plugin):
    return "com.acme.%s.%s%s" % (module, module.capitalize(),
                                 "IT" if plugin == "failsafe" else "Test")

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

args = sys.argv[1:]
sys.stdout.write(MARKER + "\n")
if "test-compile" in args:
    sys.stdout.write("[ERROR] /p/src/test/java/FooTest.java:[1,1] cannot find symbol\n")
    sys.stdout.write("[INFO] BUILD FAILURE\n")
    sys.exit(1)
dirs = {}
for arg in args:
    for plugin in ("surefire", "failsafe"):
        flag = "-D%s.reportsDirectory=" % plugin
        if arg.startswith(flag):
            dirs[plugin] = arg[len(flag):]
plugins = ["surefire"]
if any(goal in args for goal in ("integration-test", "verify",
                                  "failsafe:integration-test")):
    plugins.append("failsafe")
modules = list(MODULES)
if "-pl" in args:
    modules = [args[args.index("-pl") + 1]]
failing = os.environ.get("FAKE_FAIL") == "1"
zero = os.environ.get("FAKE_ZERO") == "1"
if os.environ.get("FAKE_REPORT") != "none":
    for module in modules:
        for plugin in plugins:
            name = class_name(module, plugin)
            sys.stdout.write("[INFO] Running %s\n" % name)
            variant = "zero" if zero else (
                "fail" if failing and module == "alpha" and plugin == "surefire"
                else "pass")
            directory = dirs.get(plugin) or os.path.join(
                module, "target", "%s-reports" % plugin)
            write(os.path.join(directory, "TEST-%s.xml" % name),
                  REPORTS["%s/%s/%s" % (module, plugin, variant)])
    if os.environ.get("FAKE_NO_JACOCO") != "1":
        for module in modules:
            write(os.path.join(module, JACOCO_REL), JACOCO[module])
sys.stdout.write("[INFO] BUILD %s\n" % ("FAILURE" if failing else "SUCCESS"))
sys.stdout.flush()
sys.exit(int(os.environ.get("FAKE_EXIT", "1" if failing else "0")))
'''

# A `docker` stand-in: `e2e` lists containers and the gate brings a compose
# stack up and down; it exits 0 with no output, so the host's real docker is
# never reached.
_FAKE_DOCKER = "import sys\nsys.exit(0)\n"

# A POM declaring one tier profile, `<tier>`, and nothing else.
_POM = ('<?xml version="1.0" encoding="UTF-8"?>\n'
        '<project xmlns="http://maven.apache.org/POM/4.0.0">\n'
        '  <modelVersion>4.0.0</modelVersion>\n'
        '  <profiles><profile><id>{tier}</id></profile></profiles>\n'
        '</project>\n')


def _texts(plugins, modules=MODULES, variant="pass", failing_module=None):
    """The report texts a run over one pooled reports directory sends, in
    the order that directory's `TEST-*.xml` sort: by file name."""
    named = []
    for module in modules:
        for plugin in plugins:
            chosen = ("fail" if module == failing_module and plugin == "surefire"
                      else variant)
            named.append((_report_name(module, plugin),
                          REPORTS[f"{module}/{plugin}/{chosen}"]))
    return [text for _name, text in sorted(named)]


SUREFIRE_TEXTS = _texts(("surefire",))
BOTH_TEXTS = _texts(PLUGINS)
JACOCO_TEXTS = [JACOCO[m] for m in MODULES]


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _codes(envelope):
    return [w.get("code") for w in (envelope or {}).get("warnings") or []
            if isinstance(w, dict)]


def _figures(envelope):
    """The integer figures an envelope's `run:` block states."""
    run = (envelope or {}).get("run")
    if not isinstance(run, dict):
        return {}
    return {k: run[k] for k in ("passed", "failed", "pending", "total", "files")
            if isinstance(run.get(k), int) and not isinstance(run.get(k), bool)}


def _write_script(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


class _MavenProject:
    """A scratch two-module reactor with the fake `mvnw`, filing to a
    RecordingBoard."""

    def make(self, board=None):
        self.project = new_scratch("mvn-sends-its-reports-")
        self.bin_dir = new_scratch("mvn-sends-its-reports-bin-")
        self.board = board or RecordingBoard()
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n")
        _write_script(os.path.join(self.project, "mvnw"), _FAKE_MVNW)
        _write_script(os.path.join(self.bin_dir, "docker"), _FAKE_DOCKER)

    def cleanup(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)
        shutil.rmtree(self.bin_dir, ignore_errors=True)

    def declare_tier_profile(self, tier):
        Path(self.project, "pom.xml").write_text(_POM.format(tier=tier))

    def env(self, **fake_env):
        env = scrubbed_env(self.bin_dir, **fake_env)
        for key in _SCRUBBED + _FAKE_KEYS:
            if key not in fake_env:
                env.pop(key, None)
        return env

    def argv(self, verb, agent, *extra):
        return [verb, "--agent", agent, "--project-dir", self.project, *extra]

    def drive(self, verb, agent, *extra, **fake_env):
        cmd = [sys.executable, str(MVN_CLIENT), *self.argv(verb, agent, *extra)]
        return subprocess.run(cmd, cwd=self.project, env=self.env(**fake_env),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def write_existing_reports(self, variant="pass", jacoco=True):
        """The reports a previous build left in each module's `target`, for
        `auto-ingest` (which runs no maven) to file."""
        for module in MODULES:
            for plugin in PLUGINS:
                path = Path(self.project, module, "target", f"{plugin}-reports",
                            _report_name(module, plugin))
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(REPORTS[f"{module}/{plugin}/{variant}"])
            if jacoco:
                csv = Path(self.project, module, JACOCO_REL)
                csv.parent.mkdir(parents=True, exist_ok=True)
                csv.write_text(JACOCO[module])

    @staticmethod
    def diagnostics(result):
        return (f"exit={result.returncode} stdout={result.stdout!r} "
                f"stderr={result.stderr[-2500:]!r}")

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def envelope_of(self, result):
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(  # type: ignore[attr-defined]
            envelope, f"stdout is not one TOON envelope; {self.diagnostics(result)}")
        return envelope or {}

    def the_one_runs_ingest(self, result):
        """The run's one `POST /api/v2/runs`, after asserting that nothing went
        to the parsed route and that its reports travel inline."""
        self.assertEqual(  # type: ignore[attr-defined]
            self.posts_to(PARSED), [],
            f"the maven client never posts to {PARSED}; posts="
            f"{[p for p, _ in self.board.posts()]!r} {self.diagnostics(result)}")
        ingests = self.posts_to(RUNS)
        self.assertEqual(  # type: ignore[attr-defined]
            len(ingests), 1,
            f"the run is filed as exactly one POST {RUNS}; posts="
            f"{[p for p, _ in self.board.posts()]!r} {self.diagnostics(result)}")
        body = ingests[0] if ingests else {}
        self.assertNotIn("dataPath", body,  # type: ignore[attr-defined]
                         f"reports travel inline, never as a path; body={body!r}")
        self.assertEqual(body.get("stack"), "mvn",  # type: ignore[attr-defined]
                         f"body={body!r}")
        self.assertEqual(body.get("codec"), "junit",  # type: ignore[attr-defined]
                         f"body={body!r}")
        for key in ("summary", "tree"):
            self.assertNotIn(key, body,  # type: ignore[attr-defined]
                             f"the client sends no parse of its own; body={body!r}")
        return body

    def assert_health_read_before_the_ingest(self, result):
        events = [(m, p) for _t, m, p, _b in self.board.events]
        health = [i for i, (m, p) in enumerate(events)
                  if m == "GET" and p in (HEALTH, "/api/v2/health")]
        ingest = [i for i, (m, p) in enumerate(events) if m == "POST" and p == RUNS]
        self.assertTrue(  # type: ignore[attr-defined]
            health and ingest and health[0] < ingest[0],
            f"the board's health is read before the ingest is sent; "
            f"events={events!r} {self.diagnostics(result)}")

    def ingest_lines(self, result):
        return [line for line in result.stderr.splitlines()
                if line.startswith("ingest")]


# ── AC2 / AC8 — every report verb sends one /api/v2/runs, in order ─────────

class EveryMavenReportVerbSendsOneRunsIngestTest(_MavenProject, unittest.TestCase):
    """The route, the codec, the inline report texts in their order, `raw`
    and `runnerExit`, for every maven verb that files a report."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def assert_reports_inline_with_raw_and_exit(self, result, texts, runner_exit=0):
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("data"), texts,
                         f"`data` is every TEST-*.xml text the run wrote, inline, "
                         f"byte for byte, sorted; body={body!r}")
        self.assertIsInstance(body.get("raw"), str, f"body={body!r}")
        self.assertIn(OUTPUT_MARKER, body.get("raw") or "",
                      f"`raw` is the runner's captured output; body={body!r}")
        self.assertEqual(body.get("runnerExit"), runner_exit,
                         f"`runnerExit` is the runner's exit; body={body!r}")
        self.assert_health_read_before_the_ingest(result)
        return body

    def test_test_sends_both_modules_surefire_texts_with_raw_and_the_runner_exit(self):
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("test", "mvn-sends-test")
        body = self.assert_reports_inline_with_raw_and_exit(result, SUREFIRE_TEXTS)
        self.assertNotIn("tier", body, f"a `test` run claims no tier; body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_failing_runner_sends_its_non_zero_exit_as_runner_exit(self):
        self.board.script_run(passed=1, failed=1, total=2, files=2)
        result = self.drive("test", "mvn-sends-test-exit-3", FAKE_EXIT="3")
        self.assert_reports_inline_with_raw_and_exit(result, SUREFIRE_TEXTS,
                                                     runner_exit=3)
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_unit_sends_its_reports_directorys_texts_under_its_tier(self):
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("unit", "mvn-sends-unit")
        body = self.assert_reports_inline_with_raw_and_exit(result, SUREFIRE_TEXTS)
        self.assertEqual(body.get("tier"), "unit", f"body={body!r}")

    def test_module_over_a_two_module_reactor_sends_every_report_text_sorted(self):
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("module", "mvn-sends-module")
        body = self.assert_reports_inline_with_raw_and_exit(result, SUREFIRE_TEXTS)
        self.assertEqual(len(body.get("data") or []), 2,
                         f"one text per module's report; body={body!r}")
        self.assertEqual(body.get("tier"), "module", f"body={body!r}")

    def test_a_declared_bdd_profile_sends_its_reports_under_its_tier(self):
        self.declare_tier_profile("bdd")
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("bdd", "mvn-sends-bdd")
        body = self.assert_reports_inline_with_raw_and_exit(result, SUREFIRE_TEXTS)
        self.assertEqual(body.get("tier"), "bdd", f"body={body!r}")

    def test_integration_and_e2e_send_surefire_and_failsafe_texts_under_their_tier(self):
        self.board.script_run(passed=4, total=4, files=4)
        for verb in ("integration", "e2e"):
            with self.subTest(verb=verb):
                before = len(self.board.events)
                result = self.drive(verb, f"mvn-sends-{verb}")
                del self.board.events[:before]
                body = self.assert_reports_inline_with_raw_and_exit(result, BOTH_TEXTS)
                self.assertEqual(body.get("tier"), verb, f"body={body!r}")

    def test_regression_sends_surefire_and_failsafe_texts_and_no_coverage(self):
        self.board.script_run(passed=4, total=4, files=4)
        result = self.drive("regression", "mvn-sends-regression")
        body = self.assert_reports_inline_with_raw_and_exit(result, BOTH_TEXTS)
        self.assertEqual(body.get("tier"), "regression", f"body={body!r}")
        self.assertNotIn("coverage", body,
                         f"a run without --coverage sends no coverage; body={body!r}")
        self.assertNotIn("coverage-not-measured", _codes(self.envelope_of(result)),
                         f"nothing was asked, so nothing is missing; "
                         f"{self.diagnostics(result)}")

    def test_auto_ingest_sends_each_modules_surefire_then_failsafe_texts_with_no_raw(self):
        # The directories `auto-ingest` reads: every module's surefire
        # reports, then every module's failsafe reports.
        self.write_existing_reports()
        self.board.script_run(passed=4, total=4, files=4)
        result = self.drive("auto-ingest", "mvn-sends-auto-ingest")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(
            body.get("data"),
            [REPORTS["alpha/surefire/pass"], REPORTS["beta/surefire/pass"],
             REPORTS["alpha/failsafe/pass"], REPORTS["beta/failsafe/pass"]],
            f"`data` holds each module's surefire texts, then each module's "
            f"failsafe texts, in that order; body={body!r}")
        self.assertNotIn("raw", body, f"auto-ingest runs nothing; body={body!r}")
        self.assertNotIn("runnerExit", body, f"auto-ingest runs nothing; body={body!r}")
        self.assertNotIn("tier", body, f"auto-ingest claims no tier; body={body!r}")
        self.assertNotIn("coverage", body, f"no --coverage, no coverage; body={body!r}")
        self.assert_health_read_before_the_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_the_pre_merge_gate_regression_step_sends_one_runs_ingest_with_jacoco(self):
        self.board.script_run(passed=4, total=4, files=4, coverage=BOARD_COVERAGE)
        result = self.drive("pre-merge-gate", "mvn-sends-gate")
        body = self.assert_reports_inline_with_raw_and_exit(result, BOTH_TEXTS)
        self.assertEqual(body.get("tier"), "regression", f"body={body!r}")
        self.assertEqual(body.get("coverage"), {"codec": "jacoco", "data": JACOCO_TEXTS},
                         f"the gate measures coverage and sends both CSV texts; "
                         f"body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))


# ── AC3 — coverage travels as its report ────────────────────────────────────

class CoverageTravelsAsItsReportTest(_MavenProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_regression_coverage_on_a_passing_run_sends_both_modules_csv_texts(self):
        self.board.script_run(passed=4, total=4, files=4, coverage=BOARD_COVERAGE)
        result = self.drive("regression", "mvn-coverage-green", "--coverage")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("coverage"), {"codec": "jacoco", "data": JACOCO_TEXTS},
                         f"body={body!r}")
        self.assertNotIn("coverage-not-measured", _codes(self.envelope_of(result)),
                         self.diagnostics(result))
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_regression_coverage_on_a_failing_run_still_sends_both_csv_texts(self):
        # The board discards a red run's coverage; the client sends it anyway.
        self.board.script_run(passed=3, failed=1, total=4, files=4)
        result = self.drive("regression", "mvn-coverage-red", "--coverage",
                            FAKE_FAIL="1")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("data"),
                         _texts(PLUGINS, failing_module="alpha"), f"body={body!r}")
        self.assertEqual(body.get("coverage"), {"codec": "jacoco", "data": JACOCO_TEXTS},
                         f"coverage is sent whether or not the run passed; "
                         f"body={body!r}")
        self.assertNotIn("NOT publishing coverage", result.stderr,
                         self.diagnostics(result))
        self.assertEqual(result.returncode, 1, self.diagnostics(result))

    def test_the_stderr_ingest_line_reads_the_answers_coverage(self):
        self.board.script_run(passed=4, total=4, files=4, coverage=BOARD_COVERAGE)
        result = self.drive("regression", "mvn-coverage-line", "--coverage")
        lines = [line for line in result.stderr.splitlines()
                 if line.startswith("ingest: ")]
        self.assertEqual(len(lines), 1,
                         f"the run has one `ingest:` line; {self.diagnostics(result)}")
        line = lines[0] if lines else ""
        self.assertIn("lines=61.5%", line,
                      f"the line states the board's lines figure; {line!r}")
        self.assertIn("funcs=42.5%", line,
                      f"the line states the board's functions figure; {line!r}")
        self.assertNotIn("lines=50.0%", result.stderr,
                         f"the client's own JaCoCo sum is never reported; "
                         f"{self.diagnostics(result)}")
        self.assertNotIn("[crucible] jacoco:", result.stderr,
                         f"the client sums no CSV; {self.diagnostics(result)}")

    def test_a_coverage_run_with_no_csv_sends_no_coverage_and_warns_coverage_not_measured(self):
        self.board.script_run(passed=4, total=4, files=4)
        result = self.drive("regression", "mvn-coverage-missing", "--coverage",
                            FAKE_NO_JACOCO="1")
        body = self.the_one_runs_ingest(result)
        self.assertNotIn("coverage", body, f"body={body!r}")
        codes = _codes(self.envelope_of(result))
        self.assertEqual(codes.count("coverage-not-measured"), 1,
                         f"the envelope says the asked-for coverage was not "
                         f"measured, once; {self.diagnostics(result)}")
        self.assertNotIn("no jacoco.csv found", result.stderr,
                         f"the maven-only line is gone; {self.diagnostics(result)}")

    def test_auto_ingest_coverage_sends_both_modules_csv_texts(self):
        self.write_existing_reports()
        self.board.script_run(passed=4, total=4, files=4, coverage=BOARD_COVERAGE)
        result = self.drive("auto-ingest", "mvn-auto-ingest-coverage", "--coverage")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("coverage"), {"codec": "jacoco", "data": JACOCO_TEXTS},
                         f"body={body!r}")
        self.assertIn("lines=61.5%", result.stderr, self.diagnostics(result))
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_auto_ingest_coverage_over_a_failing_report_still_sends_the_csv_texts(self):
        self.write_existing_reports(variant="fail")
        self.board.script_run(passed=0, failed=4, total=4, files=4)
        result = self.drive("auto-ingest", "mvn-auto-ingest-coverage-red", "--coverage")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("coverage"), {"codec": "jacoco", "data": JACOCO_TEXTS},
                         f"body={body!r}")

    def test_auto_ingest_coverage_with_no_csv_sends_none_and_warns_coverage_not_measured(self):
        self.write_existing_reports(jacoco=False)
        self.board.script_run(passed=4, total=4, files=4)
        result = self.drive("auto-ingest", "mvn-auto-ingest-no-csv", "--coverage")
        body = self.the_one_runs_ingest(result)
        self.assertNotIn("coverage", body, f"body={body!r}")
        codes = _codes(self.envelope_of(result))
        self.assertEqual(codes.count("coverage-not-measured"), 1,
                         self.diagnostics(result))


# ── AC6 — the local decisions: ran nothing, and the exit ───────────────────

class TheLocalDecisionsTest(_MavenProject, unittest.TestCase):

    VERBS = ("unit", "integration", "test", "regression")

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def drive_fresh(self, verb, agent, **fake_env):
        """One drive on a board whose record holds only this drive."""
        self.board.close()
        scripted = getattr(self, "_scripted", None)
        self.board = RecordingBoard()
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n")
        if scripted is not None:
            self.board.script_run(**scripted)
        return self.drive(verb, agent, **fake_env)

    def test_a_runner_exiting_non_zero_over_reports_with_no_testcase_ran_nothing(self):
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"mvn-ran-nothing-{verb}",
                                          FAKE_ZERO="1", FAKE_EXIT="1")
                self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
                self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
                aborts = self.board.aborts()
                self.assertEqual(len(aborts), 1,
                                 f"aborts={aborts!r} {self.diagnostics(result)}")
                self.assertIn(FIRST_RUN, aborts[0][0] if aborts else "",
                              f"aborts={aborts!r}")
                self.assertEqual(_figures(self.envelope_of(result)), {},
                                 self.diagnostics(result))
                self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_run_with_a_failure_is_filed_and_exits_one(self):
        self._scripted = {"passed": 1, "failed": 1, "total": 2, "files": 2}
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"mvn-failure-{verb}", FAKE_FAIL="1")
                body = self.the_one_runs_ingest(result)
                self.assertEqual(body.get("runnerExit"), 1, f"body={body!r}")
                self.assertEqual(result.returncode, 1, self.diagnostics(result))
                self.assertEqual(_figures(self.envelope_of(result)).get("failed"), 1,
                                 self.diagnostics(result))

    def test_a_failure_only_the_board_reports_makes_the_verb_exit_one(self):
        # The runner exits 0 over passing reports; the board's decoded run
        # holds a failure, and the verb's exit is `verb_exit` over its answer.
        self._scripted = {"passed": 1, "failed": 1, "total": 2, "files": 2}
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"mvn-board-failure-{verb}")
                body = self.the_one_runs_ingest(result)
                self.assertEqual(body.get("runnerExit"), 0, f"body={body!r}")
                self.assertEqual(result.returncode, 1, self.diagnostics(result))

    def test_a_run_the_board_reports_clean_exits_zero(self):
        self._scripted = {"passed": 2, "total": 2, "files": 2}
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"mvn-board-clean-{verb}")
                self.the_one_runs_ingest(result)
                self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_auto_ingest_exits_zero_on_an_ok_answer_even_with_failures(self):
        self.write_existing_reports(variant="fail")
        self.board.script_run(passed=0, failed=4, total=4, files=4)
        result = self.drive("auto-ingest", "mvn-auto-ingest-ok")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 0,
                         f"auto-ingest runs no runner: an `ok` answer is exit 0; "
                         f"{self.diagnostics(result)}")

    def test_auto_ingest_exits_one_on_an_answer_that_is_not_ok(self):
        self.write_existing_reports()
        health = self.board.default_health()
        health.pop("codecs")
        self.board.script_health(health)
        result = self.drive("auto-ingest", "mvn-auto-ingest-refused")
        self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
        self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
        self.assertEqual(result.returncode, 1, self.diagnostics(result))


# ── AC7 — the envelope reads the answer ────────────────────────────────────

class TheEnvelopeReadsTheAnswerTest(_MavenProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_the_envelope_run_block_is_the_answers_five_counts_on_every_emitter(self):
        # The reports hold passing cases in two or four classes; the board
        # says otherwise, and the envelope states what the board said.
        self.board.script_run(passed=7, failed=2, pending=3, total=12, files=5)
        self.write_existing_reports()
        for verb in ("test", "unit", "integration", "regression", "auto-ingest"):
            with self.subTest(verb=verb):
                result = self.drive(verb, f"mvn-envelope-counts-{verb}")
                self.assertEqual(
                    _figures(self.envelope_of(result)),
                    {"passed": 7, "failed": 2, "pending": 3, "total": 12, "files": 5},
                    self.diagnostics(result))
                lines = self.ingest_lines(result)
                self.assertEqual(
                    [token for line in lines if line.startswith("ingest: ")
                     for token in line.split() if token.startswith("files=")],
                    ["files=5"],
                    "the one `ingest:` line carries the answer's files figure; "
                    + self.diagnostics(result))
                self.assertEqual(
                    [line for line in lines
                     if line.startswith(("ingest junit:", "ingest parsed:"))],
                    [], "the maven ingest lines are gone; " + self.diagnostics(result))

    def test_a_board_report_skipped_warning_joins_the_envelope_warnings(self):
        warning = {"code": "report-skipped",
                   "detail": "report 1 skipped: not a JUnit report"}
        self.board.script_run(passed=2, total=2, files=2, warnings=[warning])
        for verb in ("test", "unit", "regression"):
            with self.subTest(verb=verb):
                result = self.drive(verb, f"mvn-envelope-report-skipped-{verb}")
                self.assertIn(warning, self.envelope_of(result).get("warnings") or [],
                              self.diagnostics(result))

    def test_a_board_coverage_dropped_warning_joins_the_envelope_warnings(self):
        warning = {"code": "coverage-dropped",
                   "detail": "jacoco coverage dropped: no LINE columns"}
        self.board.script_run(passed=4, total=4, files=4, warnings=[warning])
        result = self.drive("regression", "mvn-envelope-coverage-dropped", "--coverage")
        self.assertIn(warning, self.envelope_of(result).get("warnings") or [],
                      self.diagnostics(result))


# ── AC7 — an older board, a body too large ─────────────────────────────────

class ABoardThatCannotTakeTheRunIsRefusedBeforeSendingTest(_MavenProject,
                                                           unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def assert_refused_before_sending(self, result, *named):
        self.assertEqual(self.posts_to(RUNS), [],
                         f"nothing is sent to {RUNS}; {self.diagnostics(result)}")
        self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
        aborts = self.board.aborts()
        self.assertEqual(len(aborts), 1,
                         f"the run the verb opened is aborted; aborts={aborts!r} "
                         f"{self.diagnostics(result)}")
        self.assertIn(FIRST_RUN, aborts[0][0] if aborts else "", f"aborts={aborts!r}")
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertIn("run-aborted", _codes(envelope), f"envelope={envelope!r}")
        self.assertEqual(_figures(envelope), {},
                         f"a run that was not filed carries no figures; "
                         f"envelope={envelope!r}")
        said = json.dumps(envelope)
        for text in named:
            self.assertIn(text, said, f"the refusal names {text!r}; envelope={envelope!r}")
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_health_with_no_codecs_is_refused_naming_the_version_and_the_floor(self):
        health = self.board.default_health()
        health.pop("codecs")
        health["version"] = "0.3.7"
        self.board.script_health(health)
        for verb in ("test", "regression"):
            with self.subTest(verb=verb):
                before = len(self.board.events)
                result = self.drive(verb, f"mvn-older-board-{verb}")
                runs = self.board.run_ids_opened()
                del self.board.events[:before]
                self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
                self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
                envelope = self.envelope_of(result)
                said = json.dumps(envelope)
                for text in ("0.3.7", "0.4.0"):
                    self.assertIn(text, said, f"envelope={envelope!r}")
                self.assertIn("run-aborted", _codes(envelope), f"envelope={envelope!r}")
                self.assertEqual(_figures(envelope), {}, f"envelope={envelope!r}")
                self.assertEqual(len(self.board.aborts()), 1,
                                 f"runs={runs!r} {self.diagnostics(result)}")
                self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_codecs_lacking_jacoco_refuse_a_coverage_run(self):
        health = self.board.default_health()
        health["codecs"] = {"test": ["junit"], "coverage": ["lcov"]}
        health["version"] = "0.3.9"
        self.board.script_health(health)
        result = self.drive("regression", "mvn-board-without-jacoco", "--coverage")
        self.assert_refused_before_sending(result, "0.3.9", "0.4.0", "jacoco")

    def test_health_that_cannot_be_read_is_refused_before_sending(self):
        self.board.fail_health(status=503, error="health unavailable")
        result = self.drive("regression", "mvn-health-unreadable")
        self.assert_refused_before_sending(result)

    def test_health_with_codecs_but_no_limits_still_sends(self):
        health = self.board.default_health()
        health.pop("limits")
        self.board.script_health(health)
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("test", "mvn-board-without-limits")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_body_over_the_advertised_limit_is_refused_naming_ingest_body_bytes(self):
        self.board.close()
        self.make(board=RecordingBoard(ingest_body_bytes=64))
        result = self.drive("test", "mvn-body-too-large")
        self.assert_refused_before_sending(result, "ingest_body_bytes", "64")

    def test_a_413_from_the_board_is_reported_naming_ingest_body_bytes(self):
        self.board.refuse_ingest_for(FIRST_RUN, status=413)
        result = self.drive("test", "mvn-board-413")
        self.assertEqual(len(self.posts_to(RUNS)), 1, self.diagnostics(result))
        self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertIn("ingest_body_bytes", str(envelope.get("error")),
                      f"envelope={envelope!r}")
        self.assertEqual(_figures(envelope), {}, f"envelope={envelope!r}")
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))


# ── AC7 — no board, no figures ──────────────────────────────────────────────

_UNREACHABLE = {"ok": False, "error": "connection failed: [Errno 111] Connection "
                                      "refused (is Crucible running?)"}


class NoBoardNoFiguresTest(_MavenProject, unittest.TestCase):
    """The client's own `main()`, in-process, with ONE route answered as the
    fleet transport answers a board it cannot reach; every other route
    reaches the recording board."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def drive_in_process(self, argv, unreachable):
        module = load_client("mvn-crucible.py")
        real_request = module._request

        def request(method, path, payload=None, timeout=None):
            if (method, path) in unreachable:
                return dict(_UNREACHABLE)
            return real_request(method, path, payload, timeout)

        # Real files, not StringIO: the gate hands its own stdio to the
        # docker step it spawns, which needs a file descriptor.
        with tempfile.TemporaryFile("w+") as out, \
                tempfile.TemporaryFile("w+") as err:
            with mock.patch.object(module, "_request", request), \
                    mock.patch.dict(os.environ, self.env(), clear=True), \
                    mock.patch.object(sys, "argv", ["mvn-crucible.py", *argv]), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    module.main()
                    code = 0
                except SystemExit as exit_:
                    code = exit_.code
            out.seek(0)
            err.seek(0)
            return code, out.read(), err.read()

    def assert_no_figures_and_not_filed(self, code, stdout, stderr):
        where = f"exit={code} stdout={stdout!r} stderr={stderr[-2500:]!r}"
        envelope = _envelope(stdout)
        self.assertIsNotNone(envelope, where)
        envelope = envelope or {}
        self.assertIs(envelope.get("ok"), False, where)
        self.assertEqual(_figures(envelope), {},
                         f"with no board there are no figures; {where}")
        self.assertIsInstance(envelope.get("error"), str,
                              f"the envelope says why the run was not filed; {where}")
        self.assertNotEqual(code, 0, where)
        return envelope

    def test_an_ingest_that_cannot_reach_the_board_carries_no_figures(self):
        for verb in ("test", "unit", "regression"):
            with self.subTest(verb=verb):
                code, stdout, stderr = self.drive_in_process(
                    self.argv(verb, f"mvn-ingest-unreachable-{verb}"),
                    {("POST", RUNS), ("POST", PARSED)})
                envelope = self.assert_no_figures_and_not_filed(code, stdout, stderr)
                self.assertIn("connection failed", envelope.get("error") or "", stdout)

    def test_a_health_read_that_cannot_reach_the_board_sends_nothing(self):
        code, stdout, stderr = self.drive_in_process(
            self.argv("regression", "mvn-health-unreachable"), {("GET", HEALTH)})
        self.assert_no_figures_and_not_filed(code, stdout, stderr)
        self.assertEqual(self.posts_to(RUNS), [], stdout)
        self.assertEqual(self.posts_to(PARSED), [], stdout)
        self.assertIn("run-aborted", _codes(_envelope(stdout)), stdout)

    def assert_gate_unreported(self, code, stdout, stderr):
        where = f"exit={code} stdout={stdout!r} stderr={stderr[-2500:]!r}"
        envelope = _envelope(stdout) or {}
        self.assertIs(envelope.get("ok"), False, where)
        self.assertIn("gate-suite-unreported", _codes(envelope),
                      f"the gate names the suite it could not file as "
                      f"unreported; {where}")
        self.assertNotIn("gate-suite-failed", _codes(envelope), where)
        self.assertNotEqual(code, 0, where)
        return envelope

    def test_pre_merge_gate_reports_its_unfiled_whole_suite_unreported_and_is_not_green(self):
        # No declared suite: the gate's envelope is its whole-suite run's.
        code, stdout, stderr = self.drive_in_process(
            self.argv("pre-merge-gate", "mvn-gate-unreachable"),
            {("POST", RUNS), ("POST", PARSED)})
        envelope = self.assert_gate_unreported(code, stdout, stderr)
        self.assertEqual(_figures(envelope), {},
                         f"the gate states no figures for a suite it could not "
                         f"file; stdout={stdout!r}")

    def test_pre_merge_gate_composing_a_declared_suite_reports_it_unreported(self):
        # A POM declaring a tier profile: the gate composes, and its
        # whole-suite run is a suite whose outcome it must report.
        self.declare_tier_profile("unit")
        code, stdout, stderr = self.drive_in_process(
            self.argv("pre-merge-gate", "mvn-gate-composed-unreachable"),
            {("POST", RUNS), ("POST", PARSED)})
        self.assert_gate_unreported(code, stdout, stderr)


# ── AC9 — one ingest line, and the shared module does not grow ─────────────

# `clients/_crucible_axi.py`'s length, in lines, at `develop@de4ae4a`: the
# maven client's move to the shared ingest adds nothing to it.
SHARED_MODULE_LINE_BUDGET = 9997
_OWN_INGEST_LINES = ("ingest junit:", "ingest parsed:")


def own_ingest_line_literals(source):
    """Every string literal of `source` (an f-string's literal parts too)
    that begins a client-owned ingest line."""
    return sorted({node.value for node in ast.walk(ast.parse(source))
                   if isinstance(node, ast.Constant) and isinstance(node.value, str)
                   and node.value.startswith(_OWN_INGEST_LINES)})


class TheMavenClientPrintsOnlyTheSharedIngestLineTest(unittest.TestCase):

    def test_the_scan_finds_an_own_ingest_line_in_a_plain_or_formatted_literal(self):
        source = textwrap.dedent('''
            import sys
            def _a(resp):
                print(f"ingest junit: ok={resp} dir=x", file=sys.stderr)
            def _b(resp):
                print("ingest parsed: ok=" + str(resp), file=sys.stderr)
            def _c(resp):
                print(f"ingest compile: ok={resp}", file=sys.stderr)
                print(f"ingest: ok={resp}", file=sys.stderr)
        ''')
        self.assertEqual(own_ingest_line_literals(source),
                         ["ingest junit: ok=", "ingest parsed: ok="])

    def test_the_maven_client_holds_no_ingest_junit_or_ingest_parsed_literal(self):
        found = own_ingest_line_literals(MVN_CLIENT.read_text(encoding="utf-8"))
        self.assertEqual(found, [],
                         f"the shared `ingest:` line is the run's one ingest "
                         f"line; mvn-crucible.py still prints {found!r}")

    def test_the_shared_module_is_no_longer_than_its_line_budget(self):
        text = (CLIENTS / "_crucible_axi.py").read_text(encoding="utf-8")
        lines = text.count("\n")
        self.assertLessEqual(
            lines, SHARED_MODULE_LINE_BUDGET,
            f"clients/_crucible_axi.py is {lines} lines, over the "
            f"{SHARED_MODULE_LINE_BUDGET} it held before the maven client "
            f"moved to the shared ingest")


# ── the no-report exits, unchanged ─────────────────────────────────────────

class TheNoReportExitsAreUnchangedTest(_MavenProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_a_run_with_no_report_files_its_compile_ingest_and_no_run(self):
        for verb in ("test", "unit", "regression"):
            with self.subTest(verb=verb):
                before = len(self.board.events)
                result = self.drive(verb, f"mvn-no-report-{verb}",
                                    FAKE_REPORT="none", FAKE_EXIT="1")
                del self.board.events[:before]
                compiles = self.posts_to(COMPILE)
                self.assertEqual(len(compiles), 1, self.diagnostics(result))
                self.assertIn("cannot find symbol", (compiles[0] or {}).get("errors", ""),
                              f"compile body={compiles[0]!r}")
                self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
                self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
                self.assertNotEqual(result.returncode, 0, self.diagnostics(result))


if __name__ == "__main__":
    unittest.main()
