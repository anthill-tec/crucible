"""`test` runs through the `package.json` script the project declares.

A project declares `crucible.testScript` in `package.json`, beside
`crucible.reportPath`: a string naming a script of the same file's script
table. With it, every `test` run -- targeted by `--tests` or not, filtered by
`--name` or not -- is `bun run <script>` with the files and the filter passed
on, under the report mechanism `crucible.reportPath.<script>` declares
(including a `crucible.rawReport` declaration), exactly as a tier verb runs a
declared script. A starved script is reported in the tier verbs' own words,
naming the script. The run claims no tier. The envelope's `script` field names
the script the run went through. A declaration that is not a string, names no
script of the table, or names one whose body is empty is refused before
anything is posted to the board: `ok: false`, exit 1, naming the script and
`package.json`.

Three kinds of proof:

* A REAL Vitest project (`tests/fixtures/vitest-project`) whose declared script
  launches Vitest on the Bun runtime and whose `vitest.config.ts` reads its
  JUnit path from the variable its `crucible.reportPath` declares. It is run
  from a scratch copy -- never in the checkout -- whose `node_modules` is a
  directory of links to this repo's installed packages, so no network install
  is needed and Vitest's caches land in the copy.
* A declared `bun test` script under the default `flag` mechanism, on the real
  `bun`, for the name filter.
* The argv and the report routes, with a fake `bun` that records every
  invocation (and only the NAMES of the report variables it was handed).

Every test drives the real `clients/bun-crucible.py` as an OS subprocess. A run
that files evidence files it to a `RecordingBoard` on loopback that the
scratch project's own `crucible.toml` points the client at -- never the live
board, never a URL on the command line.

Invocation:
    python3 -m unittest tests.client.test_bun_declared_test_script_runs_the_projects_runner -v
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    REPO_ROOT,
    RecordingBoard,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
BUN_CLIENT = CLIENTS / "bun-crucible.py"
TIMEOUT = 180
AGENT = "declared-test-script-fixture-agent"
PROJECT_KEY = "declared-test-script-fixture-key"
PARSED_INGEST = "/api/v2/runs/parsed"
RAW_INGEST = "/api/v2/runs"
START = "/api/v2/runs/start"

VITEST_FIXTURE = REPO_ROOT / "tests" / "fixtures" / "vitest-project"
REPO_NODE_MODULES = REPO_ROOT / "node_modules"
VITEST_SCRIPT = "test:vitest"
VITEST_REPORT_VAR = "FIXTURE_JUNIT_PATH"
MIXED_RESULT_FILE = "pass-and-fail.vitest.ts"
RUNTIME_FILE = "runtime.vitest.ts"
NAME_FILTER_FILE = "name-filter.vitest.ts"
PASSING_CASE = "a passing case"
FAILING_CASE = "a deliberately failing case"
RUNTIME_CASE = "vitest runs on the bun runtime"

# The client's own resolution variables: a value inherited from the shell
# running this suite would silently decide the directory or binary under test.
_CLIENT_RESOLUTION_KEYS = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
                           "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
                           VITEST_REPORT_VAR)

ALPHA = "alpha matches the filter"
BETA = "beta stays out of the filter"
# A regular expression with an anchor and a space: it must reach the runner as
# ONE argument, unchanged.
MATCHING_PATTERN = "^alpha match"
NO_MATCH_PATTERN = "zeta-matches-no-test"

BUN_SCRIPT = "test:bun"
_MARK_PRELOAD = "mark-script-ran.ts"
_SCRIPT_RAN_MARKER = "script-ran.marker"

_PAIR_TEST = f'''import {{ expect, test }} from "bun:test";

test("{ALPHA}", () => {{
  expect(1 + 1).toBe(2);
}});

test("{BETA}", () => {{
  expect(2 + 2).toBe(4);
}});
'''

# The report variables the fake `bun` looks for. It records only which of them
# it was handed (names, never values), and writes its report wherever the
# flag or the variable points.
ENV_JUNIT_VAR = "DECLARED_JUNIT_PATH"
RAW_JUNIT_VAR = "RAW_JUNIT_PATH"
RAW_JSON_VAR = "RAW_JSON_PATH"
_WATCHED_VARS = (VITEST_REPORT_VAR, ENV_JUNIT_VAR, RAW_JUNIT_VAR, RAW_JSON_VAR)

_FAKE_BUN_BODY = r'''
import json
import os
import sys

WATCHED = ''' + repr(_WATCHED_VARS) + r'''
JUNIT_VARS = WATCHED[:3]
RAW_VAR = WATCHED[3]

argv = sys.argv[1:]
log = os.environ.get("FAKE_BUN_LOG")
if log:
    handed = sorted(name for name in WATCHED if name in os.environ)
    with open(log, "a") as handle:
        handle.write(json.dumps({"argv": argv, "vars": handed}) + "\n")
if os.environ.get("FAKE_BUN_WRITE") == "none":
    sys.exit(0)

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

junit = None
for name in JUNIT_VARS:
    if name in os.environ:
        junit = os.environ[name]
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
if junit:
    write(junit,
          '<?xml version="1.0" encoding="UTF-8"?><testsuites>'
          '<testsuite name="pair.test.ts" tests="1" failures="0">'
          '<testcase name="fixture_case" file="pair.test.ts" time="0.001">'
          '</testcase></testsuite></testsuites>')
if RAW_VAR in os.environ:
    write(os.environ[RAW_VAR], "{}")
sys.exit(0)
'''


def _client_env(**extra):
    env = scrubbed_env(None, **extra)
    for key in _CLIENT_RESOLUTION_KEYS:
        env.pop(key, None)
    return env


def _write_project_config(project, board_url):
    """The project's own `.env` and `crucible.toml`: the board the client
    files to is named by the project, never by the command line."""
    Path(project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
    Path(project, "crucible.toml").write_text(
        f"[client]\nurl = {json.dumps(board_url)}\n\n"
        "[limits.truncate_field_chars]\nvalue = 4000\n")


def _write_manifest(project, scripts, crucible):
    manifest = {"name": "declared-test-script-fixture", "private": True,
                "scripts": scripts}
    if crucible is not None:
        manifest["crucible"] = crucible
    Path(project, "package.json").write_text(json.dumps(manifest, indent=2))


def _link_repo_node_modules(project):
    """A `node_modules` DIRECTORY of links to this repo's installed packages.

    The scratch copy lives outside the checkout, so the checkout's
    `node_modules` is not one of its ancestors. Linking each package (and
    `.bin`) -- rather than linking `node_modules` itself -- keeps everything
    Vitest writes beside its config (Vite's `.vite-temp`) inside the copy."""
    target = Path(project, "node_modules")
    target.mkdir()
    for entry in REPO_NODE_MODULES.iterdir():
        if entry.name.startswith(".") and entry.name != ".bin":
            continue
        os.symlink(entry, target / entry.name)


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _leaf_statuses(tree):
    return {leaf.get("name"): leaf.get("status")
            for suite in tree or [] for leaf in suite.get("children") or []}


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout!r} "
            f"stderr={result.stderr[-2500:]!r}")


class _BoardCase(unittest.TestCase):
    """A scratch project and a recording board."""

    board: RecordingBoard

    def parsed_ingests(self):
        return [body for path, body in self.board.posts() if path == PARSED_INGEST]

    def only_parsed_ingest(self, result):
        ingests = self.parsed_ingests()
        self.assertEqual(
            len(ingests), 1,
            f"the run must be filed exactly once as a parsed JUnit result; "
            f"{_diagnostics(result)}")
        return ingests[0]

    def envelope_of(self, result):
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(envelope,
                             f"stdout is not one TOON envelope; {_diagnostics(result)}")
        return envelope or {}

    def assert_untiered(self, body):
        self.assertNotIn(
            "tier", body,
            f"a `test` run claims no tier, through a declared script or not; "
            f"body={body!r}")
        starts = [b for p, b in self.board.posts() if p == START]
        self.assertEqual(len(starts), 1, f"posts={self.board.posts()!r}")
        self.assertNotIn("tier", starts[0] or {},
                         f"the opened run claims no tier; start={starts[0]!r}")

    def assert_run_counts(self, envelope, passed, failed, pending):
        run = envelope.get("run") or {}
        self.assertEqual(
            (run.get("passed"), run.get("failed"), run.get("pending")),
            (passed, failed, pending), f"envelope run={run!r}")


# ── The real Vitest project, on the Bun runtime ─────────────────────────────

class _VitestFixtureCase(_BoardCase):
    """A scratch copy of the committed Vitest fixture, the real `bun`, and a
    recording board."""

    def setUp(self):
        self.real_bun = shutil.which("bun")
        self.assertIsNotNone(
            self.real_bun,
            "this proof needs the real `bun` on PATH: Vitest runs on it")
        self.assertTrue(
            (REPO_NODE_MODULES / "vitest" / "package.json").is_file(),
            "this proof needs this repo's dev dependencies installed "
            "(`bun install`): the fixture runs the real Vitest")
        self.assertTrue((VITEST_FIXTURE / "package.json").is_file(),
                        f"the committed Vitest fixture is missing: {VITEST_FIXTURE}")
        self.checkout_fixture_before = sorted(
            p.name for p in VITEST_FIXTURE.iterdir())
        self.project = os.path.join(new_scratch("declared-test-script-vitest-"),
                                    "project")
        shutil.copytree(VITEST_FIXTURE, self.project)
        _link_repo_node_modules(self.project)
        self.board = RecordingBoard()
        _write_project_config(self.project, self.board.url)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(os.path.dirname(self.project), ignore_errors=True)

    def drive(self, *extra):
        cmd = [sys.executable, str(BUN_CLIENT), "test", "--agent", AGENT,
               "--project-dir", self.project, "--package-dir", self.project,
               "--bun", self.real_bun, "--reports", "reports", *extra]
        return subprocess.run(cmd, cwd=self.project, env=_client_env(),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)


class DeclaredVitestScriptRunsTheTargetedFileTest(_VitestFixtureCase):
    """`test --tests <file>` on the Vitest fixture runs the declared script and
    files the counts Vitest reported through the declared env mechanism."""

    def test_a_targeted_run_files_vitests_one_passed_and_one_failed(self):
        result = self.drive("--tests", MIXED_RESULT_FILE)
        body = self.only_parsed_ingest(result)
        summary = body.get("summary") or {}
        self.assertEqual(
            (summary.get("passed"), summary.get("failed"),
             summary.get("pending"), summary.get("total")),
            (1, 1, 0, 2),
            f"Vitest ran the one targeted file (1 passed, 1 failed); "
            f"summary={summary!r}; {_diagnostics(result)}")
        self.assertEqual(
            _leaf_statuses(body.get("tree")),
            {PASSING_CASE: "pass", FAILING_CASE: "fail"},
            f"tree={body.get('tree')!r}")
        self.assert_untiered(body)

        self.assertEqual(result.returncode, 1,
                         f"a run with a failing test exits 1; {_diagnostics(result)}")
        envelope = self.envelope_of(result)
        self.assertEqual(
            envelope.get("script"), VITEST_SCRIPT,
            f"the envelope's `script` field names the script the run went "
            f"through; envelope={envelope!r}")
        self.assert_run_counts(envelope, 1, 1, 0)

    def test_the_runtime_fixture_proves_vitest_ran_on_the_bun_runtime(self):
        result = self.drive("--tests", RUNTIME_FILE)
        body = self.only_parsed_ingest(result)
        self.assertEqual(
            _leaf_statuses(body.get("tree")), {RUNTIME_CASE: "pass"},
            f"the runtime test passes only when Vitest runs on Bun; "
            f"tree={body.get('tree')!r}; {_diagnostics(result)}")
        summary = body.get("summary") or {}
        self.assertEqual((summary.get("passed"), summary.get("failed"),
                          summary.get("total")), (1, 0, 1), f"summary={summary!r}")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
        self.assertEqual(envelope.get("script"), VITEST_SCRIPT,
                         f"envelope={envelope!r}")

    def test_a_whole_suite_run_goes_through_the_declared_script(self):
        result = self.drive()
        body = self.only_parsed_ingest(result)
        summary = body.get("summary") or {}
        self.assertEqual(
            (summary.get("passed"), summary.get("failed"),
             summary.get("pending"), summary.get("total")),
            (4, 1, 0, 5),
            f"the whole fixture suite runs under Vitest: three files, five "
            f"tests, one failing; summary={summary!r}; {_diagnostics(result)}")
        self.assertEqual(
            _leaf_statuses(body.get("tree")),
            {RUNTIME_CASE: "pass", PASSING_CASE: "pass", FAILING_CASE: "fail",
             ALPHA: "pass", BETA: "pass"},
            f"tree={body.get('tree')!r}")
        self.assert_untiered(body)
        self.assertEqual(result.returncode, 1, _diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertEqual(envelope.get("script"), VITEST_SCRIPT,
                         f"envelope={envelope!r}")
        self.assert_run_counts(envelope, 4, 1, 0)

    def test_a_run_writes_nothing_into_the_checkouts_fixture(self):
        caches = (".vite", ".vite-temp", ".vitest-cache")
        before = {name for name in caches if (REPO_NODE_MODULES / name).exists()}
        self.drive("--tests", RUNTIME_FILE)
        after = {name for name in caches if (REPO_NODE_MODULES / name).exists()}
        self.assertEqual(
            after - before, set(),
            "Vitest's caches stay in the scratch copy, never in this repo's "
            "node_modules")
        self.assertEqual(
            sorted(p.name for p in VITEST_FIXTURE.iterdir()),
            self.checkout_fixture_before,
            "the fixture is run from a scratch copy: no cache and no report "
            "may land in the checkout's fixture directory")


class DeclaredVitestScriptFiltersByNameTest(_VitestFixtureCase):
    """`test --name <pattern>` through the declared Vitest script."""

    def test_a_name_filter_files_one_passed_and_one_pending(self):
        result = self.drive("--tests", NAME_FILTER_FILE, "--name", MATCHING_PATTERN)
        body = self.only_parsed_ingest(result)
        summary = body.get("summary") or {}
        self.assertEqual(
            (summary.get("passed"), summary.get("pending"),
             summary.get("failed"), summary.get("total")),
            (1, 1, 0, 2),
            f"only the matching test runs; the one Vitest's `-t` excluded is "
            f"filed as pending; summary={summary!r}; {_diagnostics(result)}")
        self.assertEqual(_leaf_statuses(body.get("tree")),
                         {ALPHA: "pass", BETA: "pending"},
                         f"tree={body.get('tree')!r}")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
        self.assertEqual(envelope.get("name"), MATCHING_PATTERN,
                         f"the envelope's `name` field names the filter; "
                         f"envelope={envelope!r}")
        self.assertEqual(envelope.get("script"), VITEST_SCRIPT,
                         f"envelope={envelope!r}")
        self.assert_run_counts(envelope, 1, 0, 1)

    def test_a_pattern_matching_no_test_aborts_the_run_and_names_the_pattern(self):
        result = self.drive("--tests", NAME_FILTER_FILE, "--name", NO_MATCH_PATTERN)
        diagnostics = _diagnostics(result)
        self.assertEqual(result.returncode, 1,
                         f"a run that ran nothing exits 1; {diagnostics}")
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertIn(
            NO_MATCH_PATTERN, json.dumps(envelope.get("warnings") or []),
            f"a warning must name the pattern that matched nothing; "
            f"envelope={envelope!r}")
        self.assertEqual(
            self.parsed_ingests(), [],
            f"a run that ran nothing is never filed; posts={self.board.posts()!r}")
        compiles = [p for p, _ in self.board.posts() if p == "/api/v2/runs/compile"]
        self.assertEqual(compiles, [],
                         f"nor filed as a compile failure; {diagnostics}")
        opened = self.board.run_ids_opened()
        aborts = self.board.aborts()
        self.assertEqual(len(opened), 1, f"posts={self.board.posts()!r}")
        self.assertEqual(len(aborts), 1,
                         f"the opened run is aborted exactly once; aborts={aborts!r}")
        self.assertIn(opened[0], aborts[0][0], f"aborts={aborts!r}")


# ── A declared `bun test` script under the default flag mechanism ──────────

class DeclaredBunTestScriptFiltersByNameTest(_BoardCase):
    """`test --name <pattern>` through a declared `bun test` script under the
    `flag` mechanism runs only the matching test, on the real `bun`."""

    def setUp(self):
        self.real_bun = shutil.which("bun")
        self.assertIsNotNone(
            self.real_bun,
            "this proof needs the real `bun` on PATH: what is filed is what "
            "bun's own `-t` filter reported through the script")
        self.project = new_scratch("declared-test-script-bun-")
        # The script is `bun test` with a preload that leaves a marker: a run
        # that went through the script, and not a bare `bun test`, leaves it.
        _write_manifest(self.project, {BUN_SCRIPT: f"bun test --preload ./{_MARK_PRELOAD}"},
                        {"testScript": BUN_SCRIPT})
        Path(self.project, _MARK_PRELOAD).write_text(
            f'await Bun.write("{_SCRIPT_RAN_MARKER}", "ran");\n')
        Path(self.project, "pair.test.ts").write_text(_PAIR_TEST)
        self.board = RecordingBoard()
        _write_project_config(self.project, self.board.url)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def drive(self, *extra):
        cmd = [sys.executable, str(BUN_CLIENT), "test", "--agent", AGENT,
               "--project-dir", self.project, "--package-dir", self.project,
               "--bun", self.real_bun, "--reports", "reports", *extra]
        return subprocess.run(cmd, cwd=self.project, env=_client_env(),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def test_a_name_filter_through_the_script_files_one_passed_and_one_pending(self):
        result = self.drive("--tests", "pair.test.ts", "--name", MATCHING_PATTERN)
        self.assert_went_through_the_script(result)
        body = self.only_parsed_ingest(result)
        summary = body.get("summary") or {}
        self.assertEqual(
            (summary.get("passed"), summary.get("pending"),
             summary.get("failed"), summary.get("total")),
            (1, 1, 0, 2),
            f"summary={summary!r}; {_diagnostics(result)}")
        self.assertEqual(_leaf_statuses(body.get("tree")),
                         {ALPHA: "pass", BETA: "pending"},
                         f"tree={body.get('tree')!r}")
        self.assert_untiered(body)
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
        self.assertEqual(envelope.get("name"), MATCHING_PATTERN,
                         f"envelope={envelope!r}")
        self.assertEqual(envelope.get("script"), BUN_SCRIPT,
                         f"envelope={envelope!r}")
        self.assert_run_counts(envelope, 1, 0, 1)

    def assert_went_through_the_script(self, result):
        self.assertTrue(
            Path(self.project, _SCRIPT_RAN_MARKER).is_file(),
            f"the run must go through the declared script (its preload leaves "
            f"a marker a bare `bun test` never writes); {_diagnostics(result)}")

    def test_a_pattern_matching_no_test_through_the_script_aborts_the_run(self):
        result = self.drive("--tests", "pair.test.ts", "--name", NO_MATCH_PATTERN)
        self.assert_went_through_the_script(result)
        self.assertEqual(result.returncode, 1, _diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertIn(NO_MATCH_PATTERN, json.dumps(envelope.get("warnings") or []),
                      f"envelope={envelope!r}")
        self.assertEqual(self.parsed_ingests(), [],
                         f"posts={self.board.posts()!r}")
        self.assertEqual(len(self.board.aborts()), 1,
                         f"posts={self.board.posts()!r}")


# ── The argv, the report routes and the refusals, with a recording `bun` ────

class _FakeBunCase(_BoardCase):
    """A scratch project whose `bun` is a recording fake."""

    SCRIPTS = {}
    CRUCIBLE = None

    def setUp(self):
        self.project = new_scratch("declared-test-script-argv-")
        _write_manifest(self.project, self.SCRIPTS, self.CRUCIBLE)
        self.board = RecordingBoard()
        _write_project_config(self.project, self.board.url)
        self.bun_log = os.path.join(self.project, "bun-calls.jsonl")
        self.fake_bun = os.path.join(self.project, "fake_bun.py")
        Path(self.fake_bun).write_text("#!" + sys.executable + "\n" + _FAKE_BUN_BODY)
        os.chmod(self.fake_bun,
                 os.stat(self.fake_bun).st_mode | stat.S_IXUSR | stat.S_IRUSR)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def drive(self, *extra, agent=True, **env):
        cmd = [sys.executable, str(BUN_CLIENT), "test",
               *(["--agent", AGENT] if agent else []),
               "--project-dir", self.project, "--package-dir", self.project,
               "--bun", self.fake_bun, "--reports", "reports", *extra]
        return subprocess.run(cmd, cwd=self.project,
                              env=_client_env(FAKE_BUN_LOG=self.bun_log, **env),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def bun_calls(self):
        if not os.path.exists(self.bun_log):
            return []
        with open(self.bun_log) as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def only_bun_call(self, result):
        calls = self.bun_calls()
        self.assertEqual(
            len(calls), 1,
            f"`test` must spawn bun exactly once; calls={calls!r} "
            f"{_diagnostics(result)}")
        return calls[0]


class DeclaredScriptUnderFlagArgvTest(_FakeBunCase):
    """Under `flag` the report flags are appended, and the files and the filter
    follow them with no `--`."""

    SCRIPTS = {BUN_SCRIPT: "bun test"}
    CRUCIBLE = {"testScript": BUN_SCRIPT}

    def test_a_targeted_filtered_run_is_the_script_its_report_flags_the_file_and_the_filter(self):
        pattern = "^alpha (one|two) match$"
        result = self.drive("--tests", "pair.test.ts", "--name", pattern)
        argv = self.only_bun_call(result)["argv"]
        self.assertEqual(argv[:3], ["run", BUN_SCRIPT, "--reporter=junit"],
                         f"the declared script runs by name; argv={argv!r}")
        self.assertRegex(argv[3], r"^--reporter-outfile=.+junit\.xml$",
                         f"argv={argv!r}")
        self.assertEqual(
            argv[4:], ["pair.test.ts", "-t", pattern],
            f"the file and the filter follow the report flags as written, the "
            f"pattern unchanged and as one argument; argv={argv!r}")
        self.assertNotIn("--", argv, f"argv={argv!r}")
        self.assertEqual(result.returncode, 0, _diagnostics(result))

    def test_a_whole_suite_run_is_the_script_and_its_report_flags(self):
        result = self.drive()
        argv = self.only_bun_call(result)["argv"]
        self.assertEqual(len(argv), 4, f"argv={argv!r}")
        self.assertEqual(argv[:3], ["run", BUN_SCRIPT, "--reporter=junit"],
                         f"argv={argv!r}")
        self.assertRegex(argv[3], r"^--reporter-outfile=.+junit\.xml$",
                         f"argv={argv!r}")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertEqual(envelope.get("script"), BUN_SCRIPT,
                         f"envelope={envelope!r}")


class DeclaredScriptUnderEnvArgvTest(_FakeBunCase):
    """Under `env:<VAR>` nothing is appended: the files and the filter follow a
    `--`, exactly as a tier verb's passthrough does, and the report path rides
    the declared variable."""

    SCRIPTS = {VITEST_SCRIPT: "bun --bun vitest run"}
    CRUCIBLE = {"testScript": VITEST_SCRIPT,
                "reportPath": {VITEST_SCRIPT: f"env:{ENV_JUNIT_VAR}"}}

    def test_a_targeted_filtered_run_passes_the_file_and_filter_after_dashdash(self):
        result = self.drive("--tests", "a.vitest.ts", "--name", MATCHING_PATTERN)
        call = self.only_bun_call(result)
        self.assertEqual(
            call["argv"], ["run", VITEST_SCRIPT, "--", "a.vitest.ts", "-t",
                           MATCHING_PATTERN],
            f"under env:<VAR> nothing is appended; argv={call['argv']!r}")
        self.assertEqual(call["vars"], [ENV_JUNIT_VAR],
                         f"the report path rides the declared variable; "
                         f"handed={call['vars']!r}")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        self.assertEqual(len(self.parsed_ingests()), 1, _diagnostics(result))

    def test_a_whole_suite_run_is_the_script_alone(self):
        result = self.drive()
        call = self.only_bun_call(result)
        self.assertEqual(call["argv"], ["run", VITEST_SCRIPT],
                         f"argv={call['argv']!r}")
        self.assertEqual(call["vars"], [ENV_JUNIT_VAR], f"handed={call['vars']!r}")
        self.assertEqual(result.returncode, 0, _diagnostics(result))


class DeclaredScriptWithARawReportTest(_FakeBunCase):
    """A declared script whose report the board decodes is filed by the raw
    route, as a tier verb files it."""

    RAW_SCRIPT = "test:raw"
    SCRIPTS = {RAW_SCRIPT: "some-runner"}
    CRUCIBLE = {"testScript": RAW_SCRIPT,
                "reportPath": {RAW_SCRIPT: f"env:{RAW_JUNIT_VAR}"},
                "rawReport": {RAW_SCRIPT: {"codec": "stub", "file": "stub.json",
                                           "path": f"env:{RAW_JSON_VAR}"}}}

    def test_the_raw_report_is_posted_for_the_board_to_decode(self):
        result = self.drive("--tests", "some.spec")
        call = self.only_bun_call(result)
        self.assertEqual(call["argv"], ["run", self.RAW_SCRIPT, "--", "some.spec"],
                         f"argv={call['argv']!r}")
        self.assertEqual(call["vars"], sorted([RAW_JUNIT_VAR, RAW_JSON_VAR]),
                         f"both declared variables are handed to the script; "
                         f"handed={call['vars']!r}")
        raw = [b for p, b in self.board.posts() if p == RAW_INGEST]
        self.assertEqual(len(raw), 1,
                         f"the raw report is filed once; posts={self.board.posts()!r}")
        self.assertEqual(raw[0].get("codec"), "stub", f"body={raw[0]!r}")
        self.assertTrue(str(raw[0].get("dataPath") or "").endswith("stub.json"),
                        f"body={raw[0]!r}")
        self.assertNotIn("tier", raw[0], f"body={raw[0]!r}")
        self.assertEqual(self.parsed_ingests(), [],
                         f"a declared raw report is never parsed here; "
                         f"posts={self.board.posts()!r}")


class StarvedDeclaredScriptNamesItselfTest(_FakeBunCase):
    """A declared script that writes no report is reported as a tier verb
    reports one: naming the script, the command and the path."""

    QUIET = "test:quiet"
    SCRIPTS = {QUIET: "some-runner"}
    CRUCIBLE = {"testScript": QUIET,
                "reportPath": {QUIET: f"env:{ENV_JUNIT_VAR}"}}

    def test_a_starved_script_is_named_with_its_command_and_report_path(self):
        result = self.drive("--tests", "a.spec", FAKE_BUN_WRITE="none")
        self.assertEqual(len(self.bun_calls()), 1, _diagnostics(result))
        self.assertEqual(result.returncode, 1, _diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        out = result.stdout
        self.assertIn(
            f"declared target `{self.QUIET}` exited 0 and wrote no report at", out,
            f"the starved script is reported in the tier verbs' words, naming "
            f"the script; {_diagnostics(result)}")
        self.assertIn(f"run {self.QUIET}", out,
                      f"the command that ran it is named; {_diagnostics(result)}")
        self.assertIn("junit.xml", out,
                      f"the report path is named; {_diagnostics(result)}")
        self.assertIn("no-test-reports", out, _diagnostics(result))


class _RefusedDeclarationCase(_FakeBunCase):
    """A bad `crucible.testScript` is refused before anything is posted."""

    def assert_refused(self, result, names):
        diagnostics = _diagnostics(result)
        self.assertEqual(result.returncode, 1, diagnostics)
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertIn(names, result.stdout,
                      f"the refusal names the script; {diagnostics}")
        self.assertIn("package.json", result.stdout,
                      f"the refusal names package.json; {diagnostics}")
        self.assertEqual(self.board.posts(), [],
                         f"nothing may be posted to the board; "
                         f"posts={self.board.posts()!r}")
        self.assertEqual(self.bun_calls(), [],
                         f"the runner never starts; calls={self.bun_calls()!r}")


class ADeclarationThatIsNotAStringIsRefusedTest(_RefusedDeclarationCase):
    SCRIPTS = {"test:listed": "bun test"}
    CRUCIBLE = {"testScript": ["test:listed"]}

    def test_a_non_string_declaration_is_refused_before_anything_is_posted(self):
        self.assert_refused(self.drive("--tests", "pair.test.ts"), "test:listed")


class ADeclarationNamingNoScriptIsRefusedTest(_RefusedDeclarationCase):
    SCRIPTS = {"test:unit": "bun test"}
    CRUCIBLE = {"testScript": "test:absent"}

    def test_a_declaration_naming_no_script_is_refused_before_anything_is_posted(self):
        self.assert_refused(self.drive("--tests", "pair.test.ts"), "test:absent")

    def test_a_whole_suite_run_is_refused_too(self):
        self.assert_refused(self.drive(), "test:absent")


class ADeclarationNamingAnEmptyScriptIsRefusedTest(_RefusedDeclarationCase):
    SCRIPTS = {"test:empty": ""}
    CRUCIBLE = {"testScript": "test:empty"}

    def test_a_declaration_naming_an_empty_script_is_refused_before_anything_is_posted(self):
        self.assert_refused(self.drive("--tests", "pair.test.ts"), "test:empty")


if __name__ == "__main__":
    unittest.main()
