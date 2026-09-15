"""CR-CRU-133 (cycle 464) — a declared target is run on its own terms.

`clients/bun-crucible.py`'s `_bun_run_script_cmd` (`:479`) states in its own
docstring that a DECLARED tier target "is run BY NAME (`bun run test:unit`),
never by re-parsing its body … and the client never classifies what the project
declared", and then appends `--reporter=junit --reporter-outfile=<path>` —
flags only `bun test` understands. That IS a classification, and it is why
`bun-crucible.py e2e` cannot ingest: `"test:e2e": "bunx bddgen && bunx
playwright test"` dies on `error: unknown option '--reporter-outfile=…'` while
the suite itself is 46 green.

THE CONTRACT THIS FILE FIXES (ruled for cycle 464 before RED, so GREEN
implements a decision rather than re-deriving one):

  * The report path reaches a declared target by the mechanism its DECLARATION
    names, and by nothing else. The declaration rides the manifest this stack
    already declares its targets in — `package.json` — beside the script table:

        "crucible": {"reportPath": {"test:e2e": "env:PLAYWRIGHT_JUNIT_OUTPUT_NAME"}}

    `"env:<VAR>"` means the runner reads the path from `<VAR>`. `"flag"` — or
    NO entry at all — is the FLAG default: `bun test`'s own
    `--reporter=junit --reporter-outfile=<path>` convention, which is every
    target this project declares today except `test:e2e`. The default is what
    makes AC4 satisfiable with no edit to any declaration that exists today
    (§S2's own sentence); the explicit opt-in is what makes §S1 true for a
    runner that is not `bun test`.
  * Under the ENV mechanism the invocation carries NO bun flag at all —
    reporter AND coverage — because both are `bun test`'s flags, not the
    target's. A target that rejects an unknown option (playwright does) is the
    case the CR was cut for.
  * §S3's richer starvation message rides the EXISTING additive keywords of
    the SHARED `no_report_help(verb, artifact, remedy=None)` /
    `no_report_warning(verb, artifact, exit_code, output, cause=None)`
    (`clients/_crucible_axi.py:1365,1384`, 12 call sites across five clients).
    Neither helper's required-parameter shape may change, and this client may
    not grow a local copy — `tests/client/test_cr054_drift_guard.py` guards
    that, and nothing here relaxes it.

HOW THE INVOCATION IS MEASURED, and why not by monkeypatching
`subprocess.run`: both runners are tiny fake EXECUTABLES that append their own
`argv`, `cwd` and the report-carrying slice of their ENVIRONMENT to
`$CR133_ARGV_LOG` before doing anything. The record is therefore what the
operating system was actually asked to run, and the environment it was actually
handed — the two halves AC3 is about. The fake `bun` is FAITHFUL to `bun run`
(it executes the declared script's OWN body with the extra arguments appended,
resolving a leading `bun` to itself), adopted from
`tests/client/test_gate_multi_suite_coverage.py`'s fake for the same reason it
was written there: a fake that only recorded its argv would make a run
dispatched THROUGH a declared script invisible, and the fixture would then
decide the finding. The fake e2e runner is faithful to playwright in the one
way this CR turns on: it REJECTS an option it does not know, and it takes its
JUnit path from `PLAYWRIGHT_JUNIT_OUTPUT_NAME`.

No request leaves the process (the client's `_post`/`_get`/`_patch` seam is
recorded, so the live board on :3849 is never touched) and no real bun,
playwright or bun package is needed anywhere on the machine.

WHAT IS RED HERE AND WHAT IS A PIN, stated per test, because a suite that does
not say which of its members were born green is a suite whose colour means
nothing. Measured on `feature/CR-CRU-133` @ `b68270f`:

  AC1  RED  `DeclaredE2eTargetIngestsTest` — all four. Today the e2e verb
            appends `--reporter-outfile=` to a playwright target, the runner
            exits 1 on the unknown option, nothing is written and nothing is
            ingested; and this project's own manifest declares no report
            mechanism for `test:e2e` while its playwright config hardcodes an
            output file no declaration can move.
  AC2  RED  `DeclaredInvocationCarriesNoRunnerSpecificFlagTest` — the
            construction scan: `_bun_run_script_cmd` types four `bun test`
            flag literals into the body (and promises them in its docstring),
            so the NEXT runner-specific assumption fails here rather than at a
            verb.
  AC3  RED  `ReportMechanismFollowsTheDeclarationTest` — the ENV half and the
            one-builder-for-both half. The FLAG half
            (`…_a_flag_declared_target_…`) is a PIN: a target that declares
            the default mechanism explicitly must keep receiving the flags.
  AC4  PIN  `DeclaredBunTestTargetsKeepWorkingTest` — all three, by nature:
            AC4 says the targets that work today keep working. They are the
            bound that stops §S1's fix from levelling the mechanism as it
            levels the assumption, and they enumerate the REAL manifest so a
            target added later is covered without editing this file.
  AC5  RED  `NoReportNamesTheTargetTest` — today's envelope names neither the
            script, nor the command, nor the path it expected.
  AC6  RED  `InvocationIsClassifiedOnlyByItsDeclarationTest` — both. Today the
            invocation is a function of an ASSUMED runner: two targets with
            opposite declarations are invoked identically.

Invocation (the convention every tests/client/ harness follows):
    python3 clients/python-crucible.py regression --start-dir tests/client
Fallback:
    python3 -m unittest tests.client.test_declared_target_report_mechanism
"""

import contextlib
import copy
import importlib.util
import inspect
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"
AXI_PATH = REPO_ROOT / "clients" / "_crucible_axi.py"
MANIFEST_PATH = REPO_ROOT / "package.json"
PLAYWRIGHT_CONFIG_PATH = REPO_ROOT / "playwright.config.ts"

AGENT = "cr133-declared-target-probe"
PROJECT_KEY = "cr133-declared-target-key"

# The CR's own measurement: `bun run test:e2e` with `PLAYWRIGHT_JUNIT_OUTPUT_NAME`
# is "46 passed in 1.1 m". AC1 asks for an ingest "whose count matches an
# independently-measured run", so the fixture suite is that size and the
# assertion compares the INGESTED count against the report the runner actually
# wrote — counted here, from the file, rather than trusted from the constant.
E2E_TEST_COUNT = 46

# The one environment variable playwright takes its JUnit path from, and the
# declaration value that names it.
E2E_REPORT_VAR = "PLAYWRIGHT_JUNIT_OUTPUT_NAME"
ENV_MECHANISM = f"env:{E2E_REPORT_VAR}"
FLAG_MECHANISM = "flag"

# Every flag in this set is `bun test`'s own. Appending one to a target whose
# runner is not `bun test` is the defect CR-CRU-133 exists to remove, so the
# set is named ONCE and both the construction scan (AC2) and the invocation
# assertions (AC3/AC6) read it.
BUN_TEST_FLAGS = ("--reporter", "--reporter-outfile", "--coverage",
                  "--coverage-reporter", "--coverage-dir")

_UNREACHABLE_CRUCIBLE_URL = "http://127.0.0.1:1"

_ENV_KEYS = (
    "WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE",
    "AGENT_ID", "CRUCIBLE_URL", "CRUCIBLE_BASE",
    "BUN_CRUCIBLE_PROJECT_DIR", "BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_BUN",
    "BUN_CRUCIBLE_NO_LIFECYCLE",
    "FAKE_BUN_JUNIT_CONTENT", "FAKE_BUN_EXIT_CODE",
    "FAKE_E2E_JUNIT_CONTENT", "FAKE_E2E_EXIT_CODE",
    "CR133_ARGV_LOG", E2E_REPORT_VAR,
)

# A server answer rich enough for BOTH ingest shapes this client uses.
_OK_RESPONSE = {"ok": True,
                "run": {"passed": 1, "failed": 0, "pending": 0, "total": 1}}

_INGEST = "/api/v2/runs/parsed"


# ── fixtures: the two runners ──────────────────────────────────────────────

# Shared head: every fake records what it was asked to run BEFORE it decides
# anything, so a refusal is as visible as a run.
_RECORD_HEAD = """#!__PYTHON__
import json
import os
import sys

argv = sys.argv[1:]
_log = os.environ.get("CR133_ARGV_LOG")
if _log:
    _seen = dict((k, v) for k, v in os.environ.items()
                 if k.startswith(("PLAYWRIGHT_", "CRUCIBLE_", "BUN_", "JUNIT"))
                 or "REPORT" in k)
    with open(_log, "a") as _handle:
        _handle.write(json.dumps({"tool": "__TOOL__", "argv": argv,
                                  "cwd": os.getcwd(), "env": _seen}) + "\\n")
"""

# A FAITHFUL fake `bun`: `bun run <script> [args]` executes the DECLARED
# script's own body with the extra arguments appended (which is how a declared
# target receives anything the client appends), and a leading `bun` inside that
# body resolves to this same fake. `bun test …` writes FAKE_BUN_JUNIT_CONTENT
# to whatever `--reporter-outfile=` it was given — the flag contract itself.
_FAKE_BUN_TAIL = """
import shlex
import subprocess

if argv[:1] == ["run"] and len(argv) > 1:
    try:
        with open(os.path.join(os.getcwd(), "package.json")) as handle:
            scripts = (json.load(handle) or {}).get("scripts") or {}
    except OSError:
        scripts = {}
    body = scripts.get(argv[1])
    if body is None:
        sys.stderr.write("error: Script not found %s\\n" % argv[1])
        sys.exit(1)
    command = " ".join([body] + [shlex.quote(a) for a in argv[2:]])
    if command.startswith("bun "):
        command = shlex.quote(sys.argv[0]) + command[3:]
    sys.exit(subprocess.run(command, shell=True, cwd=os.getcwd()).returncode)

outfile = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        outfile = arg.split("=", 1)[1]
content = os.environ.get("FAKE_BUN_JUNIT_CONTENT", "")
if outfile and content:
    directory = os.path.dirname(outfile)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(outfile, "w") as handle:
        handle.write(content)
sys.exit(int(os.environ.get("FAKE_BUN_EXIT_CODE", "0")))
"""

# A fake playwright, faithful in the two ways this CR turns on: it REFUSES an
# option it does not know (`error: unknown option '…'`, exit 1 — the measured
# behaviour quoted in the CR's Problem section) and it takes its JUnit output
# path from PLAYWRIGHT_JUNIT_OUTPUT_NAME, never from a flag.
_FAKE_E2E_TAIL = """
known = ("--config", "--project", "--workers")
for arg in argv:
    if arg.startswith("--") and arg.split("=", 1)[0] not in known:
        sys.stderr.write("error: unknown option '%s'\\n" % arg)
        sys.exit(1)

outfile = os.environ.get("PLAYWRIGHT_JUNIT_OUTPUT_NAME")
content = os.environ.get("FAKE_E2E_JUNIT_CONTENT", "")
if outfile and content:
    directory = os.path.dirname(outfile)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(outfile, "w") as handle:
        handle.write(content)
sys.exit(int(os.environ.get("FAKE_E2E_EXIT_CODE", "0")))
"""


def _junit_xml(suite, count, prefix):
    """A JUnit report of `count` passing cases — the shape both fakes write."""
    cases = "\n".join(
        f'<testcase name="{prefix} {index}" classname="{suite}" '
        f'file="tests/{suite}" time="0.010"></testcase>'
        for index in range(1, count + 1))
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<testsuites>\n<testsuite name="{suite}" tests="{count}" '
            f'failures="0">\n{cases}\n</testsuite>\n</testsuites>\n')


E2E_JUNIT_XML = _junit_xml("e2e.feature", E2E_TEST_COUNT, "a user")
UNIT_JUNIT_XML = _junit_xml("unit.test.ts", 3, "a unit")


# ── the harness ────────────────────────────────────────────────────────────

_LOADS = {"n": 0}


def _load_client():
    """Load `clients/bun-crucible.py` by file path (a hyphenated filename cannot
    be imported), fresh per test, pointed at the REPO copy — the source of
    truth (CR-CRU-008 Risk section), never the deployed mirror."""
    if not CLIENT_PATH.exists():
        raise unittest.SkipTest(f"{CLIENT_PATH} not found")
    _LOADS["n"] += 1
    spec = importlib.util.spec_from_file_location(
        f"cr133_bun_client_{_LOADS['n']}", CLIENT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Drive:
    """One real `main()` dispatch: its exit code, both streams, every
    `(path, payload)` handed to the client's ONE HTTP seam, and every command
    the declared-target invocation BUILDER returned during it."""

    def __init__(self, code, out, err, calls, built):
        self.code, self.out, self.err = code, out, err
        self.calls, self.built = calls, built

    def payloads(self, endpoint=_INGEST):
        return [payload for path, payload in self.calls if path == endpoint]

    def paths(self):
        return [path for path, _payload in self.calls]

    @property
    def document(self):
        """The AXI envelope as one whitespace-normalised line: the machine
        channel is stdout, and a needle must be found there rather than in the
        human stderr echo — which already prints the command today and would
        make AC5 pass vacuously."""
        return " ".join(self.out.split())


class _DeclaredTargetCase(unittest.TestCase):
    """A throwaway project that DECLARES targets, two fake runners on disk, and
    the client's HTTP seam recorded."""

    def setUp(self):
        self.module = _load_client()
        self.tmpdir = tempfile.mkdtemp(prefix="cr133-declared-")
        self.project = Path(self.tmpdir)
        (self.project / ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n"
            "CRUCIBLE_PROJECT_NAME=cr133-declared-target-project\n")
        self.argv_log = str(self.project / "argv.jsonl")

        self.fake_bun = self._write_fake("fake-bun", _FAKE_BUN_TAIL)
        self.fake_e2e = self._write_fake("fake-playwright", _FAKE_E2E_TAIL)

        self._saved_env = {key: os.environ.get(key) for key in _ENV_KEYS}
        for key in _ENV_KEYS:
            os.environ.pop(key, None)
        os.environ["CRUCIBLE_URL"] = _UNREACHABLE_CRUCIBLE_URL
        os.environ["CRUCIBLE_BASE"] = _UNREACHABLE_CRUCIBLE_URL
        os.environ["CR133_ARGV_LOG"] = self.argv_log

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # ── fixture construction ───────────────────────────────────────────────

    def _write_fake(self, name, tail):
        path = self.project / name
        path.write_text(_RECORD_HEAD.replace("__PYTHON__", sys.executable)
                        .replace("__TOOL__", name) + tail)
        path.chmod(0o755)
        return str(path)

    def declare(self, scripts, report_path=None, project=None):
        """Write the manifest: the script table, and — only when the fixture
        says so — the `crucible.reportPath` declaration beside it. A fixture
        that declares NO mechanism is the AC4 case and must keep working."""
        root = Path(project or self.project)
        manifest = {"name": "cr133-fixture", "scripts": dict(scripts)}
        if report_path:
            manifest["crucible"] = {"reportPath": dict(report_path)}
        (root / "package.json").write_text(json.dumps(manifest, indent=2))
        return root

    def e2e_body(self):
        """A declared target whose runner is NOT `bun test` — the CR's case."""
        return f"{self.fake_e2e} test"

    def bun_body(self, paths="tests/unit"):
        return f"bun test {paths}"

    def junit_path(self, project=None):
        return str(Path(project or self.project) / "test-reports" / "junit.xml")

    # ── driving ────────────────────────────────────────────────────────────

    def drive(self, verb, project=None, extra=()):
        root = str(project or self.project)
        argv = [verb, "--agent", AGENT, "--project-dir", root,
                "--package-dir", root, "--bun", self.fake_bun, *extra]
        calls, built = [], []

        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            return copy.deepcopy(_OK_RESPONSE)

        real_builder = self.module._bun_run_script_cmd

        def recording_builder(*args, **kwargs):
            result = real_builder(*args, **kwargs)
            built.append(result)
            return result

        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(self.module, "_post", side_effect=fake_post,
                               create=True), \
                mock.patch.object(self.module, "_get", return_value=None,
                                  create=True), \
                mock.patch.object(self.module, "_patch",
                                  return_value={"ok": True}, create=True), \
                mock.patch.object(self.module, "_bun_run_script_cmd",
                                  side_effect=recording_builder), \
                mock.patch.object(sys, "argv", ["bun-crucible.py"] + argv), \
                contextlib.redirect_stdout(stdout), \
                contextlib.redirect_stderr(stderr):
            try:
                self.module.main()
                code = 0
            except SystemExit as exc:
                code = (exc.code if isinstance(exc.code, int)
                        else (0 if exc.code is None else 1))
        return _Drive(code, stdout.getvalue(), stderr.getvalue(), calls, built)

    # ── measurement ────────────────────────────────────────────────────────

    def invocations(self, tool=None):
        """What the operating system was actually asked to run."""
        if not os.path.exists(self.argv_log):
            return []
        records = [json.loads(line) for line in
                   Path(self.argv_log).read_text().splitlines() if line.strip()]
        return [r for r in records if tool is None or r["tool"] == tool]

    def flags_seen_by(self, tool):
        return [arg for record in self.invocations(tool) for arg in record["argv"]
                if arg.startswith("-")]

    def assertIngested(self, drive, tier, site):
        payloads = drive.payloads()
        self.assertTrue(
            payloads,
            f"{site}: the drive POSTed nothing to {_INGEST}, so this test "
            f"measured nothing. paths={drive.paths()!r} exit={drive.code} "
            f"stderr={drive.err[-2000:]!r}")
        payload = payloads[0]
        self.assertEqual(payload.get("agentId"), AGENT,
                         f"{site}: the first POST to {_INGEST} is not this "
                         f"run's ingest body: {payload!r}")
        self.assertEqual(
            payload.get("tier"), tier,
            f"{site}: the tier a run reports is the VERB's; the ingest body "
            f"carried tier={payload.get('tier')!r}, expected {tier!r}.")
        return payload

    def assertNoBunFlag(self, args, site):
        offenders = [arg for arg in args
                     if any(arg.split("=", 1)[0] == flag for flag in BUN_TEST_FLAGS)]
        self.assertEqual(
            offenders, [],
            f"§S1 — {site}: a declared target is run on its OWN terms, so the "
            f"client may append no flag its runner never agreed to accept; it "
            f"appended {offenders!r}. Seen: {args!r}")


# ── AC1 — the e2e target ingests ───────────────────────────────────────────

class DeclaredE2eTargetIngestsTest(_DeclaredTargetCase):
    """AC1 — "`e2e` ingests. The 46 e2e tests reach the board with `tier: e2e`,
    asserted by an ingest whose count matches an independently-measured run."

    ALL RED. Today the verb appends `--reporter-outfile=` to a runner that has
    never heard of it, the runner refuses, and nothing reaches the board."""

    def setUp(self):
        super().setUp()
        self.declare({"test:e2e": self.e2e_body()},
                     report_path={"test:e2e": ENV_MECHANISM})
        os.environ["FAKE_E2E_JUNIT_CONTENT"] = E2E_JUNIT_XML

    def test_the_declared_e2e_target_ingests_every_test_its_runner_ran(self):
        drive = self.drive("e2e")
        payload = self.assertIngested(drive, "e2e", "AC1")

        report = Path(self.junit_path())
        self.assertTrue(
            report.exists(),
            "AC1: the declared e2e runner wrote no report at "
            f"{report} — stderr={drive.err[-2000:]!r}")
        # The independent measurement: the report the RUNNER wrote, counted
        # here rather than trusted from a constant, and the constant asserted
        # against it so a fixture that silently shrank cannot pass.
        measured = len(ET.parse(str(report)).getroot().findall(".//testcase"))
        self.assertEqual(measured, E2E_TEST_COUNT,
                         "AC1: the fixture suite is no longer the measured "
                         f"size ({measured} cases).")
        summary = payload.get("summary") or {}
        self.assertEqual(summary.get("total"), measured,
                         f"AC1: the ingest must carry every test the run "
                         f"produced; summary={summary!r}")
        self.assertEqual(summary.get("passed"), measured,
                         f"AC1: a green e2e run ingests green; summary={summary!r}")
        self.assertEqual(summary.get("failed"), 0,
                         f"AC1: summary={summary!r}")
        self.assertEqual(drive.code, 0,
                         f"AC1: a green ingested run exits 0; "
                         f"stdout={drive.document[-1500:]!r}")

    def test_the_e2e_runner_is_never_handed_an_option_it_rejects(self):
        """AC1's cause, asserted at the runner: the measured failure was
        `error: unknown option '--reporter-outfile=…'`, and the fake refuses
        exactly as playwright did."""
        drive = self.drive("e2e")
        runs = self.invocations("fake-playwright")
        self.assertEqual(
            len(runs), 1,
            f"AC1: the declared e2e target must run exactly once; ran {len(runs)} "
            f"time(s). stderr={drive.err[-2000:]!r}")
        self.assertNoBunFlag(runs[0]["argv"], "AC1")
        self.assertNotIn(
            "unknown option", drive.err,
            "AC1: the runner refused an option the client invented for it.")

    def test_this_project_declares_the_report_mechanism_its_e2e_runner_uses(self):
        """AC1 against the REAL manifest: a fixture proves the code path, and
        this proves THIS project's own e2e verb is the one that ingests. The
        declaration is the project's statement of its target's contract."""
        manifest = json.loads(MANIFEST_PATH.read_text())
        self.assertIn("test:e2e", manifest.get("scripts") or {},
                      "AC1: this project no longer declares test:e2e.")
        declared = ((manifest.get("crucible") or {}).get("reportPath") or {})
        self.assertEqual(
            declared.get("test:e2e"), ENV_MECHANISM,
            "§S2 — playwright takes its JUnit path from "
            f"{E2E_REPORT_VAR}, not a flag, so this project must DECLARE that "
            f"mechanism for test:e2e; it declares {declared.get('test:e2e')!r}.")

    def test_the_e2e_runner_honours_the_mechanism_this_project_declared(self):
        """The round trip: a declaration the TARGET ignores is not a contract.
        This project's playwright config hardcodes
        `outputFile: "test-reports/junit.xml"`, and playwright's junit reporter
        prefers an explicit `outputFile` over the environment variable — so the
        declared mechanism is inert until the config reads it."""
        if not PLAYWRIGHT_CONFIG_PATH.exists():
            self.skipTest("no playwright config in this project")
        config = PLAYWRIGHT_CONFIG_PATH.read_text()
        self.assertIn(
            E2E_REPORT_VAR, config,
            "AC1/§S2 — this project declares its e2e report path is taken by "
            f"{E2E_REPORT_VAR}, but the playwright config never reads it, so "
            "the client's `--reports` can never move the file the suite "
            "writes and the declaration states something untrue.")


# ── AC2 — asserted by construction ─────────────────────────────────────────

class DeclaredInvocationCarriesNoRunnerSpecificFlagTest(unittest.TestCase):
    """AC2 — "`_bun_run_script_cmd` appends no runner-specific flag to a
    declared target — asserted by CONSTRUCTION, so the next runner-specific
    assumption fails at the scan rather than at a verb."

    RED. The function types four `bun test` flag literals into its body and
    promises them in its docstring. After GREEN the flag text belongs to the
    FLAG MECHANISM — named once, beside the mechanism vocabulary — and this
    function composes whatever the declaration selected, so typing the next
    runner's flag here fails HERE."""

    def setUp(self):
        self.module = _load_client()

    def test_the_declared_target_builder_names_no_bun_test_flag_of_its_own(self):
        builder = getattr(self.module, "_bun_run_script_cmd", None)
        self.assertIsNotNone(
            builder,
            "AC2: `_bun_run_script_cmd` is the one function this CR fixes and "
            "its single caller is `cmd_regression`; it must still exist.")
        source = inspect.getsource(builder)
        offenders = sorted({flag for flag in BUN_TEST_FLAGS if flag in source})
        self.assertEqual(
            offenders, [],
            "AC2 — the invocation of a DECLARED target must name no runner's "
            "flags, in its code or in its docstring: how the target is told "
            "where to write its report is the DECLARATION's business, and the "
            f"flag text belongs to the flag mechanism. Found {offenders} in "
            "`_bun_run_script_cmd`.")

    def test_the_shared_no_report_helpers_keep_the_shape_four_clients_call(self):
        """§S3's bound, by construction: the richer message rides the ADDITIVE
        `remedy=`/`cause=` keywords CR-CRU-064/065 already added, so the twelve
        call sites across five clients keep compiling. A RED that let GREEN
        re-shape a shared helper would break arduino, mvn, python and rust."""
        axi = importlib.util.module_from_spec(
            importlib.util.spec_from_file_location("cr133_axi_shape", AXI_PATH))
        axi.__loader__.exec_module(axi)
        self.assertEqual(
            [p.name for p in inspect.signature(axi.no_report_help).parameters.values()],
            ["verb", "artifact", "remedy"],
            "§S3: `no_report_help`'s required shape is shared by five clients.")
        self.assertEqual(
            [p.name for p in inspect.signature(axi.no_report_warning).parameters.values()],
            ["verb", "artifact", "exit_code", "output", "cause"],
            "§S3: `no_report_warning`'s required shape is shared by five clients.")


# ── AC3 — both mechanisms, one code path ───────────────────────────────────

class ReportMechanismFollowsTheDeclarationTest(_DeclaredTargetCase):
    """AC3 — "A declared target whose runner takes its report path by
    ENVIRONMENT is ingested, and one that takes it by FLAG is ingested, through
    the same code path — both asserted."""

    def test_an_environment_declared_target_is_handed_its_path_by_environment(self):
        """RED — the ENV half. The runner is told WHERE to write by the variable
        its declaration named, and by nothing else."""
        self.declare({"test:e2e": self.e2e_body()},
                     report_path={"test:e2e": ENV_MECHANISM})
        os.environ["FAKE_E2E_JUNIT_CONTENT"] = E2E_JUNIT_XML

        drive = self.drive("e2e")

        runs = self.invocations("fake-playwright")
        self.assertEqual(len(runs), 1,
                         f"AC3(env): the target ran {len(runs)} time(s). "
                         f"stderr={drive.err[-2000:]!r}")
        self.assertEqual(
            runs[0]["env"].get(E2E_REPORT_VAR), self.junit_path(),
            f"AC3(env): the runner must receive the report path in "
            f"{E2E_REPORT_VAR} — the mechanism its declaration names. It saw "
            f"{runs[0]['env'].get(E2E_REPORT_VAR)!r}.")
        self.assertNoBunFlag(runs[0]["argv"], "AC3(env)")
        self.assertIngested(drive, "e2e", "AC3(env)")

    def test_an_environment_declared_target_is_handed_no_coverage_flag_either(self):
        """RED — the bound on the ENV half: `--coverage` is `bun test`'s flag
        exactly as `--reporter` is, so `--coverage` on the verb may not smuggle
        one back in. A fix that only removed the reporter pair passes the test
        above and fails this one."""
        self.declare({"test:e2e": self.e2e_body()},
                     report_path={"test:e2e": ENV_MECHANISM})
        os.environ["FAKE_E2E_JUNIT_CONTENT"] = E2E_JUNIT_XML

        drive = self.drive("e2e", extra=["--coverage"])

        runs = self.invocations("fake-playwright")
        self.assertEqual(len(runs), 1,
                         f"AC3(env): the target ran {len(runs)} time(s). "
                         f"stderr={drive.err[-2000:]!r}")
        self.assertNoBunFlag(runs[0]["argv"], "AC3(env,--coverage)")
        self.assertIngested(drive, "e2e", "AC3(env,--coverage)")

    def test_a_flag_declared_target_is_handed_its_path_by_flag(self):
        """PIN — the FLAG half. A target that declares the default mechanism
        EXPLICITLY must receive exactly what an undeclared one receives; this is
        the bound that stops §S1's fix from stripping the flags wholesale."""
        self.declare({"test:unit": self.bun_body()},
                     report_path={"test:unit": FLAG_MECHANISM})
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = UNIT_JUNIT_XML

        drive = self.drive("unit")

        self.assertIn(
            f"--reporter-outfile={self.junit_path()}", self.flags_seen_by("fake-bun"),
            f"AC3(flag): a target declaring the FLAG mechanism must be handed "
            f"the path as `bun test`'s own flag. Seen: "
            f"{self.flags_seen_by('fake-bun')!r}")
        payload = self.assertIngested(drive, "unit", "AC3(flag)")
        self.assertEqual((payload.get("summary") or {}).get("total"), 3,
                         f"AC3(flag): summary={payload.get('summary')!r}")

    def test_both_mechanisms_reach_the_board_through_the_one_builder(self):
        """RED — "through the same code path", asserted rather than assumed: one
        project declares BOTH targets, each verb ingests, and each run was built
        by the SAME `_bun_run_script_cmd`. A second, playwright-shaped
        invocation path bolted on beside it would ingest and fail here."""
        self.declare({"test:unit": self.bun_body(),
                      "test:e2e": self.e2e_body()},
                     report_path={"test:e2e": ENV_MECHANISM})
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = UNIT_JUNIT_XML
        os.environ["FAKE_E2E_JUNIT_CONTENT"] = E2E_JUNIT_XML

        flag_drive = self.drive("unit")
        env_drive = self.drive("e2e")

        self.assertEqual((self.assertIngested(flag_drive, "unit", "AC3")
                          .get("summary") or {}).get("total"), 3)
        self.assertEqual((self.assertIngested(env_drive, "e2e", "AC3")
                          .get("summary") or {}).get("total"), E2E_TEST_COUNT)
        for label, drive in (("flag", flag_drive), ("env", env_drive)):
            self.assertEqual(
                len(drive.built), 1,
                f"AC3: the {label} run must be built by the one declared-target "
                f"builder `_bun_run_script_cmd`; it called it "
                f"{len(drive.built)} time(s).")


# ── AC4 — the targets that work today keep working ─────────────────────────

def _declared_test_targets():
    """Every target THIS project declares today, read from the real manifest —
    AC4 is about the targets that exist, so the list is the project's and never
    one this file keeps. `test:` is the head `_read_declared_suites` itself
    uses."""
    scripts = (json.loads(MANIFEST_PATH.read_text()).get("scripts") or {})
    return {name: body for name, body in scripts.items()
            if name.startswith("test:")}


class DeclaredBunTestTargetsKeepWorkingTest(_DeclaredTargetCase):
    """AC4 — "The `bun test` targets keep working unchanged, asserted per
    declared target that exists today."

    PINs by nature — AC4 names what must NOT change. They are the bound on §S1:
    a fix that made every declared target env-driven would ingest e2e and break
    the four targets the project runs every day."""

    def test_every_declared_tier_target_still_ingests_by_the_flag_default(self):
        targets = _declared_test_targets()
        self.assertTrue(targets, "AC4: this project declares no test targets.")
        tiers = {name.split(":", 1)[1] for name in targets} & {
            "unit", "module", "integration", "e2e", "regression", "bdd"}
        driven = sorted(tiers - {"e2e"})
        self.assertTrue(
            driven,
            f"AC4: no declared tier target to drive; declared={sorted(targets)}")
        for tier in driven:
            with self.subTest(target=f"test:{tier}"):
                project = Path(tempfile.mkdtemp(prefix=f"cr133-ac4-{tier}-",
                                                dir=self.tmpdir))
                (project / ".env").write_text(
                    f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
                # Declared with NO report-path entry — the state every one of
                # these targets is in today, which §S2 says must keep meaning
                # the FLAG contract.
                self.declare({f"test:{tier}": self.bun_body(f"tests/{tier}")},
                             project=project)
                os.environ["FAKE_BUN_JUNIT_CONTENT"] = UNIT_JUNIT_XML

                drive = self.drive(tier, project=project)

                self.assertIn(
                    f"--reporter-outfile={self.junit_path(project)}",
                    self.flags_seen_by("fake-bun"),
                    f"AC4: `test:{tier}` declares no mechanism, so it keeps "
                    f"`bun test`'s flag contract. Seen: "
                    f"{self.flags_seen_by('fake-bun')!r}")
                payload = self.assertIngested(drive, tier, f"AC4(test:{tier})")
                self.assertEqual(
                    (payload.get("summary") or {}).get("total"), 3,
                    f"AC4: summary={payload.get('summary')!r}")
                self.assertEqual(drive.code, 0, f"AC4: exit={drive.code}")

    def test_no_bun_test_target_this_project_declares_needs_a_declaration(self):
        """§S2's own promise, asserted against the real manifest: only a target
        whose runner is not `bun test` opts in, so GREEN may not pay for e2e by
        editing every other entry."""
        declared = ((json.loads(MANIFEST_PATH.read_text()).get("crucible") or {})
                    .get("reportPath") or {})
        needless = sorted(name for name in _declared_test_targets()
                          if name != "test:e2e" and name in declared)
        self.assertEqual(
            needless, [],
            "AC4/§S2: a `bun test` target's declaration is unchanged by this "
            f"CR — these grew a report-path entry they do not need: {needless}")

    def test_a_declared_target_another_stack_owns_is_still_that_stacks_to_run(self):
        """AC4's other half: `test:client` is a python suite living in bun's
        script table (CR-CRU-112 §S1). The FLAG default must not quietly claim
        it — the declaring STACK decides who runs it, and bun never appends
        `bun test` flags to somebody else's runner."""
        targets = _declared_test_targets()
        foreign = {name: body for name, body in targets.items()
                   if self.module._axi().declaring_stack(body) != "bun"}
        self.assertTrue(
            foreign,
            "AC4: this project no longer declares a suite another stack owns, "
            f"so this bound measures nothing. declared={sorted(targets)}")
        for name, body in sorted(foreign.items()):
            with self.subTest(target=name):
                self.assertNotEqual(
                    self.module._axi().declaring_stack(body), "bun",
                    f"AC4: {name} is owned by the stack its declared command "
                    f"names, not by bun: {body!r}")


# ── AC5 — a starved target names itself ────────────────────────────────────

class NoReportNamesTheTargetTest(_DeclaredTargetCase):
    """AC5 — "A target producing no report names the script, the command and
    the expected path in its error."

    RED. Today the envelope says `the e2e run produced no junit.xml — read the
    e2e runner output on stderr`, which names no target, no command and no
    path: the operator is told a verb failed, never WHICH declared target of
    theirs did or where it was supposed to write."""

    def setUp(self):
        super().setUp()
        # Declared, runs cleanly, writes nothing — the starvation case.
        self.declare({"test:e2e": self.e2e_body()},
                     report_path={"test:e2e": ENV_MECHANISM})
        os.environ.pop("FAKE_E2E_JUNIT_CONTENT", None)

    def test_a_declared_target_that_produced_no_report_names_script_command_path(self):
        drive = self.drive("e2e")
        document = drive.document

        self.assertEqual(drive.code, 1,
                         f"AC5: a starved run fails; stdout={document[-1500:]!r}")
        self.assertIn(
            "test:e2e", document,
            "AC5: the failure must name the SCRIPT that produced nothing — "
            f"the envelope names no target at all: {document[-1500:]!r}")
        self.assertIn(
            "run test:e2e", document,
            "AC5: the failure must name the COMMAND that was run, so the "
            f"operator can type it themselves: {document[-1500:]!r}")
        self.assertIn(
            self.junit_path(), document,
            "AC5: the failure must name the PATH the report was expected at — "
            f"without it nothing says where to look: {document[-1500:]!r}")

    def test_the_starved_envelope_still_carries_the_shared_no_report_contract(self):
        """§S3's bound: richer, not different. The starved exit keeps the
        structured `no-test-reports` warning every client's consumers read, so
        the extra detail is ADDITIVE."""
        drive = self.drive("e2e")
        self.assertIn(
            "no-test-reports", drive.document,
            "§S3: the shared starvation warning code must survive the richer "
            f"message: {drive.document[-1500:]!r}")


# ── AC6 — classified by its declaration, and by nothing else ───────────────

class InvocationIsClassifiedOnlyByItsDeclarationTest(_DeclaredTargetCase):
    """AC6 — "The docstring's claim and the code agree: a test fails if the
    invocation classifies a declared target by anything other than its
    declaration."

    The claim has two directions, and both are asserted: the invocation must
    CHANGE when the declaration changes, and must NOT change when only the
    script BODY does. Today it does neither — it is a constant, derived from an
    assumed runner."""

    def _built_command(self, drive, site):
        self.assertEqual(
            len(drive.built), 1,
            f"AC6 — {site}: exactly one declared-target invocation was expected; "
            f"the builder ran {len(drive.built)} time(s). "
            f"stderr={drive.err[-2000:]!r}")
        return drive.built[0]

    def test_the_same_body_under_two_declarations_is_invoked_two_ways(self):
        """RED — the declaration DECIDES. Two projects, the same script body,
        opposite declarations: today both are invoked identically, because the
        client reads neither."""
        env_project = Path(tempfile.mkdtemp(prefix="cr133-ac6-env-", dir=self.tmpdir))
        flag_project = Path(tempfile.mkdtemp(prefix="cr133-ac6-flag-", dir=self.tmpdir))
        for project in (env_project, flag_project):
            (project / ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        body = self.e2e_body()
        self.declare({"test:e2e": body}, report_path={"test:e2e": ENV_MECHANISM},
                     project=env_project)
        self.declare({"test:e2e": body}, report_path={"test:e2e": FLAG_MECHANISM},
                     project=flag_project)
        os.environ["FAKE_E2E_JUNIT_CONTENT"] = E2E_JUNIT_XML

        # Both invocations are normalised against their OWN project root
        # before they are compared: two fixtures in two tempdirs differ in
        # their paths whatever the client does, and a comparison that let the
        # tempdir name carry the difference would pass today.
        env_built = str(self._built_command(self.drive("e2e", project=env_project),
                                           "env")).replace(str(env_project),
                                                            "<project>")
        flag_built = str(self._built_command(self.drive("e2e", project=flag_project),
                                            "flag")).replace(str(flag_project),
                                                             "<project>")

        self.assertNotEqual(
            env_built, flag_built,
            "AC6: the two targets declare OPPOSITE report mechanisms and the "
            "client built the identical invocation for both — it classified "
            f"them by an assumed runner, not by their declaration: {env_built!r}")
        self.assertNotIn(
            "--reporter-outfile", env_built,
            f"AC6: the env-declared target's invocation carries `bun test`'s "
            f"flag: {env_built!r}")
        self.assertIn(
            "--reporter-outfile", flag_built,
            f"AC6: the flag-declared target's invocation lost its flag: "
            f"{flag_built!r}")

    def test_two_bodies_under_the_same_declaration_are_invoked_identically(self):
        """RED — the converse bound, and the docstring's own claim: a declared
        target is run BY NAME, so what its body happens to say is invisible to
        the client. The two invocations must differ in nothing but the project
        path, and neither may carry a flag the declaration did not ask for."""
        playwright_project = Path(tempfile.mkdtemp(prefix="cr133-ac6-pw-",
                                                   dir=self.tmpdir))
        buntest_project = Path(tempfile.mkdtemp(prefix="cr133-ac6-bt-",
                                                dir=self.tmpdir))
        for project in (playwright_project, buntest_project):
            (project / ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        declaration = {"test:e2e": ENV_MECHANISM}
        self.declare({"test:e2e": self.e2e_body()}, report_path=declaration,
                     project=playwright_project)
        self.declare({"test:e2e": self.bun_body("tests/e2e")},
                     report_path=declaration, project=buntest_project)
        os.environ["FAKE_E2E_JUNIT_CONTENT"] = E2E_JUNIT_XML
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = E2E_JUNIT_XML

        playwright_built = str(self._built_command(
            self.drive("e2e", project=playwright_project), "playwright body"))
        buntest_built = str(self._built_command(
            self.drive("e2e", project=buntest_project), "bun test body"))

        normalised = (playwright_built.replace(str(playwright_project), "<project>"),
                      buntest_built.replace(str(buntest_project), "<project>"))
        self.assertEqual(
            normalised[0], normalised[1],
            "AC6: the two targets declare the SAME mechanism and differ only in "
            "the body the project wrote, which the client never reads — yet it "
            f"built two different invocations: {normalised!r}")
        self.assertNotIn(
            "--reporter", normalised[0],
            f"AC6: an env-declared target takes no reporter flag: {normalised[0]!r}")


if __name__ == "__main__":
    unittest.main()
