"""A go `test` run resolves the one module it runs.

Relative to the project dir, the module dir is, in this order:
  1. `--module-dir`;
  2. `GO_CRUCIBLE_MODULE_DIR`;
  3. the nearest `go.mod` at or above the working directory, never above the
     project dir;
  4. the project's `crucible.toml` `[go] module_dir` (a `crucible.toml` that
     does not parse declares nothing).
A named dir with no `go.mod`, or no module found at all, is refused with the
fleet's envelope, naming the ways to declare one: nothing runs and no run is
opened.

The project holds two modules (`tests/fixtures/go-client/two-modules`):
`api` (package `example.com/api`) and `worker` (packages `example.com/worker`
and `example.com/worker/sub`, a package dir with no `go.mod` of its own). The
module that ran is read from what the board holds: the packages of go's own
stream.

Driven with the real `go` through a recording shim (`go_client_harness`),
against a `RecordingBoard`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_go_run_resolves_its_module_dir
"""

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client import TEST_INSTALL_MARKER, establish_test_install, pid_alive
from tests.client.go_client_harness import (
    GO_CLIENT,
    GoProject,
    diagnostics,
    envelope,
    go_toolchain_gap,
    said,
)
from tests.client.live_run_harness import new_scratch
from tests.client.client_fleet_envelope_census_helpers import (
    declare_board,
    would_resolve,
)

API = {"example.com/api"}
WORKER = {"example.com/worker", "example.com/worker/sub"}
DECLARATION_WAYS = ("--module-dir", "GO_CRUCIBLE_MODULE_DIR", "[go] module_dir")


class _ModuleDir(unittest.TestCase):
    maxDiff = 4000

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")

    def project(self, project_dir=None):
        p = GoProject(self, fixture="two-modules", project_dir=project_dir)
        p.board.script_run(passed=1)
        return p

    def assert_ran(self, p, result, packages, why):
        where = f"{why}; {diagnostics(result)}"
        self.assertEqual(len(p.starts()), 1, f"one run is opened; {where}")
        self.assertEqual(p.packages_run(), packages, f"the module that ran; {where}")
        self.assertEqual(result.returncode, 0, where)

    def assert_refused(self, p, result, why):
        where = f"{why}; calls={[c['argv'] for c in p.calls()]!r} {diagnostics(result)}"
        self.assertNotEqual(result.returncode, 0, f"the run is refused; {where}")
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {where}")
        self.assertEqual((axi or {}).get("verb"), "test", where)
        self.assertIs((axi or {}).get("ok"), False, where)
        words = said(axi)
        for way in DECLARATION_WAYS:
            self.assertIn(way, words, f"the refusal names {way}; {where}")
        self.assertEqual(p.test_calls(), [], f"no go test runs; {where}")
        self.assertEqual(p.run_route_posts(), [], f"no run is opened; {where}")


class TheModuleDirPrecedenceTest(_ModuleDir):

    def test_the_flag_names_the_module_relative_to_the_project_dir_from_inside_another(self):
        p = self.project()
        result = p.drive("--module-dir", "worker", cwd=os.path.join(p.dir, "api"))
        self.assert_ran(p, result, WORKER, "--module-dir worker, standing in api")

    def test_the_environment_variable_names_the_module_from_inside_another(self):
        p = self.project()
        result = p.drive(cwd=os.path.join(p.dir, "api"), GO_CRUCIBLE_MODULE_DIR="worker")
        self.assert_ran(p, result, WORKER, "GO_CRUCIBLE_MODULE_DIR=worker, standing in api")

    def test_the_flag_comes_before_the_environment_variable(self):
        p = self.project()
        result = p.drive("--module-dir", "api", GO_CRUCIBLE_MODULE_DIR="worker")
        self.assert_ran(p, result, API, "--module-dir api over GO_CRUCIBLE_MODULE_DIR=worker")

    def test_the_nearest_go_mod_above_the_working_directory_is_the_module(self):
        p = self.project()
        result = p.drive(cwd=os.path.join(p.dir, "worker", "sub"))
        self.assert_ran(p, result, WORKER, "standing in worker/sub, a package dir")

    def test_the_module_the_working_directory_is_in_comes_before_the_declaration(self):
        p = self.project()
        p.declare_module_dir("api")
        result = p.drive(cwd=os.path.join(p.dir, "worker"))
        self.assert_ran(p, result, WORKER, "standing in worker, [go] module_dir = api")

    def test_the_declaration_names_the_module_when_the_working_directory_is_in_none(self):
        p = self.project()
        p.declare_module_dir("api")
        result = p.drive(cwd=p.dir)
        self.assert_ran(p, result, API, "standing in the project dir, [go] module_dir = api")

    def test_a_go_mod_above_the_project_dir_is_never_the_module(self):
        outer = new_scratch("go-outer-")
        Path(outer, "go.mod").write_text("module example.com/outer\n\ngo 1.24\n",
                                         encoding="utf-8")
        Path(outer, "outer_test.go").write_text(
            'package outer\n\nimport "testing"\n\nfunc TestOuter(t *testing.T) {}\n',
            encoding="utf-8")
        p = self.project(project_dir=os.path.join(outer, "project"))
        p.declare_module_dir("api")
        result = p.drive(cwd=p.dir)
        self.assert_ran(p, result, API,
                        "a go.mod above the project dir is passed over for [go] module_dir")


class AProjectDirReachedThroughASymlinkTest(_ModuleDir):
    """The project dir named through a symlink: the working directory the
    client stands in is always its real path, so the walk compares real paths
    on both sides — the module the working directory is in is still found, and
    a go.mod above the project's real dir is still never the module."""

    def linked(self, p):
        """`p` named from now on through a symlink to its real project dir."""
        link = os.path.join(new_scratch("go-link-"), "linked-project")
        os.symlink(p.dir, link)
        self.assertNotEqual(os.path.realpath(link), link, "the project dir is a symlink")
        p.dir = link
        return p

    def test_the_nearest_go_mod_is_found_when_the_project_dir_is_a_symlink(self):
        p = self.linked(self.project())
        result = p.drive(cwd=os.path.join(p.dir, "worker", "sub"))
        self.assert_ran(p, result, WORKER,
                        "standing in worker/sub of a project dir named through a symlink")

    def test_the_working_directorys_module_comes_before_the_declaration_through_a_symlink(self):
        p = self.linked(self.project())
        p.declare_module_dir("api")
        result = p.drive(cwd=os.path.join(p.dir, "worker"))
        self.assert_ran(p, result, WORKER,
                        "standing in worker through a symlinked project dir, "
                        "[go] module_dir = api")

    def test_a_go_mod_above_the_real_project_dir_is_never_the_module_through_a_symlink(self):
        outer = new_scratch("go-outer-")
        Path(outer, "go.mod").write_text("module example.com/outer\n\ngo 1.24\n",
                                         encoding="utf-8")
        p = self.linked(self.project(project_dir=os.path.join(outer, "project")))
        result = p.drive(cwd=p.dir)
        self.assert_refused(p, result,
                            "only a go.mod above the real dir of a symlinked project dir")


class AModuleThatCannotBeFoundIsRefusedTest(_ModuleDir):

    def test_no_module_found_is_refused_naming_the_ways_to_declare_one(self):
        p = self.project()
        result = p.drive(cwd=p.dir)
        self.assert_refused(p, result, "standing in the project dir, nothing declared")

    def test_a_go_mod_above_the_project_dir_does_not_stand_in_for_a_module(self):
        outer = new_scratch("go-outer-")
        Path(outer, "go.mod").write_text("module example.com/outer\n\ngo 1.24\n",
                                         encoding="utf-8")
        p = self.project(project_dir=os.path.join(outer, "project"))
        result = p.drive(cwd=p.dir)
        self.assert_refused(p, result, "only a go.mod above the project dir")

    def test_a_flag_naming_a_dir_with_no_go_mod_is_refused(self):
        p = self.project()
        result = p.drive("--module-dir", "worker/sub", cwd=os.path.join(p.dir, "api"))
        self.assert_refused(p, result, "--module-dir worker/sub holds no go.mod")

    def test_an_environment_variable_naming_a_dir_with_no_go_mod_is_refused(self):
        p = self.project()
        result = p.drive(cwd=os.path.join(p.dir, "api"),
                         GO_CRUCIBLE_MODULE_DIR="no-such-dir")
        self.assert_refused(p, result, "GO_CRUCIBLE_MODULE_DIR names no dir")

    def test_a_declaration_naming_a_dir_with_no_go_mod_is_refused(self):
        p = self.project()
        p.declare_module_dir("worker/sub")
        result = p.drive(cwd=p.dir)
        self.assert_refused(p, result, "[go] module_dir = worker/sub holds no go.mod")

    def install_declaring(self, board_url):
        """A go client of this test's own: a test install laid down by the
        suite's helper inside a parent this test owns (removed with it), its
        `crucible.toml` declaring `board_url`. Answers the install's client."""
        parent = tempfile.mkdtemp(prefix="go-install-parent-")
        self.addCleanup(shutil.rmtree, parent, ignore_errors=True)
        environ = {}
        with mock.patch.object(tempfile, "tempdir", parent):
            install = Path(establish_test_install(
                environ, pid=os.getpid(), pid_alive=pid_alive, at_exit=self.addCleanup))
        self.assertEqual(environ, {TEST_INSTALL_MARKER: str(install)})
        declare_board(install / "crucible.toml", board_url)
        return install / "clients" / GO_CLIENT.name

    def test_a_crucible_toml_that_does_not_parse_declares_nothing(self):
        p = self.project()
        p.declare_module_dir("api")
        with open(os.path.join(p.dir, "crucible.toml"), "a", encoding="utf-8") as fh:
            fh.write("\nthis line = is not [ toml\n")
        # The project file no longer parses, so it declares no board either:
        # the board comes from the install, which here is this test's own.
        client = self.install_declaring(p.board.url)
        resolves, reason = would_resolve(client.parent / "_crucible_axi.py",
                                         p.dir, p.board.url)
        self.assertTrue(resolves, f"the test's own install declares the board: {reason}")
        result = p.drive(cwd=p.dir, client=client)
        self.assert_refused(p, result, "an unparseable crucible.toml naming api")


if __name__ == "__main__":
    unittest.main()
