"""Every client has a `lint` verb, built once: the same declaration gives the
same post and the same envelope from all six. Rust and go lint by default when
nothing is declared, a declared command replaces the default, the other four
skip, and `check` never runs a declared linter, on any of the six. A linter
killed by a signal is filed by every client with a non-negative exit.

Every drive is a real subprocess of a client from a scratch copy of the fleet,
against a recording double of the board (`tests/client/lint_verb_harness.py`).
`cargo` and `go` are the fake linter under those names: it records each
call's argv, working directory and `CARGO_BUILD_JOBS`, and prints and exits
as scripted (per module, for go, from a `.fake-lint.json` in the module).

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> --tests \
        tests.client.test_every_client_has_a_lint_verb
"""

import importlib.util
import signal
import unittest

from tests.client.lint_verb_harness import (
    AGENT,
    CLIENTS,
    CLIENTS_DIR,
    PROJECT_KEY,
    LintDriveMixin,
    declared_source,
    lint_table,
    warning_codes,
    write_script,
)

RUFF = "lint-fixture-ruff"

#: The exit a shell reports for a process killed by SIGTERM: 128 + 15.
SIGTERM_EXIT = 128 + int(signal.SIGTERM)

#: The rust default: today's gate step, unchanged.
CLIPPY_WORKSPACE_ARGV = ["clippy", "--workspace", "--all-targets", "--all-features",
                         "--", "-D", "warnings"]

#: The output of each of the two go modules' `go vet`, and its exit. The first
#: module's exit is the first non-zero one, and neither the larger nor the last.
GO_MODULE_A_OUTPUT = "# example.com/alpha\n./alpha.go:3:2: unreachable code\n"
GO_MODULE_B_OUTPUT = "# example.com/beta\n./beta.go:7:9: printf: bad verb %z\n"
GO_MODULE_A_EXIT = 1
GO_MODULE_B_EXIT = 2


def _workspace_build_jobs():
    """The `CARGO_BUILD_JOBS` today's workspace clippy step sets, read from
    the rust client itself."""
    spec = importlib.util.spec_from_file_location(
        "lint_census_rust_client", CLIENTS_DIR / "rust-crucible.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.WORKSPACE_BUILD_JOBS


class EveryClientRunsTheSameLintTest(LintDriveMixin, unittest.TestCase):
    """One declaration, six clients: one post and one envelope, the stack and
    the envelope's context aside."""

    def setUp(self):
        super().setUp()
        self.fake(RUFF)
        self.say((("out", "app/a.py:1:1: F401 `os` imported but unused\n"),),
                 exit_code=1)
        self.board.answer_counts(1, 0)

    def test_every_client_runs_the_declared_linter_and_files_it_marked(self):
        root = self.project(lint_table([RUFF, "check", "."], format="ruff"))
        for client in CLIENTS:
            with self.subTest(client=client):
                self.board.reset()
                self.board.answer_counts(1, 0)
                result, axi = self.filed(client, root)
                body = self.one_compile_post(result, axi)
                self.assertEqual(
                    {key: body.get(key) for key in ("lint", "format", "runnerExit",
                                                    "projectKey", "agentId", "stack")},
                    {"lint": "ruff", "format": "ruff", "runnerExit": 1,
                     "projectKey": PROJECT_KEY, "agentId": AGENT, "stack": client},
                    f"{client}: {body!r}")
                self.assertEqual(
                    (axi.get("verb"), axi.get("ok"), axi.get("linter"),
                     axi.get("declared"), axi.get("exit")),
                    ("lint", False, "ruff", declared_source(root), 1),
                    f"{client}: {axi!r} stderr={result.stderr[-1500:]}")

    def test_the_six_clients_post_the_same_body_and_print_the_same_envelope(self):
        root = self.project(lint_table([RUFF, "check", "."], format="ruff"))
        seen = {}
        for client in CLIENTS:
            self.board.reset()
            self.board.answer_counts(1, 0)
            result, axi = self.filed(client, root)
            posts = self.board.compile_posts()
            self.assertEqual(len(posts), 1,
                             f"{client}: one lint post; {axi!r} "
                             f"stderr={result.stderr[-1500:]}")
            seen[client] = (
                {k: v for k, v in posts[0].items() if k != "stack"},
                {k: v for k, v in axi.items() if k != "context"},
                result.returncode)
        reference = seen["python"]
        for client, observed in seen.items():
            with self.subTest(client=client):
                self.assertEqual(
                    observed, reference,
                    f"{client}'s lint differs from python's: it is implemented "
                    f"more than once")


class RustAndGoLintByDefaultTest(LintDriveMixin, unittest.TestCase):

    def test_a_rust_project_with_nothing_declared_runs_the_workspace_clippy_with_its_build_jobs(self):
        self.fake("cargo")
        self.say((("err", "warning: unused variable: `x`\n --> src/main.rs:2:9\n"),),
                 exit_code=0)
        root = self.project(None)
        result, axi = self.filed("rust", root)
        calls = self.calls("cargo")
        self.assertEqual(
            [(c["argv"], c["cwd"]) for c in calls],
            [(CLIPPY_WORKSPACE_ARGV, str(root))],
            f"the rust default is today's workspace clippy step; {axi!r} "
            f"stderr={result.stderr[-1500:]}")
        self.assertEqual(calls[0]["env"]["CARGO_BUILD_JOBS"], _workspace_build_jobs(),
                         "it runs with the build jobs the gate step sets")
        body = self.one_compile_post(result, axi)
        self.assertEqual((body.get("lint"), body.get("format"), body.get("runnerExit")),
                         ("clippy", "clippy", 0), f"{body!r}")
        self.assertEqual(
            (axi.get("verb"), axi.get("ok"), axi.get("linter"), axi.get("declared")),
            ("lint", True, "clippy", "default"), f"{axi!r}")

    def _two_module_go_project(self, table_text=None):
        root = self.project(table_text)
        for name, output, code in (("alpha", GO_MODULE_A_OUTPUT, GO_MODULE_A_EXIT),
                                   ("beta", GO_MODULE_B_OUTPUT, GO_MODULE_B_EXIT)):
            module = root / name
            module.mkdir()
            (module / "go.mod").write_text(f"module example.com/{name}\n\ngo 1.24\n")
            (module / f"{name}.go").write_text(f"package {name}\n")
            write_script(module / ".fake-lint.json", (("err", output),), code)
        return root

    def test_a_go_project_with_two_modules_runs_go_vet_in_each_and_files_one_post(self):
        self.fake("go")
        root = self._two_module_go_project()
        result, axi = self.filed("go", root)
        vets = [c for c in self.calls("go") if c["argv"][:1] == ["vet"]]
        self.assertEqual(
            [(c["argv"], c["cwd"]) for c in vets],
            [(["vet", "./..."], str(root / "alpha")),
             (["vet", "./..."], str(root / "beta"))],
            f"`go vet ./...` once in each module, in module order; {axi!r} "
            f"stderr={result.stderr[-1500:]}")
        body = self.one_compile_post(result, axi)
        self.assertEqual((body.get("lint"), body.get("format"), body.get("runnerExit")),
                         ("go vet", "go vet", GO_MODULE_A_EXIT),
                         f"the exit is the first non-zero one; {body!r}")
        output = body.get("errors") or ""
        self.assertIn(GO_MODULE_A_OUTPUT, output, f"{body!r}")
        self.assertIn(GO_MODULE_B_OUTPUT, output, f"{body!r}")
        self.assertLess(output.index(GO_MODULE_A_OUTPUT), output.index(GO_MODULE_B_OUTPUT),
                        f"the outputs are joined in module order; {body!r}")
        self.assertEqual(
            (axi.get("verb"), axi.get("ok"), axi.get("linter"), axi.get("declared"),
             axi.get("exit")),
            ("lint", False, "go vet", "default", GO_MODULE_A_EXIT), f"{axi!r}")

    def test_a_declared_command_replaces_the_rust_default(self):
        self.fake("cargo")
        self.fake(RUFF)
        root = self.project(lint_table([RUFF, "check", "."], format="ruff"))
        result, axi = self.filed("rust", root)
        self.assertEqual(len(self.calls(RUFF)), 1,
                         f"the declared linter ran; {axi!r} stderr={result.stderr[-1500:]}")
        self.assertEqual([c["argv"] for c in self.calls("cargo")
                          if c["argv"][:1] == ["clippy"]], [],
                         "the default clippy did not run beside it")
        self.assertEqual(axi.get("linter"), "ruff", f"{axi!r}")

    def test_a_declared_command_replaces_the_go_default(self):
        self.fake("go")
        self.fake(RUFF)
        root = self._two_module_go_project(lint_table([RUFF, "check", "."], format="ruff"))
        result, axi = self.filed("go", root)
        self.assertEqual([c["cwd"] for c in self.calls(RUFF)], [str(root)],
                         f"the declared linter ran once, in the project dir; {axi!r} "
                         f"stderr={result.stderr[-1500:]}")
        self.assertEqual([c for c in self.calls("go") if c["argv"][:1] == ["vet"]], [],
                         "`go vet` did not run beside it")
        body = self.one_compile_post(result, axi)
        self.assertEqual(body.get("lint"), "ruff", f"{body!r}")


class TheOtherFourClientsHaveNoDefaultTest(LintDriveMixin, unittest.TestCase):

    def test_python_bun_mvn_and_arduino_skip_when_nothing_is_declared(self):
        root = self.project(None)
        for client in ("python", "bun", "mvn", "arduino"):
            with self.subTest(client=client):
                self.board.reset()
                result, axi = self.filed(client, root)
                self.assertEqual(
                    (axi.get("verb"), axi.get("ok"), axi.get("skipped")),
                    ("lint", True, "not-declared"),
                    f"{client}: stdout={result.stdout!r} "
                    f"stderr={result.stderr[-1500:]}")
                self.assertEqual(result.returncode, 0, f"{client}: {axi!r}")
                self.assertEqual(self.board.compile_posts(), [],
                                 f"{client}: a skip posts nothing")


class CheckNeverLintsTest(LintDriveMixin, unittest.TestCase):
    """A guard: `check` passes today, and must keep passing once `lint`
    exists."""

    def setUp(self):
        super().setUp()
        self.fake(RUFF)
        self.fake("cargo")

    def test_python_check_runs_no_declared_linter(self):
        root = self.project(lint_table([RUFF, "check", "."], format="ruff"))
        (root / "app").mkdir()
        (root / "app" / "ok.py").write_text("VALUE = 1\n")
        result, axi = self.filed("python", root, verb="check")
        self.assertEqual(axi.get("verb"), "check",
                         f"stdout={result.stdout!r} stderr={result.stderr[-1500:]}")
        self.assertEqual(self.calls(RUFF), [], "check ran the declared linter")

    def test_rust_check_runs_no_declared_linter_and_no_clippy(self):
        root = self.project(lint_table([RUFF, "check", "."], format="ruff"))
        result, axi = self.filed("rust", root, "--crate", "probe", verb="check")
        self.assertEqual(axi.get("verb"), "check",
                         f"stdout={result.stdout!r} stderr={result.stderr[-1500:]}")
        self.assertEqual(self.calls(RUFF), [], "check ran the declared linter")
        self.assertEqual([c["argv"][:1] for c in self.calls("cargo")], [["check"]],
                         "check runs cargo check alone")

    def _check(self, client, root, *argv, env=None, cwd=None):
        result, axi = self.filed(client, root, *argv, verb="check", env=env,
                                 cwd=cwd)
        why = (f"{client}: envelope={axi!r} stdout={result.stdout[-800:]!r} "
               f"stderr={result.stderr[-1500:]}")
        self.assertEqual(axi.get("verb"), "check", f"the drive reached check; {why}")
        self.assertIn("exit", axi, f"check ran its compile, it was not refused; {why}")
        self.assertNotIn("error", axi, f"check ran its compile, it was not refused; {why}")
        return result, axi, why

    def test_bun_check_runs_no_declared_linter(self):
        root = self.project(lint_table([RUFF, "check", "."], format="ruff"))
        (root / "package.json").write_text('{"name": "lint-check-fixture"}\n')
        _result, axi, why = self._check("bun", root)
        self.assertEqual(self.calls(RUFF), [], f"check ran the declared linter; {why}")
        self.assertEqual([b for b in self.board.compile_posts() if b.get("lint")], [],
                         f"check files no lint record; {why}")

    def test_go_check_runs_no_declared_linter_and_no_go_vet(self):
        self.fake("go")
        root = self.project(lint_table([RUFF, "check", "."], format="ruff"))
        (root / "go.mod").write_text("module example.com/checkfixture\n\ngo 1.24\n")
        (root / "checkfixture.go").write_text("package checkfixture\n")
        # Go's check finds its module from the directory it is run in.
        _result, axi, why = self._check("go", root, cwd=root)
        self.assertEqual(self.calls(RUFF), [], f"check ran the declared linter; {why}")
        self.assertEqual([c["argv"] for c in self.calls("go") if c["argv"][:1] == ["vet"]],
                         [], f"check runs no go vet; {why}")
        self.assertEqual([c["argv"] for c in self.calls("go") if c["argv"][:1] == ["build"]],
                         [["build", "./..."]], f"check runs its go build alone; {why}")
        self.assertEqual([b for b in self.board.compile_posts() if b.get("lint")], [],
                         f"check files no lint record; {why}")

    def test_mvn_check_runs_no_declared_linter(self):
        root = self.project(lint_table([RUFF, "check", "."], format="ruff"))
        (root / "pom.xml").write_text("<project/>\n")
        _result, axi, why = self._check("mvn", root)
        self.assertEqual(self.calls(RUFF), [], f"check ran the declared linter; {why}")
        self.assertEqual([b for b in self.board.compile_posts() if b.get("lint")], [],
                         f"check files no lint record; {why}")

    def test_arduino_check_runs_no_declared_linter(self):
        root = self.project(lint_table([RUFF, "check", "."], format="ruff"))
        _result, axi, why = self._check("arduino", root)
        self.assertEqual(self.calls(RUFF), [], f"check ran the declared linter; {why}")
        self.assertEqual([b for b in self.board.compile_posts() if b.get("lint")], [],
                         f"check files no lint record; {why}")


class EveryClientFilesASignalKilledLinterWithANonNegativeExitTest(LintDriveMixin,
                                                                  unittest.TestCase):
    """One declaration whose linter kills itself with SIGTERM, six clients:
    each files `runnerExit` 143 (128 + 15), the board double takes it, and
    `lint` fails with that exit."""

    def test_every_client_files_runner_exit_143_and_fails_with_it(self):
        self.fake(RUFF)
        self.say((("out", "app/a.py:1:1: F401 `os` imported but unused\n"),),
                 kill_signal=signal.SIGTERM)
        root = self.project(lint_table([RUFF, "check", "."], format="ruff"))
        for client in CLIENTS:
            with self.subTest(client=client):
                self.board.reset()
                self.board.answer_counts(1, 0)
                result, axi = self.filed(client, root)
                body = self.one_compile_post(result, axi)
                why = f"{client}: body={body!r} envelope={axi!r}"
                self.assertEqual(body.get("runnerExit"), SIGTERM_EXIT, why)
                self.assertNotIn("ingest-failed", warning_codes(axi),
                                 f"the board takes the post; {why}")
                self.assertEqual((axi.get("ok"), axi.get("exit")), (False, SIGTERM_EXIT), why)
                self.assertNotEqual(result.returncode, 0, why)
                self.assertGreaterEqual(result.returncode, 0, why)


if __name__ == "__main__":
    unittest.main()
