"""The helpers of `test_mvn_client_sends_its_runners_reports.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
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

HEALTH = "/api/health"

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
# reports`. As real surefire does, `-Dtest=!*` runs (and writes) no surefire
# report. alpha's surefire case fails under FAKE_FAIL=1; every report holds
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
plugins = [] if "-Dtest=!*" in args else ["surefire"]
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


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


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
