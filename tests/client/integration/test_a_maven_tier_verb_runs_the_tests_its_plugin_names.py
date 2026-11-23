"""A maven tier verb runs the tests its plugin names.

The maven client's tier verbs hand maven the lifecycle split its own plugins
make, and file only what the verb names:

  - `unit` runs `mvn clean test [-Dtest=<pattern>]` and files surefire;
  - `integration` runs `mvn clean verify -Dtest='!*'
    -Dsurefire.failIfNoSpecifiedTests=false` and files failsafe only;
  - `module` runs `mvn clean test -pl <m> [-am]`, and with no `--module` and
    no declared `module` profile it is refused (`tier-run-undeclared`);
  - `e2e` and `bdd` run only a declared profile;
  - a pom.xml profile whose id is the tier takes the verb over: `clean test
    -P<tier>` for `unit` and `module`, `clean verify -P<tier>` for
    `integration`, `e2e` and `bdd`, filing every report the run wrote;
  - `--profile` is checked before maven runs: refused on a declared tier, and
    refused for an id no pom.xml under the maven directory and no
    `~/.m2/settings.xml` declares (`?id` and `!id` pass through);
  - a selection that ran no test is refused after maven exits and before
    anything is filed (`tier-selection-empty`): no compile record, no second
    maven run, the opened run aborted;
  - `regression` and the gate keep their one run, and a gate row covering a
    declared profile says the profile was not activated.

Every test but the real-maven class drives the real `clients/mvn-crucible.py`
as a subprocess, from a scratch project it owns, against a loopback
`RecordingBoard` the project declares in its own `crucible.toml`. Maven is the
lifecycle-aware fake `tests/client/fake_mvn.py`, first on `PATH`, building the
JSON project model each test writes; it records every argv it is handed, so a
test asserts what maven was asked to run, and writes its reports where real
surefire and failsafe 3.5.4 write them. `HOME` is a scratch directory each
test owns, so no operator `~/.m2/settings.xml` is ever read.

`TheSplitOnRealMavenTest` runs real maven, offline, on a copy of
`tests/fixtures/failsafe-live-project` against the suite's own maven
repository (`.cache/test-suite/m2`, filled by
`scripts/provision-test-caches.sh` and stamped `failsafe-provision.stamp`). A
missing `mvn` or `java`, or a repository not provisioned for that fixture's
pom.xml, FAILS those tests naming what is missing, as the live surefire module
does; nothing is skipped.

TIER: integration (a client subprocess, a fake or real `mvn` subprocess, a
loopback HTTP board).

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_maven_tier_verb_runs_the_tests_its_plugin_names
"""

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tests.client.fake_mvn import launcher_text, read_calls, write_project
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
REAL_TIMEOUT = 600
PROJECT_KEY = "mvn-tier-plugins-key"

START = "/api/v2/runs/start"
RUNS = "/api/v2/runs"
COMPILE = "/api/v2/runs/compile"
UNREGISTER = "/api/v2/agents/unregister"

TIER_SELECTION_EMPTY = "tier-selection-empty"
TIER_RUN_UNDECLARED = "tier-run-undeclared"

# The argv elements S1 names for an undeclared `integration`, each one element.
SKIP_SUREFIRE = ("-Dtest=!*", "-Dsurefire.failIfNoSpecifiedTests=false")

# The tests a project holds: surefire's `*Test`, failsafe's `*IT`.
FOO_TEST = "live.FooTest#adds"
FOO_IT = "live.FooIT#integrates"

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "failsafe-live-project"
SUITE_MAVEN_REPO = REPO_ROOT / ".cache" / "test-suite" / "m2"
FAILSAFE_STAMP = "failsafe-provision.stamp"
PROVISION_SCRIPT = "scripts/provision-test-caches.sh"

_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_COVERAGE_PROFILE",
             "MVN_CRUCIBLE_PROJECT_DIR", "MVN_CRUCIBLE_MAVEN_DIR",
             "MVN_CRUCIBLE_COMPOSE_FILE", "FAKE_MVN_COMPILE_ERROR", "MAVEN_OPTS",
             "MAVEN_ARGS")

_REPORTS_DIRECTORY = re.compile(r"^-D(surefire|failsafe)\.reportsDirectory=")
_SUITE_NAME = re.compile(r"<testsuite\b[^>]*?\sname=\"([^\"]+)\"")


def _write_script(path, body):
    Path(path).write_text(body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


def _pom(profiles=(), artifact="failsafe-live"):
    ids = "".join(f"<profile><id>{p}</id></profile>" for p in profiles)
    block = f"  <profiles>{ids}</profiles>\n" if profiles else ""
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<project xmlns="http://maven.apache.org/POM/4.0.0">\n'
            '  <modelVersion>4.0.0</modelVersion>\n'
            f'  <groupId>live</groupId>\n  <artifactId>{artifact}</artifactId>\n'
            f'  <version>1</version>\n{block}</project>\n')


def _settings(profiles):
    ids = "".join(f"<profile><id>{p}</id></profile>" for p in profiles)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">\n'
            f'  <profiles>{ids}</profiles>\n</settings>\n')


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout or "")
    except ValueError:
        return None
    axi = decoded.get("axi") if isinstance(decoded, dict) else None
    return axi if isinstance(axi, dict) else None


def _codes(value):
    """Every value of a `code` key anywhere in an envelope."""
    found = []
    if isinstance(value, dict):
        for key, inner in value.items():
            if key == "code" and isinstance(inner, str):
                found.append(inner)
            else:
                found.extend(_codes(inner))
    elif isinstance(value, list):
        for inner in value:
            found.extend(_codes(inner))
    return found


def _said(axi):
    """What an envelope says, past the verb it names and its context."""
    return json.dumps({k: v for k, v in (axi or {}).items()
                       if k not in ("verb", "context")})


def _spec_argv(argv):
    """An argv as the spec states it: `(goals, flags)`. The client's own
    batch-mode `-B` and its `-D<plugin>.reportsDirectory=` are dropped (both
    are carried on every run today and the spec's argv leaves them out);
    `-P x` is spelled `-Px`, and `-pl m` is the one flag `-pl m`."""
    goals, flags = [], []
    i = 0
    while i < len(argv):
        arg = argv[i]
        value = argv[i + 1] if i + 1 < len(argv) else None
        if arg == "-B" or _REPORTS_DIRECTORY.match(arg):
            i += 1
            continue
        if arg in ("-P", "-pl") and value is not None:
            flags.append(f"-P{value}" if arg == "-P" else f"-pl {value}")
            i += 2
            continue
        (flags if arg.startswith("-") else goals).append(arg)
        i += 1
    return goals, flags


def _profiles(argv):
    """Every profile id an argv activates or names, comma lists split."""
    _goals, flags = _spec_argv(argv)
    return [p for f in flags if f.startswith("-P") for p in f[2:].split(",") if p]


def _suites(body):
    """The testsuite names of the report texts one `/api/v2/runs` body sent."""
    return sorted(name for text in (body or {}).get("data") or []
                  for name in _SUITE_NAME.findall(text or ""))


class _MavenTierProject(unittest.TestCase):
    """A scratch maven project built by the fake `mvn` first on PATH, with
    its own HOME, filing to its own `RecordingBoard`."""

    maxDiff = 4000

    def setUp(self):
        self.project = new_scratch("mvn-tier-plugins-")
        self.bin_dir = new_scratch("mvn-tier-plugins-bin-")
        self.home = new_scratch("mvn-tier-plugins-home-")
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        for path in (self.project, self.bin_dir, self.home):
            self.addCleanup(shutil.rmtree, path, True)
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n")
        _write_script(os.path.join(self.bin_dir, "mvn"), launcher_text())
        _write_script(os.path.join(self.bin_dir, "docker"),
                      "#!" + sys.executable + "\nimport sys\nsys.exit(0)\n")
        self.model_path = os.path.join(self.bin_dir, "project.json")
        self.calls_path = os.path.join(self.bin_dir, "mvn-calls.jsonl")
        self.profiles = []
        self.model = {"group": "live", "artifact": "failsafe-live",
                      "modules": [{"name": "", "tests": [FOO_TEST], "its": [FOO_IT],
                                   "failsafe": True}],
                      "profiles": []}
        self.write_pom()

    # ── the project ────────────────────────────────────────────────────────

    def write_pom(self):
        Path(self.project, "pom.xml").write_text(_pom(self.profiles))

    def declare_profiles(self, *ids, failsafe=False):
        """Profiles in the root pom.xml, each also in the fake's model; a
        `failsafe` profile binds failsafe as a project's own profile would."""
        self.profiles += list(ids)
        self.model["profiles"] += [{"id": p, "failsafe": failsafe} for p in ids]
        self.write_pom()

    def project_without_failsafe_tests(self):
        self.model["modules"][0]["its"] = []

    def project_without_failsafe(self):
        self.model["modules"][0]["failsafe"] = False

    def reactor(self):
        """A two-module reactor, `alpha` and `beta`, each with a Test and an
        IT, failsafe bound in both."""
        self.model["modules"] = [
            {"name": m, "tests": [f"live.{m.capitalize()}Test#adds"],
             "its": [f"live.{m.capitalize()}IT#integrates"], "failsafe": True}
            for m in ("alpha", "beta")]
        for module in ("alpha", "beta"):
            Path(self.project, module).mkdir(exist_ok=True)
            Path(self.project, module, "pom.xml").write_text(_pom(artifact=module))

    # ── the drive ──────────────────────────────────────────────────────────

    def drive(self, verb, *extra, agent=None, **env_extra):
        write_project(self.model_path, self.model)
        env = scrubbed_env(self.bin_dir)
        for key in _SCRUBBED:
            env.pop(key, None)
        env.update({"HOME": self.home, "FAKE_MVN_PROJECT": self.model_path,
                    "FAKE_MVN_CALLS": self.calls_path})
        env.update({k: str(v) for k, v in env_extra.items()})
        argv = [verb, "--project-dir", self.project]
        if agent:
            argv += ["--agent", agent]
        argv += list(extra)
        return subprocess.run([sys.executable, str(MVN_CLIENT), *argv],
                              cwd=self.project, env=env, capture_output=True,
                              text=True, timeout=TIMEOUT, check=False)

    @staticmethod
    def where(result):
        return (f"exit={result.returncode} stdout={result.stdout[-1500:]!r} "
                f"stderr={result.stderr[-2500:]!r}")

    def mvn_calls(self):
        return [c["argv"] for c in read_calls(self.calls_path)]

    def the_one_mvn_call(self, result):
        calls = self.mvn_calls()
        self.assertEqual(len(calls), 1, f"maven ran once; calls={calls!r} {self.where(result)}")
        return calls[0] if calls else []

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def envelope_of(self, result):
        axi = _envelope(result.stdout)
        self.assertIsNotNone(axi, f"stdout is one TOON envelope; {self.where(result)}")
        return axi or {}

    # ── what maven was handed ──────────────────────────────────────────────

    def assertArgv(self, argv, goals, flags):
        """`argv` is the spec's: exactly these goals, in order, and exactly
        these flags, in any order (the client's `-B` and reportsDirectory
        properties aside)."""
        got_goals, got_flags = _spec_argv(argv)
        self.assertEqual(got_goals, list(goals), f"the goals; argv={argv!r}")
        self.assertCountEqual(got_flags, list(flags), f"the flags; argv={argv!r}")

    # ── what the board was sent ────────────────────────────────────────────

    def assertFiledUnder(self, result, tier, suites):
        """One run opened and one filed under `tier`, carrying exactly the
        reports of `suites`."""
        self.assertEqual([s.get("tier") for s in self.posts_to(START)], [tier],
                         f"one run opened under {tier}; {self.where(result)}")
        closes = self.posts_to(RUNS)
        self.assertEqual([c.get("tier") for c in closes], [tier],
                         f"one run filed under {tier}; {self.where(result)}")
        self.assertEqual(_suites(closes[0] if closes else None), sorted(suites),
                         f"the reports filed; {self.where(result)}")

    def assertNothingFiled(self, result):
        self.assertEqual(self.posts_to(START), [], f"no run opened; {self.where(result)}")
        self.assertEqual(self.posts_to(COMPILE), [],
                         f"no compile record; {self.where(result)}")
        self.assertEqual(self.posts_to(RUNS), [], f"no run filed; {self.where(result)}")

    def assertRefusedBeforeMavenRan(self, result, *named):
        """`ok: false`, a non-zero exit, each of `named` in what the envelope
        says, no maven call at all and nothing filed."""
        axi = self.envelope_of(result)
        self.assertIs(axi.get("ok"), False, self.where(result))
        self.assertNotEqual(result.returncode, 0, self.where(result))
        for text in named:
            self.assertIn(text, _said(axi), f"the refusal names {text!r}; envelope={axi!r}")
        self.assertEqual(self.mvn_calls(), [], f"refused before maven runs; {self.where(result)}")
        self.assertNothingFiled(result)
        return axi

    def assertUndeclared(self, result, *help_names):
        """The shared `tier-run-undeclared` refusal: `ok: false`, exit 1, no
        maven call and no board call at all."""
        axi = self.envelope_of(result)
        self.assertIs(axi.get("ok"), False, self.where(result))
        self.assertEqual(result.returncode, 1, self.where(result))
        self.assertTrue(TIER_RUN_UNDECLARED in _codes(axi)
                        or TIER_RUN_UNDECLARED in result.stderr,
                        f"answers {TIER_RUN_UNDECLARED}; {self.where(result)}")
        help_text = " ".join(str(line) for line in axi.get("help") or [])
        for name in help_names:
            self.assertIn(name, help_text, f"the help names {name!r}; help={help_text!r}")
        self.assertEqual(self.mvn_calls(), [], f"no maven run; {self.where(result)}")
        self.assertEqual(self.board.events, [],
                         f"no board call; events={[e[1:3] for e in self.board.events]!r}")


# ── AC2 — the argv ─────────────────────────────────────────────────────────


class TheArgvATierVerbHandsMavenTest(_MavenTierProject):
    """S1's argv for `integration`, S2's for `unit`, S3's `module`, and S5's
    for every declared tier, as the fake `mvn` received them."""

    def test_integration_hands_maven_clean_verify_with_surefire_selecting_nothing(self):
        result = self.drive("integration", agent="mvn-argv-integration")
        self.assertArgv(self.the_one_mvn_call(result), ["clean", "verify"], SKIP_SUREFIRE)

    def test_integration_without_an_agent_hands_maven_the_same_argv(self):
        result = self.drive("integration")
        self.assertArgv(self.the_one_mvn_call(result), ["clean", "verify"], SKIP_SUREFIRE)
        self.assertEqual(self.board.posts(), [], self.where(result))

    def test_integration_files_only_failsafes_reports_under_integration(self):
        result = self.drive("integration", agent="mvn-argv-integration-filed")
        self.assertFiledUnder(result, "integration", ["live.FooIT"])

    def test_integration_carries_the_users_maven_flags(self):
        self.reactor()
        result = self.drive("integration", "--module", "beta", "--also-make",
                            agent="mvn-argv-integration-flags")
        self.assertArgv(self.the_one_mvn_call(result), ["clean", "verify"],
                        SKIP_SUREFIRE + ("-pl beta", "-am"))
        self.assertFiledUnder(result, "integration", ["live.BetaIT"])

    def test_a_system_prop_setting_test_on_integration_is_refused_before_maven_runs(self):
        result = self.drive("integration", "--system-prop", "test=x",
                            agent="mvn-argv-integration-test-prop")
        self.assertRefusedBeforeMavenRan(result, "test")

    def test_unit_hands_maven_clean_test_and_no_test_pattern(self):
        """Passes today: S2, `unit` is unchanged."""
        result = self.drive("unit", agent="mvn-argv-unit")
        self.assertArgv(self.the_one_mvn_call(result), ["clean", "test"], [])
        self.assertFiledUnder(result, "unit", ["live.FooTest"])

    def test_unit_with_a_test_pattern_hands_maven_that_pattern(self):
        """Passes today: S2, `-Dtest` only with `--test`."""
        result = self.drive("unit", "--test", "FooTest", agent="mvn-argv-unit-test")
        self.assertArgv(self.the_one_mvn_call(result), ["clean", "test"], ["-Dtest=FooTest"])

    def test_module_with_a_module_hands_maven_pl_that_module(self):
        """Passes today: S3, `module --module <m>` runs as today."""
        self.reactor()
        result = self.drive("module", "--module", "alpha", agent="mvn-argv-module")
        self.assertArgv(self.the_one_mvn_call(result), ["clean", "test"], ["-pl alpha"])
        self.assertFiledUnder(result, "module", ["live.AlphaTest"])

    def test_module_without_a_module_or_a_declared_profile_is_refused(self):
        self.reactor()
        result = self.drive("module", agent="mvn-argv-module-refused")
        self.assertUndeclared(result, "--module", "profile")

    def test_module_without_a_module_is_refused_without_an_agent(self):
        self.reactor()
        self.assertUndeclared(self.drive("module"), "--module", "profile")

    def drive_declared(self, tier, *extra):
        self.declare_profiles(tier)
        result = self.drive(tier, *extra, agent=f"mvn-argv-declared-{tier}")
        argv = self.the_one_mvn_call(result)
        _goals, flags = _spec_argv(argv)
        self.assertNotIn("-Dtest=!*", flags, f"a declared profile decides; argv={argv!r}")
        return result, argv

    def test_a_declared_unit_profile_runs_clean_test_minus_p_unit(self):
        result, argv = self.drive_declared("unit")
        self.assertArgv(argv, ["clean", "test"], ["-Punit"])
        self.assertFiledUnder(result, "unit", ["live.FooTest"])

    def test_a_declared_unit_profile_keeps_the_test_pattern(self):
        _result, argv = self.drive_declared("unit", "--test", "FooTest")
        self.assertArgv(argv, ["clean", "test"], ["-Punit", "-Dtest=FooTest"])

    def test_a_declared_module_profile_runs_clean_test_minus_p_module(self):
        result, argv = self.drive_declared("module")
        self.assertArgv(argv, ["clean", "test"], ["-Pmodule"])
        self.assertFiledUnder(result, "module", ["live.FooTest"])

    def test_a_declared_module_profile_keeps_the_module(self):
        self.reactor()
        _result, argv = self.drive_declared("module", "--module", "alpha")
        self.assertArgv(argv, ["clean", "test"], ["-Pmodule", "-pl alpha"])

    def test_a_declared_integration_profile_runs_clean_verify_and_files_every_report(self):
        result, argv = self.drive_declared("integration")
        self.assertArgv(argv, ["clean", "verify"], ["-Pintegration"])
        self.assertFiledUnder(result, "integration", ["live.FooIT", "live.FooTest"])

    def test_a_declared_e2e_profile_runs_clean_verify_minus_p_e2e(self):
        result, argv = self.drive_declared("e2e")
        self.assertArgv(argv, ["clean", "verify"], ["-Pe2e"])
        self.assertFiledUnder(result, "e2e", ["live.FooIT", "live.FooTest"])

    def test_a_declared_bdd_profile_runs_clean_verify_minus_p_bdd(self):
        result, argv = self.drive_declared("bdd")
        self.assertArgv(argv, ["clean", "verify"], ["-Pbdd"])
        self.assertFiledUnder(result, "bdd", ["live.FooIT", "live.FooTest"])


# ── AC3 — e2e and bdd are declared-only ────────────────────────────────────


class E2eAndBddAreDeclaredOnlyTest(_MavenTierProject):
    """With no declared profile `e2e` and `bdd` answer `tier-run-undeclared`
    with no maven run and no board call; `e2e --failsafe-only` files only
    the failsafe reports its own run wrote."""

    def test_an_undeclared_e2e_answers_tier_run_undeclared(self):
        self.assertUndeclared(self.drive("e2e", agent="mvn-e2e-undeclared"), "-Pe2e")

    def test_an_undeclared_e2e_answers_tier_run_undeclared_without_an_agent(self):
        self.assertUndeclared(self.drive("e2e"), "-Pe2e")

    def test_an_undeclared_bdd_answers_tier_run_undeclared(self):
        """Passes today: the guard that `bdd` stays declared-only."""
        self.assertUndeclared(self.drive("bdd", agent="mvn-bdd-undeclared"), "-Pbdd")

    def runs_today(self, result):
        """The help line of a `tier-run-undeclared` refusal that names the
        tier verbs this client runs."""
        lines = [str(line) for line in self.envelope_of(result).get("help") or []
                 if str(line).startswith("tier verbs this client runs today")]
        self.assertEqual(len(lines), 1, self.where(result))
        return lines[0] if lines else None

    def test_an_undeclared_bdd_names_the_tiers_an_undeclared_e2e_names(self):
        bdd = self.runs_today(self.drive("bdd"))
        e2e = self.runs_today(self.drive("e2e"))
        self.assertEqual(bdd, "tier verbs this client runs today: integration, regression, unit")
        self.assertEqual(bdd, e2e)

    def test_an_undeclared_bdd_names_a_tier_the_project_declares(self):
        self.declare_profiles("module")
        self.assertEqual(self.runs_today(self.drive("bdd")),
                         "tier verbs this client runs today: integration, module, "
                         "regression, unit")

    def test_a_declared_e2e_failsafe_only_files_only_the_failsafe_reports_its_run_wrote(self):
        self.declare_profiles("e2e")
        target = Path(self.project, "target")
        # The package a previous build left: compiled tests, a surefire report
        # and an IT report that this run does not write.
        (target / "test-classes").mkdir(parents=True)
        stale = {target / "surefire-reports" / "TEST-live.FooTest.xml": "live.FooTest",
                 target / "failsafe-reports" / "TEST-live.OldIT.xml": "live.OldIT"}
        an_hour_ago = time.time() - 3600
        for path, name in stale.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('<?xml version="1.0" encoding="UTF-8"?>\n'
                            f'<testsuite name="{name}" tests="1" errors="0" '
                            f'skipped="0" failures="0">\n  <testcase name="stale" '
                            f'classname="{name}" time="0.001"/>\n</testsuite>')
            os.utime(path, (an_hour_ago, an_hour_ago))
        result = self.drive("e2e", "--failsafe-only", agent="mvn-e2e-failsafe-only")
        self.assertArgv(self.the_one_mvn_call(result),
                        ["failsafe:integration-test", "failsafe:verify"], ["-Pe2e"])
        self.assertFiledUnder(result, "e2e", ["live.FooIT"])


# ── AC4 — `--profile` is checked before maven runs ─────────────────────────


class TheProfileFlagIsCheckedBeforeMavenRunsTest(_MavenTierProject):
    """A `--profile` on a declared tier, and an id no pom.xml under the maven
    directory and no `~/.m2/settings.xml` declares, are refused before maven
    runs; `?id` and `!id` pass through."""

    def assertErrorNamesTheDeclaredProfile(self, axi, tier):
        error = str(axi.get("error") or "")
        self.assertIn(f"`{tier}` profile", error, f"envelope={axi!r}")
        self.assertIn(os.path.join(self.project, "pom.xml"), error, f"envelope={axi!r}")

    def test_a_profile_on_a_tier_with_a_declared_profile_is_refused_naming_it(self):
        self.declare_profiles("integration", "coverage")
        result = self.drive("integration", "--profile", "coverage",
                            agent="mvn-profile-declared-tier")
        axi = self.assertRefusedBeforeMavenRan(result, "coverage")
        self.assertErrorNamesTheDeclaredProfile(axi, "integration")

    def test_a_profile_on_a_declared_unit_tier_is_refused_without_an_agent(self):
        self.declare_profiles("unit", "coverage")
        result = self.drive("unit", "--profile", "coverage")
        axi = self.assertRefusedBeforeMavenRan(result, "coverage")
        self.assertErrorNamesTheDeclaredProfile(axi, "unit")

    def test_an_undeclared_profile_id_is_refused_naming_the_id(self):
        result = self.drive("unit", "--profile", "nosuchprofile", agent="mvn-profile-unknown")
        self.assertRefusedBeforeMavenRan(result, "nosuchprofile")

    def test_an_undeclared_profile_id_on_integration_is_refused_naming_the_id(self):
        result = self.drive("integration", "--profile", "nosuchprofile")
        self.assertRefusedBeforeMavenRan(result, "nosuchprofile")

    def test_a_comma_list_is_checked_id_by_id(self):
        self.declare_profiles("coverage")
        result = self.drive("unit", "--profile", "coverage,nosuchprofile",
                            agent="mvn-profile-comma")
        self.assertRefusedBeforeMavenRan(result, "nosuchprofile")

    def test_an_id_declared_only_under_target_is_refused(self):
        build = Path(self.project, "target")
        build.mkdir()
        (build / "pom.xml").write_text(_pom(["builtonly"]))
        result = self.drive("unit", "--profile", "builtonly", agent="mvn-profile-target")
        self.assertRefusedBeforeMavenRan(result, "builtonly")

    def test_an_id_declared_only_under_a_hidden_directory_is_refused(self):
        hidden = Path(self.project, ".cache", "copy")
        hidden.mkdir(parents=True)
        (hidden / "pom.xml").write_text(_pom(["hiddenonly"]))
        result = self.drive("unit", "--profile", "hiddenonly", agent="mvn-profile-hidden")
        self.assertRefusedBeforeMavenRan(result, "hiddenonly")

    def test_an_id_declared_only_under_node_modules_is_refused(self):
        vendored = Path(self.project, "node_modules", "pkg")
        vendored.mkdir(parents=True)
        (vendored / "pom.xml").write_text(_pom(["vendoredonly"]))
        result = self.drive("unit", "--profile", "vendoredonly", agent="mvn-profile-vendored")
        self.assertRefusedBeforeMavenRan(result, "vendoredonly")

    def test_an_id_declared_in_the_root_pom_runs_with_it(self):
        """Passes today: the guard that a declared id is not refused."""
        self.declare_profiles("coverage")
        result = self.drive("unit", "--profile", "coverage", agent="mvn-profile-root")
        self.assertEqual(_profiles(self.the_one_mvn_call(result)), ["coverage"],
                         self.where(result))
        self.assertFiledUnder(result, "unit", ["live.FooTest"])

    def test_an_id_declared_in_a_modules_pom_runs_with_it(self):
        """Passes today: any pom.xml under the maven directory declares."""
        self.reactor()
        Path(self.project, "alpha", "pom.xml").write_text(_pom(["fromalpha"], artifact="alpha"))
        result = self.drive("unit", "--profile", "fromalpha", agent="mvn-profile-module")
        self.assertEqual(_profiles(self.the_one_mvn_call(result)), ["fromalpha"],
                         self.where(result))

    def test_an_id_declared_only_in_the_users_settings_xml_runs_with_it(self):
        """Passes today: `~/.m2/settings.xml`, under this test's own HOME."""
        settings = Path(self.home, ".m2", "settings.xml")
        settings.parent.mkdir(parents=True)
        settings.write_text(_settings(["fromsettings"]))
        result = self.drive("unit", "--profile", "fromsettings", agent="mvn-profile-settings")
        self.assertEqual(_profiles(self.the_one_mvn_call(result)), ["fromsettings"],
                         self.where(result))

    def test_an_optional_id_passes_through_unchecked(self):
        """Passes today: `?x` is maven's to resolve."""
        result = self.drive("unit", "--profile", "?x", agent="mvn-profile-optional")
        self.assertEqual(_profiles(self.the_one_mvn_call(result)), ["?x"], self.where(result))

    def test_a_deactivated_id_passes_through_unchecked(self):
        """Passes today: `!x` is maven's to resolve."""
        result = self.drive("unit", "--profile", "!x", agent="mvn-profile-deactivate")
        self.assertEqual(_profiles(self.the_one_mvn_call(result)), ["!x"], self.where(result))

    def test_a_minus_deactivated_id_passes_through_unchecked(self):
        """Maven's older `-x` deactivation is maven's to resolve."""
        result = self.drive("unit", "--profile=-x", agent="mvn-profile-minus")
        self.assertEqual(_profiles(self.the_one_mvn_call(result)), ["-x"], self.where(result))

    def test_a_plus_activated_id_passes_through_unchecked(self):
        """Maven's older `+x` activation is maven's to resolve."""
        result = self.drive("unit", "--profile=+x", agent="mvn-profile-plus")
        self.assertEqual(_profiles(self.the_one_mvn_call(result)), ["+x"], self.where(result))


# ── AC5 — an empty selection is refused ────────────────────────────────────


class AnEmptySelectionIsRefusedTest(_MavenTierProject):
    """After maven exits and before anything is filed: `ok: false`,
    `tier-selection-empty`, exit 1, no compile record and no second maven
    run; with an agent the opened run is aborted and the run's identity
    closed, without one nothing is posted. A real compile error still files
    its compile record."""

    def setUp(self):
        super().setUp()
        # The identity heartbeat answers that it created the agent row, so
        # the closing bracket removes it.
        self.board.answer("POST", "/api/v2/agents/heartbeat",
                          {"ok": True, "changed": True})

    def assertSelectionEmpty(self, result, *named, agent=None):
        axi = self.envelope_of(result)
        self.assertIs(axi.get("ok"), False, self.where(result))
        self.assertEqual(result.returncode, 1, self.where(result))
        self.assertIn(TIER_SELECTION_EMPTY, _codes(axi), f"envelope={axi!r}")
        for text in named:
            self.assertIn(text, _said(axi), f"the answer names {text!r}; envelope={axi!r}")
        self.assertEqual(len(self.mvn_calls()), 1,
                         f"no second maven run; calls={self.mvn_calls()!r}")
        self.assertEqual(self.posts_to(COMPILE), [], f"no compile record; {self.where(result)}")
        self.assertEqual(self.posts_to(RUNS), [], f"nothing filed; {self.where(result)}")
        if agent is None:
            self.assertEqual(self.board.posts(), [], f"nothing posted; {self.where(result)}")
            return
        opened = self.board.run_ids_opened()
        self.assertEqual(len(opened), 1, f"the run was opened; {self.where(result)}")
        aborts = self.board.aborts()
        self.assertEqual([path for path, _body in aborts],
                         [f"/api/v2/runs/{opened[0]}/abort"] if opened else [],
                         f"the opened run is aborted; {self.where(result)}")
        removed = [b for b in self.posts_to(UNREGISTER)
                   if (b or {}).get("agentId") == agent]
        self.assertEqual(len(removed), 1, f"the run's identity is closed; {self.where(result)}")

    def test_integration_on_a_project_without_failsafe_tests_is_empty(self):
        self.project_without_failsafe_tests()
        result = self.drive("integration", agent="mvn-empty-no-its")
        self.assertSelectionEmpty(result, agent="mvn-empty-no-its")

    def test_integration_on_a_project_without_failsafe_tests_is_empty_without_an_agent(self):
        self.project_without_failsafe_tests()
        self.assertSelectionEmpty(self.drive("integration"))

    def test_integration_on_a_project_without_failsafe_is_empty_naming_failsafe(self):
        self.project_without_failsafe()
        result = self.drive("integration", agent="mvn-empty-no-failsafe")
        self.assertSelectionEmpty(result, "failsafe", agent="mvn-empty-no-failsafe")

    def test_unit_with_a_pattern_matching_nothing_is_empty(self):
        result = self.drive("unit", "--test", "Nope", agent="mvn-empty-nope")
        self.assertSelectionEmpty(result, agent="mvn-empty-nope")

    def test_unit_with_a_pattern_matching_nothing_is_empty_without_an_agent(self):
        self.assertSelectionEmpty(self.drive("unit", "--test", "Nope"))

    def test_an_empty_undeclared_unit_advises_declaring_a_unit_profile(self):
        result = self.drive("unit", "--test", "Nope", agent="mvn-empty-advice")
        self.assertSelectionEmpty(result, "declare a `unit` profile", agent="mvn-empty-advice")

    def test_an_empty_declared_unit_does_not_advise_declaring_its_profile(self):
        self.declare_profiles("unit")
        result = self.drive("unit", "--test", "Nope", agent="mvn-empty-declared")
        self.assertSelectionEmpty(result, agent="mvn-empty-declared")
        self.assertNotIn("declare a `unit` profile", _said(self.envelope_of(result)),
                         self.where(result))

    def test_an_empty_declared_e2e_failsafe_only_does_not_advise_declaring_its_profile(self):
        self.declare_profiles("e2e")
        self.project_without_failsafe_tests()
        result = self.drive("e2e", "--failsafe-only", agent="mvn-empty-declared-e2e")
        self.assertSelectionEmpty(result, "failsafe", agent="mvn-empty-declared-e2e")
        self.assertNotIn("declare a `e2e` profile", _said(self.envelope_of(result)),
                         self.where(result))


class AReactorModuleThatMatchesNothingIsNotAnEmptySelectionTest(_MavenTierProject):
    """A reactor whose `alpha` runs FooTest and whose `gamma` holds only
    GammaTest: `unit --test FooTest` runs FooTest, then surefire fails in
    `gamma` with "No tests matching pattern". The run ran a test, so it is
    not an empty selection: FooTest is filed and the run is not aborted."""

    def setUp(self):
        super().setUp()
        self.model["modules"] = [
            {"name": m, "tests": [test], "its": [], "failsafe": False}
            for m, test in (("alpha", FOO_TEST), ("gamma", "live.GammaTest#adds"))]
        for module in ("alpha", "gamma"):
            Path(self.project, module).mkdir()
            Path(self.project, module, "pom.xml").write_text(_pom(artifact=module))

    def test_with_an_agent_foo_test_is_filed_and_the_run_is_not_aborted(self):
        result = self.drive("unit", "--test", "FooTest", agent="mvn-reactor-unmatched")
        self.assertNotIn(TIER_SELECTION_EMPTY, _codes(self.envelope_of(result)),
                         self.where(result))
        self.assertFiledUnder(result, "unit", ["live.FooTest"])
        self.assertEqual(self.board.aborts(), [], f"no run aborted; {self.where(result)}")
        self.assertEqual(self.posts_to(COMPILE), [], f"no compile record; {self.where(result)}")
        self.assertNotEqual(result.returncode, 0, f"maven failed; {self.where(result)}")

    def test_without_an_agent_the_run_is_not_an_empty_selection(self):
        result = self.drive("unit", "--test", "FooTest")
        self.assertNotIn(TIER_SELECTION_EMPTY, _codes(_envelope(result.stdout)),
                         self.where(result))
        self.assertNotIn(TIER_SELECTION_EMPTY, result.stderr, self.where(result))
        self.assertEqual(len(self.mvn_calls()), 1, self.where(result))
        self.assertNotEqual(result.returncode, 0, f"maven failed; {self.where(result)}")
        self.assertEqual(self.board.posts(), [], f"nothing posted; {self.where(result)}")


# ── S9 — the help says what each verb runs ─────────────────────────────────


class TheHelpSaysWhatEachVerbRunsTest(_MavenTierProject):
    """The root listing's `bdd` line names the declared profile's run, each
    tier verb's own `--help` says what it runs, and `--profile`'s help names
    when it is refused."""

    def help_of(self, *argv):
        env = scrubbed_env(self.bin_dir)
        for key in _SCRUBBED:
            env.pop(key, None)
        env["HOME"] = self.home
        result = subprocess.run([sys.executable, str(MVN_CLIENT), *argv, "--help"],
                                cwd=self.project, env=env, capture_output=True,
                                text=True, timeout=TIMEOUT, check=False)
        self.assertEqual(result.returncode, 0, self.where(result))
        return result.stdout

    def test_the_root_listing_says_a_declared_bdd_profile_runs_clean_verify(self):
        said = " ".join(self.help_of().split())
        self.assertIn("`mvn clean verify -Pbdd`", said)
        self.assertNotIn("No target for it is declared", said)

    def test_each_tier_verbs_own_help_says_what_it_runs(self):
        for verb, runs in (("unit", "`mvn clean test`"),
                           ("module", "`mvn clean test -pl <module> [-am]`"),
                           ("integration", "-Dsurefire.failIfNoSpecifiedTests=false"),
                           ("e2e", "`mvn clean verify -Pe2e`"),
                           ("bdd", "`mvn clean verify -Pbdd`")):
            with self.subTest(verb=verb):
                self.assertIn(runs, " ".join(self.help_of(verb).split()))

    def test_the_profile_flags_help_names_when_it_is_refused(self):
        for verb in ("unit", "module", "integration", "e2e", "bdd"):
            with self.subTest(verb=verb):
                lines = self.help_of(verb).splitlines()
                start = next((i for i, line in enumerate(lines)
                              if line.lstrip().startswith("--profile")), None)
                self.assertIsNotNone(start, f"{verb} --help lists --profile")
                block = [lines[start or 0]]
                for line in lines[(start or 0) + 1:]:
                    if line.lstrip().startswith("-") or not line.strip():
                        break
                    block.append(line)
                said = " ".join(" ".join(block).split())
                self.assertIn("refused", said, f"{verb}: {said!r}")
                self.assertIn("settings.xml", said, f"{verb}: {said!r}")

    def test_a_real_compile_error_still_files_its_compile_record(self):
        """Passes today: the guard that a build failure is never empty."""
        result = self.drive("unit", agent="mvn-empty-compile", FAKE_MVN_COMPILE_ERROR="1")
        compiles = self.posts_to(COMPILE)
        self.assertEqual(len(compiles), 1, self.where(result))
        self.assertIn("cannot find symbol", json.dumps(compiles[0]), f"compiles={compiles!r}")
        self.assertEqual(self.posts_to(RUNS), [], self.where(result))
        self.assertNotIn(TIER_SELECTION_EMPTY, _codes(_envelope(result.stdout)),
                         self.where(result))
        self.assertNotEqual(result.returncode, 0, self.where(result))


# ── AC6 — what stays ───────────────────────────────────────────────────────


class RegressionAndTheGateStayOneRunTest(_MavenTierProject):
    """`regression` hands maven today's argv and is filed once; the gate is
    one run; a declared profile's gate row says it was not activated."""

    def test_regression_hands_maven_todays_argv_and_is_filed_under_regression(self):
        """Passes today: the guard that `regression` keeps its one run."""
        result = self.drive("regression", agent="mvn-stays-regression")
        self.assertArgv(self.the_one_mvn_call(result), ["clean", "verify"], [])
        self.assertFiledUnder(result, "regression", ["live.FooIT", "live.FooTest"])

    def test_the_gate_is_one_run_with_no_profile(self):
        """Passes today: the gate's maven leg is one run, with no `-P`."""
        self.declare_profiles("unit")
        result = self.drive("pre-merge-gate", "--skip-lint", agent="mvn-stays-gate")
        self.assertArgv(self.the_one_mvn_call(result), ["clean", "verify"], [])
        self.assertEqual([s.get("tier") for s in self.posts_to(START)], ["regression"],
                         self.where(result))

    def test_a_declared_profiles_gate_row_says_the_profile_was_not_activated(self):
        self.declare_profiles("unit")
        result = self.drive("pre-merge-gate", "--skip-lint", agent="mvn-stays-gate-row")
        rows = [r for r in self.envelope_of(result).get("suites") or []
                if isinstance(r, dict) and r.get("suite") == "unit"]
        self.assertEqual(len(rows), 1, self.where(result))
        self.assertIn("not activated", json.dumps(rows[0] if rows else {}).lower(),
                      f"row={rows!r}")


# ── AC1 — the split, on real maven ─────────────────────────────────────────


def _maven_env(home, base):
    env = dict(base)
    env["HOME"] = str(home)
    env["MAVEN_OPTS"] = f"-Duser.home={home}"
    return env


def _real_maven_gap():
    """What is missing to run real maven on the fixture, or None."""
    missing = [f"{tool} ({why})" for tool, why in (
        ("mvn", "the client runs real maven"), ("java", "surefire forks a JVM"))
        if shutil.which(tool) is None]
    if missing:
        return "; ".join(missing)
    with tempfile.TemporaryDirectory(prefix="mvn-tier-plugins-version-") as home:
        ran = subprocess.run(["mvn", "--version"], env=_maven_env(home, os.environ),
                             capture_output=True, text=True, check=False, timeout=120)
    found = re.search(r"Apache Maven ([0-9][0-9A-Za-z.-]*)", ran.stdout or "")
    pom = hashlib.sha256((FIXTURE / "pom.xml").read_bytes()).hexdigest()
    expected = f"pom-sha256={pom}\nmaven={found.group(1) if found else None}\n"
    stamp = SUITE_MAVEN_REPO / FAILSAFE_STAMP
    remedy = f"run `{PROVISION_SCRIPT}` to provision it (network needed once)"
    if not stamp.is_file():
        return f"the suite's maven repository {SUITE_MAVEN_REPO} is not provisioned; {remedy}"
    if stamp.read_text(encoding="utf-8").split() != expected.split():
        return (f"the suite's maven repository {SUITE_MAVEN_REPO} was provisioned for "
                f"another failsafe fixture pom.xml or maven; {remedy}")
    return None


class TheSplitOnRealMavenTest(unittest.TestCase):
    """Real maven 3.9 on `tests/fixtures/failsafe-live-project` (surefire and
    failsafe 3.5.4, `FooTest` and `FooIT`, no tier profile), offline on the
    suite's own repository: `unit` files exactly `FooTest` and `integration`
    exactly `FooIT`."""

    maxDiff = 4000

    def setUp(self):
        gap = _real_maven_gap()
        if gap:
            self.fail(f"the real maven split tests need: {gap}")
        scratch = tempfile.mkdtemp(prefix="mvn-tier-plugins-real-")
        self.addCleanup(shutil.rmtree, scratch, True)
        self.project = os.path.join(scratch, "project")
        shutil.copytree(FIXTURE, self.project)
        Path(self.project, ".mvn", "maven.config").write_text(
            f"-o\n-Dmaven.repo.local={SUITE_MAVEN_REPO}\n", encoding="utf-8")
        self.home = os.path.join(scratch, "home")
        os.makedirs(self.home)
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        self.board.script_run(passed=1, total=1, files=1)
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n")

    def drive(self, verb, agent):
        env = scrubbed_env(None)
        for key in _SCRUBBED:
            env.pop(key, None)
        env = _maven_env(self.home, env)
        return subprocess.run(
            [sys.executable, str(MVN_CLIENT), verb, "--project-dir", self.project,
             "--agent", agent],
            cwd=self.project, env=env, capture_output=True, text=True,
            timeout=REAL_TIMEOUT, check=False)

    def assertFiledExactly(self, result, tier, suite):
        where = (f"exit={result.returncode} stdout={result.stdout[-1500:]!r} "
                 f"stderr={result.stderr[-3000:]!r}")
        closes = [b for p, b in self.board.posts() if p == RUNS]
        self.assertEqual([c.get("tier") for c in closes], [tier], where)
        self.assertEqual(_suites(closes[0] if closes else None), [suite], where)
        self.assertEqual(result.returncode, 0, where)

    def test_unit_files_exactly_foo_test_under_unit(self):
        """Passes today: the guard that `unit` stays surefire's."""
        self.assertFiledExactly(self.drive("unit", "mvn-real-unit"), "unit", "live.FooTest")

    def test_integration_files_exactly_foo_it_under_integration(self):
        self.assertFiledExactly(self.drive("integration", "mvn-real-integration"),
                                "integration", "live.FooIT")


if __name__ == "__main__":
    unittest.main()
