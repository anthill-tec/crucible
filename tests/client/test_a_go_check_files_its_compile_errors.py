"""A go `check` compiles its module and files what fails to compile.

`check` runs `go build ./...` in the module `test` resolves (`--module-dir`,
`GO_CRUCIBLE_MODULE_DIR`, the nearest `go.mod`, `[go] module_dir`).
`check --tests` runs the test compile instead of the build: every package and
every test file is compiled, no test binary runs (a `TestMain` does not run)
and no vet check runs (`-vet=off`). It replaces the build, so a non-test error
is filed once, never twice. As in every client, a failing `check` with
`--agent` files its output as ONE compile run (`POST /api/v2/runs/compile`,
format `go`); a clean one files nothing; without `--agent` nothing is filed.
Below the Go floor (1.24) `check` is refused before anything compiles, as
`test` is.

The modules (`tests/fixtures/go-client`):
  - `does-not-build`: `q/q.go` holds one type error and no test file; `m`
    builds and its `TestMain` writes `testmain-ran` into its package dir.
  - `test-file-error`: `p/p.go` builds, `p/p_test.go` does not.
  - `vet-finding`: `p/p.go` builds; its one finding is vet's
    `fmt.Sprintf("%d", "x")`.
  - `module`: builds, test files included (its tests fail when run).
  - `two-modules`: the module-resolution project `test`'s tests use.

Driven with the real `go` through the recording shim (`go_client_harness`),
against a `RecordingBoard`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_go_check_files_its_compile_errors
"""

import os
import re
import shutil
import subprocess
import unittest

from tests.client.go_client_harness import (
    AGENT,
    PROJECT_KEY,
    TIMEOUT,
    GoProject,
    copy_fixture,
    diagnostics,
    envelope,
    flag_value,
    go_toolchain_gap,
    said,
    toolchain_env,
)
from tests.client.live_run_harness import new_scratch

COMPILE = "/api/v2/runs/compile"
MARKER = "testmain-ran"
# What go prints for each fixture's one error (measured on Go 1.27.3); the
# path is relative to the module dir. Matched as a substring, so a path Go
# printed absolute still carries it.
NON_TEST_ERROR = 'q/q.go:3:13: cannot use "q" (untyped string constant) as int value'
NON_TEST_POSITION = "q/q.go:3:13:"
TEST_FILE_ERROR = ("p/p_test.go:5:45: cannot use One() (value of type int) as "
                   "string value")
VET_FINDING = 'fmt.Sprintf format %d has arg "x" of wrong type string'


def clear_marker(module_dir):
    """Remove a marker a copy may carry: a tool that ran the fixture's tests
    in the repository's tree leaves one behind."""
    marker = os.path.join(module_dir, "m", MARKER)
    if os.path.exists(marker):
        os.remove(marker)


class _Check(unittest.TestCase):
    maxDiff = 4000

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")

    def check(self, p, *argv, **kw):
        return p.drive(*argv, verb="check", **kw)

    def where(self, p, result):
        return (f"calls={[(c['argv'], c['cwd']) for c in p.calls()]!r} "
                f"posts={[path for path, _b in p.posts()]!r} {diagnostics(result)}")

    def compile_posts(self, p):
        return [b for path, b in p.posts() if path == COMPILE]

    def assert_envelope(self, result, ok, where):
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {where}")
        self.assertEqual((axi or {}).get("verb"), "check", where)
        self.assertIs((axi or {}).get("ok"), ok, where)
        return axi

    def assert_one_go_compile_run(self, p, result, error_text):
        """The check failed and filed exactly one compile run of format `go`
        under the agent, carrying `error_text`; nothing else was filed."""
        where = self.where(p, result)
        self.assertNotEqual(result.returncode, 0, f"a failing check exits non-zero; {where}")
        self.assert_envelope(result, False, where)
        self.assertEqual(p.run_route_posts(), [COMPILE],
                         f"exactly one compile run is filed, nothing else; {where}")
        body = self.compile_posts(p)[0]
        self.assertEqual(body.get("format"), "go", f"the compile format; {where}")
        self.assertEqual(body.get("agentId"), AGENT, where)
        self.assertEqual(body.get("projectKey"), PROJECT_KEY, where)
        self.assertIn(error_text, body.get("errors") or "",
                      f"the compile run carries the output go printed; {where}")
        return body

    def assert_files_nothing_and_passes(self, p, result):
        where = self.where(p, result)
        self.assertEqual(result.returncode, 0, f"a clean check exits 0; {where}")
        self.assert_envelope(result, True, where)
        self.assertEqual(self.compile_posts(p), [], f"a clean check files nothing; {where}")
        self.assertEqual(p.run_route_posts(), [], f"no run of any kind is filed; {where}")

    def assert_marker_fixture_is_live(self, fixture):
        """Control: the fixture's `m` TestMain DOES write its marker when its
        test binary runs, so the marker's absence after a check means no test
        binary ran."""
        copy = copy_fixture(fixture, new_scratch("go-marker-control-"))
        clear_marker(copy)
        go = shutil.which("go")
        if go is None:
            self.fail("missing toolchain: go on PATH")
        ran = subprocess.run([go, "test", "-count=1", "-run", "^$", "./m"], cwd=copy,
                             env=toolchain_env(), capture_output=True, text=True,
                             check=False, timeout=TIMEOUT)
        self.assertTrue(os.path.exists(os.path.join(copy, "m", MARKER)),
                        f"control: m's TestMain writes its marker when run; "
                        f"exit={ran.returncode} out={ran.stdout[-600:]!r} "
                        f"err={ran.stderr[-600:]!r}")

    def assert_no_test_binary_ran(self, p, result):
        self.assertFalse(os.path.exists(os.path.join(p.dir, "m", MARKER)),
                         f"m's TestMain did not run; {self.where(p, result)}")


class ACheckOfAModuleThatDoesNotBuildFilesOneGoCompileRunTest(_Check):

    def test_check_runs_go_build_in_the_module_and_files_one_go_compile_run(self):
        p = GoProject(self, fixture="does-not-build")
        result = self.check(p)
        where = self.where(p, result)
        builds = p.subcommand_calls("build")
        self.assertEqual([c["argv"] for c in builds], [["build", "./..."]],
                         f"one `go build ./...`; {where}")
        self.assertEqual(os.path.realpath(builds[0]["cwd"]), os.path.realpath(p.dir),
                         f"go build runs in the resolved module; {where}")
        self.assertEqual(p.subcommand_calls("test"), [],
                         f"a plain check runs no test compile; {where}")
        self.assert_one_go_compile_run(p, result, NON_TEST_ERROR)

    def test_check_without_an_agent_compiles_fails_and_files_nothing(self):
        p = GoProject(self, fixture="does-not-build")
        result = self.check(p, agent=None)
        where = self.where(p, result)
        self.assertEqual([c["argv"] for c in p.subcommand_calls("build")],
                         [["build", "./..."]], f"the check still compiles; {where}")
        self.assertNotEqual(result.returncode, 0, f"it still fails; {where}")
        self.assert_envelope(result, False, where)
        self.assertEqual(p.posts(), [], f"without --agent nothing is posted; {where}")


class ACheckWithTestsCompilesTestFilesAndRunsNoneTest(_Check):

    def test_a_test_file_error_is_filed_as_one_go_compile_run(self):
        p = GoProject(self, fixture="test-file-error")
        result = self.check(p, "--tests")
        self.assert_one_go_compile_run(p, result, TEST_FILE_ERROR)

    def test_the_test_compile_turns_vet_off_runs_no_test_and_replaces_the_build(self):
        p = GoProject(self, fixture="test-file-error")
        result = self.check(p, "--tests")
        where = self.where(p, result)
        self.assertEqual(p.subcommand_calls("build"), [],
                         f"--tests runs no go build in addition; {where}")
        tests = p.subcommand_calls("test")
        self.assertEqual(len(tests), 1, f"one test compile; {where}")
        argv = tests[0]["argv"]
        self.assertIn("-vet=off", argv, f"no vet check runs; {where}")
        self.assertEqual(flag_value(argv, "-run"), "^$", f"no test is selected; {where}")
        self.assertIn("-count=1", argv, f"no cached result stands in; {where}")
        self.assertEqual(argv[-1], "./...", f"every package is compiled; {where}")
        self.assertEqual(os.path.realpath(tests[0]["cwd"]), os.path.realpath(p.dir),
                         f"the test compile runs in the resolved module; {where}")

    def test_test_main_does_not_run_and_a_non_test_error_is_filed_once(self):
        self.assert_marker_fixture_is_live("does-not-build")
        p = GoProject(self, fixture="does-not-build")
        clear_marker(p.dir)
        result = self.check(p, "--tests")
        where = self.where(p, result)
        self.assertEqual(p.subcommand_calls("build"), [],
                         f"--tests runs no go build in addition; {where}")
        self.assertEqual(len(p.subcommand_calls("test")), 1, f"one test compile; {where}")
        body = self.assert_one_go_compile_run(p, result, NON_TEST_ERROR)
        self.assertEqual((body.get("errors") or "").count(NON_TEST_POSITION), 1,
                         f"the non-test error is filed once, not twice; {where}")
        self.assert_no_test_binary_ran(p, result)

    def test_a_module_whose_only_finding_is_a_vet_finding_passes_and_files_nothing(self):
        p = GoProject(self, fixture="vet-finding")
        result = self.check(p, "--tests")
        where = self.where(p, result)
        self.assertEqual(len(p.subcommand_calls("test")), 1, f"one test compile; {where}")
        self.assertNotIn(VET_FINDING, result.stdout + result.stderr,
                         f"no vet check ran; {where}")
        self.assert_files_nothing_and_passes(p, result)


class ACleanCheckFilesNothingTest(_Check):

    def test_a_clean_check_exits_0_files_nothing_and_says_ok(self):
        p = GoProject(self, fixture="module")
        result = self.check(p)
        where = self.where(p, result)
        self.assertEqual([c["argv"] for c in p.subcommand_calls("build")],
                         [["build", "./..."]], f"the module was compiled; {where}")
        self.assert_files_nothing_and_passes(p, result)

    def test_a_clean_check_with_tests_exits_0_files_nothing_and_says_ok(self):
        # The module's tests fail when run: a clean exit also shows none ran.
        p = GoProject(self, fixture="module")
        result = self.check(p, "--tests")
        where = self.where(p, result)
        self.assertEqual(len(p.subcommand_calls("test")), 1,
                         f"the module's tests were compiled; {where}")
        self.assert_files_nothing_and_passes(p, result)


# The tier fixtures' errors, matched by pattern: the column is go's to report.
# `tier-broken`: its `integration`-tagged `broken/integ_test.go` does not
# compile; its untagged test file does.
TAGGED_ERROR = re.compile(r'broken/integ_test\.go:9:\d+: cannot use "not an int"')
# `tier-check-untagged-error` and `tier-check-both-errors`: the untagged
# `p/u_test.go`, compiled by every build, does not compile.
UNTAGGED_ERROR = re.compile(r"p/u_test\.go:6:\d+: cannot use One\(\)")
UNTAGGED_POSITION = "p/u_test.go:6:"
# `tier-check-both-errors`: its `integration`-tagged `p/integ_test.go` does
# not compile either.
BOTH_TAGGED_ERROR = re.compile(r'p/integ_test\.go:8:\d+: cannot use "integration"')
BOTH_TAGGED_POSITION = "p/integ_test.go:8:"


class ACheckWithTestsCompilesEveryDeclaredTierTest(_Check):
    """`check --tests` also compiles each declared tier's test files under
    that tier's tag. Every compile runs, even after an earlier one fails; their
    output is filed as ONE compile run; a diagnostic line an earlier compile
    already reported is dropped, so an untagged error is filed once.

    The modules (`tests/fixtures/go-client`):
      - `tier-broken`: declares `integration`; its tagged test file has a type
        error, its untagged one compiles.
      - `tier-check-untagged-error`: declares `integration` and `bdd`, both
        of which compile; its untagged test file has a type error, so every
        build (untagged, `integration`, `bdd`) prints that error.
      - `tier-check-both-errors`: declares `integration`; the untagged test
        file and the tagged one each have a type error.
      - `tiers`: declares `integration`; everything compiles."""

    def tag_compiles(self, p, tag):
        """Every `go test` the shim recorded under `-tags <tag>` (None: the
        untagged ones)."""
        return [c for c in p.subcommand_calls("test")
                if flag_value(c["argv"], "-tags") == tag]

    def assert_one_compile_each(self, p, result, tags):
        """Exactly one test compile per tag of `tags` (None: untagged), each
        a compile that runs no test and no vet check, in the module."""
        where = self.where(p, result)
        for tag in tags:
            calls = self.tag_compiles(p, tag)
            self.assertEqual(len(calls), 1,
                             f"one test compile under tag {tag!r}; {where}")
            argv = calls[0]["argv"]
            self.assertEqual(flag_value(argv, "-run"), "^$",
                             f"tag {tag!r}: no test is selected; {where}")
            self.assertIn("-exec", argv,
                          f"tag {tag!r}: the test binary is handed to a no-op, so "
                          f"none runs; {where}")
            self.assertIn("-vet=off", argv, f"tag {tag!r}: no vet check; {where}")
            self.assertEqual(os.path.realpath(calls[0]["cwd"]), os.path.realpath(p.dir),
                             f"tag {tag!r}: compiled in the module; {where}")
        tagged = {flag_value(c["argv"], "-tags") for c in p.subcommand_calls("test")}
        self.assertEqual(tagged, set(tags),
                         f"no compile under a tag the module does not declare; {where}")
        self.assertEqual(p.subcommand_calls("build"), [],
                         f"--tests runs no go build in addition; {where}")

    def test_an_integration_tagged_compile_error_fails_check_tests_and_is_filed_as_go(self):
        p = GoProject(self, fixture="tier-broken")
        result = self.check(p, "--tests")
        where = self.where(p, result)
        self.assert_one_compile_each(p, result, (None, "integration"))
        body = self.assert_one_go_compile_run(p, result, "broken/integ_test.go:9:")
        self.assertRegex(body.get("errors") or "", TAGGED_ERROR,
                         f"the tagged file's error is filed; {where}")

    def test_an_untagged_compile_error_is_filed_once_however_many_tiers_are_declared(self):
        p = GoProject(self, fixture="tier-check-untagged-error")
        result = self.check(p, "--tests")
        where = self.where(p, result)
        # Every compile runs, even after the untagged one fails.
        self.assert_one_compile_each(p, result, (None, "integration", "bdd"))
        body = self.assert_one_go_compile_run(p, result, UNTAGGED_POSITION)
        errors = body.get("errors") or ""
        self.assertRegex(errors, UNTAGGED_ERROR, where)
        self.assertEqual(
            errors.count(UNTAGGED_POSITION), 1,
            f"three builds print the untagged error; it is filed once, not once "
            f"per build; errors={errors!r}; {where}")

    def test_an_untagged_and_a_tagged_error_are_filed_together_in_one_compile_run(self):
        p = GoProject(self, fixture="tier-check-both-errors")
        result = self.check(p, "--tests")
        where = self.where(p, result)
        self.assert_one_compile_each(p, result, (None, "integration"))
        body = self.assert_one_go_compile_run(p, result, UNTAGGED_POSITION)
        errors = body.get("errors") or ""
        self.assertRegex(errors, UNTAGGED_ERROR, f"the untagged error; {where}")
        self.assertRegex(errors, BOTH_TAGGED_ERROR, f"and the tagged one, in the same "
                                                   f"compile run; {where}")
        self.assertEqual(errors.count(UNTAGGED_POSITION), 1,
                         f"the untagged error is filed once; errors={errors!r}; {where}")
        self.assertEqual(errors.count(BOTH_TAGGED_POSITION), 1,
                         f"the tagged error is filed once; errors={errors!r}; {where}")

    def test_a_module_whose_declared_tiers_all_compile_passes_and_files_nothing(self):
        p = GoProject(self, fixture="tiers")
        result = self.check(p, "--tests")
        self.assert_one_compile_each(p, result, (None, "integration"))
        self.assert_files_nothing_and_passes(p, result)

    def test_plain_check_on_a_module_declaring_a_broken_tier_only_builds(self):
        """PIN — plain `check` is unchanged: `go build ./...` alone, which
        compiles no test file, so a tagged test file's error neither runs a
        test compile nor fails it."""
        p = GoProject(self, fixture="tier-broken")
        result = self.check(p)
        where = self.where(p, result)
        self.assertEqual([c["argv"] for c in p.subcommand_calls("build")],
                         [["build", "./..."]], f"one go build ./...; {where}")
        self.assertEqual(p.subcommand_calls("test"), [],
                         f"a plain check runs no test compile, tagged or not; {where}")
        self.assert_files_nothing_and_passes(p, result)


class ACheckResolvesItsModuleAsTestDoesTest(_Check):
    """The module that compiled is read off the `go build` call's working
    directory, as the shim recorded it."""

    def assert_built_in(self, p, result, module, why):
        where = f"{why}; {self.where(p, result)}"
        builds = p.subcommand_calls("build")
        self.assertEqual(len(builds), 1, f"one go build; {where}")
        self.assertEqual(os.path.realpath(builds[0]["cwd"]),
                         os.path.realpath(os.path.join(p.dir, module)),
                         f"the module that compiled; {where}")
        self.assertEqual(result.returncode, 0, where)

    def project(self):
        return GoProject(self, fixture="two-modules")

    def test_the_flag_names_the_module_from_inside_another(self):
        p = self.project()
        result = self.check(p, "--module-dir", "worker", cwd=os.path.join(p.dir, "api"))
        self.assert_built_in(p, result, "worker", "--module-dir worker, standing in api")

    def test_the_environment_variable_names_the_module_from_inside_another(self):
        p = self.project()
        result = self.check(p, cwd=os.path.join(p.dir, "api"),
                            GO_CRUCIBLE_MODULE_DIR="worker")
        self.assert_built_in(p, result, "worker",
                             "GO_CRUCIBLE_MODULE_DIR=worker, standing in api")

    def test_the_nearest_go_mod_above_the_working_directory_is_the_module(self):
        p = self.project()
        result = self.check(p, cwd=os.path.join(p.dir, "worker", "sub"))
        self.assert_built_in(p, result, "worker", "standing in worker/sub, a package dir")

    def test_the_declaration_names_the_module_when_the_working_directory_is_in_none(self):
        p = self.project()
        p.declare_module_dir("api")
        result = self.check(p, cwd=p.dir)
        self.assert_built_in(p, result, "api",
                             "standing in the project dir, [go] module_dir = api")


class ACheckBelowTheGoFloorIsRefusedTest(_Check):
    """The version is injected through the shim (`GO_SHIM_VERSION`); with
    `GO_SHIM_FAKE_ONLY` a client that compiled anyway would compile nothing
    real, so only the recorded calls tell."""

    def setUp(self):
        pass  # the refusal needs no real toolchain

    def assert_refused(self, *argv):
        p = GoProject(self, fixture="does-not-build")
        result = self.check(p, *argv, GO_SHIM_VERSION="go1.23.4", GO_SHIM_FAKE_ONLY="1")
        where = self.where(p, result)
        self.assertNotEqual(result.returncode, 0, f"the check is refused; {where}")
        axi = self.assert_envelope(result, False, where)
        words = said(axi)
        self.assertIn("1.23.4", words, f"the refusal names the version found; {where}")
        self.assertIn("1.24", words, f"the refusal names the floor; {where}")
        self.assertEqual(p.subcommand_calls("build"), [], f"no go build runs; {where}")
        self.assertEqual(p.subcommand_calls("test"), [], f"no go test runs; {where}")
        self.assertEqual(p.run_route_posts(), [], f"nothing is filed; {where}")

    def test_check_below_the_floor_is_refused_before_go_build_runs(self):
        self.assert_refused()

    def test_check_with_tests_below_the_floor_is_refused_before_the_test_compile(self):
        self.assert_refused("--tests")


if __name__ == "__main__":
    unittest.main()
