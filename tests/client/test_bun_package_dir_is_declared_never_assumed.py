"""The bun client's package dir is DECLARED, never assumed.

A project names the directory its bun package lives in as `[bun] package_dir`
in its OWN `crucible.toml`. The client resolves the directory every verb runs
in by one order: `--package-dir`, then `$BUN_CRUCIBLE_PACKAGE_DIR`, then the
declared value, then the project root -- and a relative value from any of the
three is resolved against the project root, never the working directory the
client happened to be launched from. No layout belonging to one project is a
fallback for every other: a project holding `integrations/pi/package.json`
that declares nothing runs from its own root. An install-level `[bun]` value
is never read -- an install-wide package dir would make one project
everyone's default.

A bad value is refused before anything reaches the board: a flag or variable
value that is not a directory, and a declared value that is not a directory
holding a `package.json`, each with `ok: false`, exit 1, and the refusal
naming the value and where it came from.

Every test drives the REAL entry point -- `clients/bun-crucible.py` as an OS
subprocess -- with a fake `bun` that records the argv and working directory of
every invocation, so "the verb ran in the package dir" is read from where the
runner actually ran. A `RecordingBoard` on loopback stands in for the board the
project's own `crucible.toml` points the client at; no live board and no real
toolchain are ever touched.

Invocation:
    python3 -m unittest tests.client.test_bun_package_dir_is_declared_never_assumed -v
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tomllib
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    SHIPPED_TOML,
    RecordingBoard,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
TIMEOUT = 60
AGENT = "package-dir-fixture-agent"
PROJECT_KEY = "package-dir-fixture-key"
VARIABLE = "BUN_CRUCIBLE_PACKAGE_DIR"
FLAG = "--package-dir"

# The client's own resolution variables: a value inherited from the shell
# running this suite would silently decide the directory under test.
_CLIENT_RESOLUTION_KEYS = (VARIABLE, "BUN_CRUCIBLE_PROJECT_DIR",
                           "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE")

# A fake `bun`. Every invocation appends `{argv, cwd}` to the JSON-lines file
# `$FAKE_BUN_LOG` names, then behaves like the real tool closely enough for
# each verb to finish: `bun x tsc …` typechecks clean, `bun run <script>`
# dispatches to the script body of the package.json in its cwd (a leading
# `bun` re-enters this same fake), and `bun test … --reporter-outfile=PATH`
# writes a one-case passing JUnit report.
_FAKE_BUN_BODY = r'''
import json
import os
import shlex
import subprocess
import sys

argv = sys.argv[1:]
log = os.environ.get("FAKE_BUN_LOG")
if log:
    with open(log, "a") as handle:
        handle.write(json.dumps({"argv": argv, "cwd": os.getcwd()}) + "\n")

if argv[:1] == ["x"]:
    sys.exit(0)

if argv[:1] == ["run"] and len(argv) > 1:
    try:
        with open(os.path.join(os.getcwd(), "package.json")) as handle:
            scripts = (json.load(handle) or {}).get("scripts") or {}
    except OSError:
        scripts = {}
    body = scripts.get(argv[1])
    if body is None:
        sys.stderr.write('error: Script not found "%s"\n' % argv[1])
        sys.exit(1)
    extra = argv[2:]
    if extra[:1] == ["--"]:
        extra = extra[1:]
    command = " ".join([body] + [shlex.quote(a) for a in extra])
    if command.startswith("bun "):
        command = shlex.quote(sys.argv[0]) + command[3:]
    sys.exit(subprocess.run(command, shell=True, cwd=os.getcwd()).returncode)

outfile = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        outfile = arg.split("=", 1)[1]
if outfile:
    directory = os.path.dirname(outfile)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(outfile, "w") as handle:
        handle.write(
            '<?xml version="1.0" encoding="UTF-8"?><testsuites>'
            '<testsuite name="fixture.test.ts" tests="1" failures="0">'
            '<testcase name="fixture_case" file="fixture.test.ts" time="0.001">'
            '</testcase></testsuite></testsuites>')
sys.exit(0)
'''


def _junit(case_name):
    return ('<?xml version="1.0" encoding="UTF-8"?><testsuites>'
            '<testsuite name="found.test.ts" tests="1" failures="0">'
            f'<testcase name="{case_name}" file="found.test.ts" time="0.001">'
            '</testcase></testsuite></testsuites>')


def _write_package(directory, scripts=None):
    os.makedirs(directory, exist_ok=True)
    manifest = {"name": os.path.basename(directory) or "package"}
    if scripts:
        manifest["scripts"] = scripts
    Path(directory, "package.json").write_text(json.dumps(manifest))
    return directory


def _toml_string(value):
    # A JSON string literal is a valid TOML basic string for a plain path.
    return json.dumps(value)


def _write_project_config(project, board_url, package_dir=None):
    """The project's own `.env` and `crucible.toml`, written whole rather than
    copied from the shipped file, so a `[bun]` table the shipped file grows can
    never be duplicated here. The display limit is raised so a refusal naming a
    long scratch path is not cut before the words under test."""
    Path(project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
    text = (f"[client]\nurl = {_toml_string(board_url)}\n\n"
            "[limits.truncate_field_chars]\nvalue = 4000\n")
    if package_dir is not None:
        text += f"\n[bun]\npackage_dir = {_toml_string(package_dir)}\n"
    Path(project, "crucible.toml").write_text(text)


def _same_dir(left, right):
    return os.path.realpath(left) == os.path.realpath(right)


class _PackageDirCase(unittest.TestCase):
    """A scratch root holding the project, a sibling directory the client is
    launched from, the fake `bun`, and the log of its invocations."""

    def setUp(self):
        self.root = new_scratch("bun-package-dir-")
        self.project = os.path.join(self.root, "project")
        self.elsewhere = os.path.join(self.root, "elsewhere")
        os.makedirs(self.project)
        os.makedirs(self.elsewhere)
        self.bun_log = os.path.join(self.root, "bun-calls.jsonl")
        self.fake_bun = os.path.join(self.root, "fake_bun.py")
        Path(self.fake_bun).write_text("#!" + sys.executable + "\n" + _FAKE_BUN_BODY)
        os.chmod(self.fake_bun,
                 os.stat(self.fake_bun).st_mode | stat.S_IXUSR | stat.S_IRUSR)
        self.board = RecordingBoard()

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.root, ignore_errors=True)

    def env(self, **extra):
        env = scrubbed_env(None, FAKE_BUN_LOG=self.bun_log)
        for key in _CLIENT_RESOLUTION_KEYS:
            env.pop(key, None)
        env.update(extra)
        return env

    def drive(self, argv, cwd=None, client=None, env=None):
        cmd = [sys.executable, str(client or CLIENTS / "bun-crucible.py"), *argv]
        return subprocess.run(cmd, cwd=cwd or self.project,
                              env=env if env is not None else self.env(),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def bun_calls(self):
        if not os.path.exists(self.bun_log):
            return []
        with open(self.bun_log) as handle:
            return [json.loads(line) for line in handle if line.strip()]

    @staticmethod
    def envelope(stdout):
        try:
            decoded = TOON.decode(stdout)
        except ValueError:
            return None
        return decoded.get("axi") if isinstance(decoded, dict) else None

    def assert_every_call_ran_in(self, expected_dir, label, result):
        calls = self.bun_calls()
        self.assertGreaterEqual(
            len(calls), 1,
            f"{label}: the fake bun was never invoked; exit={result.returncode} "
            f"stdout={result.stdout!r} stderr={result.stderr[-1500:]!r}")
        wrong = [c["cwd"] for c in calls if not _same_dir(c["cwd"], expected_dir)]
        self.assertEqual(
            wrong, [],
            f"{label}: every bun invocation must run in {expected_dir}; these ran "
            f"elsewhere: {wrong!r}; stderr={result.stderr[-1500:]!r}")
        return calls


class DeclaredPackageDirIsWhereEveryVerbRunsTest(_PackageDirCase):
    """`[bun] package_dir` in the project's own `crucible.toml`, with no flag
    and no variable set, is the directory each verb that runs in the package
    dir runs in. The project root is itself a package too, so a resolver that
    picks "the first dir holding a package.json" cannot pass."""

    def setUp(self):
        super().setUp()
        _write_package(self.project)
        self.pkg = _write_package(os.path.join(self.project, "pkg"),
                                  {"test:unit": "bun test"})
        _write_project_config(self.project, self.board.url, package_dir="pkg")

    def test_check_runs_tsc_in_the_declared_package_dir(self):
        result = self.drive(["check", "--bun", self.fake_bun,
                             "--project-dir", self.project])
        calls = self.assert_every_call_ran_in(self.pkg, "check", result)
        self.assertEqual([c["argv"][:2] for c in calls], [["x", "tsc"]],
                         f"check must spawn exactly one `bun x tsc`; got {calls!r}")
        self.assertEqual(result.returncode, 0, result.stderr[-1500:])

    def test_test_runs_bun_test_in_the_declared_package_dir(self):
        result = self.drive(["test", "--bun", self.fake_bun,
                             "--project-dir", self.project])
        calls = self.assert_every_call_ran_in(self.pkg, "test", result)
        self.assertEqual(len(calls), 1, f"test must spawn bun once; got {calls!r}")
        self.assertEqual(calls[0]["argv"][0], "test")
        self.assertEqual(result.returncode, 0, result.stderr[-1500:])

    def test_regression_runs_the_whole_suite_in_the_declared_package_dir(self):
        result = self.drive(["regression", "--agent", AGENT, "--bun", self.fake_bun,
                             "--project-dir", self.project, "--reports", "reports"])
        calls = self.assert_every_call_ran_in(self.pkg, "regression", result)
        self.assertEqual([c["argv"][0] for c in calls], ["test"],
                         f"regression must spawn one `bun test`; got {calls!r}")
        self.assertEqual(result.returncode, 0,
                         f"stdout={result.stdout!r} stderr={result.stderr[-1500:]!r}")

    def test_a_tier_verb_runs_the_script_declared_in_the_declared_package_dir(self):
        # Only the declared package's manifest declares `test:unit`; the
        # project root's manifest declares no script at all.
        result = self.drive(["unit", "--bun", self.fake_bun,
                             "--project-dir", self.project, "--reports", "reports"])
        calls = self.assert_every_call_ran_in(self.pkg, "unit", result)
        self.assertEqual(calls[0]["argv"][:2], ["run", "test:unit"],
                         f"unit must run the declared script by name; got {calls!r}")
        self.assertEqual(result.returncode, 0,
                         f"stdout={result.stdout!r} stderr={result.stderr[-1500:]!r}")

    def test_auto_ingest_files_the_report_found_under_the_declared_package_dir(self):
        os.makedirs(os.path.join(self.pkg, "reports"))
        Path(self.pkg, "reports", "junit.xml").write_text(
            _junit("declared_package_case"))
        os.makedirs(os.path.join(self.project, "reports"))
        Path(self.project, "reports", "junit.xml").write_text(
            _junit("project_root_decoy_case"))
        result = self.drive(["auto-ingest", "--agent", AGENT, "--reports", "reports",
                             "--project-dir", self.project])
        self.assertEqual(result.returncode, 0,
                         f"stdout={result.stdout!r} stderr={result.stderr[-1500:]!r}")
        ingests = [json.dumps(body) for path, body in self.board.posts()
                   if path == "/api/v2/runs/parsed"]
        self.assertEqual(len(ingests), 1, f"exactly one ingest; got {ingests!r}")
        self.assertIn("declared_package_case", ingests[0])
        self.assertNotIn("project_root_decoy_case", ingests[0])

    def test_pre_merge_gate_runs_its_check_and_regression_in_the_declared_package_dir(self):
        # No `test:*` script, so the gate is its tsc step plus its own
        # whole-suite regression and nothing else.
        _write_package(self.pkg)
        result = self.drive(["pre-merge-gate", "--agent", AGENT, "--bun", self.fake_bun,
                             "--project-dir", self.project, "--reports", "reports"])
        calls = self.assert_every_call_ran_in(self.pkg, "pre-merge-gate", result)
        heads = [c["argv"][0] for c in calls]
        self.assertEqual(heads, ["x", "test"],
                         f"the gate must spawn its tsc check then its regression; "
                         f"got {calls!r}")


class PackageDirResolutionOrderTest(_PackageDirCase):
    """`--package-dir` > `$BUN_CRUCIBLE_PACKAGE_DIR` > the declared value >
    the project root, and a relative value from any of the three resolves
    against the project root. The client is launched from a sibling directory
    holding same-named packages, so a value left relative to the working
    directory runs somewhere observably wrong."""

    def setUp(self):
        super().setUp()
        _write_package(self.project)
        for name in ("pkg", "envpkg", "flagpkg"):
            _write_package(os.path.join(self.project, name))
            _write_package(os.path.join(self.elsewhere, name))
        _write_project_config(self.project, self.board.url, package_dir="pkg")

    def _test(self, *extra_argv, env=None):
        return self.drive(["test", "--bun", self.fake_bun,
                           "--project-dir", self.project, *extra_argv],
                          cwd=self.elsewhere, env=env)

    def test_the_flag_wins_over_the_variable_and_the_declared_value(self):
        result = self._test(FLAG, os.path.join(self.project, "flagpkg"),
                            env=self.env(**{VARIABLE: os.path.join(self.project, "envpkg")}))
        self.assert_every_call_ran_in(os.path.join(self.project, "flagpkg"),
                                      "flag over variable over declared", result)

    def test_the_variable_wins_over_the_declared_value_when_no_flag_is_given(self):
        result = self._test(env=self.env(**{VARIABLE: os.path.join(self.project, "envpkg")}))
        self.assert_every_call_ran_in(os.path.join(self.project, "envpkg"),
                                      "variable over declared", result)

    def test_an_absolute_declared_value_is_used_when_neither_flag_nor_variable_is_set(self):
        _write_project_config(self.project, self.board.url,
                              package_dir=os.path.join(self.project, "pkg"))
        result = self._test()
        self.assert_every_call_ran_in(os.path.join(self.project, "pkg"),
                                      "absolute declared value", result)

    def test_a_relative_flag_resolves_against_the_project_root_not_the_working_dir(self):
        result = self._test(FLAG, "flagpkg")
        self.assert_every_call_ran_in(os.path.join(self.project, "flagpkg"),
                                      "relative flag", result)

    def test_a_relative_variable_resolves_against_the_project_root_not_the_working_dir(self):
        result = self._test(env=self.env(**{VARIABLE: "envpkg"}))
        self.assert_every_call_ran_in(os.path.join(self.project, "envpkg"),
                                      "relative variable", result)

    def test_a_relative_declared_value_resolves_against_the_project_root_not_the_working_dir(self):
        result = self._test()
        self.assert_every_call_ran_in(os.path.join(self.project, "pkg"),
                                      "relative declared value", result)


class NoProjectIsAnyonesDefaultTest(_PackageDirCase):
    """With nothing declared the package dir is the project root -- whatever
    layout the project happens to hold, and whatever an install's own
    `crucible.toml` says."""

    def test_a_project_holding_integrations_pi_package_json_runs_from_the_project_root(self):
        _write_package(self.project)
        _write_package(os.path.join(self.project, "integrations", "pi"))
        _write_project_config(self.project, self.board.url)
        result = self.drive(["test", "--bun", self.fake_bun,
                             "--project-dir", self.project])
        self.assert_every_call_ran_in(self.project, "nothing declared", result)
        self.assertEqual(result.returncode, 0, result.stderr[-1500:])

    def test_an_install_level_package_dir_is_never_read(self):
        """The install's `crucible.toml` is the walk's fallback for `[client]`
        and `[limits]` when the project has no file of its own; `[bun]
        package_dir` is read from the project's own file only. Driven from a
        copied install so the install-level file is one this test owns."""
        install = os.path.join(self.root, "install")
        shutil.copytree(CLIENTS, os.path.join(install, "clients"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        _write_package(self.project)
        pkg = _write_package(os.path.join(self.project, "pkg"))
        Path(install, "crucible.toml").write_text(
            f"[client]\nurl = {_toml_string(self.board.url)}\n\n"
            f"[bun]\npackage_dir = {_toml_string(pkg)}\n")
        self.assertFalse(os.path.exists(os.path.join(self.project, "crucible.toml")),
                         "fixture: the project must declare nothing of its own")
        result = self.drive(["test", "--bun", self.fake_bun,
                             "--project-dir", self.project],
                            client=os.path.join(install, "clients", "bun-crucible.py"))
        self.assert_every_call_ran_in(self.project, "install-level value", result)


class BadPackageDirIsRefusedBeforeTheBoardTest(_PackageDirCase):
    """A flag or variable value that is not a directory, and a declared value
    that is not a directory holding a `package.json`, are refused before
    anything is posted to the board and before the runner starts: `ok: false`,
    exit 1, and the refusal names the value and where it came from."""

    def setUp(self):
        super().setUp()
        _write_package(self.project, {"test:unit": "bun test"})
        _write_project_config(self.project, self.board.url)
        Path(self.project, "a-plain-file").write_text("not a directory\n")

    def assert_refused(self, result, value, source, label, posts_before=0):
        out = result.stdout
        diag = f"exit={result.returncode} stdout={out!r} stderr={result.stderr[-1500:]!r}"
        self.assertIn(value, out, f"{label}: the refusal must name the value; {diag}")
        self.assertIn(source, out,
                      f"{label}: the refusal must name where the value came from "
                      f"({source}); {diag}")
        axi = self.envelope(out)
        if axi is None:
            self.fail(f"{label}: stdout must be one AXI envelope; {diag}")
        self.assertIs(axi.get("ok"), False, f"{label}: {diag}")
        self.assertEqual(result.returncode, 1, f"{label}: {diag}")
        posts = self.board.posts()[posts_before:]
        self.assertEqual(posts, [],
                         f"{label}: nothing may be posted to the board; got {posts!r}")
        self.assertEqual(self.bun_calls(), [],
                         f"{label}: the runner must never start; "
                         f"got {self.bun_calls()!r}")

    def _test(self, *extra_argv, env=None):
        return self.drive(["test", "--agent", AGENT, "--bun", self.fake_bun,
                           "--project-dir", self.project, *extra_argv], env=env)

    def test_a_flag_value_that_does_not_exist_is_refused_naming_it_and_the_flag(self):
        result = self._test(FLAG, "missing-flag-dir")
        self.assert_refused(result, "missing-flag-dir", FLAG, "missing flag dir")

    def test_a_flag_value_that_is_a_file_is_refused_naming_it_and_the_flag(self):
        result = self._test(FLAG, "a-plain-file")
        self.assert_refused(result, "a-plain-file", FLAG, "flag names a file")

    def test_a_variable_value_that_is_not_a_directory_is_refused_naming_it_and_the_variable(self):
        result = self._test(env=self.env(**{
            VARIABLE: os.path.join(self.project, "missing-variable-dir")}))
        self.assert_refused(result, "missing-variable-dir", VARIABLE,
                            "missing variable dir")

    def test_a_declared_value_that_is_not_a_directory_is_refused_naming_it_and_the_file(self):
        _write_project_config(self.project, self.board.url,
                              package_dir="missing-declared-dir")
        result = self._test()
        self.assert_refused(result, "missing-declared-dir", "crucible.toml",
                            "missing declared dir")

    def test_a_declared_directory_holding_no_package_json_is_refused_naming_it_and_the_file(self):
        os.makedirs(os.path.join(self.project, "bare-declared-dir"))
        _write_project_config(self.project, self.board.url,
                              package_dir="bare-declared-dir")
        result = self._test()
        self.assert_refused(result, "bare-declared-dir", "crucible.toml",
                            "declared dir without package.json")

    def test_every_verb_that_runs_in_the_package_dir_refuses_a_bad_declared_value(self):
        _write_project_config(self.project, self.board.url,
                              package_dir="missing-declared-dir")
        verbs = {
            "check": ["check", "--agent", AGENT, "--bun", self.fake_bun],
            "regression": ["regression", "--agent", AGENT, "--bun", self.fake_bun,
                           "--reports", "reports"],
            "unit": ["unit", "--agent", AGENT, "--bun", self.fake_bun,
                     "--reports", "reports"],
            "auto-ingest": ["auto-ingest", "--agent", AGENT, "--reports", "reports"],
            "pre-merge-gate": ["pre-merge-gate", "--agent", AGENT,
                               "--bun", self.fake_bun, "--reports", "reports"],
        }
        for verb, argv in verbs.items():
            with self.subTest(verb=verb):
                if os.path.exists(self.bun_log):
                    os.remove(self.bun_log)
                before = len(self.board.posts())
                result = self.drive([*argv, "--project-dir", self.project])
                self.assert_refused(result, "missing-declared-dir", "crucible.toml",
                                    verb, posts_before=before)

    def test_a_flag_or_variable_directory_without_package_json_is_accepted(self):
        """Only a DECLARED value must hold a `package.json`; a flag or
        variable naming an existing directory is run in as given."""
        plain = os.path.join(self.project, "plain-dir")
        os.makedirs(plain)
        for label, argv, env in (
                ("flag", [FLAG, plain], self.env()),
                ("variable", [], self.env(**{VARIABLE: plain}))):
            with self.subTest(source=label):
                if os.path.exists(self.bun_log):
                    os.remove(self.bun_log)
                result = self.drive(["test", "--bun", self.fake_bun,
                                     "--project-dir", self.project, *argv], env=env)
                self.assertEqual(result.returncode, 0,
                                 f"{label}: stdout={result.stdout!r} "
                                 f"stderr={result.stderr[-1500:]!r}")
                self.assert_every_call_ran_in(plain, label, result)


class ShippedConfigDocumentsThePackageDirKeyTest(unittest.TestCase):
    """The shipped `crucible.toml` documents `[bun] package_dir` and declares
    no value, so an install that copies it makes no project anyone's default."""

    def test_the_shipped_file_carries_a_bun_table_that_declares_no_package_dir(self):
        with open(SHIPPED_TOML, "rb") as handle:
            parsed = tomllib.load(handle)
        self.assertIsInstance(parsed.get("bun"), dict,
                              "the shipped crucible.toml must carry a [bun] table")
        self.assertNotIn("package_dir", parsed["bun"],
                         "the shipped crucible.toml must declare no package_dir value")

    def test_the_shipped_file_documents_the_package_dir_key_in_a_comment(self):
        lines = SHIPPED_TOML.read_text().splitlines()
        documented = [line for line in lines
                      if line.lstrip().startswith("#") and "package_dir" in line]
        self.assertGreaterEqual(
            len(documented), 1,
            "the shipped crucible.toml must document `package_dir` in a comment")


if __name__ == "__main__":
    unittest.main()
