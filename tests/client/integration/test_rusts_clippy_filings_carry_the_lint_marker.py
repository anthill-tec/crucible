"""Rust's `clippy` and `workspace-clippy` keep what they run, file their result
as a lint record -- the marker `lint: "clippy"`, the `clippy` format and the
linter's exit as `runnerExit` -- and exit with clippy's verdict. `check`, which
shares their ingest, files an unmarked compile record as before.

Every drive is a real subprocess of the rust client from a scratch copy of the
fleet, against a recording double of the board, with `cargo` a fake that
records each call and prints and exits as scripted
(`tests/client/lint_verb_harness.py`).

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> --tests \
        tests.client.integration.test_rusts_clippy_filings_carry_the_lint_marker
"""

import signal
import unittest

from tests.client.lint_verb_harness import LintDriveMixin, warning_codes

CRATE = "probe"

#: What a failing clippy prints, on stderr, as cargo does.
CLIPPY_FAILURE = ("error: this comparison involving the minimum or maximum element "
                  "is always true\n --> src/lib.rs:3:5\n"
                  "error: could not compile `probe` (lib) due to 1 previous error\n")
CLIPPY_EXIT = 101

#: The exit a shell reports for a cargo killed by SIGTERM: 128 + 15.
SIGTERM_EXIT = 128 + int(signal.SIGTERM)

CLIPPY_ARGV = ["clippy", "-p", CRATE, "--", "-D", "warnings"]
WORKSPACE_CLIPPY_ARGV = ["clippy", "--workspace", "--all-targets", "--all-features",
                         "--", "-D", "warnings"]


class RustsClippyVerbsFileALintRecordTest(LintDriveMixin, unittest.TestCase):

    def setUp(self):
        super().setUp()
        self.fake("cargo")
        self.say((("err", CLIPPY_FAILURE),), exit_code=CLIPPY_EXIT)
        self.board.answer_counts(2, 0)
        self.root = self.project(None)

    def clippy(self):
        return self.filed("rust", self.root, "--crate", CRATE, "--deny-warnings",
                          verb="clippy")

    def test_clippy_runs_the_command_it_runs_today(self):
        """A guard: what `clippy` runs is unchanged."""
        result, axi = self.clippy()
        self.assertEqual([(c["argv"], c["cwd"]) for c in self.calls("cargo")],
                         [(CLIPPY_ARGV, str(self.root))],
                         f"{axi!r} stderr={result.stderr[-1500:]}")

    def test_clippys_post_carries_the_lint_marker_the_clippy_format_and_runner_exit(self):
        result, axi = self.clippy()
        body = self.one_compile_post(result, axi)
        self.assertEqual(
            (body.get("lint"), body.get("format"), body.get("runnerExit")),
            ("clippy", "clippy", CLIPPY_EXIT), f"{body!r}")
        self.assertIn(CLIPPY_FAILURE, body.get("errors") or "", f"{body!r}")

    def test_a_failing_clippy_exits_non_zero_when_its_ingest_succeeds(self):
        result, axi = self.clippy()
        self.assertEqual(len(self.board.compile_posts()), 1, f"{axi!r}")
        self.assertEqual((axi.get("verb"), axi.get("ok")), ("clippy", False), f"{axi!r}")
        self.assertNotEqual(
            result.returncode, 0,
            f"clippy's exit is clippy's, not its ingest's; {axi!r} "
            f"stderr={result.stderr[-1500:]}")

    def test_workspace_clippy_runs_the_command_it_runs_today(self):
        """A guard: what `workspace-clippy` runs is unchanged."""
        result, axi = self.filed("rust", self.root, verb="workspace-clippy")
        self.assertEqual([(c["argv"], c["cwd"]) for c in self.calls("cargo")],
                         [(WORKSPACE_CLIPPY_ARGV, str(self.root))],
                         f"{axi!r} stderr={result.stderr[-1500:]}")

    def test_workspace_clippys_post_carries_the_lint_marker_the_clippy_format_and_runner_exit(self):
        result, axi = self.filed("rust", self.root, verb="workspace-clippy")
        body = self.one_compile_post(result, axi)
        self.assertEqual(
            (body.get("lint"), body.get("format"), body.get("runnerExit")),
            ("clippy", "clippy", CLIPPY_EXIT), f"{body!r}")
        self.assertNotEqual(result.returncode, 0, f"{axi!r}")

    def test_checks_post_carries_no_lint_marker_and_keeps_the_rustc_format(self):
        """A guard: `check` shares the ingest and stays an unmarked compile."""
        result, axi = self.filed("rust", self.root, "--crate", CRATE, verb="check")
        body = self.one_compile_post(result, axi)
        self.assertNotIn("lint", body, f"check is a compile, not a lint; {body!r}")
        self.assertEqual(body.get("format"), "rustc", f"{body!r}")


class RustsClippyVerbsFileASignalKilledCargoWithANonNegativeExitTest(LintDriveMixin,
                                                                     unittest.TestCase):
    """`cargo clippy` prints, then is killed by SIGTERM. `clippy` and
    `workspace-clippy` file its exit as a shell reports it, 128 + 15, never
    the negative return code; the board double refuses a negative
    `runnerExit` as the board does."""

    def setUp(self):
        super().setUp()
        self.fake("cargo")
        self.say((("err", CLIPPY_FAILURE),), kill_signal=signal.SIGTERM)
        self.board.answer_counts(2, 0)
        self.root = self.project(None)

    def assertFiledWithTheSignalExit(self, result, axi):
        body = self.one_compile_post(result, axi)
        why = f"body={body!r} envelope={axi!r} stderr={result.stderr[-1500:]}"
        self.assertEqual((body.get("lint"), body.get("runnerExit")),
                         ("clippy", SIGTERM_EXIT), why)
        self.assertNotIn("ingest-failed", warning_codes(axi),
                         f"the board takes the post; {why}")

    def test_clippy_files_runner_exit_143_for_a_cargo_killed_by_sigterm(self):
        result, axi = self.filed("rust", self.root, "--crate", CRATE,
                                 "--deny-warnings", verb="clippy")
        self.assertFiledWithTheSignalExit(result, axi)

    def test_workspace_clippy_files_runner_exit_143_for_a_cargo_killed_by_sigterm(self):
        result, axi = self.filed("rust", self.root, verb="workspace-clippy")
        self.assertFiledWithTheSignalExit(result, axi)

    def assertExitsWithTheSignalExit(self, result, axi, verb):
        why = f"envelope={axi!r} stderr={result.stderr[-1500:]}"
        self.assertEqual((axi.get("verb"), axi.get("ok"), axi.get("exit")),
                         (verb, False, SIGTERM_EXIT),
                         f"the envelope's exit matches the post's; {why}")
        self.assertEqual(result.returncode, SIGTERM_EXIT,
                         f"the process exits as a shell reports it; {why}")

    def test_clippy_exits_143_with_its_envelope_saying_so_for_a_cargo_killed_by_sigterm(self):
        result, axi = self.filed("rust", self.root, "--crate", CRATE,
                                 "--deny-warnings", verb="clippy")
        self.assertExitsWithTheSignalExit(result, axi, "clippy")

    def test_workspace_clippy_exits_143_with_its_envelope_saying_so_for_a_cargo_killed_by_sigterm(self):
        result, axi = self.filed("rust", self.root, verb="workspace-clippy")
        self.assertExitsWithTheSignalExit(result, axi, "workspace-clippy")


if __name__ == "__main__":
    unittest.main()
