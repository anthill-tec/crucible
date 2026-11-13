"""A project's declared linter runs through its client's `lint` verb, and its
result is filed on the board's compile route as a lint record.

Every drive is a real subprocess of a client from a scratch copy of the fleet,
against a recording double of the board (`tests/client/lint_verb_harness.py`).
The linter is always a fake: a small program that records its argv, working
directory and environment, and prints and exits as the test scripts it.

What is pinned:

  * a declared linter runs with its declared argv in the project directory,
    and its output -- stdout and stderr as one stream, in the order written --
    is posted whole with the marker `lint`, the declared `format` and the
    linter's exit as `runnerExit`, under the `--cycle` given;
  * a clean run that printed nothing is posted too;
  * the envelope names the linter, where it was declared, its exit, the
    board's two counts as `errors` and `lints`, and the filed event;
  * the linter's exit is the verdict, whatever the output says and whether or
    not the board took the post;
  * nothing declared is a skip, not a refusal, and posts nothing; no `--agent`
    runs the linter and posts nothing;
  * a command's first word is looked up on PATH, or -- holding a `/` --
    resolved against the run directory; one that is not found is refused,
    naming it, and nothing is posted; a bun project's linter runs in its
    package directory;
  * the marker is the declared `name`, else the declared `format`, else the
    basename of the command's first word.

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> --tests \
        tests.client.test_a_projects_declared_linter_runs_through_its_client
"""

import unittest

from tests.client.lint_verb_harness import (
    AGENT,
    CYCLE,
    DEFAULT_EVENT,
    PROJECT_KEY,
    LintDriveMixin,
    closed_port_url,
    declared_source,
    lint_table,
    warning_codes,
)

RUFF = "lint-fixture-ruff"
RUFF_ARGS = ["check", "--output-format", "concise", "."]

#: What the fake ruff prints: stdout, then stderr, then stdout again.
INTERLEAVED = (("out", "app/a.py:1:1: F401 `os` imported but unused\n"),
               ("err", "warning: ruff found a stale cache\n"),
               ("out", "app/b.py:2:5: E711 comparison to None\n"))
INTERLEAVED_TEXT = "".join(text for _stream, text in INTERLEAVED)


def _ruff_table(command=None, **fields):
    return lint_table(command or [RUFF, *RUFF_ARGS], **{"format": "ruff", **fields})


class ADeclaredLinterRunsAndIsFiledTest(LintDriveMixin, unittest.TestCase):

    def setUp(self):
        super().setUp()
        self.fake(RUFF)

    def test_the_declared_command_runs_once_with_its_declared_argv_in_the_project_directory(self):
        root = self.project(_ruff_table())
        result, axi = self.filed("python", root)
        calls = self.calls(RUFF)
        self.assertEqual(
            [(c["argv"], c["cwd"]) for c in calls], [(RUFF_ARGS, str(root))],
            f"the declared ruff runs once, with its declared arguments, in the "
            f"project directory; envelope={axi!r} stderr={result.stderr[-2000:]}")

    def test_the_post_carries_the_marker_the_format_the_exit_and_the_output_in_order(self):
        self.say(INTERLEAVED, exit_code=1)
        root = self.project(_ruff_table())
        result, axi = self.filed("python", root)
        body = self.one_compile_post(result, axi)
        self.assertEqual(
            {key: body.get(key) for key in ("lint", "format", "runnerExit", "errors",
                                            "projectKey", "agentId", "stack")},
            {"lint": "ruff", "format": "ruff", "runnerExit": 1,
             "errors": INTERLEAVED_TEXT, "projectKey": PROJECT_KEY,
             "agentId": AGENT, "stack": "python"},
            f"the lint post; body={body!r}")
        self.assertEqual(
            str((body.get("context") or {}).get("cycleId")), str(CYCLE),
            f"the post is filed under the --cycle given; body={body!r}")

    def test_a_clean_run_that_printed_nothing_is_posted_with_runner_exit_zero(self):
        self.say((), exit_code=0)
        root = self.project(_ruff_table())
        result, axi = self.filed("python", root)
        body = self.one_compile_post(result, axi)
        self.assertEqual(
            (body.get("lint"), body.get("runnerExit"), body.get("errors")),
            ("ruff", 0, ""),
            f"a clean run is filed with empty output and exit 0; body={body!r}")

    def test_the_envelope_names_the_linter_its_declaration_its_exit_the_boards_counts_and_the_event(self):
        self.say(INTERLEAVED, exit_code=1)
        self.board.answer_counts(3, 2, event="evt-lint-fixture-0042")
        root = self.project(_ruff_table())
        result, axi = self.filed("python", root)
        self.assertEqual(
            {key: axi.get(key) for key in ("verb", "ok", "linter", "declared",
                                            "exit", "errors", "lints", "event",
                                            "tier")},
            {"verb": "lint", "ok": False, "linter": "ruff",
             "declared": declared_source(root), "exit": 1, "errors": 3,
             "lints": 2, "event": "evt-lint-fixture-0042", "tier": "compile"},
            f"the lint envelope; stdout={result.stdout!r} "
            f"stderr={result.stderr[-2000:]}")
        self.assertNotIn("skipped", axi, f"a run is not a skip; {axi!r}")


class TheLintersExitIsTheVerdictTest(LintDriveMixin, unittest.TestCase):

    def setUp(self):
        super().setUp()
        self.fake(RUFF)

    def test_a_linter_exiting_one_answers_ok_false_and_the_client_exits_non_zero(self):
        self.say(INTERLEAVED, exit_code=1)
        self.board.answer_counts(2, 0)
        root = self.project(_ruff_table())
        result, axi = self.filed("python", root)
        self.assertEqual((axi.get("verb"), axi.get("ok"), axi.get("exit")),
                         ("lint", False, 1), f"envelope={axi!r}")
        self.assertNotEqual(result.returncode, 0,
                            f"a failing linter fails the client; {axi!r}")

    def test_a_linter_exiting_zero_with_warnings_in_its_output_answers_ok_true(self):
        self.say((("out", "app/a.py:1:1: W291 trailing whitespace\n"),), exit_code=0)
        self.board.answer_counts(0, 4)
        root = self.project(_ruff_table())
        result, axi = self.filed("python", root)
        self.assertEqual(
            (axi.get("verb"), axi.get("ok"), axi.get("exit"), axi.get("lints")),
            ("lint", True, 0, 4),
            f"warnings in the output never fail a linter that exited 0; {axi!r} "
            f"stderr={result.stderr[-2000:]}")
        self.assertEqual(result.returncode, 0, f"{axi!r}")

    def _refused(self, status, exit_code):
        self.say((("out", "app/a.py:1:1: F401 unused\n"),), exit_code=exit_code)
        self.board.refuse_compile(status, f"HTTP {status} refused by the double")
        root = self.project(_ruff_table())
        result, axi = self.filed("python", root)
        self.assertEqual(len(self.board.compile_posts()), 1,
                         f"the run was posted, and refused; {axi!r}")
        return result, axi

    def test_a_post_the_board_refuses_with_413_keeps_a_clean_linters_ok_and_warns_ingest_failed(self):
        result, axi = self._refused(413, exit_code=0)
        self.assertEqual((axi.get("verb"), axi.get("ok"), axi.get("exit")),
                         ("lint", True, 0), f"{axi!r}")
        self.assertEqual(result.returncode, 0, f"{axi!r}")
        self.assertIn("ingest-failed", warning_codes(axi), f"{axi!r}")
        self.assertEqual(
            (axi.get("errors"), axi.get("lints"), axi.get("event")),
            (None, None, None),
            f"nothing was filed, so the counts and event are null; {axi!r}")

    def test_a_post_the_board_refuses_with_400_keeps_a_failing_linters_ok_false_and_warns_ingest_failed(self):
        result, axi = self._refused(400, exit_code=1)
        self.assertEqual((axi.get("verb"), axi.get("ok"), axi.get("exit")),
                         ("lint", False, 1), f"{axi!r}")
        self.assertNotEqual(result.returncode, 0, f"{axi!r}")
        self.assertIn("ingest-failed", warning_codes(axi), f"{axi!r}")

    def test_an_unreachable_board_keeps_the_linters_verdict_and_warns_ingest_failed(self):
        self.say((("out", "app/a.py:1:1: F401 unused\n"),), exit_code=0)
        root = self.project(_ruff_table(), board_url=closed_port_url())
        result, axi = self.filed("python", root)
        self.assertEqual(len(self.calls(RUFF)), 1, "the linter still ran")
        self.assertEqual((axi.get("verb"), axi.get("ok"), axi.get("exit")),
                         ("lint", True, 0), f"{axi!r} stderr={result.stderr[-2000:]}")
        self.assertIn("ingest-failed", warning_codes(axi), f"{axi!r}")
        self.assertIsNone(axi.get("event"), f"nothing was filed; {axi!r}")


class NothingDeclaredIsSkippedAndNoAgentPostsNothingTest(LintDriveMixin, unittest.TestCase):

    def test_a_python_project_with_no_lint_table_answers_skipped_not_declared_and_posts_nothing(self):
        self.fake(RUFF)
        root = self.project(None)
        result, axi = self.filed("python", root)
        self.assertEqual(
            (axi.get("verb"), axi.get("ok"), axi.get("skipped")),
            ("lint", True, "not-declared"),
            f"stdout={result.stdout!r} stderr={result.stderr[-2000:]}")
        self.assertEqual(result.returncode, 0, f"a skip is not a failure; {axi!r}")
        self.assertEqual(self.board.compile_posts(), [], "a skip posts nothing")
        self.assertEqual(self.calls(), [], "no linter ran")

    def test_without_agent_a_declared_linter_runs_and_nothing_is_posted(self):
        self.fake(RUFF)
        self.say(INTERLEAVED, exit_code=1)
        root = self.project(_ruff_table())
        result, axi = self.run_client("python", root)
        self.assertEqual(len(self.calls(RUFF)), 1,
                         f"the linter ran; {axi!r} stderr={result.stderr[-2000:]}")
        self.assertEqual(self.board.writes(), [], "no --agent: nothing is posted")
        self.assertEqual(
            (axi.get("verb"), axi.get("ok"), axi.get("exit"), axi.get("linter")),
            ("lint", False, 1, "ruff"), f"{axi!r}")
        self.assertEqual(
            (axi.get("errors"), axi.get("lints"), axi.get("event")),
            (None, None, None), f"nothing was filed; {axi!r}")
        self.assertNotEqual(result.returncode, 0, f"{axi!r}")


class TheCommandIsFoundOrRefusedTest(LintDriveMixin, unittest.TestCase):

    def test_a_first_word_not_on_path_is_refused_naming_it_and_nothing_is_posted(self):
        missing = "lint-fixture-no-such-linter"
        root = self.project(lint_table([missing, "check", "."], format="ruff"))
        result, axi = self.filed("python", root)
        self.assertEqual((axi.get("verb"), axi.get("ok")), ("lint", False),
                         f"stdout={result.stdout!r} stderr={result.stderr[-2000:]}")
        self.assertIn(missing, str(axi.get("error") or ""),
                      f"the refusal names the command not found; {axi!r}")
        self.assertNotEqual(result.returncode, 0, f"{axi!r}")
        self.assertEqual(self.board.compile_posts(), [], "nothing is posted")

    def test_a_first_word_holding_a_slash_is_resolved_against_the_project_directory(self):
        root = self.project(lint_table([f".venv/bin/{RUFF}", *RUFF_ARGS], format="ruff"))
        self.fake(RUFF, root / ".venv" / "bin")
        # A decoy at the same relative path under the process's own working
        # directory: resolving against the cwd would run it instead.
        decoy_log = self.scratch / "decoy-calls.jsonl"
        decoy_dir = self.scratch / ".venv" / "bin"
        decoy_dir.mkdir(parents=True)
        (decoy_dir / RUFF).write_text(
            f"#!/bin/sh\necho decoy >> {decoy_log}\nexit 0\n", encoding="utf-8")
        (decoy_dir / RUFF).chmod(0o755)
        result, axi = self.filed("python", root, cwd=self.scratch)
        calls = self.calls(RUFF)
        self.assertEqual([(c["argv"], c["cwd"]) for c in calls],
                         [(RUFF_ARGS, str(root))],
                         f"{axi!r} stderr={result.stderr[-2000:]}")
        self.assertFalse(decoy_log.exists(),
                         "the relative path is resolved against the project, "
                         "never the process's working directory")
        body = self.one_compile_post(result, axi)
        self.assertEqual(body.get("lint"), "ruff", f"{body!r}")

    def _bun_project(self, command):
        root = self.project(
            "\n[bun]\npackage_dir = \"web\"\n" + lint_table(command))
        (root / "web").mkdir()
        return root

    def test_a_bun_projects_linter_runs_in_its_package_directory(self):
        self.fake("lint-fixture-eslint")
        root = self._bun_project(["lint-fixture-eslint", "."])
        result, axi = self.filed("bun", root)
        self.assertEqual(
            [c["cwd"] for c in self.calls("lint-fixture-eslint")],
            [str(root / "web")],
            f"bun lints where `check` runs, its package dir; {axi!r} "
            f"stderr={result.stderr[-2000:]}")

    def test_a_bun_projects_relative_command_is_resolved_against_its_package_directory(self):
        root = self._bun_project(["./node_modules/.bin/lint-fixture-eslint", "."])
        self.fake("lint-fixture-eslint", root / "web" / "node_modules" / ".bin")
        result, axi = self.filed("bun", root)
        self.assertEqual(
            [(c["argv"], c["cwd"]) for c in self.calls("lint-fixture-eslint")],
            [(["."], str(root / "web"))],
            f"{axi!r} stderr={result.stderr[-2000:]}")


class TheMarkerIsTheNameElseTheFormatElseTheBasenameTest(LintDriveMixin, unittest.TestCase):

    def test_python_dash_m_ruff_with_format_ruff_posts_lint_ruff(self):
        interpreter = self.fake("python", self.scratch / "interpreter")
        root = self.project(lint_table(
            [str(interpreter), "-m", "ruff", "check", "."], format="ruff"))
        result, axi = self.filed("python", root)
        body = self.one_compile_post(result, axi)
        self.assertEqual((body.get("lint"), body.get("format")), ("ruff", "ruff"),
                         f"the format names the marker, not the interpreter; {body!r}")
        self.assertEqual(axi.get("linter"), "ruff", f"{axi!r}")

    def test_a_declared_name_wins_over_the_format(self):
        self.fake(RUFF)
        root = self.project(lint_table([RUFF, "check", "."], format="ruff",
                                       name="ruff-strict"))
        result, axi = self.filed("python", root)
        body = self.one_compile_post(result, axi)
        self.assertEqual((body.get("lint"), body.get("format")),
                         ("ruff-strict", "ruff"), f"{body!r}")
        self.assertEqual(axi.get("linter"), "ruff-strict", f"{axi!r}")

    def test_with_no_format_and_no_name_the_marker_is_the_basename_and_no_format_is_sent(self):
        eslint = self.fake("lint-fixture-eslint", self.scratch / "tools")
        root = self.project(lint_table([str(eslint), "."]))
        result, axi = self.filed("python", root)
        body = self.one_compile_post(result, axi)
        self.assertEqual(body.get("lint"), "lint-fixture-eslint", f"{body!r}")
        self.assertNotIn("format", body,
                         f"an undeclared format is not sent; the board detects "
                         f"it; {body!r}")
        self.assertEqual(axi.get("linter"), "lint-fixture-eslint", f"{axi!r}")

    def test_the_default_event_id_is_the_one_the_board_answered(self):
        self.fake(RUFF)
        root = self.project(_ruff_table())
        _result, axi = self.filed("python", root)
        self.assertEqual(axi.get("event"), DEFAULT_EVENT, f"{axi!r}")


if __name__ == "__main__":
    unittest.main()
