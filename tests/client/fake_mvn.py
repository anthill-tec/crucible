"""A fake `mvn` that answers as real Maven 3.9.9 does with surefire and
failsafe 3.5.4 bound, for the client tests that put it first on `PATH`.

A test writes a one-line launcher named `mvn` (`launcher_text()`) into a
directory it puts first on `PATH`; the launcher imports this module and calls
`main(argv)`. The project the fake builds is a JSON model the test writes
(`write_project`) and names in FAKE_MVN_PROJECT:

    {"group": "live", "artifact": "failsafe-live",
     "modules": [{"name": "", "tests": ["live.FooTest#adds"],
                  "its": ["live.FooIT#integrates"], "failsafe": true}],
     "profiles": [{"id": "integration", "failsafe": true},
                  {"id": "dflt", "activeByDefault": true}]}

A module named "" is the project in the maven directory itself; a named one
lives in that subdirectory. `tests` are the classes surefire's default
includes find (`*Test`), `its` the ones failsafe's find (`*IT`), each
`<class>[#<method>]`. `failsafe` says whether the module's pom binds failsafe's
`integration-test` and `verify` goals. An active profile with `failsafe: true`
binds them as well.

What it does, as the survey's real runs and the scratch projects under
`/tmp/cr268-red/` showed Maven 3.9.9 doing:
  - goals run in order. `clean` deletes the module's `target`. A lifecycle
    phase runs every mojo bound up to it: `test-compile` compiles (it creates
    `target/test-classes`), `test` runs surefire, `package` the jar plugin,
    `integration-test` failsafe's `integration-test` (when bound) and `verify`
    failsafe's `verify` (when bound). `failsafe:integration-test`,
    `failsafe:verify` and `surefire:test` named on the command line run in
    every selected module whether or not the pom binds them, as execution
    `default-cli`; with no `target/test-classes` they find no test.
  - surefire runs the module's `tests`. `-Dtest=<patterns>` (comma
    separated; `!` excludes; `#method` is ignored; `*` and `?` glob the simple
    or the full class name) selects among the `tests` and the `its`, as real
    surefire does once `-Dtest` replaces its includes. A `-Dtest` that selects
    nothing fails the build with surefire's "No tests matching pattern"
    message, unless `-Dsurefire.failIfNoSpecifiedTests=false`. `-Dtest` never
    reaches failsafe; `-Dit.test` is failsafe's own.
  - failsafe's `integration-test` runs the `its` and writes
    `failsafe-summary.xml`; its `verify` prints "No tests to run." when no
    summary was written. A bound failsafe with no IT writes no
    `failsafe-reports` directory.
  - `-DskipTests` skips both plugins; `-DskipITs` skips failsafe.
  - reports go where real 3.5.4 writes them, `<module>/target/<plugin>-
    reports/TEST-<class>.xml` and `<class>.txt`: the `-D<plugin>.
    reportsDirectory` property is ignored, as the real plugins ignore it.
  - `-P <ids>` / `-P<ids>` (comma lists) activate profiles; any `-P` turns
    off an `activeByDefault` profile. An id the model does not declare is
    warned about, with Maven's own line, before the build and after it; an id
    written `!id` is never warned about. `-pl <m>` selects one module; a
    module the model does not hold fails as Maven fails.
  - FAKE_MVN_COMPILE_ERROR=1: test compilation fails with javac's
    `cannot find symbol` error, and the build fails at `testCompile`.

Every call is appended to FAKE_MVN_CALLS (one JSON line: `argv`, `cwd`) so a
test asserts the argv it was handed (`read_calls`).

The console omits the reactor summary of a multi-module build and the
`Downloading`/`Downloaded` lines of an online one: no client reads either.
"""

import datetime
import fnmatch
import json
import os
import shutil
import sys

PLUGIN_VERSION = "3.5.4"
PROVIDER = "org.apache.maven.surefire.junitplatform.JUnitPlatformProvider"
RULE = "[INFO] " + "-" * 72
TESTS_RULE = "[INFO] " + "-" * 55
LIFECYCLE = ("validate", "initialize", "generate-sources", "process-sources",
             "generate-resources", "process-resources", "compile",
             "process-classes", "generate-test-sources", "process-test-sources",
             "generate-test-resources", "process-test-resources", "test-compile",
             "process-test-classes", "test", "prepare-package", "package",
             "pre-integration-test", "integration-test", "post-integration-test",
             "verify", "install", "deploy")
_FLAGS_WITH_VALUE = ("-pl", "--projects", "-P", "--activate-profiles", "-f", "-s",
                     "-rf", "-T")


# ── for the tests ───────────────────────────────────────────────────────────


def launcher_text(python=None):
    """The `mvn` a test writes into its fake bin directory."""
    here = os.path.dirname(os.path.abspath(__file__))
    return (f"#!{python or sys.executable}\nimport sys\n"
            f"sys.path.insert(0, {here!r})\nimport fake_mvn\n"
            f"sys.exit(fake_mvn.main(sys.argv[1:]))\n")


def write_project(path, model):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(model, handle)


def read_calls(path):
    """Every call the fake recorded in `path`, in order."""
    try:
        with open(path, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]
    except FileNotFoundError:
        return []


# ── the command line ────────────────────────────────────────────────────────


class _Invocation:
    def __init__(self, argv):
        self.goals, self.props, self.profiles, self.projects = [], {}, [], None
        args = list(argv)
        i = 0
        while i < len(args):
            arg = args[i]
            value = args[i + 1] if i + 1 < len(args) else None
            if arg in _FLAGS_WITH_VALUE:
                self._flag(arg, value)
                i += 2
                continue
            if arg.startswith("-P") and len(arg) > 2:
                self._flag("-P", arg[2:])
            elif arg == "-D" and value is not None:
                self._property(value)
                i += 2
                continue
            elif arg.startswith("-D"):
                self._property(arg[2:])
            elif not arg.startswith("-"):
                self.goals.append(arg)
            i += 1

    def _flag(self, flag, value):
        if value is None:
            return
        if flag in ("-P", "--activate-profiles"):
            self.profiles += [p.strip() for p in value.split(",") if p.strip()]
        elif flag in ("-pl", "--projects"):
            self.projects = [p.strip() for p in value.split(",") if p.strip()]

    def _property(self, text):
        key, _sep, value = text.partition("=")
        self.props[key] = value if _sep else "true"

    def flag_off(self, key):
        return self.props.get(key, "").lower() == "false"

    def flag_on(self, key):
        return key in self.props and self.props[key].lower() != "false"


# ── the build ───────────────────────────────────────────────────────────────


class _Failure(Exception):
    def __init__(self, lines):
        super().__init__(lines[0] if lines else "")
        self.lines = lines


def _out(line=""):
    sys.stdout.write(line + "\n")


def _mojo(plugin, version, goal, execution, artifact):
    _out("[INFO] ")
    _out(f"[INFO] --- {plugin}:{version}:{goal} ({execution}) @ {artifact} ---")


def _split(entry):
    cls, _sep, method = entry.partition("#")
    return cls, method or "test"


def _matches(pattern, cls):
    pattern = pattern.split("#", 1)[0]
    simple = cls.rsplit(".", 1)[-1]
    return (fnmatch.fnmatchcase(simple, pattern) or fnmatch.fnmatchcase(cls, pattern)
            or fnmatch.fnmatchcase(cls.replace(".", "/"), pattern))


def _select(spec, candidates):
    patterns = [p.strip() for p in spec.split(",") if p.strip()]
    includes = [p for p in patterns if not p.startswith("!")]
    excludes = [p[1:] for p in patterns if p.startswith("!")]
    chosen = []
    for entry in candidates:
        cls, _method = _split(entry)
        if includes and not any(_matches(p, cls) for p in includes):
            continue
        if any(_matches(p, cls) for p in excludes):
            continue
        chosen.append(entry)
    return chosen


def _report_xml(plugin, cls, methods):
    cases = "".join(f'  <testcase name="{m}" classname="{cls}" time="0.012"/>\n'
                    for m in methods)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
            f'xsi:noNamespaceSchemaLocation="https://maven.apache.org/surefire/'
            f'maven-{plugin}-plugin/xsd/{plugin}-test-report.xsd" version="3.0.2" '
            f'name="{cls}" time="0.026" tests="{len(methods)}" errors="0" '
            f'skipped="0" failures="0">\n  <properties>\n  </properties>\n'
            f'{cases}</testsuite>')


def _report_txt(cls, count):
    rule = "-" * 79
    return (f"{rule}\nTest set: {cls}\n{rule}\nTests run: {count}, Failures: 0, "
            f"Errors: 0, Skipped: 0, Time elapsed: 0.026 s -- in {cls}\n")


def _summary_xml(completed):
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<failsafe-summary xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
            'xsi:noNamespaceSchemaLocation="https://maven.apache.org/surefire/'
            'maven-surefire-plugin/xsd/failsafe-summary.xsd" result="null" '
            'timeout="false">\n'
            f'    <completed>{completed}</completed>\n    <errors>0</errors>\n'
            '    <failures>0</failures>\n    <skipped>0</skipped>\n'
            '    <flakes>0</flakes>\n    <failureMessage xsi:nil="true" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>\n'
            '</failsafe-summary>')


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


class _Module:
    def __init__(self, model, spec, inv, bound_by_profile):
        self.name = spec.get("name", "")
        self.artifact = self.name or model.get("artifact", "fake-project")
        self.root = os.path.join(os.getcwd(), self.name) if self.name else os.getcwd()
        self.target = os.path.join(self.root, "target")
        self.tests = list(spec.get("tests") or [])
        self.its = list(spec.get("its") or [])
        self.failsafe = bool(spec.get("failsafe")) or bound_by_profile
        self.inv = inv

    def reports(self, plugin):
        return os.path.join(self.target, f"{plugin}-reports")

    def compiled(self):
        return os.path.isdir(os.path.join(self.target, "test-classes"))

    def clean(self):
        _mojo("clean", "3.2.0", "clean", "default-clean", self.artifact)
        if os.path.isdir(self.target):
            _out(f"[INFO] Deleting {self.target}")
            shutil.rmtree(self.target)

    def test_compile(self):
        _mojo("resources", "3.3.1", "resources", "default-resources", self.artifact)
        _out(f"[INFO] skip non existing resourceDirectory "
             f"{os.path.join(self.root, 'src', 'main', 'resources')}")
        _mojo("compiler", "3.13.0", "compile", "default-compile", self.artifact)
        _out("[INFO] No sources to compile")
        _mojo("resources", "3.3.1", "testResources", "default-testResources",
              self.artifact)
        _out(f"[INFO] skip non existing resourceDirectory "
             f"{os.path.join(self.root, 'src', 'test', 'resources')}")
        _mojo("compiler", "3.13.0", "testCompile", "default-testCompile", self.artifact)
        _out("[INFO] Recompiling the module because of changed source code.")
        sources = len({_split(e)[0] for e in self.tests + self.its})
        compiling = (f"[INFO] Compiling {sources} source "
                     f"{'file' if sources == 1 else 'files'} with javac [debug "
                     f"release 21] to target/test-classes")
        if os.environ.get("FAKE_MVN_COMPILE_ERROR") == "1":
            source = os.path.join(self.root, "src", "test", "java", "live", "FooTest.java")
            cause = f"{source}:[12,25] cannot find symbol"
            _out(compiling)
            _out("[INFO] " + "-" * 61)
            _out("[ERROR] COMPILATION ERROR : ")
            _out("[INFO] " + "-" * 61)
            _out(f"[ERROR] {cause}")
            _out("  symbol:   variable undefinedValue")
            _out("  location: class live.FooTest")
            _out("[INFO] 1 error")
            _out("[INFO] " + "-" * 61)
            raise _Failure([
                f"[ERROR] Failed to execute goal org.apache.maven.plugins:"
                f"maven-compiler-plugin:3.13.0:testCompile (default-testCompile) on "
                f"project {self.artifact}: Compilation failure",
                f"[ERROR] {cause}",
                "[ERROR]   symbol:   variable undefinedValue",
                "[ERROR]   location: class live.FooTest",
                "[ERROR] -> [Help 1]"])
        _out(compiling)
        os.makedirs(os.path.join(self.target, "test-classes"), exist_ok=True)

    def _run_classes(self, plugin, entries):
        _out(f"[INFO] Using auto detected provider {PROVIDER}")
        _out("[INFO] ")
        _out(TESTS_RULE)
        _out("[INFO]  T E S T S")
        _out(TESTS_RULE)
        by_class = {}
        for entry in entries:
            cls, method = _split(entry)
            by_class.setdefault(cls, []).append(method)
        for cls, methods in by_class.items():
            _out(f"[INFO] Running {cls}")
            _out(f"[INFO] Tests run: {len(methods)}, Failures: 0, Errors: 0, Skipped: 0, "
                 f"Time elapsed: 0.026 s -- in {cls}")
            _write(os.path.join(self.reports(plugin), f"TEST-{cls}.xml"),
                   _report_xml(plugin, cls, methods))
            _write(os.path.join(self.reports(plugin), f"{cls}.txt"),
                   _report_txt(cls, len(methods)))
        _out("[INFO] ")
        _out("[INFO] Results:")
        _out("[INFO] ")
        _out(f"[INFO] Tests run: {len(entries)}, Failures: 0, Errors: 0, Skipped: 0")
        _out("[INFO] ")
        return len(entries)

    def surefire(self, execution):
        _mojo("surefire", PLUGIN_VERSION, "test", execution, self.artifact)
        if self.inv.flag_on("skipTests") or self.inv.flag_on("maven.test.skip"):
            _out("[INFO] Tests are skipped.")
            return
        spec = self.inv.props.get("test")
        if not self.compiled():
            _out("[INFO] No tests to run.")
            return
        if spec is None:
            chosen = self.tests
        else:
            chosen = _select(spec, self.tests + self.its)
            if not chosen and not self.inv.flag_off("surefire.failIfNoSpecifiedTests"):
                raise _Failure([
                    f"[ERROR] Failed to execute goal org.apache.maven.plugins:"
                    f"maven-surefire-plugin:{PLUGIN_VERSION}:test ({execution}) on "
                    f"project {self.artifact}: No tests matching pattern \"{spec}\" "
                    f"were executed! (Set -Dsurefire.failIfNoSpecifiedTests=false to "
                    f"ignore this error.) -> [Help 1]"])
        if chosen:
            self._run_classes("surefire", chosen)

    def jar(self):
        _mojo("jar", "3.4.2", "jar", "default-jar", self.artifact)
        _out("[WARNING] JAR will be empty - no content was marked for inclusion!")
        jar = os.path.join(self.target, f"{self.artifact}-1.jar")
        _out(f"[INFO] Building jar: {jar}")
        _write(jar, "")

    def failsafe_integration_test(self, execution):
        _mojo("failsafe", PLUGIN_VERSION, "integration-test", execution, self.artifact)
        if self.inv.flag_on("skipTests") or self.inv.flag_on("skipITs"):
            _out("[INFO] Tests are skipped.")
            return
        if not self.compiled():
            return
        spec = self.inv.props.get("it.test")
        chosen = self.its if spec is None else _select(spec, self.its + self.tests)
        if spec is not None and not chosen \
                and not self.inv.flag_off("failsafe.failIfNoSpecifiedTests"):
            raise _Failure([
                f"[ERROR] Failed to execute goal org.apache.maven.plugins:"
                f"maven-failsafe-plugin:{PLUGIN_VERSION}:integration-test ({execution}) "
                f"on project {self.artifact}: No tests matching pattern \"{spec}\" "
                f"were executed! (Set -Dfailsafe.failIfNoSpecifiedTests=false to "
                f"ignore this error.) -> [Help 1]"])
        if chosen:
            count = self._run_classes("failsafe", chosen)
            _write(os.path.join(self.reports("failsafe"), "failsafe-summary.xml"),
                   _summary_xml(count))

    def failsafe_verify(self, execution):
        _mojo("failsafe", PLUGIN_VERSION, "verify", execution, self.artifact)
        if self.inv.flag_on("skipTests") or self.inv.flag_on("skipITs"):
            _out("[INFO] Tests are skipped.")
            return
        if not os.path.isfile(os.path.join(self.reports("failsafe"),
                                           "failsafe-summary.xml")):
            _out("[INFO] No tests to run.")

    def phase(self, name):
        upto = LIFECYCLE.index(name)

        def reached(phase):
            return upto >= LIFECYCLE.index(phase)

        if reached("test-compile"):
            self.test_compile()
        elif reached("process-resources"):
            _mojo("resources", "3.3.1", "resources", "default-resources", self.artifact)
        if reached("test"):
            self.surefire("default-test")
        if reached("package"):
            self.jar()
        if reached("integration-test") and self.failsafe:
            self.failsafe_integration_test("default")
        if reached("verify") and self.failsafe:
            self.failsafe_verify("default")

    def goal(self, goal):
        if goal == "clean":
            self.clean()
        elif goal in LIFECYCLE:
            self.phase(goal)
        elif goal == "failsafe:integration-test":
            self.failsafe_integration_test("default-cli")
        elif goal == "failsafe:verify":
            self.failsafe_verify("default-cli")
        elif goal == "surefire:test":
            self.surefire("default-cli")
        else:
            raise _Failure([f"[ERROR] Unknown lifecycle phase \"{goal}\". You must "
                            f"specify a valid lifecycle phase or a goal. -> [Help 1]"])


def _active_profiles(model, inv):
    declared = {p.get("id"): p for p in model.get("profiles") or []}
    warnings, active = [], []
    for wanted in inv.profiles:
        if wanted.startswith(("!", "-")):
            continue
        if wanted in declared:
            active.append(declared[wanted])
        else:
            warnings.append(f"[WARNING] The requested profile \"{wanted}\" could not "
                            f"be activated because it does not exist.")
    if not inv.profiles:
        active = [p for p in declared.values() if p.get("activeByDefault")]
    return active, warnings


def _finish(ok, warnings, failure_lines=()):
    _out(RULE)
    _out(f"[INFO] BUILD {'SUCCESS' if ok else 'FAILURE'}")
    _out(RULE)
    _out("[INFO] Total time:  0.680 s")
    stamp = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    _out(f"[INFO] Finished at: {stamp}")
    _out(RULE)
    for line in warnings:
        _out(line)
    if not ok:
        for line in failure_lines:
            _out(line)
        _out("[ERROR] ")
        _out("[ERROR] To see the full stack trace of the errors, re-run Maven with the "
             "-e switch.")
        _out("[ERROR] Re-run Maven using the -X switch to enable full debug logging.")
        _out("[ERROR] ")
        _out("[ERROR] For more information about the errors and possible solutions, "
             "please read the following articles:")
        _out("[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/"
             "MojoFailureException")


def _record(argv):
    calls = os.environ.get("FAKE_MVN_CALLS")
    if calls:
        with open(calls, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"argv": list(argv), "cwd": os.getcwd()}) + "\n")


def main(argv):
    _record(argv)
    with open(os.environ["FAKE_MVN_PROJECT"], encoding="utf-8") as handle:
        model = json.load(handle)
    inv = _Invocation(argv)
    active, warnings = _active_profiles(model, inv)
    bound = any(p.get("failsafe") for p in active)
    _out("[INFO] Scanning for projects...")
    for line in warnings:
        _out(line)
    modules = [_Module(model, spec, inv, bound) for spec in model.get("modules") or []]
    if inv.projects:
        known = {m.name for m in modules}
        missing = [p for p in inv.projects if p not in known]
        if missing:
            _out(f"[ERROR] Could not find the selected project in the reactor: "
                 f"{missing[0]} @ ")
            _out("[ERROR] -> [Help 1]")
            sys.stdout.flush()
            return 1
        modules = [m for m in modules if m.name in inv.projects]
    if not inv.goals:
        _out("[ERROR] No goals have been specified for this build. -> [Help 1]")
        return 1
    try:
        for module in modules:
            title = f" {model.get('group', 'live')}:{module.artifact} "
            _out("[INFO] ")
            left = (72 - len(title) - 2) // 2
            _out("[INFO] " + "-" * left + "<" + title + ">"
                 + "-" * (72 - left - len(title) - 2))
            _out(f"[INFO] Building {module.artifact} 1")
            _out("[INFO]   from pom.xml")
            _out("[INFO] " + "-" * 32 + "[ jar ]" + "-" * 33)
            for goal in inv.goals:
                module.goal(goal)
    except _Failure as failure:
        _finish(False, warnings, failure.lines)
        sys.stdout.flush()
        return 1
    _finish(True, warnings)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
