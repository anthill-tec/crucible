"""The real maven run reads its artifacts from the suite's own repository.

The live maven module (`test_a_declared_maven_run_shows_its_real_surefire_
console_live_end_to_end`) runs real maven offline against the committed
fixture `tests/fixtures/surefire-live-project`. Maven's offline repository is
the suite's own `<repo>/.cache/test-suite/m2`, never the operator's `~/.m2`:

  - the fixture copy the module builds carries a generated `.mvn/maven.config`
    holding `-o` and `-Dmaven.repo.local=<absolute suite repository>`; the
    committed fixture's own `maven.config` stays `-o`;
  - before any board or copy, the module checks the suite repository's stamp
    (`provision.stamp`: `pom-sha256=<sha256 of the fixture's pom.xml>` and
    `maven=<maven version>`, one per line). No stamp, or a stamp for another
    pom or another maven, and the module FAILS naming
    `scripts/provision-test-caches.sh`; a matching stamp lets it proceed. The
    check reads the stamp, not mere emptiness;
  - `scripts/provision-test-caches.sh` fills the suite repository by running
    the fixture's real lifecycle against it, then writes the stamp, and skips
    when the stamp already matches. No test runs it: it is pinned as a file.

Every test here is UNIT: in process, on temp directories the test owns, with
fakes where maven, a board or a spawn would be. The readiness check is always
pointed at a test-only directory, never the real suite repository.

The module's surface these tests pin (in the live maven module):
  `SUITE_MAVEN_REPO`           the suite repository, read at call time;
  `maven_version()`            the version `mvn --version` reports;
  `maven_repo_gap(repo, ver)`  None when `repo`'s stamp matches, else a
                               message naming the provisioning script;
  `copy_fixture(dest, repo)`   the fixture copied to `dest`, its
                               `.mvn/maven.config` naming `repo`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_maven_fixture_runs_from_a_provisioned_suite_repository
"""

import contextlib
import hashlib
import importlib
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SUITE_CACHE_ROOT = REPO_ROOT / ".cache" / "test-suite"
EXPECTED_SUITE_MAVEN_REPO = SUITE_CACHE_ROOT / "m2"
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "surefire-live-project"
FIXTURE_POM = FIXTURE / "pom.xml"
PROVISION_SCRIPT_REL = "scripts/provision-test-caches.sh"
PROVISION_SCRIPT = REPO_ROOT / "scripts" / "provision-test-caches.sh"
STAMP_NAME = "provision.stamp"
MAVEN_MODULE = ("tests.client."
                "test_a_declared_maven_run_shows_its_real_surefire_console_live_end_to_end")
MAVEN_VERSION = "3.9.9"


def _maven_module():
    return importlib.import_module(MAVEN_MODULE)


def _pom_sha256():
    return hashlib.sha256(FIXTURE_POM.read_bytes()).hexdigest()


def _stamp_text(pom_sha256, maven_version):
    return f"pom-sha256={pom_sha256}\nmaven={maven_version}\n"


def _config_tokens(project):
    return (Path(project) / ".mvn" / "maven.config").read_text(encoding="utf-8").split()


class _TempDirs(unittest.TestCase):

    def temp_dir(self, prefix):
        path = Path(tempfile.mkdtemp(prefix=prefix))
        self.addCleanup(shutil.rmtree, path, ignore_errors=True)
        return path

    def provisioned_repo(self, pom_sha256=None, maven_version=MAVEN_VERSION):
        repo = self.temp_dir("suite-m2-")
        (repo / STAMP_NAME).write_text(
            _stamp_text(pom_sha256 or _pom_sha256(), maven_version), encoding="utf-8")
        return repo


class TheSuiteRepositoryIsTheSuitesOwnTest(_TempDirs):

    def test_the_suite_repository_is_the_git_ignored_cache_under_the_checkout(self):
        repo = _maven_module().SUITE_MAVEN_REPO
        self.assertEqual(Path(repo), EXPECTED_SUITE_MAVEN_REPO,
                         "the suite's maven repository is `<repo>/.cache/test-suite/m2`")
        self.assertTrue(Path(repo).is_absolute(), f"absolute, never relative: {repo!r}")

    def test_the_suite_repository_never_lies_under_the_operators_home(self):
        repo = Path(_maven_module().SUITE_MAVEN_REPO)
        self.assertNotIn(".m2", repo.parts[:-1],
                         f"the suite repository is not inside an `.m2`: {repo}")
        self.assertNotEqual(repo, Path.home() / ".m2" / "repository")
        self.assertFalse(repo.is_relative_to(Path.home() / ".m2"),
                         f"the operator's ~/.m2 is never the suite repository: {repo}")
        self.assertTrue(repo.is_relative_to(REPO_ROOT),
                        f"the suite repository is the checkout's own cache: {repo}")


class TheFixtureCopyNamesTheSuiteRepositoryTest(_TempDirs):

    def test_the_copied_fixtures_maven_config_holds_offline_and_the_absolute_suite_repository(self):
        dest = self.temp_dir("maven-fixture-copy-") / "project"
        repo = self.temp_dir("suite-m2-")
        _maven_module().copy_fixture(dest, repo)
        self.assertEqual(sorted(_config_tokens(dest)),
                         sorted(["-o", f"-Dmaven.repo.local={repo}"]),
                         "the copy's .mvn/maven.config is exactly `-o` beside the "
                         "suite repository")

    def test_the_copy_carries_the_fixtures_pom_and_sources(self):
        dest = self.temp_dir("maven-fixture-copy-") / "project"
        _maven_module().copy_fixture(dest, self.temp_dir("suite-m2-"))
        self.assertEqual((dest / "pom.xml").read_bytes(), FIXTURE_POM.read_bytes())
        for name in ("AlphaTest.java", "BetaTest.java", "GammaTest.java", "Marks.java"):
            self.assertTrue((dest / "src" / "test" / "java" / "live" / name).is_file(),
                            f"the copy carries src/test/java/live/{name}")

    def test_the_committed_fixtures_own_maven_config_stays_offline_only(self):
        dest = self.temp_dir("maven-fixture-copy-") / "project"
        _maven_module().copy_fixture(dest, self.temp_dir("suite-m2-"))
        self.assertEqual(
            (FIXTURE / ".mvn" / "maven.config").read_text(encoding="utf-8").split(), ["-o"],
            "the committed fixture never carries a machine's absolute repository path")


class TheReadinessCheckReadsTheStampTest(_TempDirs):

    def assert_names_the_script(self, gap, why):
        self.assertIsInstance(gap, str, f"{why}: the check must answer a failure, got {gap!r}")
        self.assertIn(PROVISION_SCRIPT_REL, gap,
                      f"{why}: the failure names the provisioning script: {gap!r}")

    def test_an_empty_suite_repository_fails_naming_the_provisioning_script(self):
        repo = self.temp_dir("suite-m2-")
        gap = _maven_module().maven_repo_gap(repo, MAVEN_VERSION)
        self.assert_names_the_script(gap, "an empty suite repository")
        self.assertEqual(list(repo.iterdir()), [], "the check writes nothing into the repository")

    def test_a_missing_suite_repository_fails_naming_the_provisioning_script(self):
        repo = self.temp_dir("suite-m2-parent-") / "never-made"
        gap = _maven_module().maven_repo_gap(repo, MAVEN_VERSION)
        self.assert_names_the_script(gap, "a missing suite repository")
        self.assertFalse(repo.exists(), "the check creates no repository")

    def test_a_filled_repository_without_a_stamp_fails_because_the_check_is_not_mere_emptiness(self):
        repo = self.temp_dir("suite-m2-")
        artifact = repo / "org" / "apache" / "maven" / "plugins" / "maven-surefire-plugin"
        artifact.mkdir(parents=True)
        (artifact / "maven-surefire-plugin-3.5.4.jar").write_bytes(b"jar")
        gap = _maven_module().maven_repo_gap(repo, MAVEN_VERSION)
        self.assert_names_the_script(gap, "artifacts but no stamp")

    def test_a_stamp_for_another_pom_fails_naming_the_provisioning_script(self):
        repo = self.provisioned_repo(pom_sha256=hashlib.sha256(b"another pom").hexdigest())
        gap = _maven_module().maven_repo_gap(repo, MAVEN_VERSION)
        self.assert_names_the_script(gap, "a stamp keyed on another pom.xml")

    def test_a_stamp_for_another_maven_version_fails_naming_the_provisioning_script(self):
        repo = self.provisioned_repo(maven_version="3.8.1")
        gap = _maven_module().maven_repo_gap(repo, MAVEN_VERSION)
        self.assert_names_the_script(gap, "a stamp written by maven 3.8.1, run by 3.9.9")

    def test_a_matching_stamp_lets_the_run_proceed(self):
        repo = self.provisioned_repo()
        self.assertIsNone(_maven_module().maven_repo_gap(repo, MAVEN_VERSION),
                          "a stamp keyed on this pom.xml and this maven is ready")


class TheMavenVersionIsWhatMavenReportsTest(unittest.TestCase):

    def test_the_maven_version_is_read_off_mvn_version_without_running_maven_here(self):
        calls = []

        def fake_run(argv, *args, **kwargs):
            calls.append(list(argv))
            return subprocess.CompletedProcess(
                argv, 0,
                "Apache Maven 3.9.9 (8e8579a9e76f7d015ee5ec7bfcdc97d260186937)\n"
                "Maven home: /opt/maven\nJava version: 21.0.5\n", "")

        mod = _maven_module()
        with mock.patch("shutil.which", return_value="/fake/bin/mvn"), \
                mock.patch("subprocess.run", side_effect=fake_run):
            version = mod.maven_version()
        self.assertEqual(version, MAVEN_VERSION)
        self.assertEqual(len(calls), 1, f"one maven call: {calls!r}")
        self.assertTrue(calls[0][0].endswith("mvn"), f"maven itself is asked: {calls[0]!r}")
        self.assertTrue({"--version", "-v"} & set(calls[0][1:]),
                        f"maven is asked only its version: {calls[0]!r}")


class _BoardRefused(Exception):
    """Raised by the fake board: proves setup reached the board."""


class TheModulesSetupChecksTheStampBeforeAnyBoardTest(_TempDirs):
    """`setUpModule` run in process: the toolchain present, maven's version
    faked, the suite repository pointed at a test-only directory and the real
    board replaced by a fake that refuses to start."""

    def run_setup(self, repo):
        mod = _maven_module()
        saved = dict(mod._MODULE)
        mod._MODULE.clear()
        self.addCleanup(lambda: (mod._MODULE.clear(), mod._MODULE.update(saved)))
        self.addCleanup(mod.tearDownModule)
        board = mock.Mock(side_effect=_BoardRefused("the fake board refuses to start"))
        with (mock.patch.object(mod, "_toolchain_gap", return_value=None),
              mock.patch.object(mod, "maven_version", return_value=MAVEN_VERSION),
              mock.patch.object(mod, "SUITE_MAVEN_REPO", repo),
              mock.patch.object(mod, "RealBoard", board),
              contextlib.suppress(_BoardRefused)):
            mod.setUpModule()
        return mod, board, dict(mod._MODULE)

    def test_an_unprovisioned_suite_repository_fails_setup_naming_the_script_and_starts_no_board(self):
        _mod, board, state = self.run_setup(self.temp_dir("suite-m2-"))
        self.assertEqual(board.call_count, 0,
                         "no board is started for a run that cannot pass")
        self.assertIn(PROVISION_SCRIPT_REL, state.get("gap") or "",
                      f"the module's failure names the provisioning script: {state!r}")

    def test_a_stale_stamp_fails_setup_naming_the_script_and_starts_no_board(self):
        repo = self.provisioned_repo(maven_version="3.8.1")
        _mod, board, state = self.run_setup(repo)
        self.assertEqual(board.call_count, 0, "no board is started")
        self.assertIn(PROVISION_SCRIPT_REL, state.get("gap") or "",
                      f"the module's failure names the provisioning script: {state!r}")

    def test_a_provisioned_suite_repository_proceeds_and_the_project_names_it(self):
        repo = self.provisioned_repo()
        _mod, board, state = self.run_setup(repo)
        self.assertIsNone(state.get("gap"), f"a provisioned repository is ready: {state!r}")
        self.assertEqual(board.call_count, 1, "setup goes on to start its board")
        project = Path(state["scratch"]) / "project"
        self.assertEqual(sorted(_config_tokens(project)),
                         sorted(["-o", f"-Dmaven.repo.local={repo}"]),
                         "the project maven runs in reads the suite repository offline")


class TheProvisioningScriptTest(unittest.TestCase):
    """A static pin: no test runs the script."""

    def script(self):
        self.assertTrue(PROVISION_SCRIPT.is_file(), f"{PROVISION_SCRIPT_REL} exists")
        return PROVISION_SCRIPT.read_text(encoding="utf-8")

    def code_lines(self):
        return [line for line in self.script().splitlines()
                if line.strip() and not line.lstrip().startswith("#")]

    def test_the_script_exists_and_is_executable(self):
        self.script()
        mode = PROVISION_SCRIPT.stat().st_mode
        self.assertTrue(mode & stat.S_IXUSR, f"{PROVISION_SCRIPT_REL} is executable: {oct(mode)}")

    def test_the_script_fills_the_suite_repository_and_never_the_operators(self):
        code = "\n".join(self.code_lines())
        self.assertIn(".cache/test-suite/m2", code, "the script fills the suite repository")
        self.assertIn("-Dmaven.repo.local", code, "maven is pointed at the suite repository")
        for operator in ("~/.m2", "$HOME/.m2", "${HOME}/.m2"):
            self.assertNotIn(operator, code, f"the script never names {operator}")

    def test_the_script_runs_the_fixtures_real_lifecycle_not_go_offline_alone(self):
        code = self.code_lines()
        self.assertTrue(any("tests/fixtures/surefire-live-project" in line for line in code),
                        "the script provisions from the committed fixture")
        lifecycle = [line for line in code
                     if re.search(r"\bmvn\b", line, re.IGNORECASE)
                     and re.search(r"(^|\s)(test|verify|package|install)(\s|$|;|\))", line)]
        self.assertTrue(lifecycle,
                        "maven runs a lifecycle phase (test/verify/package/install) on the "
                        "fixture, which loads the lifecycle plugins and surefire providers "
                        f"`dependency:go-offline` misses; code lines: {code!r}")

    def test_the_script_writes_the_stamp_keyed_on_the_pom_and_the_maven_version(self):
        code = "\n".join(self.code_lines())
        self.assertIn(STAMP_NAME, code, "the script writes the stamp file")
        self.assertIn("pom-sha256=", code, "the stamp is keyed on the fixture's pom.xml")
        self.assertIn("maven=", code, "the stamp is keyed on the maven version")

    def test_the_script_consults_the_stamp_before_it_runs_maven(self):
        code = self.code_lines()
        stamp_at = next((i for i, line in enumerate(code) if STAMP_NAME in line), None)
        maven_at = next((i for i, line in enumerate(code)
                         if re.search(r"\bmvn\b", line, re.IGNORECASE)
                         and "--version" not in line
                         and "-v" not in line.split()), None)
        if stamp_at is None or maven_at is None:
            self.fail(f"the script names the stamp ({stamp_at}) and runs maven ({maven_at})")
        self.assertLess(stamp_at, maven_at,
                        "the stamp is read before maven runs, so a matching stamp skips "
                        "the fill")


if __name__ == "__main__":
    unittest.main()
