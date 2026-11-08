"""A maven run reads its console declaration from the project's own
`crucible.toml`, keyed by the verb's tier, and refuses one it cannot honour
before anything runs.

The declaration is one `[targets.<tier>]` table:

    [targets.regression]
    framework = "surefire"
    console = "surefire-console"

  - Where the key is read: `test` reads `unit`; `unit`, `module` and `bdd`
    (the declared-profile cell) read their own; `integration` and `e2e` read
    theirs; `regression` and `pre-merge-gate`'s regression read `regression`.
  - `framework` and `console` are required and take only those values;
    `junit`, `stream` and `coverage` are refused.
  - Refused before any board call, `docker-up` or maven, with ONE ok:false
    envelope that names the table and the field, exiting non-zero:
      * an entry under the run's own key with a wrong value, a refused key or
        a missing required field;
      * a project `crucible.toml` that does not parse;
      * a declared console on a board whose health lists no
        `surefire-console` under `codecs.view` (only the health read precedes
        that refusal).
    This holds for `e2e --with-docker` and `pre-merge-gate`, which check
    before `docker-up`.
  - Skipped, not refused: an entry whose `framework` belongs to another
    stack; the verb runs exactly as undeclared.
  - Undeclared (no project `crucible.toml`, or no entry under the run's key):
    the verb runs as it does today.
  - An unreadable health refuses nothing.

Each test drives the real client as a subprocess with a fake `mvnw` (which
logs its argv), a fake `docker` on PATH (which logs its argv) and a
RecordingBoard. A project whose own file is absent or does not parse runs a
COPIED install whose `crucible.toml` points at that board.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_maven_run_reads_its_projects_console_declaration
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
    HEALTH_PATHS,
    RecordingBoard,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
MVN_CLIENT = CLIENTS / "mvn-crucible.py"
TIMEOUT = 120
PROJECT_KEY = "mvn-console-declaration-key"
AGENT = "mvn-console-declared"
VIEW_CODEC = "surefire-console"
RUNS = "/api/v2/runs"
HEARTBEAT = "/api/v2/agents/heartbeat"
COMPOSE = ("--compose-file", "compose.yaml")

#: The one entry a maven run takes.
ENTRY = 'framework = "surefire"\nconsole = "surefire-console"\n'

#: Every verb, the argv it is driven with, and the `[targets.<key>]` it reads.
VERBS = (
    ("test", "test", (), "unit"),
    ("unit", "unit", (), "unit"),
    ("module", "module", (), "module"),
    ("bdd", "bdd", (), "bdd"),
    ("integration", "integration", (), "integration"),
    ("e2e", "e2e", (), "e2e"),
    ("e2e --with-docker", "e2e", ("--with-docker", *COMPOSE), "e2e"),
    ("regression", "regression", (), "regression"),
    ("pre-merge-gate", "pre-merge-gate", COMPOSE, "regression"),
)
KEYS = ("unit", "module", "integration", "e2e", "bdd", "regression")

#: Entries refused under the run's own key: (label, body, the field named).
REFUSED_ENTRIES = (
    ("a failsafe framework", 'framework = "failsafe"\nconsole = "surefire-console"\n',
     "framework"),
    ("an unknown framework", 'framework = "junit5"\nconsole = "surefire-console"\n',
     "framework"),
    ("bun's console codec", 'framework = "surefire"\nconsole = "bun-console"\n',
     "console"),
    ("no framework", 'console = "surefire-console"\n', "framework"),
    ("no console", 'framework = "surefire"\n', "console"),
    ("a junit field", ENTRY + 'junit = "flag"\n', "junit"),
    ("a stream field", ENTRY + 'stream = { codec = "crucible-events", path = "stdout" }\n',
     "stream"),
    ("a coverage field", ENTRY + 'coverage = "jacoco"\n', "coverage"),
)
#: The entry at fault the per-verb and per-key tests declare.
AT_FAULT = REFUSED_ENTRIES[0][1]

#: Entries another stack declares under the same table; each carries a field
#: a maven entry may not, so reading one as maven's would refuse it.
OTHER_STACKS = (
    'framework = "nextest"\nstream = { codec = "nextest", path = "stdout" }\n',
    'framework = "arduino-native"\n'
    'stream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }\n',
    'framework = "bun-test"\njunit = "flag"\nconsole = "bun-console"\ncoverage = "lcov"\n',
    'framework = "unittest"\nstream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }\n',
    'framework = "pytest"\nstream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }\n',
)

_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_COVERAGE_PROFILE",
             "MVN_CRUCIBLE_PROJECT_DIR", "MVN_CRUCIBLE_MAVEN_DIR",
             "MVN_CRUCIBLE_COMPOSE_FILE")

# A fake `mvnw`: it appends its argv to FAKE_MVN_LOG, prints one class's
# surefire lines, writes one passing surefire report (and one failsafe report
# when the goals reach failsafe) into the directory the client named for the
# plugin, writes a JaCoCo CSV, and exits 0.
_FAKE_MVNW = r'''
import json
import os
import sys

args = sys.argv[1:]
with open(os.environ["FAKE_MVN_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")

def write(path, text):
    if os.path.dirname(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

dirs = {}
for arg in args:
    for plugin in ("surefire", "failsafe"):
        flag = "-D%s.reportsDirectory=" % plugin
        if arg.startswith(flag):
            dirs[plugin] = arg[len(flag):]
plugins = ["surefire"]
if any(goal in args for goal in ("integration-test", "verify", "failsafe:integration-test")):
    plugins.append("failsafe")
for plugin in plugins:
    name = "com.acme.Alpha" + ("IT" if plugin == "failsafe" else "Test")
    sys.stdout.write("[INFO] Running %s\n" % name)
    sys.stdout.write("[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, "
                     "Time elapsed: 0.01 s -- in %s\n" % name)
    directory = dirs.get(plugin) or os.path.join("target", "%s-reports" % plugin)
    write(os.path.join(directory, "TEST-%s.xml" % name),
          '<?xml version="1.0" encoding="UTF-8"?>\n'
          '<testsuite name="%s" tests="1" failures="0" errors="0" skipped="0">'
          '<testcase name="works" classname="%s" time="0.01"/></testsuite>\n'
          % (name, name))
write(os.path.join("target", "jacoco-report", "jacoco.csv"),
      "GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED,BRANCH_MISSED,"
      "BRANCH_COVERED,LINE_MISSED,LINE_COVERED,COMPLEXITY_MISSED,COMPLEXITY_COVERED,"
      "METHOD_MISSED,METHOD_COVERED\nalpha,com.acme,Alpha,1,9,0,0,1,9,0,1,0,1\n")
sys.stdout.write("[INFO] BUILD SUCCESS\n")
sys.stdout.flush()
sys.exit(0)
'''

# A fake `docker`: it appends its argv to FAKE_DOCKER_LOG and exits 0.
_FAKE_DOCKER = r'''
import json
import os
import sys

with open(os.environ["FAKE_DOCKER_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")
sys.exit(0)
'''

# A POM declaring the `bdd` profile, so `bdd` reaches its declared-profile cell.
_POM = ('<?xml version="1.0" encoding="UTF-8"?>\n'
        '<project xmlns="http://maven.apache.org/POM/4.0.0">\n'
        '  <modelVersion>4.0.0</modelVersion>\n'
        '  <profiles><profile><id>bdd</id></profile></profiles>\n'
        '</project>\n')


def _write_script(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _said(axi):
    """The refusal as the envelope says it: its error, its warnings and its
    help."""
    axi = axi or {}
    parts = [str(axi.get("error") or "")]
    parts += [str(w.get("detail") or "") for w in axi.get("warnings") or []
              if isinstance(w, dict)]
    parts += [str(step) for step in axi.get("help") or []]
    return " ".join(parts)


def _jsonl(path):
    if not os.path.exists(path):
        return []
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


class _MavenProject(unittest.TestCase):
    """A scratch maven project with the fake `mvnw`, a compose file, the fake
    `docker` on PATH, filing to a RecordingBoard."""

    maxDiff = 6000

    def setUp(self):
        self.project = new_scratch("mvn-console-declaration-")
        self.bin_dir = new_scratch("mvn-console-declaration-bin-")
        self.logs = new_scratch("mvn-console-declaration-logs-")
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        Path(self.project, "compose.yaml").write_text("services: {}\n")
        _write_script(os.path.join(self.project, "mvnw"), _FAKE_MVNW)
        _write_script(os.path.join(self.bin_dir, "docker"), _FAKE_DOCKER)
        self.client = str(MVN_CLIENT)
        self.board = RecordingBoard()
        self.declare({})

    def tearDown(self):
        self.board.close()
        for path in (self.project, self.bin_dir, self.logs):
            shutil.rmtree(path, ignore_errors=True)

    # ── the project ─────────────────────────────────────────────────────────

    def fresh_board(self, board=None):
        self.board.close()
        self.board = board or RecordingBoard()
        self.rewrite_toml()
        self.forget_calls()
        return self.board

    def declare(self, entries):
        """The project's own `crucible.toml`: the board, then one
        `[targets.<key>]` table per entry."""
        self.entries = dict(entries)
        self.rewrite_toml()

    def rewrite_toml(self):
        tables = "".join(f"\n[targets.{key}]\n{body}" for key, body in self.entries.items())
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n{tables}")

    def copied_install(self, install_toml):
        """A copy of the clients whose install-level `crucible.toml` is
        `install_toml`; the drives that follow run the copied client."""
        install = os.path.join(self.logs, "install")
        shutil.copytree(CLIENTS, os.path.join(install, "clients"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        Path(install, "crucible.toml").write_text(install_toml)
        self.client = os.path.join(install, "clients", "mvn-crucible.py")

    def view_listing_health(self, view=("bun-console", VIEW_CODEC)):
        """The board's health, with `codecs.view` listing `view` (None: no
        `view` list at all)."""
        health = self.board.default_health()
        if view is None:
            health["codecs"].pop("view", None)
        else:
            health["codecs"]["view"] = list(view)
        return health

    # ── driving ─────────────────────────────────────────────────────────────

    def drive(self, verb, *extra):
        pom = Path(self.project, "pom.xml")
        if verb == "bdd":
            pom.write_text(_POM)
        else:
            pom.unlink(missing_ok=True)
        argv = [sys.executable, self.client, verb, "--agent", AGENT,
                "--project-dir", self.project, *extra]
        env = scrubbed_env(self.bin_dir,
                           FAKE_MVN_LOG=os.path.join(self.logs, "mvn.jsonl"),
                           FAKE_DOCKER_LOG=os.path.join(self.logs, "docker.jsonl"))
        for key in _SCRUBBED:
            env.pop(key, None)
        return subprocess.run(argv, cwd=self.project, env=env, capture_output=True,
                              text=True, timeout=TIMEOUT, check=False)

    def forget_calls(self):
        for name in ("mvn.jsonl", "docker.jsonl"):
            Path(self.logs, name).unlink(missing_ok=True)

    def mvn_calls(self):
        return _jsonl(os.path.join(self.logs, "mvn.jsonl"))

    def docker_ups(self):
        return [argv for argv in _jsonl(os.path.join(self.logs, "docker.jsonl"))
                if "compose" in argv and "up" in argv]

    def requests(self):
        return [(method, path) for _at, method, path, _body in list(self.board.events)]

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def where(self, result):
        return (f"exit={result.returncode} requests={self.requests()[:12]!r} "
                f"mvn={len(self.mvn_calls())} docker-up={self.docker_ups()!r} "
                f"stdout={result.stdout[-700:]!r} stderr={result.stderr[-700:]!r}")

    # ── assertions ──────────────────────────────────────────────────────────

    def assert_refused_before_anything(self, result, where, *named, health_read=False):
        detail = f"{where}: {self.where(result)}"
        self.assertNotEqual(result.returncode, 0, f"the refusal exits non-zero; {detail}")
        axi = _envelope(result.stdout)
        self.assertIsNotNone(axi, f"one envelope on stdout; {detail}")
        self.assertIs((axi or {}).get("ok"), False, f"the envelope is ok:false; {detail}")
        said = _said(axi)
        for text in named:
            self.assertIn(text, said, f"the refusal names {text!r}; {detail}")
        self.assertEqual(self.mvn_calls(), [], f"maven never ran; {detail}")
        self.assertEqual(self.docker_ups(), [], f"docker-up never ran; {detail}")
        allowed = [("GET", path) for path in HEALTH_PATHS] if health_read else []
        stray = [r for r in self.requests() if r not in allowed]
        self.assertEqual(stray, [], f"no board call before the refusal; {detail}")

    def assert_ran(self, result, where):
        detail = f"{where}: {self.where(result)}"
        self.assertEqual(len(self.mvn_calls()), 1, f"maven ran once; {detail}")
        self.assertEqual(result.returncode, 0, f"the run passed; {detail}")
        self.assertIs((_envelope(result.stdout) or {}).get("ok"), True, detail)
        self.assertEqual(len(self.posts_to(RUNS)), 1, f"the run is filed once; {detail}")


# ── the declaration at fault is refused before anything runs ───────────────

class AMavenDeclarationAtFaultIsRefusedBeforeAnythingRunsTest(_MavenProject):

    def test_each_entry_at_fault_under_the_runs_key_is_refused_naming_table_and_field(self):
        for label, body, field in REFUSED_ENTRIES:
            with self.subTest(entry=label):
                self.fresh_board()
                self.declare({"unit": body})
                result = self.drive("test")
                self.assert_refused_before_anything(result, label, "targets.unit", field)

    def test_every_verb_refuses_an_entry_at_fault_under_its_own_key(self):
        for label, verb, extra, key in VERBS:
            with self.subTest(verb=label):
                self.fresh_board()
                self.declare({key: AT_FAULT})
                result = self.drive(verb, *extra)
                self.assert_refused_before_anything(result, label, f"targets.{key}",
                                                    "framework")

    def test_a_project_file_that_does_not_parse_is_refused(self):
        self.copied_install(f"[client]\nurl = {json.dumps(self.board.url)}\n")
        for label, verb, extra in (("test", "test", ()),
                                   ("e2e --with-docker", "e2e", ("--with-docker", *COMPOSE)),
                                   ("pre-merge-gate", "pre-merge-gate", COMPOSE)):
            with self.subTest(verb=label):
                self.fresh_board()
                Path(self.project, "crucible.toml").write_text("[targets.unit\n")
                result = self.drive(verb, *extra)
                self.assert_refused_before_anything(result, label, "crucible.toml")


class ABoardListingNoSurefireConsoleIsRefusedTest(_MavenProject):

    def test_a_declared_console_on_a_board_listing_no_surefire_console_is_refused(self):
        for health_view in (("bun-console",), None):
            for label, verb, extra, key in VERBS:
                if label not in ("test", "e2e --with-docker", "regression", "pre-merge-gate"):
                    continue
                with self.subTest(verb=label, view=health_view):
                    board = self.fresh_board()
                    board.script_health(self.view_listing_health(health_view))
                    self.declare({key: ENTRY})
                    result = self.drive(verb, *extra)
                    self.assert_refused_before_anything(result, label, VIEW_CODEC,
                                                        "codecs.view", health_read=True)

    def test_a_declared_console_on_a_board_listing_surefire_console_is_not_refused(self):
        self.board.script_health(self.view_listing_health())
        self.declare({"unit": ENTRY})
        result = self.drive("test")
        self.assert_ran(result, "declared, board lists surefire-console")

    def test_an_unreadable_health_refuses_nothing(self):
        self.declare({"unit": ENTRY})
        self.board.fail_health()
        result = self.drive("test")
        self.assertEqual(len(self.mvn_calls()), 1, f"maven ran; {self.where(result)}")
        self.assertNotIn(VIEW_CODEC, _said(_envelope(result.stdout)),
                         f"no surefire-console refusal; {self.where(result)}")


# ── only the run's own maven entry declares it ──────────────────────────────

class OnlyTheRunsOwnMavenEntryDeclaresItTest(_MavenProject):

    def test_an_entry_at_fault_under_every_other_key_refuses_nothing(self):
        for label, verb, extra, key in VERBS:
            with self.subTest(verb=label):
                self.fresh_board()
                self.declare({other: AT_FAULT for other in (*KEYS, "test") if other != key})
                result = self.drive(verb, *extra)
                self.assert_ran(result, f"{label} with every key but {key} at fault")

    def test_another_stacks_entry_under_the_runs_key_is_skipped_not_refused(self):
        for body in OTHER_STACKS:
            for label, verb, extra, key in (VERBS[0], VERBS[6], VERBS[8]):
                with self.subTest(entry=body.splitlines()[0], verb=label):
                    self.fresh_board()
                    self.declare({key: body})
                    result = self.drive(verb, *extra)
                    self.assert_ran(result, f"{label} under {body.splitlines()[0]}")

    def test_another_stacks_entry_posts_what_a_project_declaring_nothing_posts(self):
        observed = {}
        for label, entries in (("declaring nothing", {}),
                               ("declaring nextest", {"unit": OTHER_STACKS[0]}),
                               ("declaring bun-test", {"unit": OTHER_STACKS[2]})):
            self.declare(entries)
            self.fresh_board()
            result = self.drive("test")
            axi = _envelope(result.stdout) or {}
            observed[label] = {
                "exit": result.returncode,
                "mvn": self.mvn_calls(),
                "paths": [p for p, _b in self.board.posts() if p != HEARTBEAT],
                "starts": [{k: s.get(k) for k in ("tier", "framework")}
                           for s in self.posts_to("/api/v2/runs/start")],
                "close": [{k: c.get(k) for k in ("codec", "data", "runnerExit", "tier",
                                                 "framework")}
                          for c in self.posts_to(RUNS)],
                "envelope": {k: axi.get(k) for k in ("ok", "run")},
            }
        self.assertEqual(observed["declaring nothing"]["exit"], 0, observed)
        self.assertEqual(observed["declaring nextest"], observed["declaring nothing"])
        self.assertEqual(observed["declaring bun-test"], observed["declaring nothing"])

    def test_a_project_with_no_crucible_toml_runs_undeclared_whatever_the_install_declares(self):
        self.copied_install(f"[client]\nurl = {json.dumps(self.board.url)}\n"
                            f"\n[targets.unit]\n{AT_FAULT}")
        Path(self.project, "crucible.toml").unlink()
        result = self.drive("test")
        self.assert_ran(result, "no project crucible.toml")

    def test_a_verb_with_no_entry_runs_on_a_board_listing_no_view_codec(self):
        self.board.script_health(self.view_listing_health(None))
        self.declare({"regression": ENTRY})
        result = self.drive("test")
        self.assert_ran(result, "undeclared unit, board lists no view codec")


if __name__ == "__main__":
    unittest.main()
